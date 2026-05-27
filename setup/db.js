const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DB_DIR = path.join(__dirname, '..', 'data')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR)

const db = new Database(path.join(DB_DIR, 'usage.db'))

// WAL mode — concurrent reads + writes
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

// ── Schema (from schema.sql) ─────────────
try {
  const schemaPath = path.join(__dirname, 'schema.sql')
  const schemaSQL = fs.readFileSync(schemaPath, 'utf-8')
  db.exec(schemaSQL)
  console.log('✅ Schema loaded from:', schemaPath)
} catch (err) {
  console.error('❌ Schema load error:', err.message)
}

// ── Updated Plan Limits based on realistic pricing ──
const PLAN_LIMITS = { 
  free: 10,        // 10 requests/day
  pro: 500,        // 500 requests/day ($9.99/month)
  business: 5000,  // 5,000 requests/day ($49.99/month)
  enterprise: 999999  // Unlimited (custom pricing)
}

// ── Prepared statements ──────────────────
const stmts = {
// Pending registrations (OTP flow)
  upsertPending: db.prepare(`
    INSERT INTO pending_registrations (email, password, phone, label, otp, expires_at)
    VALUES (@email, @password, @phone, @label, @otp, @expires_at)
    ON CONFLICT(email) DO UPDATE SET
      password   = excluded.password,
      phone      = excluded.phone,
      label      = excluded.label,
      otp        = excluded.otp,
      expires_at = excluded.expires_at
  `),
  getPending:    db.prepare(`SELECT * FROM pending_registrations WHERE email = ?`),
  deletePending: db.prepare(`DELETE FROM pending_registrations WHERE email = ?`),
  pruneExpired:  db.prepare(`DELETE FROM pending_registrations WHERE expires_at < ?`),

  // Auth
  createUser:     db.prepare(`INSERT INTO users (email, phone, label, password, plan) VALUES (@email, @phone, @label, @password, @plan)`),
  getUserByEmail: db.prepare(`SELECT * FROM users WHERE email = ? AND active = 1`),
  getUserById:    db.prepare(`SELECT * FROM users WHERE id = ? AND active = 1`),

  // ✅ SAFE - exclude password field
  getAllUsers:    db.prepare(`SELECT id, email, phone, plan, active, avatar, label, created_at FROM users WHERE active = 1 ORDER BY created_at DESC`),

  // Keys
  createKey:     db.prepare(`INSERT INTO api_keys (key, user_id, plan, limit_day) VALUES (@key, @user_id, @plan, @limit_day)`),
  getKey:        db.prepare(`SELECT * FROM api_keys WHERE key = ? AND active = 1`),
  getKeyByUser:  db.prepare(`SELECT * FROM api_keys WHERE user_id = ? AND active = 1`),
  deactivateKey: db.prepare(`UPDATE api_keys SET active = 0 WHERE user_id = ?`),
  setRotatedAt:  db.prepare(`UPDATE api_keys SET rotated_at = CURRENT_TIMESTAMP WHERE key = ?`),

  // update user details
  updateProfile:  db.prepare(`UPDATE users SET phone = @phone, label = @label WHERE id = @id`),
  updatePassword: db.prepare(`UPDATE users SET password = @password WHERE id = @id`),
  
  // ── Admin: Change user plan ──────────────────
  updateUserPlan: db.prepare(` UPDATE users SET plan = @plan WHERE id = @id AND active = 1 `),
  
  // ── Admin: Update API key limits when plan changes ──
  updateKeyLimits: db.prepare(`
    UPDATE api_keys 
    SET plan = @plan, limit_day = @limit_day 
    WHERE user_id = @user_id AND active = 1
  `),

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
      k.key, k.active as key_active, k.rotated_at, k.limit_day as daily_limit,
      COUNT(us.id)                                                      as total_requests,
      SUM(CASE WHEN date(us.created_at) = date('now') THEN 1 ELSE 0 END) as today
    FROM users u
    LEFT JOIN api_keys k  ON k.user_id = u.id AND k.active = 1
    LEFT JOIN usage    us ON us.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `),
 
  allKeysStats: db.prepare(`
    SELECT
      u.id, u.label, u.email, u.phone, u.plan, u.created_at,
      k.key, k.active as key_active, k.rotated_at,
      COUNT(us.id) as total_requests,
      SUM(CASE WHEN date(us.created_at) = date('now') THEN 1 ELSE 0 END) as today
    FROM users u
    LEFT JOIN api_keys k ON k.user_id = u.id
    LEFT JOIN usage us ON us.user_id = u.id
    GROUP BY u.id
    ORDER BY total_requests DESC
  `)

}

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
  const limit = PLAN_LIMITS[user.plan] || 10

  stmts.deactivateKey.run(userId)
  stmts.createKey.run({ key: newKey, user_id: userId, plan: user.plan, limit_day: limit })
  stmts.setRotatedAt.run(newKey)

  return { ok: true, key: newKey }
})

// ── Admin: Change user plan (atomic transaction) ──
const changeUserPlan = db.transaction((userId, newPlan) => {
  // Validate plan exists
  if (!PLAN_LIMITS[newPlan]) {
    return { ok: false, error: `Invalid plan. Must be one of: ${Object.keys(PLAN_LIMITS).join(', ')}` }
  }
  
  // Get user
  const user = stmts.getUserById.get(userId)
  if (!user) {
    return { ok: false, error: 'User not found' }
  }
  
  // Update user's plan
  stmts.updateUserPlan.run({ id: userId, plan: newPlan })
  
  // Update their active API key limits
  const newLimit = PLAN_LIMITS[newPlan]
  stmts.updateKeyLimits.run({ user_id: userId, plan: newPlan, limit_day: newLimit })
  
  return { 
    ok: true, 
    user: { id: userId, email: user.email, old_plan: user.plan, new_plan: newPlan, new_daily_limit: newLimit }
  }
})

// ── Admin: Get all users with their plans ──
const getAllUsersWithPlans = () => {
  const users = stmts.getAllUsers.all()
  return users.map(user => {
    const key = stmts.getKeyByUser.get(user.id)
    return {
      ...user,
      api_key: key?.key,
      daily_limit: key?.limit_day || PLAN_LIMITS[user.plan],
      used_today: stmts.countToday.get(user.id).total
    }
  })
}

module.exports = {
  upsertPending:  (data)  => stmts.upsertPending.run(data),
  getPending:     (email) => stmts.getPending.get(email),
  deletePending:  (email) => stmts.deletePending.run(email),
  pruneExpired:   ()      => stmts.pruneExpired.run(Date.now()),
  createUser:     (data)    => stmts.createUser.run(data),
  getUserByEmail: (email)   => stmts.getUserByEmail.get(email),
  getUserById:    (id)      => stmts.getUserById.get(id),
  createKey:      (data)    => stmts.createKey.run(data),
  getKey:         (key)     => stmts.getKey.get(key),
  getKeyByUser:   (userId)  => stmts.getKeyByUser.get(userId),
  updateProfile:  (data) => stmts.updateProfile.run(data),
  allKeysStats:  ()      => stmts.allKeysStats.all(),
  updatePassword: (data) => stmts.updatePassword.run(data),
  rotateKey, changeUserPlan, getAllUsersWithPlans, checkAndLog,
  countToday:     (userId)  => stmts.countToday.get(userId).total,
  statsForUser:   (userId)  => ({ ...stmts.statsForUser.get(userId), recent: stmts.recentForUser.all(userId) }),
  allUsersStats:  ()        => stmts.allUsersStats.all(),
  PLAN_LIMITS,
  db
}