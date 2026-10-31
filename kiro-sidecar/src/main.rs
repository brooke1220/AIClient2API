use std::net::SocketAddr;

use axum::{routing::get, Json, Router};
use serde_json::json;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("kiro_sidecar=info".parse().unwrap()),
        )
        .with_target(false)
        .with_writer(std::io::stdout)
        .init();

    let port: u16 = std::env::var("KIRO_SIDECAR_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(9091);

    let app = Router::new().route("/health", get(health));

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("[Kiro-Sidecar] Listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "kiro-sidecar",
        "protocol_version": 1
    }))
}
