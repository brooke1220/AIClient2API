//! Streaming proxy handler for kiro-sidecar.
//!
//! Receives requests from the IDE client, validates control headers, enforces
//! resource budgets, and streams the upstream response back. The
//! `ResourceGuard` RAII handle is held until the handler function returns;
//! since axum captures the response body stream before the handler's future
//! completes, this is safe — but it means the budget counters reflect "request
//! accepted" rather than "response fully consumed". This is an intentional
//! tradeoff for simplicity; precise tracking would require wrapping the body
//! stream to own the guard, adding complexity for marginal benefit.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::TryStreamExt;

use crate::client::ClientCache;
use crate::config::Config;
use crate::lifecycle::{BusyReason, ResourceBudget};
use crate::protocol::{self, SidecarError, H_PROTOCOL_VERSION, H_RESPONSE_SOURCE, PROTOCOL_VERSION};

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

    // 2. Read request body with size limit.
    let body_bytes = axum::body::to_bytes(body, state.config.max_payload_bytes)
        .await
        .map_err(|_| SidecarError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            source: "sidecar",
            code: "REQUEST_TOO_LARGE",
            phase: "local",
            message: format!(
                "request body exceeds {} byte limit",
                state.config.max_payload_bytes
            ),
            retryable: false,
        })?;

    // 3. Acquire resource budget (concurrency + buffer).
    let _guard = state.budget.try_acquire(body_bytes.len()).map_err(|reason| {
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
        .map_err(|e| classify_reqwest_error(&e))?;

    // 6. Build response with sidecar headers and streamed body.
    let status = upstream_resp.status();
    let upstream_headers = upstream_resp.headers().clone();

    // Map the reqwest byte stream, converting reqwest::Error → io::Error
    // so that axum's Body::from_stream can consume it.
    let body_stream = upstream_resp
        .bytes_stream()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::BrokenPipe, e));

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
        if let Some(val) = upstream_headers.get(name) {
            if let Ok(hname) = axum::http::header::HeaderName::from_bytes(name.as_bytes()) {
                if let Ok(hval) = HeaderValue::from_bytes(val.as_bytes()) {
                    resp_headers.insert(hname, hval);
                }
            }
        }
    }

    // _guard is dropped here, releasing the resource budget.
    // The body stream has been moved into the Response and will be consumed
    // by axum's connection layer after this future completes.
    Ok(response)
}

// ── Error classification ──────────────────────────────────────────────

/// Classify a reqwest send error into a structured `SidecarError`.
fn classify_reqwest_error(err: &reqwest::Error) -> SidecarError {
    let (code, phase, retryable) = if err.is_timeout() {
        ("CONNECT_TIMEOUT", "connect", true)
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
        message: format!("{err}"),
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
