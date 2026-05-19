  CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT UNIQUE NOT NULL,
  phone       TEXT,
  password    TEXT NOT NULL,        -- bcrypt hashed, never plain
  plan        TEXT DEFAULT 'free',
  active      INTEGER DEFAULT 1,
  label       TEXT,
  avatar      TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_keys (
  key         TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  plan        TEXT DEFAULT 'free',
  limit_day   INTEGER DEFAULT 30,
  active      INTEGER DEFAULT 1,
  rotated_at  DATETIME,             -- tracks last rotation
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
  
  CREATE TABLE IF NOT EXISTS usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),   
    api_key     TEXT NOT NULL,
    endpoint    TEXT NOT NULL,
    url         TEXT,
    job_id      TEXT,
    status      TEXT DEFAULT 'ok',
    ip          TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_usage_key  ON usage(api_key);
  CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);