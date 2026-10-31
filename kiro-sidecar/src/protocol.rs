//! Protocol types, header extraction, and error formatting for kiro-sidecar.

use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use url::Url;

use crate::config::Config;

/// Standard protocol version header value.
pub const PROTOCOL_VERSION: &str = "1";

/// Header name for the local authentication token.
pub const H_SIDECAR_TOKEN: &str = "x-kiro-sidecar-token";

/// Header name for the protocol version.
pub const H_PROTOCOL_VERSION: &str = "x-kiro-protocol-version";

/// Header name for the upstream target URL.
pub const H_TARGET_URL: &str = "x-target-url";

/// Header name for the optional proxy URL.
pub const H_PROXY_URL: &str = "x-proxy-url";

/// Response header indicating the source of the response.
pub const H_RESPONSE_SOURCE: &str = "x-kiro-response-source";

/// Headers that are forwarded from incoming requests to upstream targets.
const FORWARDED_HEADERS: &[&str] = &[
    "authorization",
    "tokentype",
    "content-type",
    "accept",
    "user-agent",
    "x-amz-user-agent",
    "x-amz-target",
    "amz-sdk-invocation-id",
    "amz-sdk-request",
    "x-amzn-codewhisperer-optout",
    "x-amzn-kiro-agent-mode",
    "x-amzn-kiro-profile-arn",
];

// ── SidecarError ───────────────────────────────────────────────────────

/// Structured error returned by the sidecar to the IDE client.
#[derive(Debug, Serialize)]
pub struct SidecarError {
    /// HTTP status code (not serialised into the JSON body).
    #[serde(skip)]
    pub status: StatusCode,
    /// Machine-readable error code.
    pub source: &'static str,
    /// Machine-readable error code.
    pub code: &'static str,
    /// Pipeline phase where the error occurred.
    pub phase: &'static str,
    /// Human-readable description.
    pub message: String,
    /// Whether the caller may retry the request.
    pub retryable: bool,
}

impl SidecarError {
    /// Convert the error into an axum `Response` with standard sidecar headers.
    pub fn into_response(self) -> Response {
        let body = serde_json::to_string(&self).unwrap_or_else(|_| {
            r#"{"source":"sidecar","code":"INTERNAL","phase":"response","message":"serialization failed","retryable":false}"#.to_string()
        });

        let mut response = (self.status, body).into_response();
        let headers = response.headers_mut();
        headers.insert(
            H_PROTOCOL_VERSION,
            HeaderValue::from_static(PROTOCOL_VERSION),
        );
        headers.insert(H_RESPONSE_SOURCE, HeaderValue::from_static("sidecar"));
        headers.insert(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        response
    }
}

impl IntoResponse for SidecarError {
    fn into_response(self) -> Response {
        SidecarError::into_response(self)
    }
}

// ── ControlHeaders ─────────────────────────────────────────────────────

/// Validated control headers extracted from an incoming request.
#[derive(Debug)]
pub struct ControlHeaders {
    pub target_url: Url,
    pub proxy_url: Option<String>,
}

// ── extract_control_headers ─────────────────────────────────────────────

/// Validate and extract sidecar control headers from the incoming request.
///
/// Returns `ControlHeaders` on success, or a `SidecarError` on validation failure.
pub fn extract_control_headers(
    headers: &HeaderMap,
    config: &Config,
) -> Result<ControlHeaders, SidecarError> {
    // 1. Authenticate: X-Kiro-Sidecar-Token must match config.token
    validate_auth(headers, config)?;

    // 2. Protocol version check
    validate_protocol_version(headers)?;

    // 3. X-Target-Url: required, HTTPS, no userinfo/fragment, origin in allowlist
    let target_url = validate_target_url(headers, config)?;

    // 4. X-Proxy-Url: optional, but must be a valid URL if present
    let proxy_url = validate_proxy_url(headers)?;

    Ok(ControlHeaders {
        target_url,
        proxy_url,
    })
}

/// Validate the local authentication token.
pub fn validate_auth(headers: &HeaderMap, config: &Config) -> Result<(), SidecarError> {
    let token = headers
        .get(H_SIDECAR_TOKEN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if token != config.token {
        return Err(SidecarError {
            status: StatusCode::UNAUTHORIZED,
            source: "sidecar",
            code: "LOCAL_AUTH_FAILED",
            phase: "auth",
            message: "missing or invalid X-Kiro-Sidecar-Token".into(),
            retryable: false,
        });
    }
    Ok(())
}

/// Validate the protocol version header.
pub fn validate_protocol_version(headers: &HeaderMap) -> Result<(), SidecarError> {
    let version = headers
        .get(H_PROTOCOL_VERSION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if version != PROTOCOL_VERSION {
        return Err(SidecarError {
            status: StatusCode::BAD_REQUEST,
            source: "sidecar",
            code: "PROTOCOL_UNSUPPORTED",
            phase: "auth",
            message: format!(
                "unsupported protocol version '{version}', expected '{PROTOCOL_VERSION}'"
            ),
            retryable: false,
        });
    }
    Ok(())
}

fn validate_target_url(
    headers: &HeaderMap,
    config: &Config,
) -> Result<Url, SidecarError> {
    let raw = headers
        .get(H_TARGET_URL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if raw.is_empty() {
        return Err(SidecarError {
            status: StatusCode::BAD_REQUEST,
            source: "sidecar",
            code: "INVALID_TARGET",
            phase: "auth",
            message: "X-Target-Url header is required".into(),
            retryable: false,
        });
    }

    let url = Url::parse(raw).map_err(|e| SidecarError {
        status: StatusCode::BAD_REQUEST,
        source: "sidecar",
        code: "INVALID_TARGET",
        phase: "auth",
        message: format!("X-Target-Url is not a valid URL: {e}"),
        retryable: false,
    })?;

    if !config.is_target_allowed(&url) {
        return Err(SidecarError {
            status: StatusCode::BAD_REQUEST,
            source: "sidecar",
            code: "INVALID_TARGET",
            phase: "auth",
            message: format!(
                "target URL origin is not in the allowlist: {}",
                url.origin().ascii_serialization()
            ),
            retryable: false,
        });
    }

    Ok(url)
}

fn validate_proxy_url(headers: &HeaderMap) -> Result<Option<String>, SidecarError> {
    let raw = match headers.get(H_PROXY_URL).and_then(|v| v.to_str().ok()) {
        Some(v) if !v.is_empty() => v,
        _ => return Ok(None),
    };

    // Just validate that it parses as a URL.
    Url::parse(raw).map_err(|e| SidecarError {
        status: StatusCode::BAD_REQUEST,
        source: "sidecar",
        code: "INVALID_PROXY",
        phase: "auth",
        message: format!("X-Proxy-Url is not a valid URL: {e}"),
        retryable: false,
    })?;

    Ok(Some(raw.to_string()))
}

// ── build_upstream_headers ─────────────────────────────────────────────

/// Copy only the allowed headers from the incoming request to the upstream request.
pub fn build_upstream_headers(incoming: &HeaderMap) -> reqwest::header::HeaderMap {
    let mut out = reqwest::header::HeaderMap::new();
    for &name in FORWARDED_HEADERS {
        if let Some(value) = incoming.get(name) {
            if let Ok(rval) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) {
                if let Ok(rname) = reqwest::header::HeaderName::from_bytes(name.as_bytes()) {
                    out.insert(rname, rval);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    /// Helper to build a Config with sensible test defaults.
    fn test_config() -> Config {
        Config {
            port: 9091,
            instance_id: "test-instance".into(),
            token: "test-token".into(),
            target_allowlist: vec![
                "https://q.us-east-1.amazonaws.com".into(),
            ],
            max_payload_bytes: 10 * 1024 * 1024,
            max_inflight: 128,
            max_buffer_bytes: 64 * 1024 * 1024,
            max_client_cache: 128,
            connect_timeout_secs: 10,
            transport_profile: "v1-aws-lc-rs".into(),
        }
    }

    /// Convenience: build headers with all valid control headers set.
    fn valid_headers() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(H_SIDECAR_TOKEN, "test-token".parse().unwrap());
        h.insert(H_PROTOCOL_VERSION, "1".parse().unwrap());
        h.insert(
            H_TARGET_URL,
            "https://q.us-east-1.amazonaws.com/invoke"
                .parse()
                .unwrap(),
        );
        h
    }

    #[test]
    fn missing_token_returns_401() {
        let cfg = test_config();
        let h = HeaderMap::new(); // no token
        let err = extract_control_headers(&h, &cfg).unwrap_err();
        assert_eq!(err.status, StatusCode::UNAUTHORIZED);
        assert_eq!(err.code, "LOCAL_AUTH_FAILED");
    }

    #[test]
    fn wrong_token_returns_401() {
        let cfg = test_config();
        let mut h = valid_headers();
        h.insert(H_SIDECAR_TOKEN, "wrong-token".parse().unwrap());
        let err = extract_control_headers(&h, &cfg).unwrap_err();
        assert_eq!(err.status, StatusCode::UNAUTHORIZED);
        assert_eq!(err.code, "LOCAL_AUTH_FAILED");
    }

    #[test]
    fn wrong_protocol_version_returns_400() {
        let cfg = test_config();
        let mut h = valid_headers();
        h.insert(H_PROTOCOL_VERSION, "2".parse().unwrap());
        let err = extract_control_headers(&h, &cfg).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "PROTOCOL_UNSUPPORTED");
    }

    #[test]
    fn missing_protocol_version_returns_400() {
        let cfg = test_config();
        let mut h = valid_headers();
        h.remove(H_PROTOCOL_VERSION);
        let err = extract_control_headers(&h, &cfg).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "PROTOCOL_UNSUPPORTED");
    }

    #[test]
    fn missing_target_url_returns_400() {
        let cfg = test_config();
        let mut h = valid_headers();
        h.remove(H_TARGET_URL);
        let err = extract_control_headers(&h, &cfg).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "INVALID_TARGET");
    }

    #[test]
    fn non_https_target_returns_400() {
        let cfg = test_config();
        let mut h = valid_headers();
        h.insert(
            H_TARGET_URL,
            "http://q.us-east-1.amazonaws.com/path"
                .parse()
                .unwrap(),
        );
        let err = extract_control_headers(&h, &cfg).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "INVALID_TARGET");
    }

    #[test]
    fn target_not_in_allowlist_returns_400() {
        let cfg = test_config();
        let mut h = valid_headers();
        h.insert(
            H_TARGET_URL,
            "https://evil.example.com/path".parse().unwrap(),
        );
        let err = extract_control_headers(&h, &cfg).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "INVALID_TARGET");
    }

    #[test]
    fn valid_request_without_proxy() {
        let cfg = test_config();
        let h = valid_headers();
        let ctrl = extract_control_headers(&h, &cfg).unwrap();
        assert_eq!(
            ctrl.target_url.as_str(),
            "https://q.us-east-1.amazonaws.com/invoke"
        );
        assert!(ctrl.proxy_url.is_none());
    }

    #[test]
    fn valid_request_with_proxy() {
        let cfg = test_config();
        let mut h = valid_headers();
        h.insert(H_PROXY_URL, "http://127.0.0.1:8080".parse().unwrap());
        let ctrl = extract_control_headers(&h, &cfg).unwrap();
        assert_eq!(
            ctrl.target_url.as_str(),
            "https://q.us-east-1.amazonaws.com/invoke"
        );
        assert_eq!(ctrl.proxy_url.as_deref(), Some("http://127.0.0.1:8080"));
    }

    #[test]
    fn invalid_proxy_url_returns_400() {
        let cfg = test_config();
        let mut h = valid_headers();
        h.insert(H_PROXY_URL, "not a url".parse().unwrap());
        let err = extract_control_headers(&h, &cfg).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "INVALID_PROXY");
    }

    #[test]
    fn build_upstream_copies_only_allowed_headers() {
        let mut incoming = HeaderMap::new();
        incoming.insert("authorization", "Bearer xyz".parse().unwrap());
        incoming.insert("content-type", "application/json".parse().unwrap());
        incoming.insert("x-evil-header", "should-not-copy".parse().unwrap());
        incoming.insert(H_SIDECAR_TOKEN, "secret".parse().unwrap());

        let upstream = build_upstream_headers(&incoming);
        assert_eq!(
            upstream.get("authorization").unwrap().to_str().unwrap(),
            "Bearer xyz"
        );
        assert_eq!(
            upstream.get("content-type").unwrap().to_str().unwrap(),
            "application/json"
        );
        assert!(upstream.get("x-evil-header").is_none());
        assert!(upstream.get(H_SIDECAR_TOKEN).is_none());
    }

    #[test]
    fn sidecar_error_into_response_has_correct_headers() {
        let err = SidecarError {
            status: StatusCode::UNAUTHORIZED,
            source: "sidecar",
            code: "LOCAL_AUTH_FAILED",
            phase: "auth",
            message: "bad token".into(),
            retryable: false,
        };
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            resp.headers().get(H_PROTOCOL_VERSION).unwrap().to_str().unwrap(),
            "1"
        );
        assert_eq!(
            resp.headers().get(H_RESPONSE_SOURCE).unwrap().to_str().unwrap(),
            "sidecar"
        );
    }
}
