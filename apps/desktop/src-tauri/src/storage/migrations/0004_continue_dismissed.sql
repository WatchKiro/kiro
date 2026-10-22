-- Titles taken off Continue watching by hand (see docs/library.md). A title
-- stays off while its latest progress is no newer than `dismissed_at`: playing
-- it again (a new episode, for a series) brings it back. Its watch history is
-- kept. Timestamps are Unix milliseconds.

CREATE TABLE continue_dismissed (
    profile_id   INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    type         TEXT    NOT NULL,
    id           TEXT    NOT NULL,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, type, id)
) WITHOUT ROWID;
