const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DB_DIR = process.env.DB_PATH || './data'
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR)

const db = new Database(path.join(DB_DIR, 'usage.db'))

// WAL mode — concurrent reads + writes
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

// ── Schema (from schema.sql) ─────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT UNIQUE NOT NULL,
    phone       TEXT,
    password    TEXT NOT NULL,
    plan        TEXT DEFAULT 'free',
    active      INTEGER DEFAULT 1,
    avatar      TEXT,
    label       TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    key         TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    plan        TEXT DEFAULT 'free',
    limit_day   INTEGER DEFAULT 30,
    active      INTEGER DEFAULT 1,
    rotated_at  DATETIME,
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

  CREATE INDEX IF NOT EXISTS idx_keys_user  ON api_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_usage_key  ON usage(api_key);
  CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id);
`)

// ── Prepared statements ──────────────────
const stmts = {
  // Auth
  createUser:     db.prepare(`INSERT INTO users (email, phone, label, password, plan) VALUES (@email, @phone, @label, @password, @plan)`),
  getUserByEmail: db.prepare(`SELECT * FROM users WHERE email = ? AND active = 1`),
  getUserById:    db.prepare(`SELECT * FROM users WHERE id = ? AND active = 1`),

  // Keys
  createKey:     db.prepare(`INSERT INTO api_keys (key, user_id, plan, limit_day) VALUES (@key, @user_id, @plan, @limit_day)`),
  getKey:        db.prepare(`SELECT * FROM api_keys WHERE key = ? AND active = 1`),
  getKeyByUser:  db.prepare(`SELECT * FROM api_keys WHERE user_id = ? AND active = 1`),
  deactivateKey: db.prepare(`UPDATE api_keys SET active = 0 WHERE user_id = ?`),
  setRotatedAt:  db.prepare(`UPDATE api_keys SET rotated_at = CURRENT_TIMESTAMP WHERE key = ?`),

  // update user details
  updateProfile:  db.prepare(`UPDATE users SET phone = @phone, label = @label WHERE id = @id`),
  updatePassword: db.prepare(`UPDATE users SET password = @password WHERE id = @id`),

  // Usage — counts against user_id, not key
  logRequest: db.prepare(`
    INSERT INTO usage (user_id, api_key, endpoint, url, job_id, status, ip)
    VALUES (@user_id, @api_key, @endpoint, @url, @job_id, @status, @ip)
  `),
  countToday: db.prepare(`
    SELECT COUNT(*) as total FROM usage
    WHERE user_id = ? AND date(created_at) = date('now')
  `),

  // Stats
  statsForUser: db.prepare(`
    SELECT
      COUNT(*)                                                          as total_requests,
      SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) as today,
      SUM(CASE WHEN endpoint = '/download'          THEN 1 ELSE 0 END) as downloads,
      SUM(CASE WHEN endpoint = '/audio'             THEN 1 ELSE 0 END) as audio,
      SUM(CASE WHEN endpoint = '/info'              THEN 1 ELSE 0 END) as info,
      SUM(CASE WHEN status = 'error'                THEN 1 ELSE 0 END) as errors,
      MIN(created_at) as first_seen,
      MAX(created_at) as last_seen
    FROM usage WHERE user_id = ?
  `),
  recentForUser: db.prepare(`
    SELECT endpoint, url, status, job_id, ip, created_at FROM usage
    WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 20
  `),

  // Admin
  allUsersStats: db.prepare(`
    SELECT
      u.id, u.label, u.email, u.phone, u.plan, u.created_at,
      k.key, k.active as key_active, k.rotated_at,
      COUNT(us.id)                                                      as total_requests,
      SUM(CASE WHEN date(us.created_at) = date('now') THEN 1 ELSE 0 END) as today
    FROM users u
    LEFT JOIN api_keys k  ON k.user_id = u.id
    LEFT JOIN usage    us ON us.user_id = u.id
    GROUP BY u.id
    ORDER BY total_requests DESC
  `)
}

// ── Plan limits ──────────────────────────
const PLAN_LIMITS = { free: 30, starter: 200, pro: 1000, unlimited: 99999 }

// ── Atomic check + log ───────────────────
// ── Atomic check + log ───────────────────
const checkAndLog = db.transaction((userId, limit, data) => {
  const used = stmts.countToday.get(userId).total
  if (used >= limit) return false
  stmts.logRequest.run({
    user_id: userId,
    api_key: data.api_key,
    endpoint: data.endpoint,
    url: data.url,
    job_id: data.job_id,
    status: data.status,
    ip: data.ip
  })
  return true
})

// ── Key rotation (atomic) ────────────────
const rotateKey = db.transaction((userId, newKey) => {
  const current = stmts.getKeyByUser.get(userId)
  if (current?.rotated_at) {
    const hoursSince = (Date.now() - new Date(current.rotated_at)) / 1000 / 60 / 60
    if (hoursSince < 24) {
      return { ok: false, error: `Can rotate again in ${(24 - hoursSince).toFixed(1)} hours` }
    }
  }

  const user = stmts.getUserById.get(userId)
  const limit = PLAN_LIMITS[user.plan] || 30

  stmts.deactivateKey.run(userId)
  stmts.createKey.run({ key: newKey, user_id: userId, plan: user.plan, limit_day: limit })
  stmts.setRotatedAt.run(newKey)

  return { ok: true, key: newKey }
})

module.exports = {
  createUser:     (data)    => stmts.createUser.run(data),
  getUserByEmail: (email)   => stmts.getUserByEmail.get(email),
  getUserById:    (id)      => stmts.getUserById.get(id),
  createKey:      (data)    => stmts.createKey.run(data),
  getKey:         (key)     => stmts.getKey.get(key),
  getKeyByUser:   (userId)  => stmts.getKeyByUser.get(userId),
  updateProfile:  (data) => stmts.updateProfile.run(data),
  updatePassword: (data) => stmts.updatePassword.run(data),
  rotateKey,
  checkAndLog,
  countToday:     (userId)  => stmts.countToday.get(userId).total,
  statsForUser:   (userId)  => ({ ...stmts.statsForUser.get(userId), recent: stmts.recentForUser.all(userId) }),
  allUsersStats:  ()        => stmts.allUsersStats.all(),
  PLAN_LIMITS,
  db
}