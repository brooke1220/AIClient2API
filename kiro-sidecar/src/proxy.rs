use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::client::ClientCache;
use crate::config::Config;
use crate::lifecycle::ResourceBudget;

/// Shared application state available to all handlers.
#[derive(Debug)]
pub struct AppState {
    pub config: Arc<Config>,
    pub client_cache: ClientCache,
    pub budget: Arc<ResourceBudget>,
}

/// Stub proxy/stream handler — returns 501 Not Implemented.
///
/// TODO(task-2): Implement the full streaming proxy handler.
pub async fn stream_handler(
    State(_state): State<Arc<AppState>>,
) -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "not implemented")
}
