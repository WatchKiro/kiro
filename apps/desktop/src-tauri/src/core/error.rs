use serde::ser::{Serialize, SerializeStruct, Serializer};

/// Error type returned by Tauri commands.
///
/// Serializes to `{ "code": "...", "message": "..." }`. Only
/// [`Error::InvalidArgument`] exposes its message; internal failures (I/O,
/// Tauri) are reported generically so paths and system details never reach
/// the renderer.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    Playback(#[from] crate::media::PlaybackError),
    #[error(transparent)]
    Addon(#[from] crate::addons::transport::AddonError),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Stremio(#[from] crate::stremio::StremioError),
    /// The renderer cancelled the request (`addon_cancel_request`).
    #[error("The request was cancelled")]
    Cancelled,
    #[error("internal error: {0}")]
    Internal(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::InvalidArgument(message.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidArgument(_) => "INVALID_ARGUMENT",
            Self::Io(_) => "IO_ERROR",
            Self::Tauri(_) | Self::Internal(_) => "INTERNAL_ERROR",
            Self::Playback(error) => error.code(),
            Self::Addon(_) => "ADDON_ERROR",
            Self::Database(_) => "DATABASE_ERROR",
            Self::Stremio(_) => "STREMIO_ERROR",
            Self::Cancelled => "CANCELLED",
        }
    }

    fn public_message(&self) -> String {
        match self {
            Self::InvalidArgument(message) => message.clone(),
            // Player messages describe the media, not the system.
            Self::Playback(error) => error.to_string(),
            // Addon messages describe the remote addon's behaviour.
            Self::Addon(error) => error.to_string(),
            // Written for the user; never include credentials or Stremio's text.
            Self::Stremio(error) => error.to_string(),
            Self::Cancelled => self.to_string(),
            Self::Io(_) | Self::Tauri(_) | Self::Database(_) | Self::Internal(_) => {
                "An internal error occurred".to_owned()
            }
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("Error", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.public_message())?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_argument_exposes_its_message() {
        let json = serde_json::to_value(Error::invalid_argument("volume out of range")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "INVALID_ARGUMENT", "message": "volume out of range" })
        );
    }

    #[test]
    fn internal_errors_do_not_leak_details() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "/Users/someone/secret.db");
        let json = serde_json::to_value(Error::from(io)).unwrap();
        assert_eq!(json["code"], "IO_ERROR");
        assert_eq!(json["message"], "An internal error occurred");
    }
}
