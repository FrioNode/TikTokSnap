// Run this as a daily cron: node updater.js
// or add to Railway cron jobs
const { exec } = require('child_process')

exec('pip install -U yt-dlp', (err, stdout, stderr) => {
  if (err) {
    console.error('Update failed:', stderr)
    process.exit(1)
  }
  console.log('yt-dlp updated successfully:', stdout)
})
