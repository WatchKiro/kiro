//! Addon support.
//!
//! Addons are remote services that Kiro talks to over a transport; their code
//! is never executed by Kiro. Responses are untrusted and are validated by
//! `@kiro/addon-sdk` before use. Fetching from Rust (rather than the webview)
//! avoids webview CORS and applies timeouts, size limits and URL policy in one
//! place.
//!
//! - [`transport`] — HTTP requests to addon endpoints
//! - [`registry`]  — the installed-addon list, persisted on-device
//! - [`defaults`]  — the addons a new profile starts with
//! - [`requests`]  — cancellation of in-flight requests

pub mod defaults;
pub mod registry;
pub mod requests;
pub mod transport;

use std::fmt;

use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::core::error::Error;

const MAX_URL_LENGTH: usize = 2048;

/// A validated addon endpoint URL.
///
/// - `https` is required, except `http` on loopback hosts for local addon development
/// - embedded credentials (`user:pass@`) are rejected
/// - length is bounded
///
/// Deserializes via `try_from`, so a command taking an `AddonUrl` argument
/// rejects invalid input before the handler runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AddonUrl(Url);

impl AddonUrl {
    pub fn parse(input: &str) -> Result<Self, Error> {
        if input.len() > MAX_URL_LENGTH {
            return Err(Error::invalid_argument("Addon URL is too long"));
        }
        let url = Url::parse(input)
            .map_err(|_| Error::invalid_argument("Addon URL is not a valid URL"))?;

        if !url.username().is_empty() || url.password().is_some() {
            return Err(Error::invalid_argument(
                "Addon URL must not contain credentials",
            ));
        }
        match url.scheme() {
            "https" if url.host().is_some() => Ok(Self(url)),
            "http" if is_loopback(&url) => Ok(Self(url)),
            _ => Err(Error::invalid_argument(
                "Addon URL must use https (http is only allowed for localhost)",
            )),
        }
    }

    pub fn as_url(&self) -> &Url {
        &self.0
    }
}

pub(crate) fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

impl TryFrom<String> for AddonUrl {
    type Error = Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<AddonUrl> for String {
    fn from(value: AddonUrl) -> Self {
        value.0.into()
    }
}

impl fmt::Display for AddonUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_loopback_http() {
        assert!(AddonUrl::parse("https://addon.example.com/manifest.json").is_ok());
        assert!(AddonUrl::parse("http://localhost:7000/manifest.json").is_ok());
        assert!(AddonUrl::parse("http://127.0.0.1:7000/manifest.json").is_ok());
        assert!(AddonUrl::parse("http://[::1]:7000/manifest.json").is_ok());
    }

    #[test]
    fn rejects_insecure_or_unsafe_urls() {
        for input in [
            "http://addon.example.com/manifest.json",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:secret@addon.example.com/manifest.json",
            "not a url",
        ] {
            assert!(
                AddonUrl::parse(input).is_err(),
                "expected {input} to be rejected"
            );
        }
        assert!(
            AddonUrl::parse(&format!(
                "https://example.com/{}",
                "a".repeat(MAX_URL_LENGTH)
            ))
            .is_err()
        );
    }

    #[test]
    fn validates_during_deserialization() {
        assert!(serde_json::from_str::<AddonUrl>(r#""https://addon.example.com/""#).is_ok());
        assert!(serde_json::from_str::<AddonUrl>(r#""http://addon.example.com/""#).is_err());
    }
}
