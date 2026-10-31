//! HTTP client pool with per-proxy caching for kiro-sidecar.
//!
//! Each unique proxy URL (or direct/no-proxy) gets its own `reqwest::Client`
//! instance. A bounded cache evicts an arbitrary entry when full.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::Client;

use crate::config::Config;

/// Sentinel key used for the direct (no-proxy) client.
const DIRECT_KEY: &str = "__direct__";

/// Bounded cache of `reqwest::Client` instances keyed by proxy URL.
///
/// Thread-safe: the inner map is protected by a `Mutex`.
pub struct ClientCache {
    clients: Mutex<HashMap<String, Client>>,
    max_entries: usize,
    connect_timeout: Duration,
}

impl std::fmt::Debug for ClientCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let count = self
            .clients
            .lock()
            .map(|m| m.len())
            .unwrap_or(0);
        f.debug_struct("ClientCache")
            .field("cached", &count)
            .field("max_entries", &self.max_entries)
            .finish()
    }
}

impl ClientCache {
    /// Create a new `ClientCache` from the sidecar configuration.
    pub fn new(config: &Config) -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            max_entries: config.max_client_cache,
            connect_timeout: Duration::from_secs(config.connect_timeout_secs),
        }
    }

    /// Return a cached client for the given proxy URL, or build and cache a new one.
    ///
    /// When `proxy_url` is `None`, the direct (no-proxy) client is used.
    /// If the cache is at capacity, an arbitrary entry is evicted first.
    pub fn get_or_create(&self, proxy_url: Option<&str>) -> Result<Client, String> {
        let key = proxy_url.unwrap_or(DIRECT_KEY);

        let mut map = self
            .clients
            .lock()
            .map_err(|e| format!("client cache lock poisoned: {e}"))?;

        if let Some(client) = map.get(key) {
            return Ok(client.clone());
        }

        // Evict an arbitrary entry if at capacity.
        if map.len() >= self.max_entries {
            if let Some(evict_key) = map.keys().next().cloned() {
                map.remove(&evict_key);
            }
        }

        let client = self.build_client(proxy_url)?;
        map.insert(key.to_string(), client.clone());
        Ok(client)
    }

    /// Build a new `reqwest::Client` with the sidecar's transport settings.
    fn build_client(&self, proxy_url: Option<&str>) -> Result<Client, String> {
        // Install aws-lc-rs as the default crypto provider (idempotent).
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

        let mut builder = Client::builder()
            .use_rustls_tls()
            .connect_timeout(self.connect_timeout)
            .redirect(Policy::none())
            .no_proxy()
            .http2_prior_knowledge()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd();

        if let Some(proxy_str) = proxy_url {
            let proxy = reqwest::Proxy::all(proxy_str)
                .map_err(|e| format!("invalid proxy URL '{proxy_str}': {e}"))?;
            builder = builder.proxy(proxy);
        }

        builder
            .build()
            .map_err(|e| format!("failed to build reqwest client: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config {
            port: 9091,
            instance_id: "test".into(),
            token: "tok".into(),
            target_allowlist: vec![],
            max_payload_bytes: 10 * 1024 * 1024,
            max_inflight: 128,
            max_buffer_bytes: 64 * 1024 * 1024,
            max_client_cache: 2,
            connect_timeout_secs: 5,
            transport_profile: "v1-aws-lc-rs".into(),
        }
    }

    #[test]
    fn direct_client_is_cached() {
        let cache = ClientCache::new(&test_config());
        let _c1 = cache.get_or_create(None).unwrap();
        let _c2 = cache.get_or_create(None).unwrap();

        // Both calls succeed and the cache only holds one entry for direct.
        let map = cache.clients.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert!(map.contains_key(DIRECT_KEY));
    }

    #[test]
    fn proxy_client_is_separate_from_direct() {
        let cache = ClientCache::new(&test_config());
        let _direct = cache.get_or_create(None).unwrap();
        let _proxy = cache
            .get_or_create(Some("http://127.0.0.1:8080"))
            .unwrap();

        let map = cache.clients.lock().unwrap();
        assert_eq!(map.len(), 2);
        assert!(map.contains_key(DIRECT_KEY));
        assert!(map.contains_key("http://127.0.0.1:8080"));
    }

    #[test]
    fn evicts_when_at_capacity() {
        let cache = ClientCache::new(&test_config()); // max_client_cache = 2
        cache.get_or_create(None).unwrap();
        cache
            .get_or_create(Some("http://127.0.0.1:8080"))
            .unwrap();

        // Cache is now full (2). Adding a third should evict one.
        cache
            .get_or_create(Some("http://127.0.0.1:9090"))
            .unwrap();

        let map = cache.clients.lock().unwrap();
        assert_eq!(map.len(), 2);
        assert!(map.contains_key("http://127.0.0.1:9090"));
    }

    #[test]
    fn invalid_proxy_url_returns_error() {
        let cache = ClientCache::new(&test_config());
        let result = cache.get_or_create(Some("not a valid url"));
        assert!(result.is_err());
    }
}
