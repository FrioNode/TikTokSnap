require('dotenv').config()
const express = require('express')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const rateLimit = require('express-rate-limit')
const downloadQueue = require('./queue')
const db = require('./db')

const { router: authRouter, requireAuth } = require('./auth')

const checkAndLog = db.checkAndLog

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.use('/auth', authRouter)

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  message: { error: 'Rate limit hit. Upgrade your plan.' }
})
app.use(limiter)

// ── Auth + usage tracking middleware ────
app.use((req, res, next) => {
  if (req.path === '/health') return next()
  // Don't count job polling or downloads against quota
  if (req.path.startsWith('/job/') || req.path.startsWith('/file/')) return next()
  // Auth routes use Bearer tokens, not x-api-key
  if (req.path.startsWith('/auth/')) return next()

  const key = req.headers['x-api-key']
  if (!key) return res.status(401).json({ error: 'Missing x-api-key header' })

  const keyRecord = db.getKey(key)
  if (!keyRecord) return res.status(401).json({ error: 'Invalid API key' })

  const allowed = checkAndLog(keyRecord.user_id, keyRecord.limit_day, {
    api_key: key,
    endpoint: req.path,
    url: req.body?.url || null,
    job_id: req.params?.id || null,
    status: 'ok',
    ip: req.ip
  })


  if (!allowed) {
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

function isValidTikTokUrl(url) {
  return /tiktok\.com\/@[\w.]+\/video\/\d+|vm\.tiktok\.com\/\w+|vt\.tiktok\.com\/\w+/.test(url)
}

// ─────────────────────────────────────────
// POST /info
// ─────────────────────────────────────────
app.post('/info', (req, res) => {
  const { url } = req.body
  if (!url || !isValidTikTokUrl(url)) {
    return res.status(400).json({ error: 'Invalid TikTok URL' })
  }

  exec(`yt-dlp --dump-json --no-playlist "${url}"`, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(503).json({ error: 'Could not fetch video info', detail: stderr })
    try {
      const info = JSON.parse(stdout)
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
    } catch {
      res.status(500).json({ error: 'Failed to parse video info' })
    }
  })
})

// ─────────────────────────────────────────
// POST /download
// ─────────────────────────────────────────
app.post('/download', async (req, res) => {
  const { url, quality = 'best' } = req.body
  if (!url || !isValidTikTokUrl(url)) {
    return res.status(400).json({ error: 'Invalid TikTok URL' })
  }

  try {
    const job = await downloadQueue.add({ url, quality, type: 'video' })
    const queueDepth = await downloadQueue.getWaitingCount()

    res.status(202).json({
      jobId: job.id,
      status: 'queued',
      position: queueDepth,
      pollUrl: `/job/${job.id}`,
      plan: req.keyRecord.plan,
      remainingToday: req.keyRecord.limit_day - db.countToday(req.apiKey)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue job', detail: err.message })
  }
})

// ─────────────────────────────────────────
// POST /audio
// ─────────────────────────────────────────
app.post('/audio', async (req, res) => {
  const { url } = req.body
  if (!url || !isValidTikTokUrl(url)) {
    return res.status(400).json({ error: 'Invalid TikTok URL' })
  }

  try {
    const job = await downloadQueue.add({ url, type: 'audio' })
    res.status(202).json({
      jobId: job.id,
      status: 'queued',
      pollUrl: `/job/${job.id}`,
      remainingToday: req.keyRecord.limit_day - db.countToday(req.apiKey)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue job' })
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 TikTok API on port ${PORT}`))