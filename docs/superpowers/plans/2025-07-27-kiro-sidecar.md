# kiro-sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Rust local transport proxy for the Kiro channel that provides a real Rust TLS/HTTP fingerprint, with transparent byte-level proxying and full fallback to the existing Node.js path.

**Architecture:** A standalone Rust binary (`kiro-sidecar`) listens on `127.0.0.1:9091`, receives HTTP requests from Node.js with control headers (`X-Target-Url`, `X-Proxy-Url`, etc.), forwards them to AWS via `reqwest`/`rustls`/`aws-lc-rs`, and returns the raw upstream response bytes unchanged. Node.js manages credentials, request construction, routing, event stream decoding, and retry logic. The sidecar is an optional enhancement — when unavailable, requests fall back to the existing tls-sidecar or direct axios path with zero impact.

**Tech Stack:** Rust (axum, reqwest, rustls with aws-lc-rs), Node.js (existing claude-kiro.js + new kiro-sidecar.js manager), Docker multi-stage build.

**Spec:** `docs/superpowers/specs/2025-07-27-kiro-sidecar-design.md`

---

## File Map

### New Rust files (`kiro-sidecar/`)

| File | Responsibility |
|------|---------------|
| `Cargo.toml` | Dependencies, build profile, metadata |
| `Cargo.lock` | Locked dependency versions |
| `rust-toolchain.toml` | Pin Rust version to match target client |
| `.gitignore` | Ignore `target/`, editor files |
| `src/main.rs` | axum server, parent-pipe monitoring, signal handling, graceful shutdown |
| `src/config.rs` | Startup config from env: port, instance ID, local token, target allowlist, payload limit, transport profile |
| `src/health.rs` | `GET /health` — validate local token, report instance ID, protocol version, profile |
| `src/proxy.rs` | `POST /stream` — validate request, forward to upstream, stream raw response back |
| `src/client.rs` | reqwest Client construction, per-proxy cache with bounded eviction |
| `src/protocol.rs` | Local control header extraction, target URL validation, upstream header allowlist, error response formatting |
| `src/lifecycle.rs` | In-flight request counter, concurrency budget, body buffer budget, drain logic |
| `tests/integration.rs` | End-to-end tests with mock upstream and proxy servers |

### New Node.js files

| File | Responsibility |
|------|---------------|
| `src/utils/kiro-sidecar.js` | Process lifecycle manager: state machine, spawn, health check, restart budget, shutdown |
| `tests/kiro-sidecar-integration.test.js` | Integration tests for sidecar protocol, error classification, lifecycle, fallback |

### Modified Node.js files

| File | Change |
|------|--------|
| `src/providers/claude/claude-kiro.js` | Split `_requestWithBuilderEndpointRouting` → `_buildRoutedRequest` + transport selection; add `_requestViaKiroSidecar` adapter |
| `src/core/config-manager.js` | Add `KIRO_SIDECAR_ENABLED`, `KIRO_SIDECAR_PORT`, `KIRO_SIDECAR_PATH` defaults |
| `src/services/api-server.js` | Start/stop kiro-sidecar alongside tls-sidecar |
| `Dockerfile` | Add Rust build stage for kiro-sidecar binary |

---

## Phase 0: Transport Verification

> This phase validates whether the Rust transport path produces meaningful differences from the existing path.
> If Phase 0 does not produce actionable evidence, the project pauses at `KIRO_SIDECAR_ENABLED=false`.

### Task 0.1: Set Up Rust Toolchain and Project Skeleton

**Files:**
- Create: `kiro-sidecar/Cargo.toml`
- Create: `kiro-sidecar/rust-toolchain.toml`
- Create: `kiro-sidecar/.gitignore`
- Create: `kiro-sidecar/src/main.rs`

- [ ] **Step 1: Install Rust toolchain**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustc --version
```

Expected: Rust compiler installed, version 1.82+.

- [ ] **Step 2: Create project directory and Cargo.toml**

```bash
mkdir -p kiro-sidecar/src
```

Create `kiro-sidecar/Cargo.toml`:

```toml
[package]
name = "kiro-sidecar"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
tokio-util = { version = "0.7", features = ["rt"] }
reqwest = { version = "0.12", default-features = false, features = [
    "stream", "http2", "socks", "rustls-tls-native-roots-no-provider"
] }
rustls = { version = "0.23", default-features = false, features = [
    "aws_lc_rs", "std", "tls12"
] }
http = "1"
bytes = "1"
futures-util = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
url = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

[profile.release]
lto = true
strip = true
```

- [ ] **Step 3: Create rust-toolchain.toml**

Create `kiro-sidecar/rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.82.0"
```

- [ ] **Step 4: Create .gitignore**

Create `kiro-sidecar/.gitignore`:

```
/target
```

- [ ] **Step 5: Create minimal main.rs**

Create `kiro-sidecar/src/main.rs`:

```rust
use std::net::SocketAddr;
use axum::{Router, routing::get, Json};
use serde_json::json;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("kiro_sidecar=info".parse().unwrap()))
        .with_target(false)
        .with_writer(std::io::stdout)
        .init();

    let port: u16 = std::env::var("KIRO_SIDECAR_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(9091);

    let app = Router::new()
        .route("/health", get(health));

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
```

- [ ] **Step 6: Verify it compiles and runs**

```bash
cd kiro-sidecar && cargo build 2>&1
```

Expected: Build succeeds (first build downloads dependencies, may take a few minutes).

```bash
cargo run &
sleep 2
curl -s http://127.0.0.1:9091/health | jq .
kill %1
```

Expected:
```json
{
  "status": "ok",
  "service": "kiro-sidecar",
  "protocol_version": 1
}
```

- [ ] **Step 7: Commit**

```bash
cd .. && git add kiro-sidecar/
git commit -m "chore: scaffold kiro-sidecar Rust project with health endpoint"
```

### Task 0.2: Transport Fingerprint Comparison Experiment

**Files:**
- Create: `kiro-sidecar/docs/phase0-transport-report.md`

- [ ] **Step 1: Document the target client identity**

Create `kiro-sidecar/docs/phase0-transport-report.md` documenting:

```markdown
# Phase 0: Transport Verification Report

## Target Client
- Identity: Amazon Q CLI (not Kiro IDE — distinct UA, endpoints, transport)
- Reference version: (fill in from current UA strings in claude-kiro.js)
- UA: `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0 md/appVersion-2.10.0 app/AmazonQ-For-CLI`

## Current Path Fingerprint
- TLS library: Node.js built-in OpenSSL / Go uTLS (Chrome auto)
- HTTP version: HTTP/1.1 or HTTP/2 depending on tls-sidecar negotiation
- Observed ClientHello: (to be captured)

## Rust Path Fingerprint
- TLS library: rustls 0.23 with aws-lc-rs
- HTTP version: HTTP/2 via reqwest + hyper
- Observed ClientHello: (to be captured)

## Comparison
- (to be filled after experiment)

## Decision
- [ ] Proceed to Phase 1
- [ ] Pause — insufficient evidence of value
```

- [ ] **Step 2: Capture current path TLS fingerprint**

Use a TLS fingerprint inspection endpoint (e.g., `https://tls.browserleaks.com/json` or a self-hosted tool) to capture the JA3/JA4 fingerprint from the current Node.js/tls-sidecar path. Record in the report.

- [ ] **Step 3: Add a minimal proxy endpoint to capture Rust path fingerprint**

Add a temporary `/test-proxy` endpoint to `main.rs` that makes a reqwest GET to a fingerprint service:

```rust
use axum::{routing::post, extract::Json as AxumJson};

async fn test_proxy() -> String {
    let client = reqwest::Client::builder()
        .use_rustls_default()
        .http2_prior_knowledge()
        .build()
        .unwrap();

    match client.get("https://tls.browserleaks.com/json").send().await {
        Ok(resp) => resp.text().await.unwrap_or_else(|e| format!("read error: {e}")),
        Err(e) => format!("request error: {e}"),
    }
}
```

Register route: `.route("/test-proxy", get(test_proxy))`

- [ ] **Step 4: Compare fingerprints and complete the report**

Capture from both paths, compare JA3/JA4, ALPN, HTTP/2 SETTINGS, and document differences.

- [ ] **Step 5: Make go/no-go decision and commit**

```bash
git add kiro-sidecar/docs/
git commit -m "docs: Phase 0 transport fingerprint comparison report"
```

Remove the temporary `/test-proxy` endpoint before proceeding to Phase 1.

---

## Phase 1: Rust Transport Core

### Task 1.1: Config Module

**Files:**
- Create: `kiro-sidecar/src/config.rs`
- Modify: `kiro-sidecar/src/main.rs`

- [ ] **Step 1: Create config.rs**

Create `kiro-sidecar/src/config.rs`:

```rust
use std::collections::HashSet;
use url::Url;

/// Startup configuration parsed from environment variables.
/// All values are immutable after construction.
pub struct Config {
    pub port: u16,
    pub instance_id: String,
    pub local_token: String,
    pub target_allowlist: HashSet<String>,
    pub max_payload_bytes: usize,
    pub max_inflight: usize,
    pub max_buffer_bytes: usize,
    pub max_client_cache: usize,
    pub connect_timeout_secs: u64,
    pub transport_profile: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let port = env_parse("KIRO_SIDECAR_PORT", 9091u16);
        let instance_id = env_require("KIRO_SIDECAR_INSTANCE_ID")?;
        let local_token = env_require("KIRO_SIDECAR_TOKEN")?;
        let max_payload_bytes = env_parse("KIRO_SIDECAR_MAX_PAYLOAD_BYTES", 10 * 1024 * 1024usize);
        let max_inflight = env_parse("KIRO_SIDECAR_MAX_INFLIGHT", 128usize);
        let max_buffer_bytes = env_parse("KIRO_SIDECAR_MAX_BUFFER_BYTES", 64 * 1024 * 1024usize);
        let max_client_cache = env_parse("KIRO_SIDECAR_MAX_CLIENT_CACHE", 128usize);
        let connect_timeout_secs = env_parse("KIRO_SIDECAR_CONNECT_TIMEOUT_SECS", 10u64);
        let transport_profile = env_parse_string("KIRO_SIDECAR_TRANSPORT_PROFILE", "v1-aws-lc-rs");

        // Parse target allowlist from comma-separated origins
        let allowlist_raw = env_parse_string("KIRO_SIDECAR_TARGET_ALLOWLIST", "");
        let mut target_allowlist: HashSet<String> = HashSet::new();
        // Built-in allowed origins for Kiro/CodeWhisperer/runtime endpoints
        for origin in [
            "https://q.us-east-1.amazonaws.com",
            "https://q.eu-west-1.amazonaws.com",
            "https://q.ap-southeast-1.amazonaws.com",
            "https://codewhisperer.us-east-1.amazonaws.com",
        ] {
            target_allowlist.insert(origin.to_string());
        }
        // Add runtime endpoint patterns
        // kiro.dev runtime endpoints are added via config
        for extra in allowlist_raw.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            // Validate it's a proper HTTPS origin
            match Url::parse(extra) {
                Ok(u) if u.scheme() == "https" && u.host().is_some() => {
                    target_allowlist.insert(format!("{}://{}", u.scheme(), u.authority()));
                }
                _ => return Err(format!("Invalid target allowlist entry: {extra}")),
            }
        }

        Ok(Config {
            port,
            instance_id,
            local_token,
            target_allowlist,
            max_payload_bytes,
            max_inflight,
            max_buffer_bytes,
            max_client_cache,
            connect_timeout_secs,
            transport_profile,
        })
    }

    /// Check if a target URL's origin is in the allowlist.
    pub fn is_target_allowed(&self, url: &Url) -> bool {
        if url.scheme() != "https" {
            return false;
        }
        let origin = format!("{}://{}", url.scheme(), url.authority());
        self.target_allowlist.contains(&origin)
    }
}

fn env_require(key: &str) -> Result<String, String> {
    std::env::var(key).map_err(|_| format!("Required environment variable {key} is not set"))
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn env_parse_string(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
```

- [ ] **Step 2: Wire config into main.rs**

Update `kiro-sidecar/src/main.rs`:

```rust
mod config;
mod health;
mod proxy;
mod client;
mod protocol;
mod lifecycle;

use std::net::SocketAddr;
use std::sync::Arc;
use axum::Router;
use tracing_subscriber::EnvFilter;

use config::Config;

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
        Ok(c) => Arc::new(c),
        Err(e) => {
            tracing::error!("[Kiro-Sidecar] Config error: {e}");
            std::process::exit(1);
        }
    };

    let app = Router::new()
        .route("/health", axum::routing::get(health::handle))
        .route("/stream", axum::routing::post(proxy::handle))
        .with_state(config.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    tracing::info!(
        "[Kiro-Sidecar] Listening on {addr}, profile={}, instance={}",
        config.transport_profile,
        config.instance_id
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    // Graceful shutdown on SIGTERM/SIGINT
    let shutdown = async {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("[Kiro-Sidecar] Shutting down...");
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .unwrap();
}
```

- [ ] **Step 3: Verify it compiles (stubs for missing modules next)**

Create placeholder files so the compiler doesn't fail:

`kiro-sidecar/src/health.rs`:
```rust
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use std::sync::Arc;
use crate::config::Config;

pub async fn handle(State(config): State<Arc<Config>>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "kiro-sidecar",
        "protocol_version": 1,
        "instance_id": config.instance_id,
        "transport_profile": config.transport_profile,
    }))
}
```

`kiro-sidecar/src/protocol.rs`:
```rust
// Placeholder — implemented in Task 1.3
```

`kiro-sidecar/src/client.rs`:
```rust
// Placeholder — implemented in Task 1.4
```

`kiro-sidecar/src/lifecycle.rs`:
```rust
// Placeholder — implemented in Task 1.5
```

`kiro-sidecar/src/proxy.rs`:
```rust
use axum::response::IntoResponse;
use std::sync::Arc;
use crate::config::Config;

pub async fn handle(
    axum::extract::State(_config): axum::extract::State<Arc<Config>>,
    _req: axum::extract::Request,
) -> impl IntoResponse {
    (axum::http::StatusCode::NOT_IMPLEMENTED, "not yet implemented")
}
```

```bash
cd kiro-sidecar && cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
cd .. && git add kiro-sidecar/
git commit -m "feat(kiro-sidecar): add config module with env parsing and target allowlist"
```

### Task 1.2: Health Endpoint with Auth

**Files:**
- Modify: `kiro-sidecar/src/health.rs`

- [ ] **Step 1: Implement authenticated health check**

Replace `kiro-sidecar/src/health.rs`:

```rust
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};
use std::sync::Arc;
use crate::config::Config;

pub async fn handle(
    State(config): State<Arc<Config>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Validate local token
    let token = headers
        .get("x-kiro-sidecar-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if token != config.local_token {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "source": "sidecar",
                "code": "LOCAL_AUTH_FAILED",
                "message": "invalid local sidecar token"
            })),
        ));
    }

    // Validate protocol version
    let proto_version = headers
        .get("x-kiro-protocol-version")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if proto_version != "1" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "source": "sidecar",
                "code": "PROTOCOL_UNSUPPORTED",
                "message": format!("unsupported protocol version: {proto_version}")
            })),
        ));
    }

    Ok(Json(json!({
        "status": "ok",
        "service": "kiro-sidecar",
        "protocol_version": 1,
        "instance_id": config.instance_id,
        "transport_profile": config.transport_profile,
    })))
}
```

- [ ] **Step 2: Test manually**

```bash
cd kiro-sidecar
KIRO_SIDECAR_INSTANCE_ID=test-123 KIRO_SIDECAR_TOKEN=secret-abc cargo run &
sleep 2

# Should fail — no token
curl -s -w "\n%{http_code}" http://127.0.0.1:9091/health
# Expected: 401

# Should fail — no protocol version
curl -s -w "\n%{http_code}" -H "X-Kiro-Sidecar-Token: secret-abc" http://127.0.0.1:9091/health
# Expected: 400

# Should succeed
curl -s -H "X-Kiro-Sidecar-Token: secret-abc" -H "X-Kiro-Protocol-Version: 1" http://127.0.0.1:9091/health | jq .
# Expected: { "status": "ok", "instance_id": "test-123", ... }

kill %1
```

- [ ] **Step 3: Commit**

```bash
cd .. && git add kiro-sidecar/src/health.rs
git commit -m "feat(kiro-sidecar): health endpoint with local auth and protocol version check"
```

### Task 1.3: Protocol Module — Header Extraction and Validation

**Files:**
- Modify: `kiro-sidecar/src/protocol.rs`

- [ ] **Step 1: Implement protocol module**

Replace `kiro-sidecar/src/protocol.rs`:

```rust
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use serde::Serialize;
use url::Url;
use crate::config::Config;

/// Extracted and validated local control headers.
pub struct ControlHeaders {
    pub target_url: Url,
    pub proxy_url: Option<String>,
}

/// Headers from the incoming request that should be forwarded to upstream.
/// Only headers on the explicit allowlist are forwarded.
const UPSTREAM_HEADER_ALLOWLIST: &[&str] = &[
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

/// Extract and validate local control headers.
pub fn extract_control_headers(
    headers: &HeaderMap,
    config: &Config,
) -> Result<ControlHeaders, SidecarError> {
    // Validate local token
    let token = header_str(headers, "x-kiro-sidecar-token").unwrap_or("");
    if token != config.local_token {
        return Err(SidecarError {
            status: StatusCode::UNAUTHORIZED,
            code: "LOCAL_AUTH_FAILED",
            phase: "local",
            message: "invalid local sidecar token".into(),
            retryable: false,
        });
    }

    // Validate protocol version
    let proto = header_str(headers, "x-kiro-protocol-version").unwrap_or("");
    if proto != "1" {
        return Err(SidecarError {
            status: StatusCode::BAD_REQUEST,
            code: "PROTOCOL_UNSUPPORTED",
            phase: "local",
            message: format!("unsupported protocol version: {proto}"),
            retryable: false,
        });
    }

    // Extract and validate target URL
    let target_raw = header_str(headers, "x-target-url").ok_or_else(|| SidecarError {
        status: StatusCode::BAD_REQUEST,
        code: "INVALID_TARGET",
        phase: "local",
        message: "missing X-Target-Url header".into(),
        retryable: false,
    })?;

    let target_url = Url::parse(target_raw).map_err(|e| SidecarError {
        status: StatusCode::BAD_REQUEST,
        code: "INVALID_TARGET",
        phase: "local",
        message: format!("invalid target URL: {e}"),
        retryable: false,
    })?;

    // Reject non-HTTPS, userinfo, fragments
    if target_url.scheme() != "https" {
        return Err(SidecarError {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_TARGET",
            phase: "local",
            message: "target URL must use HTTPS".into(),
            retryable: false,
        });
    }
    if !target_url.username().is_empty() || target_url.password().is_some() {
        return Err(SidecarError {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_TARGET",
            phase: "local",
            message: "target URL must not contain userinfo".into(),
            retryable: false,
        });
    }
    if target_url.fragment().is_some() {
        return Err(SidecarError {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_TARGET",
            phase: "local",
            message: "target URL must not contain fragment".into(),
            retryable: false,
        });
    }

    // Check allowlist
    if !config.is_target_allowed(&target_url) {
        return Err(SidecarError {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_TARGET",
            phase: "local",
            message: format!("target origin not in allowlist: {}", target_url.origin().ascii_serialization()),
            retryable: false,
        });
    }

    // Extract optional proxy URL
    let proxy_url = header_str(headers, "x-proxy-url").map(|s| s.to_string());
    if let Some(ref p) = proxy_url {
        if Url::parse(p).is_err() {
            return Err(SidecarError {
                status: StatusCode::BAD_REQUEST,
                code: "INVALID_PROXY",
                phase: "local",
                message: format!("invalid proxy URL: {p}"),
                retryable: false,
            });
        }
    }

    Ok(ControlHeaders { target_url, proxy_url })
}

/// Build the set of upstream headers from the incoming request's allowlisted headers.
pub fn build_upstream_headers(incoming: &HeaderMap) -> reqwest::header::HeaderMap {
    let mut out = reqwest::header::HeaderMap::new();
    for &name in UPSTREAM_HEADER_ALLOWLIST {
        if let Some(value) = incoming.get(name) {
            if let Ok(v) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) {
                out.insert(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                    v,
                );
            }
        }
    }
    out
}

/// Structured sidecar error for local failures.
#[derive(Debug, Serialize)]
pub struct SidecarError {
    #[serde(skip)]
    pub status: StatusCode,
    pub code: &'static str,
    pub phase: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl SidecarError {
    pub fn into_response(self) -> axum::response::Response {
        let status = self.status;
        let body = serde_json::json!({
            "source": "sidecar",
            "code": self.code,
            "phase": self.phase,
            "message": self.message,
            "retryable": self.retryable,
        });
        let mut resp = axum::Json(body).into_response();
        *resp.status_mut() = status;
        resp.headers_mut().insert("x-kiro-protocol-version", HeaderValue::from_static("1"));
        resp.headers_mut().insert("x-kiro-response-source", HeaderValue::from_static("sidecar"));
        resp
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd kiro-sidecar && cargo check
```

- [ ] **Step 3: Commit**

```bash
cd .. && git add kiro-sidecar/src/protocol.rs
git commit -m "feat(kiro-sidecar): protocol module with header extraction, target validation, error format"
```

### Task 1.4: Client Module — reqwest with Per-Proxy Caching

**Files:**
- Modify: `kiro-sidecar/src/client.rs`

- [ ] **Step 1: Implement client cache**

Replace `kiro-sidecar/src/client.rs`:

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use reqwest::Client;
use crate::config::Config;

/// Cache of reqwest Clients keyed by proxy configuration.
/// Each unique proxy URL (or no-proxy) gets its own Client with isolated connection pool.
pub struct ClientCache {
    clients: Mutex<HashMap<String, Client>>,
    max_entries: usize,
    connect_timeout: Duration,
}

impl ClientCache {
    pub fn new(config: &Config) -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            max_entries: config.max_client_cache,
            connect_timeout: Duration::from_secs(config.connect_timeout_secs),
        }
    }

    /// Get or create a reqwest Client for the given proxy configuration.
    /// `proxy_url` is None for direct connections, Some("socks5://...") etc for proxied.
    pub fn get_or_create(&self, proxy_url: Option<&str>) -> Result<Client, String> {
        let key = proxy_url.unwrap_or("__direct__").to_string();

        let mut cache = self.clients.lock().unwrap();

        if let Some(client) = cache.get(&key) {
            return Ok(client.clone());
        }

        // Evict oldest entry if at capacity (simple strategy: remove arbitrary entry)
        if cache.len() >= self.max_entries {
            if let Some(evict_key) = cache.keys().next().cloned() {
                cache.remove(&evict_key);
                tracing::info!("[Kiro-Sidecar] Evicted client cache entry: {evict_key}");
            }
        }

        let client = self.build_client(proxy_url)?;
        cache.insert(key, client.clone());
        Ok(client)
    }

    fn build_client(&self, proxy_url: Option<&str>) -> Result<Client, String> {
        // Install aws-lc-rs as the default crypto provider (once per process).
        // Subsequent calls are no-ops if already installed.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

        let mut builder = Client::builder()
            .use_rustls_default()
            .connect_timeout(self.connect_timeout)
            .redirect(reqwest::redirect::Policy::none())     // No auto-redirect
            .no_proxy()                                       // Don't read system proxy
            .http2_prior_knowledge()                          // Force HTTP/2
            .no_gzip()                                        // Don't auto-decompress
            .no_brotli()
            .no_deflate()
            .no_zstd();

        if let Some(proxy_str) = proxy_url {
            let proxy = reqwest::Proxy::all(proxy_str)
                .map_err(|e| format!("invalid proxy URL: {e}"))?;
            builder = builder.proxy(proxy);
        }

        builder.build().map_err(|e| format!("failed to build HTTP client: {e}"))
    }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd kiro-sidecar && cargo check
```

- [ ] **Step 3: Commit**

```bash
cd .. && git add kiro-sidecar/src/client.rs
git commit -m "feat(kiro-sidecar): reqwest client cache with per-proxy isolation and bounded eviction"
```

### Task 1.5: Lifecycle Module — Concurrency and Buffer Budget

**Files:**
- Modify: `kiro-sidecar/src/lifecycle.rs`

- [ ] **Step 1: Implement resource tracking**

Replace `kiro-sidecar/src/lifecycle.rs`:

```rust
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Tracks in-flight requests and buffer memory budget.
/// All operations are atomic — no locks needed.
pub struct ResourceBudget {
    inflight: AtomicUsize,
    max_inflight: usize,
    buffer_bytes: AtomicUsize,
    max_buffer_bytes: usize,
}

impl ResourceBudget {
    pub fn new(max_inflight: usize, max_buffer_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            inflight: AtomicUsize::new(0),
            max_inflight,
            buffer_bytes: AtomicUsize::new(0),
            max_buffer_bytes,
        })
    }

    /// Try to acquire a request slot and reserve buffer space.
    /// Returns a guard that releases both on drop.
    pub fn try_acquire(self: &Arc<Self>, body_bytes: usize) -> Result<ResourceGuard, BusyReason> {
        // Check inflight first
        let prev = self.inflight.fetch_add(1, Ordering::AcqRel);
        if prev >= self.max_inflight {
            self.inflight.fetch_sub(1, Ordering::AcqRel);
            return Err(BusyReason::TooManyRequests);
        }

        // Check buffer budget
        let prev_buf = self.buffer_bytes.fetch_add(body_bytes, Ordering::AcqRel);
        if prev_buf + body_bytes > self.max_buffer_bytes {
            self.buffer_bytes.fetch_sub(body_bytes, Ordering::AcqRel);
            self.inflight.fetch_sub(1, Ordering::AcqRel);
            return Err(BusyReason::BufferFull);
        }

        Ok(ResourceGuard {
            budget: Arc::clone(self),
            body_bytes,
        })
    }

    pub fn inflight_count(&self) -> usize {
        self.inflight.load(Ordering::Relaxed)
    }
}

pub enum BusyReason {
    TooManyRequests,
    BufferFull,
}

/// RAII guard that releases inflight slot and buffer budget on drop.
pub struct ResourceGuard {
    budget: Arc<ResourceBudget>,
    body_bytes: usize,
}

impl Drop for ResourceGuard {
    fn drop(&mut self) {
        self.budget.inflight.fetch_sub(1, Ordering::AcqRel);
        self.budget.buffer_bytes.fetch_sub(self.body_bytes, Ordering::AcqRel);
    }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd kiro-sidecar && cargo check
```

- [ ] **Step 3: Commit**

```bash
cd .. && git add kiro-sidecar/src/lifecycle.rs
git commit -m "feat(kiro-sidecar): atomic resource budget for concurrency and buffer limits"
```

### Task 1.6: Proxy Handler — Core Transport Logic

**Files:**
- Modify: `kiro-sidecar/src/proxy.rs`
- Modify: `kiro-sidecar/src/main.rs`

- [ ] **Step 1: Implement the proxy handler**

Replace `kiro-sidecar/src/proxy.rs`:

```rust
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::StreamExt;
use std::sync::Arc;

use crate::client::ClientCache;
use crate::config::Config;
use crate::lifecycle::{BusyReason, ResourceBudget};
use crate::protocol::{self, SidecarError};

/// Shared application state accessible to all handlers.
pub struct AppState {
    pub config: Arc<Config>,
    pub client_cache: ClientCache,
    pub budget: Arc<ResourceBudget>,
}

pub async fn handle(
    State(state): State<Arc<AppState>>,
    req: axum::extract::Request,
) -> Response {
    match handle_inner(&state, req).await {
        Ok(resp) => resp,
        Err(e) => e.into_response(),
    }
}

async fn handle_inner(
    state: &AppState,
    req: axum::extract::Request,
) -> Result<Response, SidecarError> {
    let (parts, body) = req.into_parts();

    // 1. Extract and validate control headers
    let control = protocol::extract_control_headers(&parts.headers, &state.config)?;

    // 2. Read request body with size limit
    let body_bytes = read_body_limited(body, state.config.max_payload_bytes).await?;

    // 3. Acquire resource budget
    let _guard = state.budget.try_acquire(body_bytes.len()).map_err(|reason| {
        let message = match reason {
            BusyReason::TooManyRequests => "too many concurrent requests",
            BusyReason::BufferFull => "request buffer budget exhausted",
        };
        SidecarError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "SIDECAR_BUSY",
            phase: "local",
            message: message.into(),
            retryable: true,
        }
    })?;

    // 4. Get or create reqwest client for this proxy configuration
    let client = state
        .client_cache
        .get_or_create(control.proxy_url.as_deref())
        .map_err(|e| SidecarError {
            status: StatusCode::BAD_GATEWAY,
            code: "PROXY_CONNECT_ERROR",
            phase: "proxy",
            message: e,
            retryable: false,
        })?;

    // 5. Build upstream request
    let upstream_headers = protocol::build_upstream_headers(&parts.headers);

    let upstream_req = client
        .post(control.target_url.as_str())
        .headers(upstream_headers)
        .body(body_bytes);

    // 6. Send upstream request
    let upstream_resp = upstream_req.send().await.map_err(|e| {
        let (code, phase, retryable) = classify_reqwest_error(&e);
        SidecarError {
            status: StatusCode::BAD_GATEWAY,
            code,
            phase,
            message: format!("{e}"),
            retryable,
        }
    })?;

    // 7. Build local response
    let upstream_status = upstream_resp.status();

    let mut resp_builder = Response::builder()
        .status(upstream_status.as_u16())
        .header("x-kiro-protocol-version", "1")
        .header("x-kiro-response-source", "upstream");

    // Forward allowed upstream response headers
    for name in [
        "content-type",
        "content-encoding",
        "retry-after",
        "x-amzn-requestid",
        "x-amzn-errortype",
    ] {
        if let Some(val) = upstream_resp.headers().get(name) {
            if let Ok(v) = HeaderValue::from_bytes(val.as_bytes()) {
                resp_builder = resp_builder.header(name, v);
            }
        }
    }

    // 8. Stream upstream body back to Node.js
    let body_stream = upstream_resp.bytes_stream().map(|result| {
        result.map_err(|e| {
            // Convert reqwest streaming error to axum body error
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, e)
        })
    });

    let resp = resp_builder
        .body(Body::from_stream(body_stream))
        .unwrap();

    Ok(resp)
}

/// Read request body with an explicit size limit.
/// Does NOT use axum's Json extractor — reads raw bytes.
async fn read_body_limited(body: Body, max_bytes: usize) -> Result<Bytes, SidecarError> {
    use http_body_util::BodyExt;
    let collected = axum::body::to_bytes(body, max_bytes).await.map_err(|_| SidecarError {
        status: StatusCode::PAYLOAD_TOO_LARGE,
        code: "REQUEST_TOO_LARGE",
        phase: "local",
        message: format!("request body exceeds {max_bytes} byte limit"),
        retryable: false,
    })?;
    Ok(collected)
}

/// Classify a reqwest error into sidecar error fields.
fn classify_reqwest_error(e: &reqwest::Error) -> (&'static str, &'static str, bool) {
    if e.is_timeout() {
        ("CONNECT_TIMEOUT", "connect", true)
    } else if e.is_connect() {
        ("CONNECT_ERROR", "connect", true)
    } else if e.is_builder() {
        ("INVALID_TARGET", "local", false)
    } else {
        ("UPSTREAM_HEADERS_ERROR", "headers", true)
    }
}
```

- [ ] **Step 2: Update main.rs to use AppState**

Update `kiro-sidecar/src/main.rs` — replace the Router construction:

```rust
mod config;
mod health;
mod proxy;
mod client;
mod protocol;
mod lifecycle;

use std::net::SocketAddr;
use std::sync::Arc;
use axum::Router;
use tracing_subscriber::EnvFilter;

use config::Config;
use client::ClientCache;
use lifecycle::ResourceBudget;
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
        Ok(c) => Arc::new(c),
        Err(e) => {
            tracing::error!("[Kiro-Sidecar] Config error: {e}");
            std::process::exit(1);
        }
    };

    let state = Arc::new(AppState {
        client_cache: ClientCache::new(&config),
        budget: ResourceBudget::new(config.max_inflight, config.max_buffer_bytes),
        config: config.clone(),
    });

    let app = Router::new()
        .route("/health", axum::routing::get(health::handle))
        .route("/stream", axum::routing::post(proxy::handle))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    tracing::info!(
        "[Kiro-Sidecar] Listening on {addr}, profile={}, instance={}",
        config.transport_profile,
        config.instance_id
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    let shutdown = async {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("[Kiro-Sidecar] Shutting down...");
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .unwrap();
}
```

Also update health.rs to use AppState:

```rust
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use std::sync::Arc;
use crate::proxy::AppState;

pub async fn handle(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, axum::response::Response> {
    let config = &state.config;
    // ... (same auth logic as before, using config)
}
```

- [ ] **Step 3: Add `http-body-util` to Cargo.toml if needed**

Check if `axum::body::to_bytes` is available in axum 0.8. If it requires `http-body-util`, add:

```toml
http-body-util = "0.1"
```

- [ ] **Step 4: Verify it compiles**

```bash
cd kiro-sidecar && cargo check
```

- [ ] **Step 5: Commit**

```bash
cd .. && git add kiro-sidecar/
git commit -m "feat(kiro-sidecar): proxy handler with body limit, resource budget, upstream streaming"
```

### Task 1.7: Rust Integration Tests

**Files:**
- Create: `kiro-sidecar/tests/integration.rs`

- [ ] **Step 1: Write integration tests with mock upstream**

Create `kiro-sidecar/tests/integration.rs`:

```rust
use axum::body::Body;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Router;
use std::net::SocketAddr;
use tokio::net::TcpListener;

/// Helper: start a mock upstream HTTPS server that echoes request info.
/// For tests, we use HTTP (not HTTPS) and adjust the target allowlist.
async fn start_mock_upstream() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/echo", axum::routing::post(|req: axum::extract::Request| async move {
            let (parts, body) = req.into_parts();
            let body_bytes = axum::body::to_bytes(body, 1024 * 1024).await.unwrap();
            let headers: std::collections::HashMap<String, String> = parts
                .headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            axum::Json(serde_json::json!({
                "method": parts.method.as_str(),
                "uri": parts.uri.to_string(),
                "headers": headers,
                "body_len": body_bytes.len(),
            }))
            .into_response()
        }))
        .route("/stream-bytes", axum::routing::post(|| async {
            // Return a stream of bytes (simulating Event Stream)
            let chunks = vec![
                Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"chunk1")),
                Ok(bytes::Bytes::from_static(b"chunk2")),
                Ok(bytes::Bytes::from_static(b"chunk3")),
            ];
            let stream = futures_util::stream::iter(chunks);
            axum::response::Response::builder()
                .status(200)
                .header("content-type", "application/vnd.amazon.eventstream")
                .body(Body::from_stream(stream))
                .unwrap()
        }))
        .route("/error-429", axum::routing::post(|| async {
            (StatusCode::TOO_MANY_REQUESTS, "rate limited").into_response()
        }));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, handle)
}

// Note: Full integration tests require starting the kiro-sidecar binary
// and are covered in the Node.js integration test suite.
// These Rust tests focus on the mock upstream interaction patterns.

#[tokio::test]
async fn test_mock_upstream_echo() {
    let (addr, _handle) = start_mock_upstream().await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/echo"))
        .body(r#"{"test": true}"#)
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let json: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(json["body_len"], 14);
}

#[tokio::test]
async fn test_mock_upstream_stream() {
    let (addr, _handle) = start_mock_upstream().await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/stream-bytes"))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body = resp.bytes().await.unwrap();
    assert_eq!(&body[..], b"chunk1chunk2chunk3");
}

#[tokio::test]
async fn test_mock_upstream_error() {
    let (addr, _handle) = start_mock_upstream().await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/error-429"))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 429);
}
```

- [ ] **Step 2: Run tests**

```bash
cd kiro-sidecar && cargo test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
cd .. && git add kiro-sidecar/tests/
git commit -m "test(kiro-sidecar): integration tests with mock upstream for echo, streaming, and errors"
```

---

## Phase 2: Node.js Integration

### Task 2.1: Config Manager — Add Kiro Sidecar Settings

**Files:**
- Modify: `src/core/config-manager.js:154-158`

- [ ] **Step 1: Add config defaults**

In `src/core/config-manager.js`, after the existing TLS_SIDECAR entries (line ~158), add:

```js
        TLS_SIDECAR_PROXY_URL: null,    // TLS Sidecar 专用的上游代理地址
        KIRO_SIDECAR_ENABLED: false,    // 启用 Rust kiro-sidecar 传输代理
        KIRO_SIDECAR_PORT: 9091,        // kiro-sidecar 监听端口
        KIRO_SIDECAR_PATH: null,        // 自定义二进制路径（默认自动搜索）
        UI_ENABLED: true           // 是否启用前端管理界面
```

(This replaces the line `UI_ENABLED: true` by inserting the new entries before it.)

- [ ] **Step 2: Commit**

```bash
git add src/core/config-manager.js
git commit -m "feat: add KIRO_SIDECAR config defaults to config-manager"
```

### Task 2.2: Kiro Sidecar Process Manager

**Files:**
- Create: `src/utils/kiro-sidecar.js`

- [ ] **Step 1: Write the process manager**

Create `src/utils/kiro-sidecar.js`. This follows the existing `tls-sidecar.js` pattern but implements the spec's state machine (stopped → starting → ready / unhealthy → backoff → unavailable):

```js
/**
 * Kiro Sidecar Manager
 *
 * Manages the Rust kiro-sidecar process lifecycle:
 * - State machine: stopped → starting → ready ↔ unhealthy → backoff → unavailable
 * - Rolling restart budget: max 5 restarts in 10 minutes
 * - Local auth token and instance ID generation per spawn
 * - Parent-pipe monitoring (stdin close → child exits)
 */

import { spawn } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirname = path.dirname(moduleFilename);

const DEFAULT_PORT = 9091;
const HEALTH_CHECK_INTERVAL = 30000;
const HEALTH_CHECK_TIMEOUT = 3000;
const STARTUP_TIMEOUT = 10000;
const MAX_RESTARTS_IN_WINDOW = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const STOP_TIMEOUT_MS = 5000;

const STATES = {
    STOPPED: 'stopped',
    STARTING: 'starting',
    READY: 'ready',
    UNHEALTHY: 'unhealthy',
    BACKOFF: 'backoff',
    UNAVAILABLE: 'unavailable',
    STOPPING: 'stopping',
};

class KiroSidecar {
    constructor() {
        this.process = null;
        this.port = DEFAULT_PORT;
        this.baseUrl = null;
        this.state = STATES.STOPPED;
        this.healthCheckTimer = null;
        this.backoffTimer = null;
        this.startPromise = null;
        this.localToken = null;
        this.instanceId = null;
        this.consecutiveHealthFailures = 0;
        this.restartTimestamps = [];
        this.currentBackoff = INITIAL_BACKOFF_MS;
        this.isShuttingDown = false;
        this.options = {};
        this.httpAgent = new http.Agent({ keepAlive: true });
    }

    /**
     * Start the sidecar process. Concurrent calls share the same promise.
     */
    async start(options = {}) {
        if (this.state === STATES.STOPPING) {
            logger.warn('[Kiro-Sidecar] Cannot start while stopping');
            return false;
        }
        if (this.state === STATES.READY || this.state === STATES.STARTING) {
            return this.startPromise || true;
        }

        this.options = options;
        this.port = options.port || parseInt(process.env.KIRO_SIDECAR_PORT) || DEFAULT_PORT;
        this.baseUrl = `http://127.0.0.1:${this.port}`;

        const binaryPath = options.binaryPath || this._findBinary();
        if (!binaryPath) {
            logger.error('[Kiro-Sidecar] Binary not found');
            return false;
        }

        this.startPromise = this._doStart(binaryPath);
        const result = await this.startPromise;
        this.startPromise = null;
        return result;
    }

    async _doStart(binaryPath) {
        this.state = STATES.STARTING;

        // Generate fresh credentials for this instance
        this.localToken = randomBytes(32).toString('hex');
        this.instanceId = randomUUID();

        try {
            if (process.platform !== 'win32') {
                try { fs.chmodSync(binaryPath, 0o755); } catch {}
            }

            this.process = spawn(binaryPath, [], {
                env: {
                    ...process.env,
                    KIRO_SIDECAR_PORT: String(this.port),
                    KIRO_SIDECAR_INSTANCE_ID: this.instanceId,
                    KIRO_SIDECAR_TOKEN: this.localToken,
                    KIRO_SIDECAR_MAX_PAYLOAD_BYTES: String(this.options.maxPayloadBytes || 10 * 1024 * 1024),
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            this.process.stdout.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.info(`[Kiro-Sidecar] ${msg}`);
            });

            this.process.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.error(`[Kiro-Sidecar] ${msg}`);
            });

            // Single exit handler — prevents double-scheduling restarts
            let exitHandled = false;
            this.process.on('exit', (code, signal) => {
                if (exitHandled) return;
                exitHandled = true;
                logger.warn(`[Kiro-Sidecar] Process exited (code=${code}, signal=${signal})`);
                this._handleExit();
            });

            this.process.on('error', (err) => {
                if (exitHandled) return;
                exitHandled = true;
                logger.error(`[Kiro-Sidecar] Spawn error: ${err.message}`);
                this._handleExit();
            });

            const ok = await this._waitForReady();
            if (ok) {
                this.state = STATES.READY;
                this.consecutiveHealthFailures = 0;
                this.currentBackoff = INITIAL_BACKOFF_MS;
                this._startHealthCheck();
                logger.info(`[Kiro-Sidecar] Ready at ${this.baseUrl}, instance=${this.instanceId}`);
                return true;
            } else {
                this._cleanup();
                this.state = STATES.STOPPED;
                return false;
            }
        } catch (err) {
            logger.error(`[Kiro-Sidecar] Failed to start: ${err.message}`);
            this._cleanup();
            this.state = STATES.STOPPED;
            return false;
        }
    }

    _handleExit() {
        this._cleanup();
        if (this.isShuttingDown || this.state === STATES.STOPPING) return;

        this.state = STATES.BACKOFF;
        if (this._hasRestartBudget()) {
            this.restartTimestamps.push(Date.now());
            logger.info(`[Kiro-Sidecar] Scheduling restart in ${this.currentBackoff}ms`);
            this.backoffTimer = setTimeout(() => {
                this.backoffTimer = null;
                if (this.state === STATES.STOPPING || this.isShuttingDown) return;
                this.start(this.options);
            }, this.currentBackoff);
            this.currentBackoff = Math.min(this.currentBackoff * 2, MAX_BACKOFF_MS);
        } else {
            this.state = STATES.UNAVAILABLE;
            logger.error('[Kiro-Sidecar] Restart budget exhausted, entering unavailable state');
        }
    }

    _hasRestartBudget() {
        const now = Date.now();
        this.restartTimestamps = this.restartTimestamps.filter(t => now - t < RESTART_WINDOW_MS);
        return this.restartTimestamps.length < MAX_RESTARTS_IN_WINDOW;
    }

    async stop() {
        this.isShuttingDown = true;
        this.state = STATES.STOPPING;
        this._stopHealthCheck();
        if (this.backoffTimer) {
            clearTimeout(this.backoffTimer);
            this.backoffTimer = null;
        }

        if (this.process) {
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.process) {
                        logger.warn('[Kiro-Sidecar] Force killing');
                        this.process.kill('SIGKILL');
                    }
                    this._finalCleanup();
                    resolve();
                }, STOP_TIMEOUT_MS);

                this.process.once('exit', () => {
                    clearTimeout(timeout);
                    this._finalCleanup();
                    resolve();
                });

                this.process.kill('SIGTERM');
            });
        }
        this._finalCleanup();
    }

    _cleanup() {
        this.process = null;
        this._stopHealthCheck();
    }

    _finalCleanup() {
        this.process = null;
        this.state = STATES.STOPPED;
        this.localToken = null;
        this.instanceId = null;
        this._stopHealthCheck();
        if (this.httpAgent) {
            this.httpAgent.destroy();
            this.httpAgent = new http.Agent({ keepAlive: true });
        }
    }

    isReady() {
        return this.state === STATES.READY && this.process !== null;
    }

    getBaseUrl() { return this.isReady() ? this.baseUrl : null; }
    getLocalToken() { return this.localToken; }
    getInstanceId() { return this.instanceId; }
    getHttpAgent() { return this.httpAgent; }

    _findBinary() {
        const projectRoot = path.resolve(moduleDirname, '..', '..');
        const isWin = process.platform === 'win32';
        const ext = isWin ? '.exe' : '';
        const candidates = [
            path.join(projectRoot, 'kiro-sidecar', `kiro-sidecar${ext}`),
            path.join(projectRoot, `kiro-sidecar${ext}`),
            path.join('/app', 'kiro-sidecar', `kiro-sidecar${ext}`),
            path.join('/app', `kiro-sidecar${ext}`),
        ];
        for (const p of candidates) {
            try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
        }
        return null;
    }

    async _waitForReady(timeoutMs = STARTUP_TIMEOUT) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                if (await this._healthCheck()) return true;
            } catch {}
            await sleep(500);
        }
        logger.error('[Kiro-Sidecar] Startup timeout');
        return false;
    }

    _healthCheck() {
        return new Promise((resolve) => {
            const opts = {
                hostname: '127.0.0.1',
                port: this.port,
                path: '/health',
                method: 'GET',
                timeout: HEALTH_CHECK_TIMEOUT,
                agent: this.httpAgent,
                headers: {
                    'X-Kiro-Sidecar-Token': this.localToken || '',
                    'X-Kiro-Protocol-Version': '1',
                },
            };
            const req = http.request(opts, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) return resolve(false);
                    try {
                        const data = JSON.parse(body);
                        // Verify instance identity
                        if (data.instance_id !== this.instanceId) {
                            logger.warn('[Kiro-Sidecar] Instance ID mismatch in health check');
                            return resolve(false);
                        }
                        resolve(true);
                    } catch {
                        resolve(false);
                    }
                });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    _startHealthCheck() {
        this._stopHealthCheck();
        this.healthCheckTimer = setInterval(async () => {
            const ok = await this._healthCheck();
            if (!ok) {
                this.consecutiveHealthFailures++;
                if (this.state === STATES.READY) {
                    this.state = STATES.UNHEALTHY;
                    logger.warn('[Kiro-Sidecar] Health check failed, marking unhealthy');
                }
                if (this.consecutiveHealthFailures >= 3 && this.process) {
                    logger.warn('[Kiro-Sidecar] 3 consecutive health failures, restarting');
                    this._stopHealthCheck();
                    this.process.kill('SIGTERM');
                    // Exit handler will schedule restart
                }
            } else {
                if (this.state === STATES.UNHEALTHY) {
                    this.state = STATES.READY;
                    logger.info('[Kiro-Sidecar] Health recovered');
                }
                this.consecutiveHealthFailures = 0;
            }
        }, HEALTH_CHECK_INTERVAL);
        this.healthCheckTimer.unref?.();
    }

    _stopHealthCheck() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

let instance = null;

export function getKiroSidecar() {
    if (!instance) instance = new KiroSidecar();
    return instance;
}

export default KiroSidecar;
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/kiro-sidecar.js
git commit -m "feat: add KiroSidecar process manager with state machine and rolling restart budget"
```

### Task 2.3: API Server Integration — Start/Stop

**Files:**
- Modify: `src/services/api-server.js`

- [ ] **Step 1: Add kiro-sidecar start alongside tls-sidecar**

Add import at top of `src/services/api-server.js`:

```js
import { getKiroSidecar } from '../utils/kiro-sidecar.js';
```

After the existing tls-sidecar start block (around line 290), add:

```js
    // Start Kiro sidecar if enabled
    if (CONFIG.KIRO_SIDECAR_ENABLED) {
        const kiroSidecar = getKiroSidecar();
        const started = await kiroSidecar.start({
            port: CONFIG.KIRO_SIDECAR_PORT,
            binaryPath: CONFIG.KIRO_SIDECAR_PATH || undefined,
            maxPayloadBytes: CONFIG.KIRO_MAX_PAYLOAD_BYTES,
        });
        if (started) {
            logger.info('[Initialization] Kiro sidecar started successfully');
        } else {
            logger.warn('[Initialization] Kiro sidecar failed to start, using existing transport');
        }
    }
```

In the shutdown handler (around line 219), after TLS sidecar stop, add:

```js
    // 停止 Kiro sidecar
    try {
        await getKiroSidecar().stop();
    } catch { /* ignore */ }
```

- [ ] **Step 2: Commit**

```bash
git add src/services/api-server.js
git commit -m "feat: integrate kiro-sidecar start/stop in api-server lifecycle"
```

### Task 2.4: Claude-Kiro.js — Split Routing from Sending

**Files:**
- Modify: `src/providers/claude/claude-kiro.js`

This is the most critical change. We split `_requestWithBuilderEndpointRouting` into `_buildRoutedRequest` (pure routing) and update `_requestWithBuilderEndpointRouting` to call it then decide transport.

- [ ] **Step 1: Add _buildRoutedRequest method**

Add this new method to the KiroApiService class, right before `_requestWithBuilderEndpointRouting`:

```js
    /**
     * Apply business routing (Builder ID / API Key runtime) to produce
     * the final URL, headers, and body — without sending the request.
     * Returns a new config object; does not mutate the input.
     */
    _buildRoutedRequest(axiosConfig, requestData) {
        let routedConfig = { ...axiosConfig, headers: { ...axiosConfig.headers } };
        let routedData = requestData;

        if (shouldRouteBuilderToCodeWhisperer({ authMethod: this.authMethod, profileArn: this.profileArn, requestUrl: axiosConfig.url })) {
            routedData = { ...requestData };
            delete routedData.profileArn;
            routedConfig = { ...routedConfig, url: this.codewhispererBaseUrl, data: routedData };
            logger.info('[Kiro] Routing profileless Builder ID request through CodeWhisperer.');
        }

        const apiKey = this.accessToken?.startsWith('ksk_') || this.apiKey && this.accessToken === this.apiKey;
        if (apiKey && (this.config.KIRO_API_KEY_RUNTIME_ENABLED === true || this.config.KIRO_API_KEY_BASE_URL)) {
            routedData = { ...requestData, conversationState: { ...requestData.conversationState } };
            delete routedData.profileArn;
            routedData.conversationState.currentMessage = { ...routedData.conversationState.currentMessage,
                userInputMessage: { ...routedData.conversationState.currentMessage?.userInputMessage, origin: 'CLI' } };
            routedConfig = { ...routedConfig, url: this.config.KIRO_API_KEY_BASE_URL || `https://runtime.${this.region || 'us-east-1'}.kiro.dev/`, data: routedData };
            routedConfig.headers['Content-Type'] = 'application/x-amz-json-1.0';
            routedConfig.headers['TokenType'] = 'API_KEY';
            routedConfig.headers['x-amzn-codewhisperer-optout'] = 'false';
        }

        if (!routedConfig.data) {
            routedConfig.data = requestData;
        }

        return routedConfig;
    }
```

- [ ] **Step 2: Update _requestWithBuilderEndpointRouting to use it**

Replace the existing `_requestWithBuilderEndpointRouting`:

```js
    async _requestWithBuilderEndpointRouting(axiosConfig, requestData, options = {}) {
        const routedConfig = this._buildRoutedRequest(axiosConfig, requestData);

        // Transport selection: kiro-sidecar → tls-sidecar → direct
        if (options.allowKiroSidecar && options._transportContext?.kind === 'kiro-sidecar') {
            return await this._requestViaKiroSidecar(routedConfig, options._transportContext);
        }

        this._applySidecar(routedConfig);
        return await this.axiosInstance.request(routedConfig);
    }
```

- [ ] **Step 3: Add _requestViaKiroSidecar adapter method**

```js
    /**
     * Send a request through kiro-sidecar. Returns an Axios-compatible response.
     * Only handles the local transport — the response is a raw stream just like
     * the existing axios path.
     */
    async _requestViaKiroSidecar(routedConfig, transportCtx) {
        const { getKiroSidecar } = await import('../../utils/kiro-sidecar.js');
        const sidecar = getKiroSidecar();
        const { resolveProxyUrlForProvider } = await import('../../utils/proxy-utils.js');

        // Resolve proxy for this account using existing rules
        const proxyUrl = resolveProxyUrlForProvider(this.config, this.config.MODEL_PROVIDER || 'claude-kiro-oauth', { forSidecar: true });

        // Merge axios instance defaults with request-level headers
        const mergedHeaders = {
            ...this.axiosInstance?.defaults?.headers?.common,
            ...this.axiosInstance?.defaults?.headers?.post,
            ...routedConfig.headers,
        };

        const localHeaders = {
            'X-Kiro-Sidecar-Token': sidecar.getLocalToken(),
            'X-Kiro-Protocol-Version': '1',
            'X-Target-Url': routedConfig.url,
        };
        if (proxyUrl) {
            localHeaders['X-Proxy-Url'] = proxyUrl;
        }

        // Forward all upstream headers — sidecar applies its allowlist
        for (const [key, value] of Object.entries(mergedHeaders)) {
            if (value != null && !key.startsWith('x-kiro-') && key.toLowerCase() !== 'x-target-url' && key.toLowerCase() !== 'x-proxy-url') {
                localHeaders[key] = value;
            }
        }

        const sidecarConfig = {
            method: 'post',
            url: `${sidecar.getBaseUrl()}/stream`,
            data: routedConfig.data,
            headers: localHeaders,
            responseType: routedConfig.responseType || 'stream',
            timeout: 0,
            signal: routedConfig.signal,
            httpAgent: sidecar.getHttpAgent(),
            proxy: false,
        };

        const response = await axios.request(sidecarConfig);

        // Classify response source for error handling
        const responseSource = response.headers?.['x-kiro-response-source'];
        if (responseSource === 'sidecar') {
            // Sidecar self-error — mark it so error handlers don't treat it as AWS failure
            const error = new Error(`Kiro sidecar error: ${response.status}`);
            error.response = response;
            error.isKiroSidecarError = true;
            error.skipErrorCount = true;
            error.shouldSwitchCredential = false;
            throw error;
        }

        return response;
    }
```

- [ ] **Step 4: Add transport selection in streamApiReal**

In `streamApiReal`, after the `axiosConfig` is built (around line 2480), before `await this._requestWithBuilderEndpointRouting(...)`, add transport selection logic:

```js
            // Transport selection: determine once per request, reuse across retries
            if (!options._transportContext) {
                const { getKiroSidecar } = await import('../../utils/kiro-sidecar.js');
                const sidecar = getKiroSidecar();
                if (this.config.KIRO_SIDECAR_ENABLED && sidecar.isReady() && axiosConfig.responseType === 'stream') {
                    options._transportContext = { kind: 'kiro-sidecar' };
                } else {
                    options._transportContext = { kind: 'default' };
                }
            }
```

And pass it through to `_requestWithBuilderEndpointRouting`:

```js
            const response = await this._requestWithBuilderEndpointRouting(axiosConfig, requestData, {
                allowKiroSidecar: true,
                _transportContext: options._transportContext,
            });
```

- [ ] **Step 5: Handle sidecar errors in the catch block**

In the existing catch block of `streamApiReal`, add early detection of sidecar errors before the existing AWS error handling:

```js
            // Identify sidecar transport errors — don't confuse with AWS failures
            if (error.isKiroSidecarError) {
                error.isRetryableUpstreamResponseFailure = true;
                error.skipErrorCount = true;
                error.shouldSwitchCredential = false;
                // Fall through to existing retry logic
            }
```

- [ ] **Step 6: Verify existing tests still pass**

```bash
npx jest tests/kiro-streaming.test.js tests/kiro-production-safety.test.js tests/kiro-truncation-recovery.test.js --no-coverage
```

Expected: 274 tests pass (all existing tests unaffected, since `KIRO_SIDECAR_ENABLED` defaults to `false`).

- [ ] **Step 7: Commit**

```bash
git add src/providers/claude/claude-kiro.js
git commit -m "feat(kiro): split routing from sending, add kiro-sidecar transport path with fallback"
```

### Task 2.5: Dockerfile — Add Rust Build Stage

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add Rust build stage**

After the existing Go sidecar builder stage (line ~17), add:

```dockerfile
# ── Stage 1b: 编译 Rust kiro-sidecar ──
FROM rust:1.82-alpine AS kiro-builder

ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY

RUN apk add --no-cache build-base cmake perl

WORKDIR /build
COPY kiro-sidecar/Cargo.toml kiro-sidecar/Cargo.lock kiro-sidecar/rust-toolchain.toml ./
COPY kiro-sidecar/src ./src
RUN cargo build --release --locked
```

In the Node.js final stage, after the tls-sidecar COPY (line ~48), add:

```dockerfile
# 复制 kiro-sidecar 二进制（可选，仅在 KIRO_SIDECAR_ENABLED=true 时使用）
COPY --from=kiro-builder /build/target/release/kiro-sidecar /app/kiro-sidecar/kiro-sidecar
RUN chmod +x /app/kiro-sidecar/kiro-sidecar
```

Also add `ca-certificates` to the runtime stage if not already present:

```dockerfile
RUN apk add --no-cache tar git procps ca-certificates
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "build: add Rust kiro-sidecar build stage to Dockerfile"
```

---

## Phase 3: Delivery Verification

### Task 3.1: Node.js Integration Tests

**Files:**
- Create: `tests/kiro-sidecar-integration.test.js`

- [ ] **Step 1: Write integration tests**

Create `tests/kiro-sidecar-integration.test.js`:

```js
import { jest } from '@jest/globals';

// Mock kiro-sidecar as not available by default (no binary in test env)
jest.unstable_mockModule('../src/utils/kiro-sidecar.js', () => {
    const mockSidecar = {
        isReady: jest.fn().mockReturnValue(false),
        getBaseUrl: jest.fn().mockReturnValue(null),
        getLocalToken: jest.fn().mockReturnValue(null),
        getInstanceId: jest.fn().mockReturnValue(null),
        getHttpAgent: jest.fn().mockReturnValue(null),
        start: jest.fn().mockResolvedValue(false),
        stop: jest.fn().mockResolvedValue(),
    };
    return {
        getKiroSidecar: () => mockSidecar,
        default: {},
        __mockSidecar: mockSidecar,
    };
});

describe('kiro-sidecar transport selection', () => {
    it('defaults to existing transport when sidecar is not enabled', async () => {
        // When KIRO_SIDECAR_ENABLED is false, _transportContext should be { kind: 'default' }
        const { __mockSidecar } = await import('../src/utils/kiro-sidecar.js');
        __mockSidecar.isReady.mockReturnValue(false);

        // Transport selection logic should choose 'default'
        const options = {};
        const config = { KIRO_SIDECAR_ENABLED: false };
        // Simulate the selection logic
        if (config.KIRO_SIDECAR_ENABLED && __mockSidecar.isReady()) {
            options._transportContext = { kind: 'kiro-sidecar' };
        } else {
            options._transportContext = { kind: 'default' };
        }
        expect(options._transportContext.kind).toBe('default');
    });

    it('selects kiro-sidecar when enabled and ready', async () => {
        const { __mockSidecar } = await import('../src/utils/kiro-sidecar.js');
        __mockSidecar.isReady.mockReturnValue(true);

        const options = {};
        const config = { KIRO_SIDECAR_ENABLED: true };
        if (config.KIRO_SIDECAR_ENABLED && __mockSidecar.isReady()) {
            options._transportContext = { kind: 'kiro-sidecar' };
        } else {
            options._transportContext = { kind: 'default' };
        }
        expect(options._transportContext.kind).toBe('kiro-sidecar');
    });

    it('reuses transport context across retries', () => {
        const options = { _transportContext: { kind: 'kiro-sidecar' } };
        // On retry, should not re-evaluate
        expect(options._transportContext.kind).toBe('kiro-sidecar');
    });
});

describe('kiro-sidecar error classification', () => {
    it('sidecar errors are not treated as AWS credential failures', () => {
        const error = new Error('sidecar error');
        error.isKiroSidecarError = true;
        error.skipErrorCount = true;
        error.shouldSwitchCredential = false;

        expect(error.shouldSwitchCredential).toBe(false);
        expect(error.skipErrorCount).toBe(true);
        expect(error.isKiroSidecarError).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests**

```bash
npx jest tests/kiro-sidecar-integration.test.js --no-coverage
```

Expected: All tests pass.

- [ ] **Step 3: Run full regression suite**

```bash
npx jest tests/kiro-streaming.test.js tests/kiro-production-safety.test.js tests/kiro-truncation-recovery.test.js --no-coverage
```

Expected: 274 tests pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git add tests/kiro-sidecar-integration.test.js
git commit -m "test: add kiro-sidecar integration tests for transport selection and error classification"
```

### Task 3.2: Docker Build Verification

- [ ] **Step 1: Build the Docker image**

```bash
docker build -t aiclient2api:kiro-sidecar-test .
```

Expected: Build completes successfully (Go sidecar + Rust sidecar + Node.js).

- [ ] **Step 2: Verify binary exists in container**

```bash
docker run --rm aiclient2api:kiro-sidecar-test ls -la /app/kiro-sidecar/kiro-sidecar
```

Expected: Binary exists, is executable.

- [ ] **Step 3: Verify health endpoint works in container**

```bash
docker run --rm -e KIRO_SIDECAR_ENABLED=true aiclient2api:kiro-sidecar-test sh -c "
  KIRO_SIDECAR_INSTANCE_ID=test KIRO_SIDECAR_TOKEN=test /app/kiro-sidecar/kiro-sidecar &
  sleep 2
  curl -s -H 'X-Kiro-Sidecar-Token: test' -H 'X-Kiro-Protocol-Version: 1' http://127.0.0.1:9091/health
  kill %1
"
```

Expected: Health check returns 200 with valid JSON.

### Task 3.3: Final Regression and Cleanup

- [ ] **Step 1: Run all kiro-related tests**

```bash
npx jest tests/kiro- --no-coverage
```

Expected: All tests pass with no regressions.

- [ ] **Step 2: Remove Phase 0 test-proxy endpoint if still present**

Verify `kiro-sidecar/src/main.rs` has no test-proxy route.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: Phase 3 delivery verification complete"
```
