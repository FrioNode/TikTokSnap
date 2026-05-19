require('dotenv').config()
const express = require('express')
const fs = require('fs')
const { exec } = require('child_process')
const rateLimit = require('express-rate-limit')
const downloadQueue = require('./queue')

const app = express()
app.use(express.json())

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { error: 'Rate limit hit. Upgrade your plan.' }
})
app.use(limiter)

app.use((req, res, next) => {
  if (req.path === '/health') return next()
  const key = req.headers['x-api-key']
  const validKeys = (process.env.API_KEYS || 'frionode').split(',')
  if (!validKeys.includes(key)) {
    return res.status(401).json({ error: 'Invalid API key.' })
  }
  next()
})

function isValidTikTokUrl(url) {
  return /tiktok\.com\/@[\w.]+\/video\/\d+|vm\.tiktok\.com\/\w+|vt\.tiktok\.com\/\w+/.test(url)
}

// ─────────────────────────────────────────
// POST /info  →  instant metadata (no queue needed)
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
// POST /download  →  queues job, returns jobId
// body: { url, quality? }
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
      message: 'Job queued. Poll /job/:id for status.'
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue job', detail: err.message })
  }
})

// ─────────────────────────────────────────
// POST /audio  →  queues audio extraction
// body: { url }
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
      message: 'Audio job queued. Poll /job/:id for status.'
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue job' })
  }
})

// ─────────────────────────────────────────
// GET /job/:id  →  poll job status
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
      return res.json({
        jobId: job.id,
        status: 'failed',
        error: job.failedReason
      })
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
// GET /file/:id  →  serve completed file
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
    stream.pipe(res)
    stream.on('end', () => { fs.unlink(filePath, () => {})  })
    res.on('close', () => { if (fs.existsSync(filePath)) fs.unlink(filePath, () => {}) })
    stream.on('error', () => res.status(500).json({ error: 'Stream error' }))
  } catch (err) {
    res.status(500).json({ error: 'Could not serve file' })
  }
})

// ─────────────────────────────────────────
// GET /queue/stats  →  queue health
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