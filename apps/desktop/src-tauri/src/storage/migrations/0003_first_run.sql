-- First-run setup (see docs/first-run.md): whether each profile has been
-- through it. `pending` until it is completed or skipped; every profile,
-- including one from before this migration, starts out pending.

ALTER TABLE profiles ADD COLUMN first_run TEXT NOT NULL DEFAULT 'pending'
    CHECK (first_run IN ('pending', 'completed', 'skipped'));
