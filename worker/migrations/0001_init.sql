-- Raw checks, one row per check, kept for 48 hours.
CREATE TABLE checks (
  t       INTEGER PRIMARY KEY,                  -- when the check started (Unix ms)
  up      INTEGER NOT NULL CHECK (up IN (0, 1)),
  ms      INTEGER,                              -- response time, only when up
  code    INTEGER,                              -- HTTP status; NULL if nothing answered
  details TEXT                                  -- sanitized JSON from the API, only when up
);

-- The rollup: one row per UTC day, kept for 90 days. Updated on every
-- check, so nothing has to be "rolled up" later and old raw rows can just
-- be deleted.
CREATE TABLE days (
  date   TEXT PRIMARY KEY,                      -- YYYY-MM-DD (UTC)
  total  INTEGER NOT NULL,
  up     INTEGER NOT NULL,
  ms_sum INTEGER NOT NULL DEFAULT 0,
  ms_n   INTEGER NOT NULL DEFAULT 0
);

-- Exactly what the page needs, rebuilt after every check. A page view
-- reads this one row and nothing else.
CREATE TABLE summary (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);
