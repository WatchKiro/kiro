//! Cancellation of in-flight addon requests.
//!
//! The renderer tags a fetch with a request id it generates and cancels it
//! by that id when the result is no longer wanted (e.g. a search query
//! changed). Cancelling drops the request future, which closes the HTTP
//! connection instead of letting the addon response download for nothing.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use futures_util::future::{AbortHandle, Abortable};
use serde::Deserialize;

use crate::core::error::Error;

const MAX_REQUEST_ID_LENGTH: usize = 64;

/// A renderer-chosen request id: 1–64 ASCII letters, digits, `-` or `_`
/// (a UUID fits).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(try_from = "String")]
pub struct RequestId(String);

impl TryFrom<String> for RequestId {
    type Error = Error;

    fn try_from(value: String) -> Result<Self, Error> {
        let valid = !value.is_empty()
            && value.len() <= MAX_REQUEST_ID_LENGTH
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
        if valid {
            Ok(Self(value))
        } else {
            Err(Error::invalid_argument("Invalid request id"))
        }
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Abort handles of the requests that can currently be cancelled.
#[derive(Debug, Default)]
pub struct InflightRequests {
    handles: Mutex<HashMap<RequestId, AbortHandle>>,
}

impl InflightRequests {
    /// Registers `id` and returns `future` wrapped so that [`Self::cancel`]
    /// aborts it, resolving to [`Error::Cancelled`]. The id is registered
    /// immediately (not on first poll) and released when the returned future
    /// completes or is dropped. An id that is already in flight is rejected.
    pub fn run<'a, F: Future + 'a>(
        &'a self,
        id: RequestId,
        future: F,
    ) -> Result<impl Future<Output = Result<F::Output, Error>> + 'a, Error> {
        let (handle, registration) = AbortHandle::new_pair();
        {
            let mut handles = self.lock();
            if handles.contains_key(&id) {
                return Err(Error::invalid_argument("Request id is already in use"));
            }
            handles.insert(id.clone(), handle);
        }
        let guard = Registration { requests: self, id };
        Ok(async move {
            let result = Abortable::new(future, registration).await;
            drop(guard);
            result.map_err(|_aborted| Error::Cancelled)
        })
    }

    /// Aborts the request with this id. Returns `false` if it is not in
    /// flight (it already finished, or never started).
    pub fn cancel(&self, id: &RequestId) -> bool {
        match self.lock().remove(id) {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<RequestId, AbortHandle>> {
        // The map stays consistent even if a holder panicked.
        self.handles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Removes a request's id when its future finishes or is dropped.
struct Registration<'a> {
    requests: &'a InflightRequests,
    id: RequestId,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.requests.lock().remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use std::future::{pending, poll_fn, ready};
    use std::pin::pin;
    use std::task::Poll;

    use futures_util::FutureExt;

    use super::*;

    fn id(value: &str) -> RequestId {
        RequestId::try_from(value.to_owned()).unwrap()
    }

    #[test]
    fn validates_request_ids() {
        assert!(RequestId::try_from("3f2b8c1e-5a4d-4e7f-9b0a-1c2d3e4f5a6b".to_owned()).is_ok());
        assert!(RequestId::try_from(String::new()).is_err());
        assert!(RequestId::try_from("a/b".to_owned()).is_err());
        assert!(RequestId::try_from("a".repeat(MAX_REQUEST_ID_LENGTH + 1)).is_err());
        assert!(serde_json::from_str::<RequestId>(r#""../x""#).is_err());
    }

    #[test]
    fn completed_requests_return_their_output_and_release_the_id() {
        let requests = InflightRequests::default();
        let output = tauri::async_runtime::block_on(requests.run(id("a"), ready(7)).unwrap());
        assert_eq!(output.unwrap(), 7);
        assert!(
            !requests.cancel(&id("a")),
            "finished requests are not cancellable"
        );
        assert!(
            requests.run(id("a"), ready(())).is_ok(),
            "the id can be reused"
        );
    }

    #[test]
    fn cancelling_aborts_a_pending_request() {
        let requests = InflightRequests::default();
        let mut request = pin!(requests.run(id("a"), pending::<()>()).unwrap());
        assert!(request.as_mut().now_or_never().is_none());

        assert!(requests.cancel(&id("a")));
        assert!(matches!(
            request.now_or_never(),
            Some(Err(Error::Cancelled))
        ));
        assert!(!requests.cancel(&id("a")));
    }

    #[test]
    fn requests_cancelled_before_their_first_poll_never_run() {
        let requests = InflightRequests::default();
        let never_polled = poll_fn(|_| -> Poll<()> { unreachable!("cancelled before polling") });
        let request = requests.run(id("a"), never_polled).unwrap();
        assert!(requests.cancel(&id("a")));
        assert!(matches!(
            tauri::async_runtime::block_on(request),
            Err(Error::Cancelled)
        ));
    }

    #[test]
    fn rejects_ids_already_in_flight_and_releases_dropped_requests() {
        let requests = InflightRequests::default();
        let first = requests.run(id("a"), pending::<()>()).unwrap();
        assert!(requests.run(id("a"), pending::<()>()).is_err());
        drop(first);
        assert!(
            !requests.cancel(&id("a")),
            "dropping a request releases its id"
        );
        assert!(requests.run(id("a"), pending::<()>()).is_ok());
    }
}
