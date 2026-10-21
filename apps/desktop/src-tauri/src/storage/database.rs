//! The on-device SQLite database (`kiro.sqlite3` in the data directory).
//!
//! Opened on first use, so launching the app does not touch the filesystem
//! until a feature needs it. Opening applies any pending [`MIGRATIONS`]; the
//! schema version is SQLite's `user_version`.
//!
//! One connection, behind a mutex: library queries are small and local, and
//! serialising them keeps writes simple. Callers run on Tauri's async command
//! threads, never the main thread.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, ErrorCode};

use crate::core::error::{Error, Result};

pub const FILE_NAME: &str = "kiro.sqlite3";

/// Schema migrations, applied in order. Never edit or remove a released
/// migration: add a new one. Migration `n` (1-based) moves `user_version`
/// from `n - 1` to `n`.
const MIGRATIONS: &[&str] = &[
    include_str!("migrations/0001_library.sql"),
    include_str!("migrations/0002_profiles.sql"),
];

#[derive(Debug)]
pub struct Database {
    path: PathBuf,
    connection: Mutex<Option<Connection>>,
}

impl Database {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
            connection: Mutex::new(None),
        }
    }

    /// Runs `f` with the connection, opening and migrating the database first
    /// if this is the first use.
    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut guard = self.connection.lock().unwrap_or_else(|e| e.into_inner());
        let connection = match guard.as_mut() {
            Some(connection) => connection,
            None => guard.insert(open(&self.path)?),
        };
        f(connection)
    }
}

/// Opens the database at `path`, creating it if needed. A file that is not a
/// usable SQLite database is moved aside (not deleted) and replaced, so a
/// damaged file never stops the app from starting.
fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    match open_and_migrate(path) {
        Err(Error::Database(error)) if is_damaged(&error) => {
            set_aside(path)?;
            open_and_migrate(path)
        }
        result => result,
    }
}

fn open_and_migrate(path: &Path) -> Result<Connection> {
    let mut connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    migrate(&mut connection)?;
    Ok(connection)
}

/// Applies pending migrations, each in its own transaction.
fn migrate(connection: &mut Connection) -> Result<()> {
    let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let current = usize::try_from(current).unwrap_or(usize::MAX);
    if current > MIGRATIONS.len() {
        // Written by a newer Kiro. Refuse rather than risk corrupting it.
        return Err(Error::Internal(format!(
            "database schema version {current} is newer than this build supports"
        )));
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let transaction = connection.transaction()?;
        transaction.execute_batch(sql)?;
        transaction.pragma_update(None, "user_version", schema_version(index + 1))?;
        transaction.commit()?;
    }
    Ok(())
}

fn schema_version(migrations: usize) -> i64 {
    i64::try_from(migrations).expect("migration count fits in i64")
}

fn is_damaged(error: &rusqlite::Error) -> bool {
    error
        .sqlite_error_code()
        .is_some_and(|code| matches!(code, ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt))
}

fn set_aside(path: &Path) -> Result<()> {
    fs::rename(path, path.with_extension("sqlite3.corrupt"))?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        match fs::remove_file(PathBuf::from(sidecar)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// A fresh, empty directory under the system temp dir.
    pub(crate) fn temp_dir(name: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kiro-{name}-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// The tables of the latest schema (`sqlite_sequence` is SQLite's, for
    /// `profiles`' AUTOINCREMENT).
    const LATEST_TABLES: [&str; 5] = [
        "history",
        "profile_options",
        "profiles",
        "sqlite_sequence",
        "watchlist",
    ];

    fn user_version(database: &Database) -> i64 {
        database
            .with(|c| Ok(c.query_row("PRAGMA user_version", [], |row| row.get(0))?))
            .unwrap()
    }

    fn tables(database: &Database) -> Vec<String> {
        database
            .with(|c| {
                let mut statement =
                    c.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")?;
                let names = statement
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(names)
            })
            .unwrap()
    }

    #[test]
    fn is_created_lazily_and_migrated_to_the_latest_version() {
        let dir = temp_dir("database");
        let database = Database::new(&dir);
        assert!(!dir.exists(), "constructing must not touch the filesystem");

        assert_eq!(user_version(&database), schema_version(MIGRATIONS.len()));
        assert!(dir.join(FILE_NAME).exists());
        assert_eq!(tables(&database), LATEST_TABLES);

        // Reopening (a restart) does not re-run migrations.
        drop(database);
        let reopened = Database::new(&dir);
        assert_eq!(user_version(&reopened), schema_version(MIGRATIONS.len()));
        // Closed first: Windows can't delete an open file.
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn applies_only_pending_migrations() {
        let dir = temp_dir("database");
        fs::create_dir_all(&dir).unwrap();
        // A database from before any migration, with unrelated data.
        let connection = Connection::open(dir.join(FILE_NAME)).unwrap();
        connection
            .execute_batch("CREATE TABLE keep (value TEXT); INSERT INTO keep VALUES ('x');")
            .unwrap();
        drop(connection);

        let database = Database::new(&dir);
        assert_eq!(user_version(&database), schema_version(MIGRATIONS.len()));
        let mut expected = LATEST_TABLES.to_vec();
        expected.insert(1, "keep");
        assert_eq!(tables(&database), expected);
        drop(database);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_a_database_from_a_newer_build() {
        let dir = temp_dir("database");
        fs::create_dir_all(&dir).unwrap();
        let connection = Connection::open(dir.join(FILE_NAME)).unwrap();
        connection
            .pragma_update(None, "user_version", schema_version(MIGRATIONS.len() + 1))
            .unwrap();
        drop(connection);

        let error = Database::new(&dir).with(|_| Ok(())).unwrap_err();
        assert!(matches!(error, Error::Internal(_)), "{error}");
        // The file is left alone.
        assert!(dir.join(FILE_NAME).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sets_a_damaged_file_aside() {
        let dir = temp_dir("database");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(FILE_NAME),
            b"definitely not sqlite, but long enough to look like a header",
        )
        .unwrap();

        let database = Database::new(&dir);
        assert_eq!(user_version(&database), schema_version(MIGRATIONS.len()));
        assert!(dir.join("kiro.sqlite3.corrupt").exists());
        drop(database);
        fs::remove_dir_all(dir).unwrap();
    }

    /// A database as Kiro 0.1 left it (schema version 1), with a library
    /// shaped like a real one: a watchlist, films and a series' episodes,
    /// finished and unfinished, with and without posters and episode names.
    fn version_1_database(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        let mut connection = Connection::open(dir.join(FILE_NAME)).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .unwrap();
        let transaction = connection.transaction().unwrap();
        transaction.execute_batch(MIGRATIONS[0]).unwrap();
        transaction.pragma_update(None, "user_version", 1).unwrap();
        transaction
            .execute_batch(
                "INSERT INTO watchlist VALUES
                     ('movie', 'tt15239678', 'Dune: Part Two', 'https://img.example/dune.jpg', 1700000000000),
                     ('series', 'tt11280740', 'Severance', NULL, 1700000500000);
                 INSERT INTO history VALUES
                     ('movie', 'tt1375666', 'tt1375666', 'Inception', 'https://img.example/inception.jpg',
                      NULL, NULL, NULL, 4310.5, 8880.0, 0, 1700001000000),
                     ('series', 'tt0903747', 'tt0903747:2:3', 'Breaking Bad', NULL,
                      2, 3, 'Bit by a Dead Bee', 2820.0, 2820.0, 1, 1700002000000),
                     ('series', 'tt0903747', 'tt0903747:2:4', 'Breaking Bad', NULL,
                      2, 4, 'Down', 1820.25, 2820.0, 0, 1700003000000);",
            )
            .unwrap();
        transaction.commit().unwrap();
    }

    fn dump(database: &Database, sql: &str) -> Vec<Vec<String>> {
        database
            .with(|c| {
                let mut statement = c.prepare(sql)?;
                let columns = statement.column_count();
                let rows = statement
                    .query_map([], |row| {
                        (0..columns)
                            .map(|i| {
                                Ok(match row.get_ref(i)? {
                                    rusqlite::types::ValueRef::Null => "NULL".to_owned(),
                                    rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                                    rusqlite::types::ValueRef::Real(n) => n.to_string(),
                                    rusqlite::types::ValueRef::Text(text) => {
                                        String::from_utf8_lossy(text).into_owned()
                                    }
                                    rusqlite::types::ValueRef::Blob(_) => "BLOB".to_owned(),
                                })
                            })
                            .collect()
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(rows)
            })
            .unwrap()
    }

    #[test]
    fn profiles_migration_moves_the_library_into_the_first_profile_intact() {
        let dir = temp_dir("database");
        version_1_database(&dir);
        // Opened lazily: still at version 1 until first used.
        let migrated = Database::new(&dir);
        // Read at version 1 by hand, as the migration must keep it.
        let watchlist_before = {
            let connection = Connection::open(dir.join(FILE_NAME)).unwrap();
            let mut statement = connection
                .prepare("SELECT type, id, name, poster, added_at FROM watchlist ORDER BY type, id")
                .unwrap();
            let rows: Vec<String> = statement
                .query_map([], |row| {
                    Ok(format!(
                        "{}|{}|{}|{:?}|{}",
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?
                    ))
                })
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            rows
        };
        assert_eq!(watchlist_before.len(), 2);

        // Opening migrates.
        assert_eq!(user_version(&migrated), schema_version(MIGRATIONS.len()));
        assert_eq!(
            dump(&migrated, "SELECT id, name, avatar, pin_hash FROM profiles"),
            [["1", "Me", "violet", "NULL"]]
        );
        assert_eq!(
            dump(&migrated, "SELECT show_picker FROM profile_options"),
            [["1"]]
        );
        let watchlist_after: Vec<String> = dump(
            &migrated,
            "SELECT type, id, name, poster, added_at, profile_id FROM watchlist ORDER BY type, id",
        )
        .into_iter()
        .map(|row| {
            assert_eq!(row[5], "1", "in the first profile");
            let poster = if row[3] == "NULL" {
                "None".to_owned()
            } else {
                format!("Some({:?})", row[3])
            };
            format!("{}|{}|{}|{}|{}", row[0], row[1], row[2], poster, row[4])
        })
        .collect();
        assert_eq!(watchlist_after, watchlist_before);
        assert_eq!(
            dump(
                &migrated,
                "SELECT profile_id, type, id, video_id, name, poster, season, episode, video_name,
                        position, duration, completed, updated_at
                 FROM history ORDER BY updated_at"
            ),
            [
                [
                    "1",
                    "movie",
                    "tt1375666",
                    "tt1375666",
                    "Inception",
                    "https://img.example/inception.jpg",
                    "NULL",
                    "NULL",
                    "NULL",
                    "4310.5",
                    "8880",
                    "0",
                    "1700001000000"
                ],
                [
                    "1",
                    "series",
                    "tt0903747",
                    "tt0903747:2:3",
                    "Breaking Bad",
                    "NULL",
                    "2",
                    "3",
                    "Bit by a Dead Bee",
                    "2820",
                    "2820",
                    "1",
                    "1700002000000"
                ],
                [
                    "1",
                    "series",
                    "tt0903747",
                    "tt0903747:2:4",
                    "Breaking Bad",
                    "NULL",
                    "2",
                    "4",
                    "Down",
                    "1820.25",
                    "2820",
                    "0",
                    "1700003000000"
                ],
            ]
        );
        // The indexes lead with the profile.
        assert_eq!(
            dump(
                &migrated,
                "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL
                 ORDER BY name"
            )
            .into_iter()
            .map(|row| row[0].clone())
            .collect::<Vec<_>>(),
            ["history_by_updated_at", "watchlist_by_added_at"]
        );
        // Deleting the profile would take its library with it.
        assert_eq!(
            dump(
                &migrated,
                "SELECT \"table\", on_delete FROM pragma_foreign_key_list('history')"
            ),
            [["profiles", "CASCADE"]]
        );
        assert!(
            dump(&migrated, "PRAGMA foreign_key_check").is_empty(),
            "no orphaned rows"
        );
        drop(migrated);
        fs::remove_dir_all(dir).unwrap();
    }
}
