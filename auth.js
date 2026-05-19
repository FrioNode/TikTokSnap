const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const db = require('./db')

const router = express.Router()
const JWT_SECRET = process.env.JWT_SECRET 
const SALT_ROUNDS = 10

// ── Helper — generate API key ────────────
function generateKey() {
  return `tk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

// ── Helper — sign JWT ────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, plan: user.plan },
    JWT_SECRET,
    { expiresIn: '7d' }
  )
}

// ── Middleware — verify JWT ──────────────
function requireAuth(req, res, next) {
  const header = req.headers['authorization']
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' })
  }

  const token = header.split(' ')[1]
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    const user = db.getUserById(decoded.id)
    if (!user) return res.status(401).json({ error: 'User not found or deactivated' })
    req.user = user
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// ─────────────────────────────────────────
// POST /auth/register
// body: { email, password, phone? }
// ─────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, phone } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' })
  }

  // Check if email already exists
  const existing = db.getUserByEmail(email.toLowerCase())
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' })
  }

  try {
    const hashed = await bcrypt.hash(password, SALT_ROUNDS)

    // Create user
    const result = db.createUser({
      email: email.toLowerCase(),
      phone: phone || null,
      label: label || null,
      password: hashed,
      plan: 'free'
    })

    const userId = result.lastInsertRowid

    // Auto-generate API key on registration
    const key = generateKey()
    db.createKey({
      key,
      user_id: userId,
      plan: 'free',
      limit_day: db.PLAN_LIMITS.free
    })

    const user = db.getUserById(userId)
    const token = signToken(user)

    res.status(201).json({
      message: 'Account created',
      token,
      api_key: key,
      plan: 'free',
      limit_day: db.PLAN_LIMITS.free
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Registration failed' })
  }
})

// ─────────────────────────────────────────
// POST /auth/login
// body: { email, password }
// ─────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' })
  }

  const user = db.getUserByEmail(email.toLowerCase())
  if (!user) {
    // Same message for both — don't leak which exists
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  const match = await bcrypt.compare(password, user.password)
  if (!match) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  const keyRecord = db.getKeyByUser(user.id)
  const token = signToken(user)

  res.json({
    token,
    api_key: keyRecord?.key || null,
    plan: user.plan,
    limit_day: db.PLAN_LIMITS[user.plan] || 30
  })
})

// ─────────────────────────────────────────
// GET /auth/me  →  profile + usage stats
// requires: Authorization: Bearer <token>
// ─────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const keyRecord = db.getKeyByUser(req.user.id)
  const stats = db.statsForUser(req.user.id)
  const usedToday = db.countToday(req.user.id)
  const user = db.getUserById(req.user.id) 

  res.json({
    id: req.user.id,
    email: req.user.email,
    phone: user.phone,
    plan: req.user.plan,
    label: user.label,
    api_key: keyRecord?.key || null,
    limit_day: db.PLAN_LIMITS[req.user.plan] || 30,
    used_today: usedToday,
    remaining_today: (db.PLAN_LIMITS[req.user.plan] || 30) - usedToday,
    rotated_at: keyRecord?.rotated_at || null,
    stats
  })
})

// ─────────────────────────────────────────
// POST /auth/rotate-key
// requires: Authorization: Bearer <token>
// ─────────────────────────────────────────
router.post('/rotate-key', requireAuth, (req, res) => {
  const newKey = generateKey()
  const result = db.rotateKey(req.user.id, newKey)

  if (!result.ok) {
    return res.status(429).json({ error: result.error })
  }

  res.json({
    message: 'Key rotated successfully',
    api_key: result.key,
    note: 'Your old key is now invalid. Usage count is unchanged.'
  })
})

router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current password and new password are required' })
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' })
  }

  const match = await bcrypt.compare(current_password, req.user.password)
  if (!match) {
    return res.status(401).json({ error: 'Current password is incorrect' })
  }

  try {
    const hashed = await bcrypt.hash(new_password, SALT_ROUNDS)
    db.updatePassword({ id: req.user.id, password: hashed })
    res.json({ message: 'Password changed successfully' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not change password' })
  }
}
)

router.post('/update-profile', requireAuth, (req, res) => {
  const { phone, label } = req.body

  try {
    db.updateProfile({ id: req.user.id, phone: phone || req.user.phone, label: label || req.user.label })
    res.json({ message: 'Profile updated successfully' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not update profile' })
  }
})

module.exports = { router, requireAuth }