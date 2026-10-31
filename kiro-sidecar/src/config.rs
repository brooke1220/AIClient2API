use std::env;
use url::Url;

/// Built-in target allowlist origins that are always permitted.
const BUILTIN_ALLOWLIST: &[&str] = &[
    "https://q.us-east-1.amazonaws.com",
    "https://q.eu-west-1.amazonaws.com",
    "https://q.ap-southeast-1.amazonaws.com",
    "https://codewhisperer.us-east-1.amazonaws.com",
];

/// Sidecar configuration parsed from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub instance_id: String,
    pub token: String,
    pub target_allowlist: Vec<String>,
    pub max_payload_bytes: usize,
    pub max_inflight: usize,
    pub max_buffer_bytes: usize,
    pub max_client_cache: usize,
    pub connect_timeout_secs: u64,
    pub transport_profile: String,
}

impl Config {
    /// Parse configuration from environment variables.
    ///
    /// Required variables: `KIRO_SIDECAR_INSTANCE_ID`, `KIRO_SIDECAR_TOKEN`.
    /// All other variables have sensible defaults.
    pub fn from_env() -> Result<Self, String> {
        let port = Self::parse_optional_env("KIRO_SIDECAR_PORT", 9091)?;
        let instance_id = Self::require_env("KIRO_SIDECAR_INSTANCE_ID")?;
        let token = Self::require_env("KIRO_SIDECAR_TOKEN")?;

        // Build target allowlist: built-in origins + user-supplied origins
        let mut target_allowlist: Vec<String> = BUILTIN_ALLOWLIST
            .iter()
            .map(|s| s.to_string())
            .collect();

        if let Ok(extra) = env::var("KIRO_SIDECAR_TARGET_ALLOWLIST") {
            for origin in extra.split(',') {
                let origin = origin.trim();
                if !origin.is_empty() {
                    // Validate that each entry is a valid HTTPS origin
                    if !origin.starts_with("https://") {
                        return Err(format!(
                            "KIRO_SIDECAR_TARGET_ALLOWLIST: origin must be HTTPS: {origin}"
                        ));
                    }
                    target_allowlist.push(origin.to_string());
                }
            }
        }

        let max_payload_bytes =
            Self::parse_optional_env("KIRO_SIDECAR_MAX_PAYLOAD_BYTES", 10 * 1024 * 1024)?;
        let max_inflight = Self::parse_optional_env("KIRO_SIDECAR_MAX_INFLIGHT", 128)?;
        let max_buffer_bytes =
            Self::parse_optional_env("KIRO_SIDECAR_MAX_BUFFER_BYTES", 64 * 1024 * 1024)?;
        let max_client_cache =
            Self::parse_optional_env("KIRO_SIDECAR_MAX_CLIENT_CACHE", 128)?;
        let connect_timeout_secs =
            Self::parse_optional_env("KIRO_SIDECAR_CONNECT_TIMEOUT_SECS", 10)?;
        let transport_profile = env::var("KIRO_SIDECAR_TRANSPORT_PROFILE")
            .unwrap_or_else(|_| "v1-aws-lc-rs".to_string());

        Ok(Config {
            port,
            instance_id,
            token,
            target_allowlist,
            max_payload_bytes,
            max_inflight,
            max_buffer_bytes,
            max_client_cache,
            connect_timeout_secs,
            transport_profile,
        })
    }

    /// Check whether a target URL is allowed by the allowlist.
    ///
    /// Rules:
    /// - Only HTTPS URLs are permitted.
    /// - URLs with userinfo (username/password) are rejected.
    /// - URLs with fragments are rejected.
    /// - The URL's origin must match one of the allowlisted origins.
    pub fn is_target_allowed(&self, url: &Url) -> bool {
        // Reject non-HTTPS
        if url.scheme() != "https" {
            return false;
        }

        // Reject URLs with userinfo
        if !url.username().is_empty() || url.password().is_some() {
            return false;
        }

        // Reject URLs with fragments
        if url.fragment().is_some() {
            return false;
        }

        let origin = url.origin().ascii_serialization();
        self.target_allowlist.iter().any(|allowed| *allowed == origin)
    }

    /// Read a required environment variable, returning an error if missing.
    fn require_env(name: &str) -> Result<String, String> {
        env::var(name).map_err(|_| format!("{name} is required but not set"))
    }

    /// Parse an optional environment variable with a default value.
    fn parse_optional_env<T>(name: &str, default: T) -> Result<T, String>
    where
        T: std::str::FromStr,
        T::Err: std::fmt::Display,
    {
        match env::var(name) {
            Ok(val) => val
                .parse::<T>()
                .map_err(|e| format!("{name}: {e}")),
            Err(_) => Ok(default),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_target_allowed_builtin() {
        let config = Config {
            port: 9091,
            instance_id: "test".into(),
            token: "tok".into(),
            target_allowlist: BUILTIN_ALLOWLIST.iter().map(|s| s.to_string()).collect(),
            max_payload_bytes: 10 * 1024 * 1024,
            max_inflight: 128,
            max_buffer_bytes: 64 * 1024 * 1024,
            max_client_cache: 128,
            connect_timeout_secs: 10,
            transport_profile: "v1-aws-lc-rs".into(),
        };

        let allowed =
            Url::parse("https://q.us-east-1.amazonaws.com/some/path").unwrap();
        assert!(config.is_target_allowed(&allowed));

        let not_allowed =
            Url::parse("https://evil.example.com/some/path").unwrap();
        assert!(!config.is_target_allowed(&not_allowed));
    }

    #[test]
    fn test_rejects_http() {
        let config = Config {
            port: 9091,
            instance_id: "test".into(),
            token: "tok".into(),
            target_allowlist: vec!["https://q.us-east-1.amazonaws.com".into()],
            max_payload_bytes: 10 * 1024 * 1024,
            max_inflight: 128,
            max_buffer_bytes: 64 * 1024 * 1024,
            max_client_cache: 128,
            connect_timeout_secs: 10,
            transport_profile: "v1-aws-lc-rs".into(),
        };

        let http_url =
            Url::parse("http://q.us-east-1.amazonaws.com/path").unwrap();
        assert!(!config.is_target_allowed(&http_url));
    }

    #[test]
    fn test_rejects_userinfo() {
        let config = Config {
            port: 9091,
            instance_id: "test".into(),
            token: "tok".into(),
            target_allowlist: vec!["https://q.us-east-1.amazonaws.com".into()],
            max_payload_bytes: 10 * 1024 * 1024,
            max_inflight: 128,
            max_buffer_bytes: 64 * 1024 * 1024,
            max_client_cache: 128,
            connect_timeout_secs: 10,
            transport_profile: "v1-aws-lc-rs".into(),
        };

        let url_with_user =
            Url::parse("https://user:pass@q.us-east-1.amazonaws.com/path").unwrap();
        assert!(!config.is_target_allowed(&url_with_user));
    }

    #[test]
    fn test_rejects_fragment() {
        let config = Config {
            port: 9091,
            instance_id: "test".into(),
            token: "tok".into(),
            target_allowlist: vec!["https://q.us-east-1.amazonaws.com".into()],
            max_payload_bytes: 10 * 1024 * 1024,
            max_inflight: 128,
            max_buffer_bytes: 64 * 1024 * 1024,
            max_client_cache: 128,
            connect_timeout_secs: 10,
            transport_profile: "v1-aws-lc-rs".into(),
        };

        let url_with_frag =
            Url::parse("https://q.us-east-1.amazonaws.com/path#frag").unwrap();
        assert!(!config.is_target_allowed(&url_with_frag));
    }
}
