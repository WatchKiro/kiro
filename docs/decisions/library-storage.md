# Library storage: SQLite

**Decision:** the watchlist and watch history live in an on-device SQLite
database (`kiro.sqlite3` in the app data directory), accessed from the Rust core
with [`rusqlite`](https://crates.io/crates/rusqlite) and its `bundled` SQLite.

## Why not JSON files

Installed addons are a JSON file (`addons.json`) because that list is tiny, read
once and rewritten whole on the rare change. Library data is different:

- **History grows without bound.** Every movie and episode played adds a row.
  A JSON file would be read, parsed and rewritten in full on every progress
  save (every ~10 s during playback).
- **It needs queries:** recently watched titles (latest video per title),
  "Continue watching" (unfinished, most recent first), all progress for one
  title. SQLite answers these from indexes; with JSON each is a full scan in
  Rust.
- **Durability.** SQLite's journal (WAL mode) makes each write atomic without
  the temp-file-and-rename dance, and a crash mid-save can't lose the file.

## Why rusqlite (not sqlx)

- Synchronous and small: commands are already `async` and run off the main
  thread, and one mutex-guarded connection serialises the (tiny, local)
  queries. sqlx would bring an async runtime layer and compile-time query
  checking that needs a database at build time.
- `bundled` compiles SQLite in, so every platform runs the same, current
  version with no system dependency.

## How it works

- `storage::database::Database` opens the file on first use (a fresh install
  doesn't touch the disk at startup) and applies pending migrations from
  `src-tauri/src/storage/migrations/`, tracked in `PRAGMA user_version`. Each
  migration runs in its own transaction. Never edit a released migration; add
  a new one.
- A database written by a newer Kiro (higher `user_version`) is refused, not
  downgraded. A file that isn't a usable database is renamed to
  `kiro.sqlite3.corrupt` and replaced, so it never blocks startup.
- `library::Library` owns the tables: `watchlist` (one row per title) and
  `history` (one row per played video, upserted with the latest position).
  Rows keep a snapshot of the title's name and poster so the Library renders
  without asking an addon.
- Every row belongs to a profile (`profile_id`, leading both primary keys and
  indexes; migration `0002_profiles.sql`). `Library::profile` gives a
  `ProfileLibrary` whose queries see one profile's rows only, and commands use
  the active profile's. See [profiles.md](../profiles.md).
- Commands validate input at the boundary (`library::types`) and never expose
  SQL errors or paths to the renderer.
