//! A profile's PIN: four digits that lock switching into it.
//!
//! A convenience lock for a shared computer (keeping a child out of a
//! parent's profile), not security: the library is a file on the computer.
//! Still, the PIN is only stored as a salted PBKDF2-HMAC-SHA256 hash, compared
//! in constant time, and never logged (its `Debug` hides it).

use std::fmt;
use std::num::NonZeroU32;

use ring::rand::{SecureRandom, SystemRandom};
use ring::{digest, pbkdf2};
use serde::Deserialize;

use crate::core::error::{Error, Result};

pub const PIN_DIGITS: usize = 4;

const ALGORITHM: pbkdf2::Algorithm = pbkdf2::PBKDF2_HMAC_SHA256;
const SCHEME: &str = "pbkdf2-sha256";
const ITERATIONS: u32 = 100_000;
const SALT_BYTES: usize = 16;
const HASH_BYTES: usize = digest::SHA256_OUTPUT_LEN;

/// Four ASCII digits, as typed. Deserializes only from a valid PIN.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct Pin(String);

impl Pin {
    pub fn parse(pin: &str) -> Result<Self> {
        if pin.len() == PIN_DIGITS && pin.bytes().all(|b| b.is_ascii_digit()) {
            Ok(Self(pin.to_owned()))
        } else {
            Err(Error::invalid_argument(format!(
                "A PIN is {PIN_DIGITS} digits"
            )))
        }
    }

    /// A new salted hash of this PIN, to store.
    pub fn hash(&self) -> Result<String> {
        let mut salt = [0u8; SALT_BYTES];
        SystemRandom::new()
            .fill(&mut salt)
            .map_err(|_| Error::Internal("no random numbers for a PIN salt".into()))?;
        let mut hash = [0u8; HASH_BYTES];
        pbkdf2::derive(
            ALGORITHM,
            iterations(ITERATIONS),
            &salt,
            self.0.as_bytes(),
            &mut hash,
        );
        Ok(format!(
            "{SCHEME}${ITERATIONS}${}${}",
            hex(&salt),
            hex(&hash)
        ))
    }

    /// Whether this is the PIN `stored` (from [`Self::hash`]) was made from.
    /// A stored value that can't be read matches nothing.
    pub fn matches(&self, stored: &str) -> bool {
        let mut parts = stored.split('$');
        let (Some(SCHEME), Some(rounds), Some(salt), Some(hash), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            return false;
        };
        let (Some(rounds), Some(salt), Some(hash)) = (
            rounds.parse::<u32>().ok().and_then(NonZeroU32::new),
            unhex(salt),
            unhex(hash),
        ) else {
            return false;
        };
        pbkdf2::verify(ALGORITHM, rounds, &salt, self.0.as_bytes(), &hash).is_ok()
    }
}

impl TryFrom<String> for Pin {
    type Error = Error;

    fn try_from(pin: String) -> Result<Self> {
        Self::parse(&pin)
    }
}

impl fmt::Debug for Pin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Pin(****)")
    }
}

fn iterations(n: u32) -> NonZeroU32 {
    NonZeroU32::new(n).expect("iterations are not zero")
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_four_digits() {
        for valid in ["0000", "1234", "9870"] {
            assert!(Pin::parse(valid).is_ok(), "{valid}");
        }
        for invalid in ["", "123", "12345", "12a4", "١٢٣٤", " 1234", "12 4", "-123"] {
            assert_eq!(
                Pin::parse(invalid).unwrap_err().code(),
                "INVALID_ARGUMENT",
                "{invalid:?}"
            );
        }
        assert!(serde_json::from_value::<Pin>(serde_json::json!(1234)).is_err());
    }

    #[test]
    fn hashes_with_a_fresh_salt_and_verifies() {
        let pin = Pin::parse("2468").unwrap();
        let first = pin.hash().unwrap();
        let second = pin.hash().unwrap();
        assert_ne!(first, second, "salted");
        assert!(!first.contains("2468"), "the PIN itself isn't stored");
        assert!(first.starts_with("pbkdf2-sha256$100000$"));
        assert!(pin.matches(&first));
        assert!(pin.matches(&second));
        assert!(!Pin::parse("2469").unwrap().matches(&first));
    }

    #[test]
    fn unreadable_hashes_match_nothing() {
        let pin = Pin::parse("0000").unwrap();
        let good = pin.hash().unwrap();
        for bad in [
            String::new(),
            "0000".to_owned(),
            good.replacen("pbkdf2-sha256", "md5", 1),
            good.replacen("100000", "0", 1),
            format!("{good}$extra"),
            good[..good.len() - 1].to_owned(),
            good.replacen('$', "$zz", 1),
        ] {
            assert!(!pin.matches(&bad), "{bad}");
        }
    }

    #[test]
    fn debug_never_shows_the_pin() {
        let pin = Pin::parse("1357").unwrap();
        assert_eq!(format!("{pin:?}"), "Pin(****)");
        assert!(!format!("{:?}", Some(&pin)).contains("1357"));
    }
}
