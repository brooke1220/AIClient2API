mod client;
mod config;
mod health;
mod lifecycle;
mod protocol;
mod proxy;

use std::future::IntoFuture;
use std::io::Read;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::routing::{get, post};
use axum::Router;
use tokio::signal;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

use client::ClientCache;
use config::Config;
use lifecycle::ResourceBudget;
use proxy::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("kiro_sidecar=info".parse().unwrap()),
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
        client_cache: ClientCache::new(&config),
        budget: ResourceBudget::new(config.max_inflight, config.max_buffer_bytes),
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
    let shutdown = CancellationToken::new();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown.clone().cancelled_owned())
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => result.unwrap(),
        _ = shutdown_signal() => {
            shutdown.cancel();
            if tokio::time::timeout(Duration::from_secs(5), &mut server).await.is_err() {
                tracing::warn!("[Kiro-Sidecar] Drain deadline reached; cancelling remaining connections");
            }
        }
    }
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

    let parent_closed = async {
        if std::env::var("KIRO_SIDECAR_MANAGED").as_deref() != Ok("1") {
            return std::future::pending::<()>().await;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        // A plain OS thread avoids Tokio stdin's non-cancellable blocking task,
        // which could otherwise prevent runtime shutdown while stdin stays open.
        std::thread::spawn(move || {
            let mut input = std::io::stdin().lock();
            let mut buf = [0u8; 256];
            loop {
                match input.read(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = tx.send(());
        });
        let _ = rx.await;
    };

    tokio::select! {
        _ = ctrl_c => {
            tracing::info!("[Kiro-Sidecar] Received SIGINT, shutting down");
        }
        _ = terminate => {
            tracing::info!("[Kiro-Sidecar] Received SIGTERM, shutting down");
        }
        _ = parent_closed => {
            tracing::info!("[Kiro-Sidecar] Parent pipe closed, shutting down");
        }
    }
}
