-- Watchlist and watch history (see docs/decisions/library-storage.md).
--
-- Both tables keep a snapshot of the title's display data so the Library can
-- render without asking an addon. Timestamps are Unix milliseconds.

CREATE TABLE watchlist (
    type     TEXT    NOT NULL,
    id       TEXT    NOT NULL,
    name     TEXT    NOT NULL,
    poster   TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (type, id)
) WITHOUT ROWID;

CREATE INDEX watchlist_by_added_at ON watchlist (added_at DESC);

-- One row per watched video: a movie (video_id = id) or an episode.
CREATE TABLE history (
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
    PRIMARY KEY (type, id, video_id)
);

CREATE INDEX history_by_updated_at ON history (updated_at DESC);
