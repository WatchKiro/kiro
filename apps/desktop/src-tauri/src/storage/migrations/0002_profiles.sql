-- Profiles (see docs/profiles.md): people sharing a computer each get their
-- own watchlist and watch history. The library so far becomes the first
-- profile's, "Me". Timestamps are Unix milliseconds.

CREATE TABLE profiles (
    -- AUTOINCREMENT: a deleted profile's id is never given to a new one.
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    -- One of the built-in avatars (`profiles::AVATARS`).
    avatar       TEXT    NOT NULL,
    -- `profiles::pin` hash of the profile's PIN; NULL: no PIN.
    pin_hash     TEXT,
    created_at   INTEGER NOT NULL,
    -- When it was last switched to; the latest is opened at launch.
    last_used_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO profiles (id, name, avatar, created_at)
VALUES (1, 'Me', 'violet', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- Choices about profiles as a whole. One row.
CREATE TABLE profile_options (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    -- Show "Who's watching?" at launch when there is more than one profile.
    show_picker INTEGER NOT NULL
);

INSERT INTO profile_options (id, show_picker) VALUES (1, 1);

-- The library tables gain the profile they belong to (rebuilt, as SQLite
-- can't add a column to a primary key). Deleting a profile deletes its rows.

CREATE TABLE watchlist_by_profile (
    profile_id INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    type       TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    poster     TEXT,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (profile_id, type, id)
) WITHOUT ROWID;

INSERT INTO watchlist_by_profile (profile_id, type, id, name, poster, added_at)
SELECT 1, type, id, name, poster, added_at FROM watchlist;

DROP TABLE watchlist;
ALTER TABLE watchlist_by_profile RENAME TO watchlist;
CREATE INDEX watchlist_by_added_at ON watchlist (profile_id, added_at DESC);

CREATE TABLE history_by_profile (
    profile_id INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    type       TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    video_id   TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    poster     TEXT,
    season     INTEGER,
    episode    INTEGER,
    video_name TEXT,
    position   REAL    NOT NULL,
    duration   REAL    NOT NULL,
    completed  INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, type, id, video_id)
);

INSERT INTO history_by_profile (profile_id, type, id, video_id, name, poster, season, episode,
                                video_name, position, duration, completed, updated_at)
SELECT 1, type, id, video_id, name, poster, season, episode,
       video_name, position, duration, completed, updated_at
FROM history;

DROP TABLE history;
ALTER TABLE history_by_profile RENAME TO history;
CREATE INDEX history_by_updated_at ON history (profile_id, updated_at DESC);
