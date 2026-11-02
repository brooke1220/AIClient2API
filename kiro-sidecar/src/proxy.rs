//! Streaming proxy handler for kiro-sidecar.
//!
//! Receives requests from the IDE client, validates control headers, enforces
//! resource budgets, and streams the upstream response back.
//! Request memory is reserved before reading. The downstream body owns the
//! in-flight guard until EOF, an error, or cancellation.

use std::error::Error as _;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::{stream, StreamExt};

use crate::client::ClientCache;
use crate::config::Config;
use crate::lifecycle::{BusyReason, ResourceBudget};
use crate::protocol::{
    self, SidecarError, H_PROTOCOL_VERSION, H_RESPONSE_SOURCE, PROTOCOL_VERSION,
};

/// Shared application state available to all handlers.
#[derive(Debug)]
pub struct AppState {
    pub config: Arc<Config>,
    pub client_cache: ClientCache,
    pub budget: Arc<ResourceBudget>,
}

/// Response headers forwarded from upstream back to the IDE client.
const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-encoding",
    "retry-after",
    "x-amzn-requestid",
    "x-amzn-errortype",
];

// ── Public handler ────────────────────────────────────────────────────

/// Axum handler for POST /stream.
///
/// Delegates to `handle_stream_inner` and converts any `SidecarError` into a
/// structured JSON error response with standard sidecar headers.
pub async fn stream_handler(
    State(state): State<Arc<AppState>>,
    req: axum::extract::Request,
) -> Response {
    match handle_stream_inner(&state, req).await {
        Ok(resp) => resp,
        Err(e) => e.into_response(),
    }
}

// ── Inner implementation ──────────────────────────────────────────────

async fn handle_stream_inner(
    state: &AppState,
    req: axum::extract::Request,
) -> Result<Response, SidecarError> {
    // 1. Split request and extract/validate control headers.
    let (parts, body) = req.into_parts();
    let control = protocol::extract_control_headers(&parts.headers, &state.config)?;

    let too_large = || SidecarError {
        status: StatusCode::PAYLOAD_TOO_LARGE,
        source: "sidecar",
        code: "REQUEST_TOO_LARGE",
        phase: "local",
        message: format!(
            "request body exceeds {} byte limit",
            state.config.max_payload_bytes
        ),
        retryable: false,
    };

    // Known framing reserves exactly Content-Length. For chunked requests,
    // reserve the payload limit up front rather than buffering outside budget.
    let reserved_bytes = parts
        .headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(state.config.max_payload_bytes);
    if reserved_bytes > state.config.max_payload_bytes {
        return Err(too_large());
    }

    // 3. Acquire resource budget (concurrency + buffer).
    let mut guard = state.budget.try_acquire(reserved_bytes).map_err(|reason| {
        let message = match &reason {
            BusyReason::TooManyRequests => "too many concurrent requests".to_string(),
            BusyReason::BufferFull => "total buffered bytes limit exceeded".to_string(),
        };
        SidecarError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            source: "sidecar",
            code: "SIDECAR_BUSY",
            phase: "local",
            message,
            retryable: true,
        }
    })?;

    let body_bytes = axum::body::to_bytes(body, reserved_bytes)
        .await
        .map_err(|_| too_large())?;

    // The business target was validated above. The relay is a separate, trusted
    // loopback origin; never configure it as reqwest's CONNECT proxy.
    let target = if control.use_tls_sidecar {
        state
            .config
            .tls_sidecar_url
            .as_ref()
            .ok_or_else(|| relay_error("TLS_SIDECAR_UNAVAILABLE"))?
    } else {
        &control.target_url
    };
    // The local hop must bypass the external proxy; Go receives it explicitly.
    let client = state
        .client_cache
        .get_or_create(if control.use_tls_sidecar {
            None
        } else {
            control.proxy_url.as_deref()
        })
        .map_err(|e| SidecarError {
            status: StatusCode::BAD_GATEWAY,
            source: "sidecar",
            code: "PROXY_CONNECT_ERROR",
            phase: "proxy",
            message: e,
            retryable: false,
        })?;

    // 5. Build and send upstream request.
    let upstream_headers = protocol::build_upstream_headers(&parts.headers);
    let mut outbound = client
        .post(target.as_str())
        .headers(upstream_headers)
        .body(body_bytes);
    if control.use_tls_sidecar {
        outbound = outbound
            .header(protocol::H_TARGET_URL, control.target_url.as_str())
            .header(H_PROTOCOL_VERSION, PROTOCOL_VERSION);
        if let Some(proxy) = &control.proxy_url {
            outbound = outbound.header(protocol::H_PROXY_URL, proxy);
        }
    }
    let upstream_resp = outbound.send().await.map_err(|e| {
        if control.use_tls_sidecar {
            relay_error("TLS_SIDECAR_CONNECTION_ERROR")
        } else {
            classify_reqwest_error(e, control.proxy_url.is_some())
        }
    })?;
    if control.use_tls_sidecar {
        validate_relay_response(&upstream_resp)?;
    }

    // 6. Build response with sidecar headers and streamed body.
    let status = upstream_resp.status();
    let upstream_headers = upstream_resp.headers().clone();

    // Map the reqwest byte stream, converting reqwest::Error → io::Error
    // so that axum's Body::from_stream can consume it.
    guard.release_buffer();
    let body_stream = stream::unfold(
        (Box::pin(upstream_resp.bytes_stream()), guard),
        |(mut upstream, guard)| async move {
            upstream.next().await.map(|chunk| {
                let chunk =
                    chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::BrokenPipe, e));
                (chunk, (upstream, guard))
            })
        },
    );

    let mut response = Response::builder()
        .status(status)
        .body(Body::from_stream(body_stream))
        .unwrap();

    let resp_headers = response.headers_mut();

    // Standard sidecar response headers.
    resp_headers.insert(
        H_PROTOCOL_VERSION,
        HeaderValue::from_static(PROTOCOL_VERSION),
    );
    resp_headers.insert(H_RESPONSE_SOURCE, HeaderValue::from_static("upstream"));

    // Forward selected upstream response headers.
    for &name in FORWARDED_RESPONSE_HEADERS {
        if protocol::is_connection_header(&upstream_headers, name) {
            continue;
        }
        if let Some(val) = upstream_headers.get(name) {
            if let Ok(hname) = axum::http::header::HeaderName::from_bytes(name.as_bytes()) {
                if let Ok(hval) = HeaderValue::from_bytes(val.as_bytes()) {
                    resp_headers.insert(hname, hval);
                }
            }
        }
    }

    Ok(response)
}

/// Only trusted relay metadata can classify an error as local. The upstream's
/// HTTP status and body remain untouched, even for 401/403/429/502 responses.
fn validate_relay_response(response: &reqwest::Response) -> Result<(), SidecarError> {
    let headers = response.headers();
    if headers
        .get(H_PROTOCOL_VERSION)
        .and_then(|v| v.to_str().ok())
        != Some(PROTOCOL_VERSION)
    {
        return Err(relay_error("TLS_SIDECAR_PROTOCOL_ERROR"));
    }
    match headers.get(H_RESPONSE_SOURCE).and_then(|v| v.to_str().ok()) {
        Some("upstream") => Ok(()),
        Some("sidecar")
            if response.status().is_client_error() || response.status().is_server_error() =>
        {
            Err(relay_error(
                headers
                    .get("x-kiro-error-code")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
            ))
        }
        _ => Err(relay_error("TLS_SIDECAR_PROTOCOL_ERROR")),
    }
}

fn relay_error(code: &str) -> SidecarError {
    let (code, phase, retryable) = match code {
        "TLS_SIDECAR_UNAVAILABLE" => ("TLS_SIDECAR_UNAVAILABLE", "local", true),
        "TLS_SIDECAR_CONNECTION_ERROR" => ("TLS_SIDECAR_CONNECTION_ERROR", "local", true),
        "INVALID_TARGET" => ("INVALID_TARGET", "local", false),
        "INVALID_PROXY" => ("INVALID_PROXY", "local", false),
        "TLS_ERROR" => ("TLS_ERROR", "tls", false),
        "PROXY_AUTH_FAILED" => ("PROXY_AUTH_FAILED", "proxy", false),
        "CONNECT_TIMEOUT" => ("CONNECT_TIMEOUT", "connect", true),
        "DNS_ERROR" => ("DNS_ERROR", "dns", true),
        "CONNECT_ERROR" => ("CONNECT_ERROR", "connect", true),
        "PROXY_CONNECT_ERROR" => ("PROXY_CONNECT_ERROR", "proxy", true),
        "UPSTREAM_HEADERS_ERROR" => ("UPSTREAM_HEADERS_ERROR", "headers", true),
        _ => ("TLS_SIDECAR_PROTOCOL_ERROR", "local", false),
    };
    SidecarError {
        status: StatusCode::BAD_GATEWAY,
        source: "sidecar",
        code,
        phase,
        message: code.into(),
        retryable,
    }
}

// ── Error classification ──────────────────────────────────────────────

/// Classify a reqwest send error into a structured `SidecarError`.
fn classify_reqwest_error(err: reqwest::Error, proxied: bool) -> SidecarError {
    let mut details = String::new();
    let mut source = err.source();
    let mut tls_error = false;
    while let Some(cause) = source {
        tls_error |= cause.downcast_ref::<rustls::Error>().is_some();
        details.push_str(&cause.to_string().to_lowercase());
        source = cause.source();
    }
    let (code, phase, retryable) = if details.contains("proxy authentication required")
        || details.contains("proxy authorization required")
        || details.contains("407 ")
        || details.contains("status code 407")
    {
        ("PROXY_AUTH_FAILED", "proxy", false)
    } else if tls_error || details.contains("certificate") || details.contains("tls handshake") {
        ("TLS_ERROR", "tls", false)
    } else if err.is_timeout() {
        ("CONNECT_TIMEOUT", "connect", true)
    } else if details.contains("dns error") || details.contains("failed to lookup address") {
        ("DNS_ERROR", "dns", true)
    } else if err.is_connect() && proxied {
        ("PROXY_CONNECT_ERROR", "proxy", true)
    } else if err.is_connect() {
        ("CONNECT_ERROR", "connect", true)
    } else if err.is_builder() {
        ("INVALID_TARGET", "local", false)
    } else {
        ("UPSTREAM_HEADERS_ERROR", "headers", true)
    };

    SidecarError {
        status: StatusCode::BAD_GATEWAY,
        source: "sidecar",
        code,
        phase,
        // Do not return URLs, proxy credentials, or provider-generated strings.
        message: code.to_string(),
        retryable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relay_response(
        status: u16,
        version: Option<&str>,
        source: Option<&str>,
        code: Option<&str>,
    ) -> reqwest::Response {
        let mut response = http::Response::builder().status(status);
        for (name, value) in [
            (H_PROTOCOL_VERSION, version),
            (H_RESPONSE_SOURCE, source),
            ("x-kiro-error-code", code),
        ] {
            if let Some(value) = value {
                response = response.header(name, value);
            }
        }
        response.body("").unwrap().into()
    }

    #[test]
    fn relay_upstream_statuses_are_not_local_errors() {
        for status in [200, 401, 403, 429, 502] {
            let response = relay_response(status, Some("1"), Some("upstream"), Some("TLS_ERROR"));
            assert!(validate_relay_response(&response).is_ok(), "{status}");
        }
    }

    #[test]
    fn relay_rejects_missing_or_invalid_protocol_metadata() {
        for (version, source, status, code) in [
            (None, Some("upstream"), 200, None),
            (Some("2"), Some("upstream"), 200, None),
            (Some("1"), None, 401, None),
            (Some("1"), Some("unknown"), 502, None),
            (Some("1"), Some("sidecar"), 200, Some("TLS_ERROR")),
            (Some("1"), Some("sidecar"), 302, Some("TLS_ERROR")),
            (Some("1"), Some("sidecar"), 502, None),
            (Some("1"), Some("sidecar"), 502, Some("UNKNOWN_ERROR")),
        ] {
            let response = relay_response(status, version, source, code);
            let error = validate_relay_response(&response).unwrap_err();
            assert_eq!(error.code, "TLS_SIDECAR_PROTOCOL_ERROR");
            assert!(!error.retryable);
        }
    }

    #[test]
    fn relay_local_errors_preserve_their_phase_and_retry_policy() {
        for (code, phase, retryable) in [
            ("TLS_SIDECAR_UNAVAILABLE", "local", true),
            ("TLS_SIDECAR_CONNECTION_ERROR", "local", true),
            ("INVALID_TARGET", "local", false),
            ("INVALID_PROXY", "local", false),
            ("TLS_ERROR", "tls", false),
            ("PROXY_AUTH_FAILED", "proxy", false),
            ("CONNECT_TIMEOUT", "connect", true),
            ("DNS_ERROR", "dns", true),
            ("CONNECT_ERROR", "connect", true),
            ("PROXY_CONNECT_ERROR", "proxy", true),
            ("UPSTREAM_HEADERS_ERROR", "headers", true),
        ] {
            let response = relay_response(502, Some("1"), Some("sidecar"), Some(code));
            let error = validate_relay_response(&response).unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(error.phase, phase);
            assert_eq!(error.retryable, retryable);
            assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        }
    }

    #[test]
    fn forwarded_response_headers_are_lowercase() {
        // Sanity check: all entries in the forwarded list must be lowercase
        // (HTTP/2 header names are always lowercase).
        for &name in FORWARDED_RESPONSE_HEADERS {
            assert_eq!(name, name.to_lowercase(), "header name must be lowercase");
        }
    }
}
