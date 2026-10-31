use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::config::Config;

/// Shared application state available to all handlers.
#[derive(Debug)]
pub struct AppState {
    pub config: Arc<Config>,
}

/// Stub proxy/stream handler — returns 501 Not Implemented.
///
/// TODO(task-2): Implement the full streaming proxy handler.
pub async fn stream_handler(
    State(_state): State<Arc<AppState>>,
) -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "not implemented")
}
