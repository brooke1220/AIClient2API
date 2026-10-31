use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::protocol::{
    self, validate_auth, validate_protocol_version, H_PROTOCOL_VERSION, H_RESPONSE_SOURCE,
    PROTOCOL_VERSION,
};
use crate::proxy::AppState;

/// Health check handler.
///
/// Validates local auth token and protocol version, then returns service status.
pub async fn health(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, protocol::SidecarError> {
    validate_auth(&headers, &state.config)?;
    validate_protocol_version(&headers)?;

    let body = json!({
        "status": "ok",
        "service": "kiro-sidecar",
        "protocol_version": 1,
        "instance_id": state.config.instance_id,
        "transport_profile": state.config.transport_profile,
    });

    let mut response = axum::Json(body).into_response();
    let hdrs = response.headers_mut();
    hdrs.insert(
        H_PROTOCOL_VERSION,
        HeaderValue::from_static(PROTOCOL_VERSION),
    );
    hdrs.insert(H_RESPONSE_SOURCE, HeaderValue::from_static("sidecar"));
    Ok(response)
}
