-- Per-service history: same pattern as checks/days, one row per service.
-- A service counts as up for a check only if the server answered AND said
-- that service's unit is active AND it answered its own probe.

CREATE TABLE service_checks (
  t       INTEGER NOT NULL,                     -- same t as the row in checks
  service TEXT NOT NULL,
  up      INTEGER NOT NULL CHECK (up IN (0, 1)),
  PRIMARY KEY (t, service)
);

CREATE TABLE service_days (
  date    TEXT NOT NULL,                        -- YYYY-MM-DD (UTC)
  service TEXT NOT NULL,
  total   INTEGER NOT NULL,
  up      INTEGER NOT NULL,
  PRIMARY KEY (date, service)
);
