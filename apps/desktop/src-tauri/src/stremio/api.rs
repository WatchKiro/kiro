//! The few calls the import makes to Stremio's account API
//! (`https://api.strem.io/api/<method>`).
//!
//! The API is not formally documented; its shapes are those of Stremio's own
//! open-source clients (`stremio-core`, `stremio-api-client`). Every call is
//! a JSON POST answered with `{ "result": … }` or
//! `{ "error": { "code", "message" } }`.
//!
//! Requests go through [`HttpTransport`] with the addon transport's limits,
//! except that redirects are refused: the bodies carry the sign-in, and must
//! only ever reach the endpoint they were written for.

use std::fmt;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::addons::AddonUrl;
use crate::addons::transport::{AddonError, HttpTransport, Limits};

/// Where Stremio's account API lives.
pub const API_URL: &str = "https://api.strem.io/api/";
/// Stremio's name for the library collection in its datastore.
const LIBRARY_COLLECTION: &str = "libraryItem";
/// Responses: a heavy user's library is a few MB, as are the manifests in
/// their addon collection.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

const MAX_AUTH_KEY_LENGTH: usize = 256;
const MAX_EMAIL_LENGTH: usize = 320;
const MAX_PASSWORD_LENGTH: usize = 1024;

/// A credential: never logged, serialized or cloned. Its `Debug` output is
/// redacted, so it can't leak through an error or a `dbg!`.
#[derive(Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// How the user signs in to Stremio for the import.
///
/// Mirrored by `StremioSignIn` in `apps/desktop/src/services/native.ts`.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "method",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SignIn {
    /// The auth key of a session the user already has (copied from
    /// web.stremio.com). Kiro never sees the password, and leaves the session
    /// signed in: it is the user's browser session.
    AuthKey { auth_key: Secret },
    /// Email and password: Kiro signs in, imports, then signs that new
    /// session out again.
    Password { email: String, password: Secret },
}

impl SignIn {
    /// Checks the shape of what was typed before anything is sent.
    pub fn validate(&self) -> Result<(), StremioError> {
        let valid = match self {
            Self::AuthKey { auth_key } => {
                let key = auth_key.expose();
                !key.is_empty()
                    && key.len() <= MAX_AUTH_KEY_LENGTH
                    && key.bytes().all(|byte| byte.is_ascii_graphic())
            }
            Self::Password { email, password } => {
                let password = password.expose();
                email.contains('@')
                    && email.len() <= MAX_EMAIL_LENGTH
                    && !email.chars().any(char::is_control)
                    && !password.is_empty()
                    && password.len() <= MAX_PASSWORD_LENGTH
            }
        };
        if valid {
            Ok(())
        } else {
            Err(StremioError::InvalidSignIn)
        }
    }
}

/// Why talking to Stremio failed. Messages are shown to the user, and never
/// include what Stremio sent back (it is untrusted) or the credentials.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StremioError {
    #[error("Enter your Stremio email and password, or an auth key.")]
    InvalidSignIn,
    #[error("Stremio didn’t accept that email and password.")]
    WrongPassword,
    #[error("Stremio didn’t accept that auth key. Copy a fresh one and try again.")]
    InvalidSession,
    #[error("Stremio did not respond in time. Try again in a moment.")]
    Timeout,
    #[error("Stremio could not be reached. Check your connection and try again.")]
    Unreachable,
    #[error("Stremio sent a response Kiro could not read.")]
    UnexpectedResponse,
    #[error("Your Stremio data is too large to import in one go.")]
    TooLarge,
    #[error("Stremio reported an error ({0}). Try again in a moment.")]
    Service(u64),
}

impl From<AddonError> for StremioError {
    fn from(error: AddonError) -> Self {
        match error {
            AddonError::Timeout => Self::Timeout,
            AddonError::Unreachable => Self::Unreachable,
            AddonError::TooLarge => Self::TooLarge,
            AddonError::InvalidRedirect | AddonError::Status(_) | AddonError::InvalidJson => {
                Self::UnexpectedResponse
            }
        }
    }
}

/// An `{ "error": … }` answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ApiError {
    code: u64,
}

/// A client for one import. Holds no credentials.
#[derive(Debug, Clone)]
pub struct StremioApi {
    transport: HttpTransport,
    base: AddonUrl,
}

impl StremioApi {
    pub fn new() -> Result<Self, crate::core::error::Error> {
        Self::with_base(AddonUrl::parse(API_URL).expect("the Stremio API URL is valid"))
    }

    /// A client for another endpoint: tests point it at a loopback server.
    pub fn with_base(base: AddonUrl) -> Result<Self, crate::core::error::Error> {
        let transport = HttpTransport::with_limits(Limits {
            max_redirects: 0,
            max_resource_bytes: MAX_RESPONSE_BYTES,
            ..Limits::default()
        })?;
        Ok(Self { transport, base })
    }

    /// Signs in with an email and password and returns the new session's
    /// auth key.
    pub async fn login(&self, email: &str, password: &Secret) -> Result<Secret, StremioError> {
        let body = json!({
            "type": "Login",
            "email": email,
            "password": password.expose(),
            "facebook": false,
        });
        match self.call("login", &body).await? {
            Ok(result) => result
                .get("authKey")
                .and_then(Value::as_str)
                .filter(|key| !key.is_empty() && key.len() <= MAX_AUTH_KEY_LENGTH)
                .map(|key| Secret(key.to_owned()))
                .ok_or(StremioError::UnexpectedResponse),
            Err(_) => Err(StremioError::WrongPassword),
        }
    }

    /// Ends a session Kiro started. Best effort: the import has its data.
    pub async fn logout(&self, auth_key: &Secret) {
        let body = json!({ "type": "Logout", "authKey": auth_key.expose() });
        let _ = self.call("logout", &body).await;
    }

    /// The user's installed addons (`addonCollectionGet`), as raw descriptors.
    pub async fn addon_collection(&self, auth_key: &Secret) -> Result<Value, StremioError> {
        let body = json!({
            "type": "AddonCollectionGet",
            "authKey": auth_key.expose(),
            "update": true,
        });
        self.call_with_session("addonCollectionGet", &body).await
    }

    /// Every item in the user's library collection (`datastoreGet`), raw.
    pub async fn library_items(&self, auth_key: &Secret) -> Result<Value, StremioError> {
        let body = json!({
            "authKey": auth_key.expose(),
            "collection": LIBRARY_COLLECTION,
            "ids": [],
            "all": true,
        });
        self.call_with_session("datastoreGet", &body).await
    }

    /// A call that needs a valid session: an API error means the key was not
    /// accepted (Stremio answers "Session does not exist").
    async fn call_with_session(&self, method: &str, body: &Value) -> Result<Value, StremioError> {
        match self.call(method, body).await? {
            Ok(result) => Ok(result),
            Err(ApiError { code: 1 | 40 }) => Err(StremioError::InvalidSession),
            Err(ApiError { code }) => Err(StremioError::Service(code)),
        }
    }

    async fn call(
        &self,
        method: &str,
        body: &Value,
    ) -> Result<Result<Value, ApiError>, StremioError> {
        let url = self
            .base
            .as_url()
            .join(method)
            .ok()
            .and_then(|url| AddonUrl::parse(url.as_str()).ok())
            .ok_or(StremioError::UnexpectedResponse)?;
        let response = self
            .transport
            .post_json(&url, body, MAX_RESPONSE_BYTES)
            .await?;
        parse_envelope(response)
    }
}

/// Splits `{ "result": … }` from `{ "error": { "code": … } }`.
fn parse_envelope(mut response: Value) -> Result<Result<Value, ApiError>, StremioError> {
    if let Some(error) = response.get("error").filter(|error| !error.is_null()) {
        let code = error.get("code").and_then(Value::as_u64).unwrap_or(0);
        return Ok(Err(ApiError { code }));
    }
    match response.get_mut("result") {
        Some(result) if !result.is_null() => Ok(Ok(result.take())),
        _ => Err(StremioError::UnexpectedResponse),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_key(key: &str) -> SignIn {
        serde_json::from_value(json!({ "method": "authKey", "authKey": key })).unwrap()
    }

    fn password(email: &str, password: &str) -> SignIn {
        serde_json::from_value(
            json!({ "method": "password", "email": email, "password": password }),
        )
        .unwrap()
    }

    #[test]
    fn validates_what_was_typed() {
        assert!(auth_key("abc123DEF").validate().is_ok());
        for bad in [
            "",
            "has space",
            "line\nbreak",
            &"k".repeat(MAX_AUTH_KEY_LENGTH + 1),
        ] {
            assert_eq!(
                auth_key(bad).validate(),
                Err(StremioError::InvalidSignIn),
                "{bad:?}"
            );
        }
        assert!(password("me@example.com", "pw").validate().is_ok());
        assert!(password("me@example.com", "").validate().is_err());
        assert!(password("not-an-email", "pw").validate().is_err());
        assert!(serde_json::from_value::<SignIn>(json!({ "method": "facebook" })).is_err());
    }

    #[test]
    fn credentials_never_show_in_debug_output() {
        let debug = format!(
            "{:?} {:?}",
            auth_key("SECRET-KEY-123"),
            password("me@example.com", "hunter2-SECRET")
        );
        assert!(!debug.contains("SECRET-KEY-123"), "{debug}");
        assert!(!debug.contains("hunter2-SECRET"), "{debug}");
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn never_follows_redirects_with_credentials() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        // Redirects (307 keeps the body) to a second server, which must never
        // be asked anything.
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_port = target.local_addr().unwrap().port();
        target.set_nonblocking(true).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let _ = stream.read(&mut [0; 4096]);
                let _ = write!(
                    stream,
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{target_port}/api/login\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
            }
        });
        let api = StremioApi::with_base(
            AddonUrl::parse(&format!("http://127.0.0.1:{port}/api/")).unwrap(),
        )
        .unwrap();
        let result =
            tauri::async_runtime::block_on(api.login("me@example.com", &Secret("pw".to_owned())));
        assert!(matches!(result, Err(StremioError::UnexpectedResponse)));
        assert!(target.accept().is_err(), "the redirect was followed");
    }

    #[test]
    fn reads_the_response_envelope() {
        assert_eq!(
            parse_envelope(json!({ "result": { "authKey": "k" } })).unwrap(),
            Ok(json!({ "authKey": "k" }))
        );
        assert_eq!(
            parse_envelope(json!({ "error": { "code": 1, "message": "Session does not exist" } }))
                .unwrap(),
            Err(ApiError { code: 1 })
        );
        assert_eq!(
            parse_envelope(json!({ "error": "odd" })).unwrap(),
            Err(ApiError { code: 0 })
        );
        for unexpected in [json!({}), json!([]), json!({ "result": null }), json!("x")] {
            assert_eq!(
                parse_envelope(unexpected),
                Err(StremioError::UnexpectedResponse)
            );
        }
    }
}
