const Queue = require('bull')
const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const downloadQueue = new Queue('tiktok-downloads', {
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: {
      age: 11 * 60, // Remove completed jobs after 11 minutes (660 seconds)
    },
    removeOnFail: {
      age: 11 * 60, // Remove failed jobs after 11 minutes (gives 1 min flex for UI)
    },
    timeout: 90000
  }
})

// ─── Worker — runs one job at a time ───
downloadQueue.process(1, async (job) => {
  const { url, quality = 'best', type = 'video' } = job.data

  job.progress(10)

  return new Promise((resolve, reject) => {
    const ext = type === 'audio' ? 'mp3' : 'mp4'
    const tmpFile = path.join(os.tmpdir(), `tiktok_${job.id}.${ext}`)

    let cmd
    if (type === 'audio') {
      cmd = `yt-dlp -x --audio-format mp3 --no-playlist -o "${tmpFile}" "${url}"`
    } else {
      const formatFlag = quality === 'best'
        ? '-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"'
        : `-f "best[height<=${quality}][ext=mp4]/best[ext=mp4]"`
      cmd = `yt-dlp ${formatFlag} --no-playlist --merge-output-format mp4 -o "${tmpFile}" "${url}"`
    }

    job.progress(30)

    exec(cmd, { timeout: 80000 }, (err, stdout, stderr) => {
      if (err || !fs.existsSync(tmpFile)) {
        if (stderr.includes('Video unavailable')) return reject(new Error('Video is private or deleted'))
        if (stderr.includes('Sign in')) return reject(new Error('Video is age-restricted'))
        if (stderr.includes('Unable to extract')) return reject(new Error('TikTok blocked this request — retrying'))
        return reject(new Error('Download failed'))
      }

      job.progress(90)

      const stat = fs.statSync(tmpFile)
      resolve({
        filePath: tmpFile,
        fileSize: stat.size,
        ext,
        jobId: job.id
      })
    })
  })
})

downloadQueue.on('completed', (job, result) => {
  console.log(`✅ Job ${job.id} done — ${result.fileSize} bytes`)
  // Auto-cleanup after 11 mins (handled by removeOnComplete now)
  // File cleanup still happens after 10 mins as before
  setTimeout(() => {
    if (fs.existsSync(result.filePath)) fs.unlink(result.filePath, () => {})
  }, 10 * 60 * 1000)
})

downloadQueue.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed: ${err.message}`)
})

downloadQueue.on('stalled', (job) => {
  console.warn(`⚠️  Job ${job.id} stalled — will retry`)
})

module.exports = downloadQueue