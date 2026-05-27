require('dotenv').config()
const express = require('express')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const rateLimit = require('express-rate-limit')
const downloadQueue = require('./setup/queue')
const db = require('./setup/db')

const { router: authRouter, requireAuth } = require('./setup/auth')

const checkAndLog = db.checkAndLog

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.use('/auth', authRouter)

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  skip: (req) => {
    return req.path.startsWith('/job/') || req.path === '/health'
  },
  message: { error: 'Rate limit hit. Upgrade your plan.' }
})
app.use(limiter)

// ─────────────────────────────────────────
// Clean TikTok URLs by extracting the core URL from messy copied text
// ─────────────────────────────────────────
function cleanTikTokUrl(rawUrl) {
  if (!rawUrl) return null
  const urlPattern = /(https?:\/\/)(www\.)?(tiktok\.com\/@[\w.]+\/video\/\d+|vm\.tiktok\.com\/\w+|vt\.tiktok\.com\/\w+)/i
  const match = rawUrl.match(urlPattern)
  
  if (match) {
    let cleanUrl = match[0]
    try {
      const urlObj = new URL(cleanUrl)
      cleanUrl = `${urlObj.origin}${urlObj.pathname}`
    } catch (e) {
      // If URL parsing fails, just use the matched URL
    }
    return cleanUrl
  }
  return rawUrl
}

function isValidTikTokUrl(url) {
  return /tiktok\.com\/@[\w.]+\/video\/\d+|vm\.tiktok\.com\/\w+|vt\.tiktok\.com\/\w+/.test(url)
}

// ── Auth middleware (NO logging yet - that happens in route handlers) ────
app.use((req, res, next) => {
  if (req.path === '/health') return next()
  // Don't count job polling or downloads against quota
  if (req.path.startsWith('/job/') || req.path.startsWith('/file/')) return next()
  // Auth routes use Bearer tokens, not x-api-key
  if (req.path.startsWith('/auth/')) return next()
  // ⭐ SKIP admin routes - they use x-admin-key instead
  if (req.path.startsWith('/admin/')) return next()

  const key = req.headers['x-api-key']
  if (!key) return res.status(401).json({ error: 'Missing x-api-key header' })

  const keyRecord = db.getKey(key)
  if (!keyRecord) return res.status(401).json({ error: 'Invalid API key' })

  // Check if user has quota (don't log yet)
  if (db.countToday(keyRecord.user_id) >= keyRecord.limit_day) {
    return res.status(429).json({
      error: 'Daily limit reached',
      plan: keyRecord.plan,
      limit: keyRecord.limit_day
    })
  }

  // Attach key info to request
  req.apiKey = key
  req.keyRecord = keyRecord
  req.ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress

  next()
})

// ─────────────────────────────────────────
// Shared: Validate video metadata early
// Reused by /info, /download, /audio
// ─────────────────────────────────────────
function validateVideoMetadata(url) {
  return new Promise((resolve, reject) => {
    exec(`yt-dlp --dump-json --no-playlist "${url}"`, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Video not found or inaccessible: ${stderr}`))
        return
      }
      try {
        const info = JSON.parse(stdout)
        resolve(info)
      } catch {
        reject(new Error('Failed to parse video metadata'))
      }
    })
  })
}

// ─────────────────────────────────────────
// POST /info
// Validates & returns metadata (logged & billable on success)
// ─────────────────────────────────────────
app.post('/info', async (req, res) => {
  const { url } = req.body
  if (!url || !isValidTikTokUrl(url)) {
    return res.status(400).json({ error: 'Invalid TikTok URL' })
  }

  try {
    const info = await validateVideoMetadata(url)
    
    // ✅ LOG ONLY ON SUCCESS
    checkAndLog(req.keyRecord.user_id, req.keyRecord.limit_day, {
      api_key: req.apiKey,
      endpoint: '/info',
      url: cleanTikTokUrl(url),
      job_id: null,
      status: 'ok',
      ip: req.ip
    })
    
    res.json({
      id: info.id,
      title: info.title,
      author: info.uploader,
      duration: info.duration,
      views: info.view_count,
      likes: info.like_count,
      thumbnail: info.thumbnail,
      uploadDate: info.upload_date
    })
  } catch (err) {
    // ❌ VALIDATION FAILED - NO LOG, NO BILL
    res.status(503).json({ error: err.message })
  }
})

// ─────────────────────────────────────────
// POST /download
// Validates BEFORE queuing (prevents phantom charges)
// ─────────────────────────────────────────
app.post('/download', async (req, res) => {
  const { url, quality = 'best' } = req.body
  if (!url || !isValidTikTokUrl(url)) {
    return res.status(400).json({ error: 'Invalid TikTok URL' })
  }

  try {
    // Early validation: check if video actually exists
    // Fails fast without billing the user
    await validateVideoMetadata(url)

    // ✅ VALIDATION PASSED - NOW LOG & BILL
    checkAndLog(req.keyRecord.user_id, req.keyRecord.limit_day, {
      api_key: req.apiKey,
      endpoint: '/download',
      url: cleanTikTokUrl(url),
      job_id: null, // Will update after queue succeeds
      status: 'ok',
      ip: req.ip
    })

    // Only queue if video is valid
    const job = await downloadQueue.add({ url, quality, type: 'video' })
    
    // Update the usage log with the job_id
    db.db.prepare(`UPDATE usage SET job_id = ? WHERE id = (
      SELECT id FROM usage WHERE api_key = ? AND endpoint = '/download' AND job_id IS NULL ORDER BY created_at DESC LIMIT 1
    )`).run(job.id, req.apiKey)
    
    const queueDepth = await downloadQueue.getWaitingCount()

    res.status(202).json({
      jobId: job.id,
      status: 'queued',
      position: queueDepth,
      pollUrl: `/job/${job.id}`,
      plan: req.keyRecord.plan,
      remainingToday: req.keyRecord.limit_day - db.countToday(req.keyRecord.user_id)
    })
  } catch (err) {
    // ❌ VALIDATION FAILED - NO LOG, NO BILL
    res.status(503).json({ error: err.message })
  }
})

// ─────────────────────────────────────────
// POST /audio
// Validates BEFORE queuing (prevents phantom charges)
// ─────────────────────────────────────────
app.post('/audio', async (req, res) => {
  const { url } = req.body
  if (!url || !isValidTikTokUrl(url)) {
    return res.status(400).json({ error: 'Invalid TikTok URL' })
  }

  try {
    // Early validation: check if video actually exists
    // Fails fast without billing the user
    await validateVideoMetadata(url)

    // ✅ VALIDATION PASSED - NOW LOG & BILL
    checkAndLog(req.keyRecord.user_id, req.keyRecord.limit_day, {
      api_key: req.apiKey,
      endpoint: '/audio',
      url: cleanTikTokUrl(url),
      job_id: null, // Will update after queue succeeds
      status: 'ok',
      ip: req.ip
    })

    // Only queue if video is valid
    const job = await downloadQueue.add({ url, type: 'audio' })
    
    // Update the usage log with the job_id
    db.db.prepare(`UPDATE usage SET job_id = ? WHERE id = (
      SELECT id FROM usage WHERE api_key = ? AND endpoint = '/audio' AND job_id IS NULL ORDER BY created_at DESC LIMIT 1
    )`).run(job.id, req.apiKey)
    
    res.status(202).json({
      jobId: job.id,
      status: 'queued',
      pollUrl: `/job/${job.id}`,
      remainingToday: req.keyRecord.limit_day - db.countToday(req.keyRecord.user_id)
    })
  } catch (err) {
    // ❌ VALIDATION FAILED - NO LOG, NO BILL
    res.status(503).json({ error: err.message })
  }
})

// ─────────────────────────────────────────
// GET /job/:id
// ─────────────────────────────────────────
app.get('/job/:id', async (req, res) => {
  try {
    const job = await downloadQueue.getJob(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found or expired' })

    const state = await job.getState()
    const progress = job._progress

    if (state === 'completed') {
      return res.json({
        jobId: job.id,
        status: 'completed',
        progress: 100,
        downloadUrl: `/file/${job.id}`,
        fileSize: job.returnvalue?.fileSize,
        ext: job.returnvalue?.ext
      })
    }

    if (state === 'failed') {
      return res.json({ jobId: job.id, status: 'failed', error: job.failedReason })
    }

    res.json({
      jobId: job.id,
      status: state,
      progress,
      message: state === 'active' ? 'Downloading...' : 'Waiting in queue...'
    })
  } catch (err) {
    res.status(500).json({ error: 'Could not get job status' })
  }
})

// ─────────────────────────────────────────
// GET /file/:id
// ─────────────────────────────────────────
app.get('/file/:id', async (req, res) => {
  try {
    const job = await downloadQueue.getJob(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found or expired' })

    const state = await job.getState()
    if (state !== 'completed') {
      return res.status(400).json({ error: `Job is ${state}, not ready yet` })
    }

    const { filePath, ext } = job.returnvalue
    if (!fs.existsSync(filePath)) {
      return res.status(410).json({ error: 'File expired. Re-submit the job.' })
    }

    const mime = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4'
    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Disposition', `attachment; filename="tiktok_${job.id}.${ext}"`)

    const stream = fs.createReadStream(filePath)

    res.on('close', () => {
      if (fs.existsSync(filePath)) fs.unlink(filePath, () => {})
    })

    stream.pipe(res)
    stream.on('end', () => fs.unlink(filePath, () => {}))
    stream.on('error', () => res.status(500).json({ error: 'Stream error' }))
    res.on('close', () => { if (fs.existsSync(filePath)) fs.unlink(filePath, () => {}) })
  } catch (err) {
    res.status(500).json({ error: 'Could not serve file' })
  }
})

// ─────────────────────────────────────────
// GET /me  →  key stats for the caller
// ─────────────────────────────────────────
app.get('/me', (req, res) => {
  const stats = db.statsForUser(req.keyRecord.user_id)
  res.json({
    api_key: req.apiKey,
    plan: req.keyRecord.plan,
    limit_day: req.keyRecord.limit_day,
    used_today: db.countToday(req.keyRecord.user_id),
    remaining_today: req.keyRecord.limit_day - db.countToday(req.keyRecord.user_id),
    email: req.keyRecord.email,
    label: req.keyRecord.label,
    stats: {
      total_requests: stats.total_requests,
      today: stats.today,
      downloads: stats.downloads,
      audio: stats.audio,
      info: stats.info,
      errors: stats.errors,
      recent: stats.recent
    }
  })
})

// ─────────────────────────────────────────
// GET /admin/stats  →  all keys overview
// protected by ADMIN_KEY header
// ─────────────────────────────────────────
app.get('/admin/stats', (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  res.json(db.allKeysStats())
})

// ─────────────────────────────────────────
// POST /admin/keys  →  create a new API key
// ─────────────────────────────────────────
app.post('/admin/keys', (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const { label, plan = 'starter' } = req.body
  if (!label) return res.status(400).json({ error: 'label is required' })

  const key = `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  db.addKey(key, label, plan)
  res.json({ key, label, plan })
})

// ─────────────────────────────────────────
// DELETE /admin/keys/:key  →  revoke a key
// ─────────────────────────────────────────
app.delete('/admin/keys/:key', (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  db.revokeKey(req.params.key)
  res.json({ revoked: req.params.key })
})

// ─────────────────────────────────────────
// POST /admin/users/:userId/plan - Change user plan
// protected by ADMIN_KEY header
// ─────────────────────────────────────────
app.post('/admin/users/:userId/plan', (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  
  const { userId } = req.params
  const { plan } = req.body
  
  if (!plan) {
    return res.status(400).json({ error: 'plan is required' })
  }
  
  const result = db.changeUserPlan(parseInt(userId), plan)
  
  if (!result.ok) {
    return res.status(400).json({ error: result.error })
  }
  
  res.json(result)
})

// ─────────────────────────────────────────
// GET /admin/users - List all users with their plans
// protected by ADMIN_KEY header
// ─────────────────────────────────────────
app.get('/admin/users', (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  
  const users = db.getAllUsersWithPlans()
  res.json({ users, plan_limits: db.PLAN_LIMITS })
})

// ─────────────────────────────────────────
// GET /admin/plans - List available plans and their limits
// ─────────────────────────────────────────
app.get('/admin/plans', (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  
  res.json({
    plans: [
      { name: 'free', daily_limit: 10, monthly_limit: 200, price: '$0.00/month', features: ['Video download only'] },
      { name: 'pro', daily_limit: 500, monthly_limit: 15000, price: '$9.99/month', features: ['Video + audio + metadata', 'Basic bulk download', 'Email support'] },
      { name: 'business', daily_limit: 5000, monthly_limit: 150000, price: '$49.99/month', features: ['Everything + unlimited bulk', 'Webhooks', 'Advanced analytics', 'Priority support'] },
      { name: 'enterprise', daily_limit: 999999, monthly_limit: 'Unlimited', price: 'Custom', features: ['SLA', 'Custom integrations', '24/7 dedicated manager'] }
    ]
  })
})

// ─────────────────────────────────────────
// GET /queue/stats
// ─────────────────────────────────────────
app.get('/queue/stats', async (req, res) => {
  const [waiting, active, completed, failed] = await Promise.all([
    downloadQueue.getWaitingCount(),
    downloadQueue.getActiveCount(),
    downloadQueue.getCompletedCount(),
    downloadQueue.getFailedCount()
  ])
  res.json({ waiting, active, completed, failed })
})

app.get('/health', (_, res) => res.json({ status: 'ok' }))

// configure automatic prune
setInterval(() => db.pruneExpired(), 60 * 60 * 1000)

const PORT = process.env.PORT || 3000
const server = process.env.BACKEND_URL || `http://localhost:${PORT}`
console.log(`🚀 TikTok API server is live at > ${server}`)
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 TikTok API on port ${PORT}`));

// ─────────────────────────────────────────
// GET /queue/config
// Returns job expiry config (frontend uses this)
// ─────────────────────────────────────────
app.get('/queue/config', (req, res) => {
  res.json({
    jobExpiryMinutes: 10, // Frontend removes jobs older than this
    jobExpirySecondsBackend: 11 * 60 // Backend TTL (11 mins = 1 min flex)
  })
})

// ─────────────────────────────────────────
// GET /queue/stats
// ─────────────────────────────────────────
app.get('/queue/stats', async (req, res) => {
  const [waiting, active, completed, failed] = await Promise.all([
    downloadQueue.getWaitingCount(),
    downloadQueue.getActiveCount(),
    downloadQueue.getCompletedCount(),
    downloadQueue.getFailedCount()
  ])
  res.json({ 
    waiting, 
    active, 
    completed, 
    failed,
    jobExpiryMinutes: 10
  })
})