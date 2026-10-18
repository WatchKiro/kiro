//! HTTP transport for addons.
//!
//! Every request goes through [`HttpTransport`], which enforces the endpoint
//! policy of [`AddonUrl`] (including on redirects), connect and total
//! timeouts, and a cap on the response body. Responses are returned as
//! parsed but otherwise **unvalidated** JSON: the renderer validates them with
//! `@kiro/addon-sdk` before use.

use std::collections::BTreeMap;
use std::time::Duration;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use serde_json::Value;
use url::Url;

use super::AddonUrl;
use crate::core::error::Error;

/// Limits applied to every addon request.
#[derive(Debug, Clone)]
pub struct Limits {
    pub connect_timeout: Duration,
    /// Covers the whole exchange, including reading the body.
    pub timeout: Duration,
    pub max_manifest_bytes: usize,
    pub max_resource_bytes: usize,
    pub max_redirects: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            timeout: Duration::from_secs(20),
            max_manifest_bytes: 1024 * 1024,
            // Large enough for a series' full episode list.
            max_resource_bytes: 8 * 1024 * 1024,
            max_redirects: 5,
        }
    }
}

/// Why an addon request failed. Messages describe the addon's behaviour, not
/// the local system, so they are safe to show to the user.
#[derive(Debug, thiserror::Error)]
pub enum AddonError {
    #[error("The addon did not respond in time")]
    Timeout,
    #[error("The addon could not be reached")]
    Unreachable,
    #[error("The addon redirected to a URL Kiro does not allow")]
    InvalidRedirect,
    #[error("The addon responded with HTTP {0}")]
    Status(u16),
    #[error("The addon's response is too large")]
    TooLarge,
    #[error("The addon's response is not valid JSON")]
    InvalidJson,
}

/// Resources Kiro requests from addons. Mirrors `ADDON_RESOURCES` in
/// `@kiro/addon-sdk`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddonResource {
    Catalog,
    Meta,
    Stream,
    Subtitles,
}

impl AddonResource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Catalog => "catalog",
            Self::Meta => "meta",
            Self::Stream => "stream",
            Self::Subtitles => "subtitles",
        }
    }
}

const MAX_TYPE_LENGTH: usize = 64;
const MAX_ID_LENGTH: usize = 512;
const MAX_EXTRA_ENTRIES: usize = 16;
const MAX_EXTRA_KEY_LENGTH: usize = 64;
const MAX_EXTRA_VALUE_LENGTH: usize = 1024;

/// A validated resource request, e.g. `catalog/movie/top/genre=Drama`.
#[derive(Debug, Clone)]
pub struct ResourceRequest {
    resource: AddonResource,
    content_type: String,
    id: String,
    extra: BTreeMap<String, String>,
}

impl ResourceRequest {
    pub fn new(
        resource: AddonResource,
        content_type: String,
        id: String,
        extra: BTreeMap<String, String>,
    ) -> Result<Self, Error> {
        if content_type.is_empty() || content_type.len() > MAX_TYPE_LENGTH {
            return Err(Error::invalid_argument("Invalid content type"));
        }
        // `type` is a whole path segment; a dot segment would be normalised
        // away and change the path. (`id` and `extra` always end in `.json`.)
        if content_type == "." || content_type == ".." {
            return Err(Error::invalid_argument("Invalid content type"));
        }
        if id.is_empty() || id.len() > MAX_ID_LENGTH {
            return Err(Error::invalid_argument("Invalid resource id"));
        }
        if extra.len() > MAX_EXTRA_ENTRIES
            || extra.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > MAX_EXTRA_KEY_LENGTH
                    || value.len() > MAX_EXTRA_VALUE_LENGTH
            })
        {
            return Err(Error::invalid_argument("Invalid extra arguments"));
        }
        Ok(Self {
            resource,
            content_type,
            id,
            extra,
        })
    }
}

/// Characters `encodeURIComponent` leaves unescaped, so paths match
/// `buildResourcePath` in `@kiro/addon-sdk`.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn encode(value: &str) -> impl std::fmt::Display + '_ {
    utf8_percent_encode(value, COMPONENT)
}

/// Resolves a resource request against an addon's manifest URL, following the
/// Stremio convention: `<base>/manifest.json` → `<base>/<resource>/<type>/<id>[/<extra>].json`.
pub fn resource_url(manifest_url: &AddonUrl, request: &ResourceRequest) -> Url {
    let mut url = manifest_url.as_url().clone();
    url.set_query(None);
    url.set_fragment(None);

    let path = url.path();
    let base = path
        .strip_suffix("/manifest.json")
        .unwrap_or(path)
        .trim_end_matches('/');
    let mut resource_path = format!(
        "{base}/{}/{}/{}",
        request.resource.as_str(),
        encode(&request.content_type),
        encode(&request.id),
    );
    if !request.extra.is_empty() {
        let extra = request
            .extra
            .iter()
            .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
            .collect::<Vec<_>>()
            .join("&");
        resource_path.push('/');
        resource_path.push_str(&extra);
    }
    resource_path.push_str(".json");
    url.set_path(&resource_path);
    url
}

/// HTTP client for addon endpoints. Cheap to share; create once.
#[derive(Debug, Clone)]
pub struct HttpTransport {
    client: reqwest::Client,
    limits: Limits,
}

impl HttpTransport {
    pub fn new() -> Result<Self, Error> {
        Self::with_limits(Limits::default())
    }

    pub fn with_limits(limits: Limits) -> Result<Self, Error> {
        // reqwest is built without a bundled crypto provider; use `ring`.
        // Fails harmlessly if a provider is already installed.
        let _ = rustls::crypto::ring::default_provider().install_default();

        let max_redirects = limits.max_redirects;
        let redirect = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= max_redirects {
                attempt.error(AddonError::InvalidRedirect)
            } else if AddonUrl::parse(attempt.url().as_str()).is_err() {
                // e.g. an https addon redirecting to plain http.
                attempt.error(AddonError::InvalidRedirect)
            } else {
                attempt.follow()
            }
        });

        let client = reqwest::Client::builder()
            .user_agent(concat!("Kiro/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(limits.connect_timeout)
            .timeout(limits.timeout)
            .redirect(redirect)
            .build()
            .map_err(|error| Error::Internal(error.to_string()))?;
        Ok(Self { client, limits })
    }

    pub async fn fetch_manifest(&self, url: &AddonUrl) -> Result<Value, AddonError> {
        self.get_json(url.as_url(), self.limits.max_manifest_bytes)
            .await
    }

    pub async fn fetch_resource(
        &self,
        manifest_url: &AddonUrl,
        request: &ResourceRequest,
    ) -> Result<Value, AddonError> {
        let url = resource_url(manifest_url, request);
        self.get_json(&url, self.limits.max_resource_bytes).await
    }

    /// Fetches JSON from a fixed endpoint that is not an addon (a service Kiro
    /// itself queries), under the same policy: `url` passed [`AddonUrl`]'s
    /// checks, redirects are re-checked and the timeouts apply. The body is
    /// capped at `max_bytes` or the resource limit, whichever is smaller.
    pub async fn fetch_json(&self, url: &AddonUrl, max_bytes: usize) -> Result<Value, AddonError> {
        self.get_json(url.as_url(), max_bytes.min(self.limits.max_resource_bytes))
            .await
    }

    /// POSTs `body` as JSON to a fixed service endpoint (not an addon), under
    /// the same policy and caps as [`Self::fetch_json`]. Nothing about the
    /// request, its body included, is logged.
    pub async fn post_json(
        &self,
        url: &AddonUrl,
        body: &Value,
        max_bytes: usize,
    ) -> Result<Value, AddonError> {
        let request = self
            .client
            .post(url.as_url().clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string());
        self.send_json(request, max_bytes.min(self.limits.max_resource_bytes))
            .await
    }

    async fn get_json(&self, url: &Url, max_bytes: usize) -> Result<Value, AddonError> {
        self.send_json(self.client.get(url.clone()), max_bytes)
            .await
    }

    async fn send_json(
        &self,
        request: reqwest::RequestBuilder,
        max_bytes: usize,
    ) -> Result<Value, AddonError> {
        let mut response = request
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(map_error)?;

        let status = response.status();
        if !status.is_success() {
            return Err(AddonError::Status(status.as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(AddonError::TooLarge);
        }

        // The declared length may be absent or wrong, so count while reading.
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(map_error)? {
            if body.len() + chunk.len() > max_bytes {
                return Err(AddonError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| AddonError::InvalidJson)
    }
}

fn map_error(error: reqwest::Error) -> AddonError {
    if error.is_timeout() {
        AddonError::Timeout
    } else if error.is_redirect() {
        AddonError::InvalidRedirect
    } else {
        AddonError::Unreachable
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    /// Serves `response` (raw HTTP) to every connection on a loopback port,
    /// after an optional delay. Returns the server's manifest URL.
    fn serve(response: Vec<u8>, delay: Duration) -> AddonUrl {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = [0; 4096];
                let _ = stream.read(&mut request);
                thread::sleep(delay);
                let _ = stream.write_all(&response);
            }
        });
        AddonUrl::parse(&format!("http://127.0.0.1:{port}/manifest.json")).unwrap()
    }

    fn http_response(head: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!("HTTP/1.1 {head}\r\nConnection: close\r\n").into_bytes();
        response.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
        response.extend_from_slice(body);
        response
    }

    fn transport(limits: Limits) -> HttpTransport {
        HttpTransport::with_limits(limits).unwrap()
    }

    fn fetch(transport: &HttpTransport, url: &AddonUrl) -> Result<Value, AddonError> {
        tauri::async_runtime::block_on(transport.fetch_manifest(url))
    }

    #[test]
    fn returns_json_bodies() {
        let url = serve(
            http_response("200 OK", br#"{"id":"org.example"}"#),
            Duration::ZERO,
        );
        let value = fetch(&transport(Limits::default()), &url).unwrap();
        assert_eq!(value["id"], "org.example");
    }

    #[test]
    fn rejects_bodies_over_the_declared_limit() {
        let url = serve(http_response("200 OK", &[b' '; 2048]), Duration::ZERO);
        let limits = Limits {
            max_manifest_bytes: 1024,
            ..Limits::default()
        };
        assert!(matches!(
            fetch(&transport(limits), &url),
            Err(AddonError::TooLarge)
        ));
    }

    #[test]
    fn rejects_oversized_bodies_without_a_content_length() {
        let mut response =
            b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        for _ in 0..4 {
            response.extend_from_slice(b"200\r\n");
            response.extend_from_slice(&[b' '; 0x200]);
            response.extend_from_slice(b"\r\n");
        }
        response.extend_from_slice(b"0\r\n\r\n");
        let url = serve(response, Duration::ZERO);
        let limits = Limits {
            max_manifest_bytes: 1024,
            ..Limits::default()
        };
        assert!(matches!(
            fetch(&transport(limits), &url),
            Err(AddonError::TooLarge)
        ));
    }

    #[test]
    fn times_out_slow_addons() {
        let url = serve(http_response("200 OK", b"{}"), Duration::from_secs(5));
        let limits = Limits {
            timeout: Duration::from_millis(200),
            ..Limits::default()
        };
        assert!(matches!(
            fetch(&transport(limits), &url),
            Err(AddonError::Timeout)
        ));
    }

    #[test]
    fn reports_http_errors_and_invalid_json() {
        let not_found = serve(http_response("404 Not Found", b"{}"), Duration::ZERO);
        assert!(matches!(
            fetch(&transport(Limits::default()), &not_found),
            Err(AddonError::Status(404))
        ));

        let html = serve(http_response("200 OK", b"<html>"), Duration::ZERO);
        assert!(matches!(
            fetch(&transport(Limits::default()), &html),
            Err(AddonError::InvalidJson)
        ));
    }

    #[test]
    fn refuses_redirects_that_break_the_url_policy() {
        let url = serve(
            b"HTTP/1.1 302 Found\r\nLocation: http://addon.example.com/manifest.json\r\nContent-Length: 0\r\n\r\n"
                .to_vec(),
            Duration::ZERO,
        );
        assert!(matches!(
            fetch(&transport(Limits::default()), &url),
            Err(AddonError::InvalidRedirect)
        ));
    }

    #[test]
    fn reports_unreachable_addons() {
        // Bind then drop, so nothing is listening on the port.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let url = AddonUrl::parse(&format!("http://127.0.0.1:{port}/manifest.json")).unwrap();
        assert!(matches!(
            fetch(&transport(Limits::default()), &url),
            Err(AddonError::Unreachable)
        ));
    }

    /// Live check against Stremio's public Cinemeta addon:
    /// `cargo test -- --ignored cinemeta`.
    #[test]
    #[ignore = "uses the network"]
    fn fetches_cinemeta() {
        let transport = transport(Limits::default());
        let url = AddonUrl::parse("https://v3-cinemeta.strem.io/manifest.json").unwrap();
        let manifest = fetch(&transport, &url).unwrap();
        assert_eq!(manifest["id"], "com.linvo.cinemeta");

        let catalog = tauri::async_runtime::block_on(
            transport.fetch_resource(&url, &request(AddonResource::Catalog, "movie", "top")),
        )
        .unwrap();
        assert!(!catalog["metas"].as_array().unwrap().is_empty());

        let mut search = request(AddonResource::Catalog, "series", "top");
        search.extra.insert("search".into(), "the office".into());
        let results =
            tauri::async_runtime::block_on(transport.fetch_resource(&url, &search)).unwrap();
        let names: Vec<_> = results["metas"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|meta| meta["name"].as_str())
            .collect();
        assert!(names.contains(&"The Office"), "{names:?}");
    }

    fn request(resource: AddonResource, content_type: &str, id: &str) -> ResourceRequest {
        ResourceRequest::new(resource, content_type.into(), id.into(), BTreeMap::new()).unwrap()
    }

    #[test]
    fn builds_resource_urls_like_the_sdk() {
        let manifest = AddonUrl::parse("https://addon.example.com/cfg/manifest.json?x=1").unwrap();

        let mut catalog = request(AddonResource::Catalog, "movie", "top");
        catalog.extra.insert("search".into(), "alien & co".into());
        assert_eq!(
            resource_url(&manifest, &catalog).as_str(),
            "https://addon.example.com/cfg/catalog/movie/top/search=alien%20%26%20co.json"
        );

        let traversal = request(AddonResource::Meta, "series", "../../admin");
        assert_eq!(
            resource_url(&manifest, &traversal).as_str(),
            "https://addon.example.com/cfg/meta/series/..%2F..%2Fadmin.json"
        );

        let root = AddonUrl::parse("https://addon.example.com/manifest.json").unwrap();
        assert_eq!(
            resource_url(&root, &request(AddonResource::Stream, "movie", "tt1")).as_str(),
            "https://addon.example.com/stream/movie/tt1.json"
        );
    }

    #[test]
    fn rejects_invalid_resource_requests() {
        let new = |content_type: &str, id: &str, extra: BTreeMap<String, String>| {
            ResourceRequest::new(
                AddonResource::Catalog,
                content_type.into(),
                id.into(),
                extra,
            )
        };
        assert!(new("", "top", BTreeMap::new()).is_err());
        assert!(new("..", "top", BTreeMap::new()).is_err());
        assert!(new("movie", "", BTreeMap::new()).is_err());
        assert!(new("movie", &"a".repeat(MAX_ID_LENGTH + 1), BTreeMap::new()).is_err());
        let too_many = (0..=MAX_EXTRA_ENTRIES)
            .map(|i| (format!("k{i}"), String::new()))
            .collect();
        assert!(new("movie", "top", too_many).is_err());
        assert!(serde_json::from_str::<AddonResource>(r#""addon_catalog""#).is_err());
    }
}
