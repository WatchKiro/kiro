//! Profiles: people sharing a computer each get their own library and
//! settings, like profiles on a TV app.
//!
//! - **Per profile:** the watchlist and watch history (rows keyed by
//!   `profile_id` in the [`Database`], see `migrations/0002_profiles.sql`)
//!   and the settings file (playback, subtitles, streams, Discover's rows,
//!   Discord).
//! - **Shared:** the installed addons and their order (one setup per
//!   computer), and the caches.
//!
//! One profile is *active*: library and settings commands act on it alone.
//! It starts as the one used last. A profile can have a 4-digit [`Pin`] that
//! locks switching into it: a convenience lock, not security.
//!
//! Each profile also records whether it has been through the first-run setup
//! ([`FirstRun`], `migrations/0003_first_run.sql`).
//!
//! Settings files: the first profile keeps `settings.json` in the config
//! directory, where it was before profiles, so an older file is the first
//! profile's unchanged. Every other profile has
//! `profiles/<id>/settings.json`.
//!
//! - [`pin`] — PIN validation, hashing and verification

pub mod pin;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub use pin::Pin;

use crate::core::error::{Error, Result};
use crate::library::now_millis;
use crate::settings::SettingsStore;
use crate::storage::database::Database;

/// Most profiles one computer can have.
pub const MAX_PROFILES: usize = 8;
/// Longest profile name, in characters.
pub const MAX_NAME_CHARS: usize = 20;
/// The built-in avatars: a colour each, showing the name's first letter.
/// Mirrored by `AVATARS` in `apps/desktop/src/features/profiles/profiles-data.ts`.
pub const AVATARS: [&str; 8] = [
    "violet", "blue", "teal", "green", "amber", "orange", "rose", "slate",
];
/// The first profile, made from the library as it was before profiles.
pub const FIRST_PROFILE: ProfileId = ProfileId(1);

/// A profile's id. Deserializes only from a positive number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "i64")]
pub struct ProfileId(i64);

impl ProfileId {
    pub fn get(self) -> i64 {
        self.0
    }
}

impl TryFrom<i64> for ProfileId {
    type Error = Error;

    fn try_from(id: i64) -> Result<Self> {
        if id >= 1 {
            Ok(Self(id))
        } else {
            Err(Error::invalid_argument("Invalid profile"))
        }
    }
}

/// A profile name: trimmed, 1 to [`MAX_NAME_CHARS`] characters, with no
/// control or text-direction characters (which could make a name look like
/// another).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct ProfileName(String);

impl ProfileName {
    pub fn parse(name: &str) -> Result<Self> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::invalid_argument("Give the profile a name"));
        }
        if name.chars().count() > MAX_NAME_CHARS {
            return Err(Error::invalid_argument(format!(
                "A profile name can be at most {MAX_NAME_CHARS} characters"
            )));
        }
        if name.chars().any(|c| c.is_control() || is_direction_mark(c)) {
            return Err(Error::invalid_argument(
                "A profile name can't contain control characters",
            ));
        }
        Ok(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ProfileName {
    type Error = Error;

    fn try_from(name: String) -> Result<Self> {
        Self::parse(&name)
    }
}

/// Characters that reorder or hide text: bidirectional embeddings, overrides
/// and isolates, direction marks, and zero-width spaces. (The zero-width
/// joiner stays: emoji sequences use it.)
fn is_direction_mark(c: char) -> bool {
    matches!(
        c,
        '\u{061C}'
            | '\u{200B}'
            | '\u{200C}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// One of the built-in [`AVATARS`].
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct Avatar(String);

impl Avatar {
    pub fn parse(avatar: &str) -> Result<Self> {
        if AVATARS.contains(&avatar) {
            Ok(Self(avatar.to_owned()))
        } else {
            Err(Error::invalid_argument("Unknown avatar"))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Avatar {
    type Error = Error;

    fn try_from(avatar: String) -> Result<Self> {
        Self::parse(&avatar)
    }
}

/// Where a profile is with the first-run setup (docs/first-run.md). It shows
/// while `Pending`, and never again once completed or skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FirstRun {
    Pending,
    Completed,
    Skipped,
}

impl FirstRun {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Skipped => "skipped",
        }
    }

    /// The stored value; anything unknown reads as done, so a damaged row
    /// never keeps showing the setup.
    fn from_stored(value: &str) -> Self {
        match value {
            "pending" => Self::Pending,
            "skipped" => Self::Skipped,
            _ => Self::Completed,
        }
    }
}

/// How the first-run setup ended: the only values the renderer may record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FirstRunOutcome {
    Completed,
    Skipped,
}

impl From<FirstRunOutcome> for FirstRun {
    fn from(outcome: FirstRunOutcome) -> Self {
        match outcome {
            FirstRunOutcome::Completed => Self::Completed,
            FirstRunOutcome::Skipped => Self::Skipped,
        }
    }
}

/// A profile as the renderer sees it: never its PIN hash.
///
/// Mirrored by `Profile` in `apps/desktop/src/services/native.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: ProfileId,
    pub name: String,
    pub avatar: String,
    /// Switching into it asks for its PIN.
    pub has_pin: bool,
    /// Unix milliseconds.
    pub created_at: i64,
    pub first_run: FirstRun,
}

/// Every profile, oldest first, and which is active.
///
/// Mirrored by `ProfilesOverview` in `apps/desktop/src/services/native.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesOverview {
    pub profiles: Vec<Profile>,
    pub active: ProfileId,
    /// Show "Who's watching?" at launch (when there is more than one).
    pub show_picker: bool,
}

/// The active profile and its settings file.
#[derive(Debug, Clone)]
struct Active {
    id: ProfileId,
    settings: Arc<SettingsStore>,
}

/// The profiles in the database, and the active one.
#[derive(Debug)]
pub struct Profiles {
    database: Arc<Database>,
    config_dir: PathBuf,
    /// Resolved on first use (the profile used last). Taken before the
    /// database's lock, never after, by everything that holds both.
    active: RwLock<Option<Active>>,
    /// Current time in Unix milliseconds; replaced in tests.
    clock: fn() -> i64,
}

impl Profiles {
    pub fn new(database: Arc<Database>, config_dir: &Path) -> Self {
        Self {
            database,
            config_dir: config_dir.to_owned(),
            active: RwLock::new(None),
            clock: now_millis,
        }
    }

    /// The active profile.
    pub fn active(&self) -> Result<ProfileId> {
        Ok(self.active_profile()?.id)
    }

    /// The active profile's settings.
    pub fn settings(&self) -> Result<Arc<SettingsStore>> {
        Ok(self.active_profile()?.settings)
    }

    fn active_profile(&self) -> Result<Active> {
        if let Some(active) = self
            .active
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            return Ok(active.clone());
        }
        let mut active = self.active.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(active) = active.as_ref() {
            return Ok(active.clone());
        }
        let id = self.database.with(|connection| {
            connection
                .query_row(
                    "SELECT id FROM profiles ORDER BY last_used_at DESC, id LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?
                .map(ProfileId)
                .ok_or_else(|| Error::Internal("there are no profiles".into()))
        })?;
        Ok(active.insert(self.activate(id)).clone())
    }

    fn activate(&self, id: ProfileId) -> Active {
        Active {
            id,
            settings: Arc::new(SettingsStore::new(&self.settings_dir(id))),
        }
    }

    /// Where a profile's `settings.json` is.
    fn settings_dir(&self, id: ProfileId) -> PathBuf {
        if id == FIRST_PROFILE {
            self.config_dir.clone()
        } else {
            self.config_dir.join("profiles").join(id.0.to_string())
        }
    }

    /// Forgets a profile's settings.
    fn remove_settings(&self, id: ProfileId) -> Result<()> {
        let removed = if id == FIRST_PROFILE {
            fs::remove_file(self.config_dir.join(crate::settings::FILE_NAME))
        } else {
            fs::remove_dir_all(self.settings_dir(id))
        };
        match removed {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    pub fn overview(&self) -> Result<ProfilesOverview> {
        let active = self.active()?;
        self.database
            .with(|connection| overview(connection, active))
    }

    /// Adds a profile, with the default settings and an empty library.
    pub fn create(
        &self,
        name: ProfileName,
        avatar: Avatar,
        pin: Option<Pin>,
    ) -> Result<ProfilesOverview> {
        let active = self.active()?;
        let pin_hash = pin.as_ref().map(Pin::hash).transpose()?;
        let now = (self.clock)();
        let (id, overview) = self.database.with(|connection| {
            let transaction = connection.transaction()?;
            let profiles = list(&transaction)?;
            if profiles.len() >= MAX_PROFILES {
                return Err(Error::invalid_argument(format!(
                    "There can be at most {MAX_PROFILES} profiles"
                )));
            }
            check_unique(&profiles, &name, None)?;
            transaction.execute(
                "INSERT INTO profiles (name, avatar, pin_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![name.as_str(), avatar.as_str(), pin_hash, now],
            )?;
            let id = ProfileId(transaction.last_insert_rowid());
            let overview = overview(&transaction, active)?;
            transaction.commit()?;
            Ok((id, overview))
        })?;
        // Ids are never reused, but a database replaced after damage starts
        // counting again: don't hand a new profile someone else's settings.
        self.remove_settings(id)?;
        Ok(overview)
    }

    pub fn rename(
        &self,
        id: ProfileId,
        name: ProfileName,
        pin: Option<&Pin>,
    ) -> Result<ProfilesOverview> {
        self.change(id, pin, |transaction| {
            check_unique(&list(transaction)?, &name, Some(id))?;
            transaction.execute(
                "UPDATE profiles SET name = ?1 WHERE id = ?2",
                params![name.as_str(), id.0],
            )?;
            Ok(())
        })
    }

    pub fn set_avatar(
        &self,
        id: ProfileId,
        avatar: Avatar,
        pin: Option<&Pin>,
    ) -> Result<ProfilesOverview> {
        self.change(id, pin, |transaction| {
            transaction.execute(
                "UPDATE profiles SET avatar = ?1 WHERE id = ?2",
                params![avatar.as_str(), id.0],
            )?;
            Ok(())
        })
    }

    /// Sets a new PIN, or removes it (`None`).
    pub fn set_pin(
        &self,
        id: ProfileId,
        new_pin: Option<Pin>,
        pin: Option<&Pin>,
    ) -> Result<ProfilesOverview> {
        let hash = new_pin.as_ref().map(Pin::hash).transpose()?;
        self.change(id, pin, |transaction| {
            transaction.execute(
                "UPDATE profiles SET pin_hash = ?1 WHERE id = ?2",
                params![hash, id.0],
            )?;
            Ok(())
        })
    }

    /// Changes profile `id`. A profile with a PIN can be changed from inside
    /// it (it was unlocked to get there), or with its PIN.
    fn change(
        &self,
        id: ProfileId,
        pin: Option<&Pin>,
        change: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<()>,
    ) -> Result<ProfilesOverview> {
        let active = self.active()?;
        self.database.with(|connection| {
            let transaction = connection.transaction()?;
            let hash = pin_hash(&transaction, id)?;
            if id != active {
                unlock(hash.as_deref(), pin)?;
            }
            change(&transaction)?;
            let overview = overview(&transaction, active)?;
            transaction.commit()?;
            Ok(overview)
        })
    }

    /// Deletes a profile with its library and settings. The last profile, and
    /// the active one, can't be deleted.
    ///
    /// A profile's PIN isn't needed: deleting shows nothing of it, and it is
    /// how a profile whose PIN was forgotten is got rid of. The renderer asks
    /// for its name to be typed instead.
    pub fn delete(&self, id: ProfileId) -> Result<ProfilesOverview> {
        self.active()?;
        // Held throughout, so the profile can't be switched to meanwhile.
        let active = self.active.write().unwrap_or_else(PoisonError::into_inner);
        let active_id = active
            .as_ref()
            .map(|active| active.id)
            .ok_or_else(|| Error::Internal("no active profile".into()))?;
        if id == active_id {
            return Err(Error::invalid_argument(
                "Switch to another profile to delete this one",
            ));
        }
        let overview = self.database.with(|connection| {
            let transaction = connection.transaction()?;
            pin_hash(&transaction, id)?;
            let count: i64 =
                transaction.query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))?;
            if count <= 1 {
                return Err(Error::invalid_argument("The last profile can't be deleted"));
            }
            // The library goes with it (ON DELETE CASCADE).
            transaction.execute("DELETE FROM profiles WHERE id = ?1", [id.0])?;
            let overview = overview(&transaction, active_id)?;
            transaction.commit()?;
            Ok(overview)
        })?;
        drop(active);
        self.remove_settings(id)?;
        Ok(overview)
    }

    /// Fails unless `pin` unlocks profile `id` (or it has no PIN).
    pub fn check_pin(&self, id: ProfileId, pin: Option<&Pin>) -> Result<()> {
        let hash = self.database.with(|connection| pin_hash(connection, id))?;
        unlock(hash.as_deref(), pin)
    }

    /// Makes `id` the active profile, and the one opened next launch. A
    /// profile with a PIN needs it, even if it's already active (unlocking it
    /// at launch).
    pub fn switch(&self, id: ProfileId, pin: Option<&Pin>) -> Result<ProfilesOverview> {
        let mut active = self.active.write().unwrap_or_else(PoisonError::into_inner);
        let now = (self.clock)();
        let overview = self.database.with(|connection| {
            let transaction = connection.transaction()?;
            let hash = pin_hash(&transaction, id)?;
            unlock(hash.as_deref(), pin)?;
            transaction.execute(
                "UPDATE profiles SET last_used_at = ?1 WHERE id = ?2",
                params![now, id.0],
            )?;
            let overview = overview(&transaction, id)?;
            transaction.commit()?;
            Ok(overview)
        })?;
        if active.as_ref().is_none_or(|current| current.id != id) {
            *active = Some(self.activate(id));
        }
        Ok(overview)
    }

    /// Records how the active profile's first-run setup ended, so it doesn't
    /// show again for it.
    pub fn finish_first_run(&self, outcome: FirstRunOutcome) -> Result<ProfilesOverview> {
        let active = self.active()?;
        self.database.with(|connection| {
            connection.execute(
                "UPDATE profiles SET first_run = ?1 WHERE id = ?2",
                params![FirstRun::from(outcome).as_str(), active.0],
            )?;
            overview(connection, active)
        })
    }

    /// Whether "Who's watching?" shows at launch.
    pub fn set_show_picker(&self, show: bool) -> Result<ProfilesOverview> {
        let active = self.active()?;
        self.database.with(|connection| {
            connection.execute("UPDATE profile_options SET show_picker = ?1", [show])?;
            overview(connection, active)
        })
    }
}

fn list(connection: &Connection) -> Result<Vec<Profile>> {
    let mut statement = connection.prepare(
        "SELECT id, name, avatar, pin_hash IS NOT NULL, created_at, first_run
         FROM profiles ORDER BY id",
    )?;
    let profiles = statement
        .query_map([], |row| {
            Ok(Profile {
                id: ProfileId(row.get(0)?),
                name: row.get(1)?,
                avatar: row.get(2)?,
                has_pin: row.get(3)?,
                created_at: row.get(4)?,
                first_run: FirstRun::from_stored(&row.get::<_, String>(5)?),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(profiles)
}

fn overview(connection: &Connection, active: ProfileId) -> Result<ProfilesOverview> {
    let show_picker = connection
        .query_row("SELECT show_picker FROM profile_options", [], |row| {
            row.get(0)
        })
        .optional()?
        .unwrap_or(true);
    Ok(ProfilesOverview {
        profiles: list(connection)?,
        active,
        show_picker,
    })
}

/// No two profiles share a name, ignoring case.
fn check_unique(profiles: &[Profile], name: &ProfileName, except: Option<ProfileId>) -> Result<()> {
    let lower = name.as_str().to_lowercase();
    if profiles
        .iter()
        .any(|profile| Some(profile.id) != except && profile.name.to_lowercase() == lower)
    {
        return Err(Error::invalid_argument(
            "Another profile already has that name",
        ));
    }
    Ok(())
}

/// The profile's PIN hash, if it has a PIN. Fails if there is no such profile.
fn pin_hash(connection: &Connection, id: ProfileId) -> Result<Option<String>> {
    connection
        .query_row(
            "SELECT pin_hash FROM profiles WHERE id = ?1",
            [id.0],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::invalid_argument("That profile doesn't exist"))
}

/// Passes a profile without a PIN, or one whose PIN was given.
fn unlock(hash: Option<&str>, pin: Option<&Pin>) -> Result<()> {
    match (hash, pin) {
        (None, _) => Ok(()),
        (Some(_), None) => Err(Error::PinRequired),
        (Some(hash), Some(pin)) if pin.matches(hash) => Ok(()),
        (Some(_), Some(_)) => Err(Error::WrongPin),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use serde_json::json;

    use super::*;
    use crate::library::{Library, PlaybackProgress, TitleSnapshot};
    use crate::settings::Settings;
    use crate::storage::database::tests::temp_dir;

    fn ticking_clock() -> i64 {
        static NOW: AtomicI64 = AtomicI64::new(1_700_000_000_000);
        NOW.fetch_add(1_000, Ordering::Relaxed)
    }

    struct Fixture {
        profiles: Profiles,
        library: Library,
        dir: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = temp_dir("profiles");
            let database = Arc::new(Database::new(&dir.join("data")));
            let mut profiles = Profiles::new(database.clone(), &dir.join("config"));
            profiles.clock = ticking_clock;
            Self {
                profiles,
                library: Library::new(database),
                dir,
            }
        }

        /// A fresh `Profiles` on the same files: the app launched again.
        fn relaunch(&self) -> Profiles {
            Profiles::new(
                Arc::new(Database::new(&self.dir.join("data"))),
                &self.dir.join("config"),
            )
        }

        fn create(&self, name: &str) -> ProfileId {
            self.create_with_pin(name, None)
        }

        fn create_with_pin(&self, name: &str, pin: Option<&str>) -> ProfileId {
            let overview = self
                .profiles
                .create(
                    ProfileName::parse(name).unwrap(),
                    Avatar::parse("teal").unwrap(),
                    pin.map(|pin| Pin::parse(pin).unwrap()),
                )
                .unwrap();
            overview
                .profiles
                .iter()
                .find(|profile| profile.name == name)
                .unwrap()
                .id
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn pin(pin: &str) -> Pin {
        Pin::parse(pin).unwrap()
    }

    fn names(overview: &ProfilesOverview) -> Vec<&str> {
        overview.profiles.iter().map(|p| p.name.as_str()).collect()
    }

    fn title(id: &str) -> TitleSnapshot {
        serde_json::from_value(json!({ "type": "movie", "id": id, "name": id })).unwrap()
    }

    fn progress(id: &str) -> PlaybackProgress {
        serde_json::from_value(json!({
            "title": title(id), "video": { "id": id }, "position": 100.0, "duration": 1000.0,
        }))
        .unwrap()
    }

    #[test]
    fn starts_with_the_first_profile() {
        let fixture = Fixture::new();
        let overview = fixture.profiles.overview().unwrap();
        assert_eq!(overview.active, FIRST_PROFILE);
        assert_eq!(names(&overview), ["Me"]);
        assert_eq!(overview.profiles[0].avatar, "violet");
        assert!(!overview.profiles[0].has_pin);
        assert!(overview.show_picker);
    }

    #[test]
    fn validates_names() {
        for valid in [
            "Sam",
            "  Grandma  ",
            "Zoë",
            "👩‍👧",
            &"x".repeat(MAX_NAME_CHARS),
        ] {
            assert!(ProfileName::parse(valid).is_ok(), "{valid:?}");
        }
        assert_eq!(
            ProfileName::parse("  Grandma ").unwrap().as_str(),
            "Grandma"
        );
        for invalid in [
            "",
            "   ",
            "a\nb",
            "tab\there",
            "nul\0",
            "\u{202E}evil",
            "zero\u{200B}width",
            &"x".repeat(MAX_NAME_CHARS + 1),
        ] {
            assert_eq!(
                ProfileName::parse(invalid).unwrap_err().code(),
                "INVALID_ARGUMENT",
                "{invalid:?}"
            );
        }
        assert!(Avatar::parse("violet").is_ok());
        assert!(Avatar::parse("https://img.example/me.png").is_err());
        assert!(serde_json::from_value::<ProfileId>(json!(0)).is_err());
        assert!(serde_json::from_value::<ProfileId>(json!(-1)).is_err());
    }

    #[test]
    fn creates_up_to_the_limit_with_distinct_names() {
        let fixture = Fixture::new();
        for n in 2..=MAX_PROFILES {
            fixture.create(&format!("Profile {n}"));
        }
        let error = fixture
            .profiles
            .create(
                ProfileName::parse("One too many").unwrap(),
                Avatar::parse("rose").unwrap(),
                None,
            )
            .unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGUMENT");
        assert_eq!(
            fixture.profiles.overview().unwrap().profiles.len(),
            MAX_PROFILES
        );

        let fixture = Fixture::new();
        let error = fixture
            .profiles
            .create(
                ProfileName::parse("ME").unwrap(),
                Avatar::parse("rose").unwrap(),
                None,
            )
            .unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGUMENT", "names are unique");
        let sam = fixture.create("Sam");
        assert!(
            fixture
                .profiles
                .rename(sam, ProfileName::parse("me").unwrap(), None)
                .is_err()
        );
        // Renaming to itself (a change of case) is fine.
        let overview = fixture
            .profiles
            .rename(sam, ProfileName::parse("SAM").unwrap(), None)
            .unwrap();
        assert_eq!(names(&overview), ["Me", "SAM"]);
    }

    #[test]
    fn switching_changes_the_active_profile_and_is_remembered() {
        let fixture = Fixture::new();
        let sam = fixture.create("Sam");
        assert_eq!(fixture.profiles.active().unwrap(), FIRST_PROFILE);
        let overview = fixture.profiles.switch(sam, None).unwrap();
        assert_eq!(overview.active, sam);
        assert_eq!(fixture.profiles.active().unwrap(), sam);
        // The next launch opens the profile used last.
        assert_eq!(fixture.relaunch().active().unwrap(), sam);
        fixture.profiles.switch(FIRST_PROFILE, None).unwrap();
        assert_eq!(fixture.relaunch().active().unwrap(), FIRST_PROFILE);

        let error = fixture.profiles.switch(ProfileId(99), None).unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGUMENT");
        assert_eq!(fixture.profiles.active().unwrap(), FIRST_PROFILE);
    }

    #[test]
    fn one_profiles_library_never_shows_in_another() {
        let fixture = Fixture::new();
        let sam = fixture.create("Sam");
        let me = fixture.library.profile(FIRST_PROFILE);
        let theirs = fixture.library.profile(sam);

        me.add_to_watchlist(title("tt1")).unwrap();
        me.record_progress(progress("tt1")).unwrap();
        me.record_progress(progress("tt2")).unwrap();
        theirs.record_progress(progress("tt3")).unwrap();

        assert!(theirs.watchlist().unwrap().is_empty());
        let watched = |library: &crate::library::ProfileLibrary<'_>| -> Vec<String> {
            library
                .history(None)
                .unwrap()
                .iter()
                .map(|title| title.latest.title.id.as_str().to_owned())
                .collect()
        };
        assert_eq!(watched(&theirs), ["tt3"]);
        let mut mine = watched(&me);
        mine.sort();
        assert_eq!(mine, ["tt1", "tt2"]);
        assert_eq!(theirs.continue_watching(None).unwrap().len(), 1);
        let state = theirs
            .title_state(&title("tt1").r#type, &title("tt1").id)
            .unwrap();
        assert!(!state.in_watchlist && state.progress.is_empty());

        // The same video in both: separate progress.
        theirs.record_progress(progress("tt1")).unwrap();
        theirs.clear_history().unwrap();
        assert_eq!(watched(&me).len(), 2, "clearing one profile's history");
        theirs.add_to_watchlist(title("tt1")).unwrap();
        me.remove_from_watchlist(&title("tt1").r#type, &title("tt1").id)
            .unwrap();
        assert_eq!(theirs.watchlist().unwrap().len(), 1);
    }

    #[test]
    fn settings_are_per_profile_and_the_first_keeps_the_old_file() {
        let fixture = Fixture::new();
        let config = fixture.dir.join("config");
        // A settings file from before profiles.
        fs::create_dir_all(&config).unwrap();
        fs::write(
            config.join("settings.json"),
            json!({ "version": 3, "playback": { "volume": 60 } }).to_string(),
        )
        .unwrap();
        assert_eq!(
            fixture
                .profiles
                .settings()
                .unwrap()
                .get()
                .unwrap()
                .playback
                .volume,
            60
        );

        let sam = fixture.create("Sam");
        fixture.profiles.switch(sam, None).unwrap();
        let theirs = fixture.profiles.settings().unwrap();
        assert_eq!(theirs.get().unwrap(), Settings::default());
        let mut changed = Settings::default();
        changed.playback.volume = 20;
        changed.general.discord_presence = true;
        theirs.set(changed.clone()).unwrap();
        assert!(
            config
                .join("profiles")
                .join(sam.get().to_string())
                .join("settings.json")
                .exists()
        );

        fixture.profiles.switch(FIRST_PROFILE, None).unwrap();
        let mine = fixture.profiles.settings().unwrap().get().unwrap();
        assert_eq!(mine.playback.volume, 60);
        assert!(!mine.general.discord_presence);
        fixture.profiles.switch(sam, None).unwrap();
        assert_eq!(fixture.profiles.settings().unwrap().get().unwrap(), changed);
    }

    #[test]
    fn a_pin_locks_switching_and_changes_from_outside() {
        let fixture = Fixture::new();
        let kid = fixture.create("Kid");
        let parent = fixture.create_with_pin("Parent", Some("4321"));
        let overview = fixture.profiles.overview().unwrap();
        assert!(
            overview
                .profiles
                .iter()
                .any(|p| p.id == parent && p.has_pin)
        );
        fixture.profiles.switch(kid, None).unwrap();

        let error = fixture.profiles.switch(parent, None).unwrap_err();
        assert_eq!(error.code(), "PIN_REQUIRED");
        let error = fixture
            .profiles
            .switch(parent, Some(&pin("1234")))
            .unwrap_err();
        assert_eq!(error.code(), "WRONG_PIN");
        assert_eq!(fixture.profiles.active().unwrap(), kid, "still the kid's");

        // From another profile, a locked profile can't be changed without its PIN.
        for error in [
            fixture
                .profiles
                .rename(parent, ProfileName::parse("Ha").unwrap(), None)
                .unwrap_err(),
            fixture
                .profiles
                .set_avatar(parent, Avatar::parse("rose").unwrap(), None)
                .unwrap_err(),
            fixture.profiles.set_pin(parent, None, None).unwrap_err(),
            fixture
                .profiles
                .set_pin(parent, None, Some(&pin("0000")))
                .unwrap_err(),
        ] {
            assert!(
                matches!(error.code(), "PIN_REQUIRED" | "WRONG_PIN"),
                "{error}"
            );
        }
        assert!(
            fixture
                .profiles
                .overview()
                .unwrap()
                .profiles
                .iter()
                .any(|p| p.id == parent && p.has_pin)
        );

        fixture.profiles.switch(parent, Some(&pin("4321"))).unwrap();
        assert_eq!(fixture.profiles.active().unwrap(), parent);
        // Unlocked: at launch, the active profile still needs its PIN.
        assert_eq!(
            fixture.relaunch().switch(parent, None).unwrap_err().code(),
            "PIN_REQUIRED"
        );
        // From inside it, it can be changed without the PIN.
        fixture
            .profiles
            .set_pin(parent, Some(pin("1111")), None)
            .unwrap();
        fixture.profiles.switch(kid, None).unwrap();
        assert!(fixture.profiles.switch(parent, Some(&pin("4321"))).is_err());
        fixture.profiles.switch(parent, Some(&pin("1111"))).unwrap();
        let overview = fixture.profiles.set_pin(parent, None, None).unwrap();
        assert!(!overview.profiles.iter().any(|p| p.has_pin));
        fixture.profiles.switch(kid, None).unwrap();
        fixture.profiles.switch(parent, None).unwrap();
    }

    #[test]
    fn deleting_takes_the_library_and_settings_but_never_the_last_or_active_profile() {
        let fixture = Fixture::new();
        let sam = fixture.create("Sam");
        fixture.profiles.switch(sam, None).unwrap();
        fixture
            .profiles
            .settings()
            .unwrap()
            .set(Settings::default())
            .unwrap();
        let settings = fixture
            .dir
            .join("config")
            .join("profiles")
            .join(sam.get().to_string());
        assert!(settings.exists());
        fixture
            .library
            .profile(sam)
            .add_to_watchlist(title("tt9"))
            .unwrap();
        fixture
            .library
            .profile(FIRST_PROFILE)
            .add_to_watchlist(title("tt1"))
            .unwrap();

        let error = fixture.profiles.delete(sam).unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGUMENT", "the active profile");
        fixture.profiles.switch(FIRST_PROFILE, None).unwrap();
        let overview = fixture.profiles.delete(sam).unwrap();
        assert_eq!(names(&overview), ["Me"]);
        assert!(!settings.exists());
        assert!(fixture.library.profile(sam).watchlist().unwrap().is_empty());
        assert_eq!(
            fixture
                .library
                .profile(FIRST_PROFILE)
                .watchlist()
                .unwrap()
                .len(),
            1
        );
        // Its rows are gone from the database, not just hidden.
        let rows: i64 = fixture
            .profiles
            .database
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM watchlist", [], |row| row.get(0))?))
            .unwrap();
        assert_eq!(rows, 1);

        let error = fixture.profiles.delete(FIRST_PROFILE).unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGUMENT");
        let error = fixture.profiles.delete(sam).unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGUMENT", "already gone");

        // A new profile never gets the deleted one's id.
        let next = fixture.create("Sam");
        assert!(next.get() > sam.get());
    }

    #[test]
    fn a_profile_whose_pin_was_forgotten_can_still_be_deleted() {
        let fixture = Fixture::new();
        let locked = fixture.create_with_pin("Locked", Some("8642"));
        fixture
            .library
            .profile(locked)
            .add_to_watchlist(title("tt1"))
            .unwrap();
        let overview = fixture.profiles.delete(locked).unwrap();
        assert_eq!(names(&overview), ["Me"]);
        assert!(
            fixture
                .library
                .profile(locked)
                .watchlist()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_first_profile_can_be_deleted_and_its_settings_go_too() {
        let fixture = Fixture::new();
        fixture
            .profiles
            .settings()
            .unwrap()
            .set(Settings::default())
            .unwrap();
        let sam = fixture.create("Sam");
        fixture.profiles.switch(sam, None).unwrap();
        fixture.profiles.delete(FIRST_PROFILE).unwrap();
        assert!(!fixture.dir.join("config").join("settings.json").exists());
        assert_eq!(fixture.relaunch().active().unwrap(), sam);
    }

    #[test]
    fn remembers_whether_to_show_the_picker() {
        let fixture = Fixture::new();
        assert!(!fixture.profiles.set_show_picker(false).unwrap().show_picker);
        assert!(!fixture.relaunch().overview().unwrap().show_picker);
        assert!(fixture.profiles.set_show_picker(true).unwrap().show_picker);
    }

    #[test]
    fn first_run_is_per_profile_and_stays_finished() {
        let fixture = Fixture::new();
        let first_run = |overview: &ProfilesOverview| -> Vec<FirstRun> {
            overview.profiles.iter().map(|p| p.first_run).collect()
        };
        assert_eq!(
            first_run(&fixture.profiles.overview().unwrap()),
            [FirstRun::Pending]
        );

        let sam = fixture.create("Sam");
        let overview = fixture
            .profiles
            .finish_first_run(FirstRunOutcome::Skipped)
            .unwrap();
        // Only the active profile's changes; a new one starts pending.
        assert_eq!(first_run(&overview), [FirstRun::Skipped, FirstRun::Pending]);

        fixture.profiles.switch(sam, None).unwrap();
        fixture
            .profiles
            .finish_first_run(FirstRunOutcome::Completed)
            .unwrap();
        assert_eq!(
            first_run(&fixture.relaunch().overview().unwrap()),
            [FirstRun::Skipped, FirstRun::Completed]
        );
    }

    #[test]
    fn only_completed_or_skipped_can_be_recorded() {
        for valid in ["completed", "skipped"] {
            assert!(serde_json::from_value::<FirstRunOutcome>(json!(valid)).is_ok());
        }
        for invalid in [json!("pending"), json!("done"), json!(1), json!(null)] {
            assert!(serde_json::from_value::<FirstRunOutcome>(invalid).is_err());
        }
    }

    #[test]
    fn serializes_without_the_pin() {
        let fixture = Fixture::new();
        fixture.create_with_pin("Sam", Some("9999"));
        let json = serde_json::to_value(fixture.profiles.overview().unwrap()).unwrap();
        assert_eq!(
            json["profiles"][1],
            json!({
                "id": 2,
                "name": "Sam",
                "avatar": "teal",
                "hasPin": true,
                "createdAt": json["profiles"][1]["createdAt"],
                "firstRun": "pending",
            })
        );
        assert_eq!(json["active"], 1);
        assert_eq!(json["showPicker"], true);
        assert!(!json.to_string().contains("pbkdf2"));
    }
}
