# TikTok Downloader API

No watermark. MP4 + MP3. Bulk support.

## Componentes
Info → Get video information before download
Queue → stops server crashing under load
Caching → faster responses, saves bandwidth
Error messages → cleaner UX for your customers
Usage tracking → know who's using what, needed for billing
Webhooks → lets bulk downloads run async, big feature unlock

## Setup

```bash
# Install all dependencies
npm install

# For video downloading
pip install yt-dlp

# For merging audio+video
sudo apt install ffmpeg

# for caching
sudo apt install redis-server

# Run
cp .env.example .env
npm run dev
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /info | Get video metadata |
| POST | /download | Download MP4 (no watermark) |
| POST | /audio | Extract MP3 audio |
| POST | /bulk | Metadata for up to 5 URLs |

## Auth
Pass `x-api-key: your-key` in every request header.

## Keep yt-dlp fresh (run daily)
```bash
npm run update-ytdlp
```

## Deploy to Railway
```bash
railway init && railway up
```

## Example
```bash
curl -X POST http://localhost:3000/info \
  -H "Content-Type: application/json" \
  -H "x-api-key: devkey123" \
  -d '{"url": "https://www.tiktok.com/@user/video/123456789"}'
```
