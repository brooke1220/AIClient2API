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

    // 4. Get or create reqwest client for the (optional) proxy.
    let client = state
        .client_cache
        .get_or_create(control.proxy_url.as_deref())
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
    let upstream_resp = client
        .post(control.target_url.as_str())
        .headers(upstream_headers)
        .body(body_bytes)
        .send()
        .await
        .map_err(|e| classify_reqwest_error(e, control.proxy_url.is_some()))?;

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
        || details.contains("407")
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

    #[test]
    fn forwarded_response_headers_are_lowercase() {
        // Sanity check: all entries in the forwarded list must be lowercase
        // (HTTP/2 header names are always lowercase).
        for &name in FORWARDED_RESPONSE_HEADERS {
            assert_eq!(name, name.to_lowercase(), "header name must be lowercase");
        }
    }
}
