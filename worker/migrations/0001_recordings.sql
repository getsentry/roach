-- One row for each recording. The recording itself is in R2, at
-- `<tenant>/<key>`. `last_used` is in milliseconds since the epoch. The
-- scheduled handler deletes rows that nobody used within the TTL.
CREATE TABLE recordings (
  tenant TEXT NOT NULL,
  key TEXT NOT NULL,
  rule TEXT NOT NULL,
  session TEXT,
  last_used INTEGER NOT NULL,
  PRIMARY KEY (tenant, key)
) WITHOUT ROWID;

CREATE INDEX recordings_last_used ON recordings (last_used);

-- The hash of each part of each recording, for miss diagnosis. A miss
-- looks up its own parts in `parts_lookup`, so it reads only the rows that
-- are equal, not every recording of the rule.
CREATE TABLE parts (
  tenant TEXT NOT NULL,
  key TEXT NOT NULL,
  rule TEXT NOT NULL,
  part TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (tenant, key, part),
  FOREIGN KEY (tenant, key) REFERENCES recordings (tenant, key) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX parts_lookup ON parts (tenant, rule, part, hash);
