# TubeConvert — Real YouTube → MP4

Ini adalah aplikasi **self-hosted**: frontend HTML + backend Node.js + yt-dlp + FFmpeg.

## Yang dibutuhkan

- Node.js 18+ (disarankan versi LTS terbaru)
- yt-dlp
- FFmpeg + ffprobe
- koneksi internet

yt-dlp menyatakan FFmpeg diperlukan untuk menggabungkan stream video dan audio yang terpisah. Untuk dukungan YouTube penuh, dokumentasi yt-dlp saat ini juga merekomendasikan yt-dlp-ejs dan JavaScript runtime yang didukung.

## Instalasi

1. Install Node.js.
2. Install yt-dlp sesuai OS kamu.
3. Install FFmpeg dan pastikan `ffmpeg` serta `ffprobe` ada di PATH.
4. Buka terminal pada folder project:
   npm install
5. Jalankan:
   npm start
6. Buka:
   http://localhost:3000

### Jika yt-dlp / FFmpeg tidak ada di PATH

Windows:
- set environment variable `YTDLP_PATH` ke lokasi `yt-dlp.exe`
- set `FFMPEG_DIR` ke folder yang berisi `ffmpeg.exe`

Contoh PowerShell:
$env:YTDLP_PATH="C:\tools\yt-dlp.exe"
$env:FFMPEG_DIR="C:\tools\ffmpeg\bin"
npm start

## API

GET /api/health
GET /api/info?url=<youtube-url>
POST /api/convert
GET /api/jobs/:jobId
GET /api/download/:jobId

## Catatan produksi

Untuk deploy publik, tambahkan:
- authentication/rate limit
- batas ukuran/durasi
- queue/worker
- reverse proxy HTTPS
- storage terpisah
- cleanup job
- logging
- validasi URL lebih ketat
- pembatasan concurrent downloads

Gunakan hanya untuk konten yang kamu punya hak untuk mengunduh atau memproses. Jangan gunakan untuk melewati DRM, login, paywall, atau pembatasan akses.
