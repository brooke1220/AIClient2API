use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::json;

use crate::proxy::AppState;

/// Health check handler.
///
/// Returns service status, name, and protocol version.
pub async fn health(State(_state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "kiro-sidecar",
        "protocol_version": 1
    }))
}
