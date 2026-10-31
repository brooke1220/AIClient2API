mod client;
mod config;
mod health;
mod lifecycle;
mod protocol;
mod proxy;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tokio::signal;
use tracing_subscriber::EnvFilter;

use config::Config;
use proxy::AppState;

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

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Configuration error: {e}");
            std::process::exit(1);
        }
    };

    let port = config.port;
    let profile = config.transport_profile.clone();
    let instance_id = config.instance_id.clone();

    let state = Arc::new(AppState {
        config: Arc::new(config),
    });

    let app = Router::new()
        .route("/health", get(health::health))
        .route("/stream", post(proxy::stream_handler))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!(
        "[Kiro-Sidecar] Listening on {addr} | profile={profile} | instance={instance_id}"
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

/// Wait for SIGTERM or SIGINT (Ctrl-C) to trigger graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            tracing::info!("[Kiro-Sidecar] Received SIGINT, shutting down");
        }
        _ = terminate => {
            tracing::info!("[Kiro-Sidecar] Received SIGTERM, shutting down");
        }
    }
}
