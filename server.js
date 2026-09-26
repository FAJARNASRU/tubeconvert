import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG_DIR = process.env.FFMPEG_DIR || "";

await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(ROOT, "public")));

const jobs = new Map();

function validYoutubeUrl(raw) {
  try {
    const u = new URL(raw);
    const hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtube-nocookie.com"];
    return hosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function qualityFormat(q) {
  const height = { "360p": 360, "480p": 480, "720p": 720, "1080p": 1080 }[q] || 720;
  // Prefer MP4 video + M4A audio, then fall back to a single combined format.
  return `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]`;
}

function safeName(s) {
  return String(s || "video")
    .replace(/[<>:"/\\\\|?*\\x00-\\x1F]/g, "_")
    .replace(/\\s+/g, " ")
    .trim()
    .slice(0, 160) || "video";
}

function runYtdlp(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { cwd: ROOT, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { const s = b.toString(); stdout += s; s.split(/\r?\n/).forEach(x => x && onLine?.(x)); });
    child.stderr.on("data", b => { const s = b.toString(); stderr += s; s.split(/\r?\n/).forEach(x => x && onLine?.(x)); });
    child.on("error", e => reject(new Error(`yt-dlp tidak ditemukan: ${e.message}`)));
    child.on("close", code => code === 0 ? resolve({stdout, stderr}) : reject(new Error(stderr || `yt-dlp keluar dengan kode ${code}`)));
  });
}

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.get("/api/info", async (req, res) => {
  const url = String(req.query.url || "");
  if (!validYoutubeUrl(url)) return res.status(400).json({ error: "URL YouTube tidak valid." });
  try {
    const { stdout } = await runYtdlp([
      "--dump-single-json", "--no-download", "--no-playlist", "--skip-download",
      "--no-warnings", url
    ]);
    const data = JSON.parse(stdout);
    res.json({
      id: data.id,
      title: data.title || "YouTube Video",
      uploader: data.uploader || "",
      duration: data.duration || 0,
      thumbnail: data.thumbnail || `https://img.youtube.com/vi/${data.id}/hqdefault.jpg`,
      webpage_url: data.webpage_url || url
    });
  } catch (e) {
    res.status(500).json({ error: "Gagal membaca informasi video.", detail: e.message.slice(-500) });
  }
});

app.post("/api/convert", async (req, res) => {
  const { url, quality = "720p" } = req.body || {};
  if (!validYoutubeUrl(url)) return res.status(400).json({ error: "URL YouTube tidak valid." });
  if (!["360p","480p","720p","1080p"].includes(quality)) return res.status(400).json({ error: "Kualitas tidak valid." });

  const id = crypto.randomUUID();
  jobs.set(id, { id, status: "starting", progress: 0, message: "Memulai…" });

  res.json({ jobId: id });

  (async () => {
    const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
    try {
      const info = await runYtdlp([
        "--dump-single-json", "--no-download", "--no-playlist", "--skip-download",
        "--no-warnings", url
      ]);
      const meta = JSON.parse(info.stdout);
      jobs.set(id, { ...jobs.get(id), title: meta.title || "video", thumbnail: meta.thumbnail });

      const args = [
        "--no-playlist",
        "--newline",
        "--progress",
        "--no-mtime",
        "--restrict-filenames",
        "-f", qualityFormat(quality),
        "--merge-output-format", "mp4",
        "-o", outputTemplate
      ];
      if (FFMPEG_DIR) args.push("--ffmpeg-location", FFMPEG_DIR);
      args.push(url);

      await runYtdlp(args, line => {
        const m = line.match(/(\d+(?:\.\d+)?)%/);
        const speed = line.match(/at\\s+([^\\s]+)/i);
        const eta = line.match(/ETA\\s+([^\\s]+)/i);
        const old = jobs.get(id) || {};
        jobs.set(id, {
          ...old,
          status: "downloading",
          progress: m ? Math.min(100, Number(m[1])) : old.progress || 0,
          message: m ? `Mengunduh… ${Number(m[1]).toFixed(1)}%` : line.slice(-120),
          speed: speed?.[1] || old.speed || "",
          eta: eta?.[1] || old.eta || ""
        });
      });

      const files = (await fsp.readdir(DOWNLOAD_DIR))
        .filter(x => x.startsWith(id + ".") && x.endsWith(".mp4"));
      if (!files.length) throw new Error("File MP4 hasil konversi tidak ditemukan.");

      const filename = safeName(meta.title) + ".mp4";
      jobs.set(id, {
        ...jobs.get(id),
        status: "done", progress: 100, message: "Selesai",
        filename, file: files[0]
      });
    } catch (e) {
      jobs.set(id, { ...jobs.get(id), status: "error", message: e.message.slice(-900) });
    }
  })();
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan." });
  res.json(job);
});

app.get("/api/download/:id", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.status(404).json({ error: "File belum siap." });
  const file = path.join(DOWNLOAD_DIR, job.file);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "File sudah tidak tersedia." });
  res.download(file, job.filename, async () => {
    try { await fsp.unlink(file); } catch {}
    jobs.delete(req.params.id);
  });
});

setInterval(async () => {
  try {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.status === "done" || job.status === "error") continue;
      // Prevent stale jobs from remaining forever.
      if (job.createdAt && now - job.createdAt > 30 * 60 * 1000) jobs.delete(id);
    }
    const files = await fsp.readdir(DOWNLOAD_DIR);
    for (const file of files) {
      const full = path.join(DOWNLOAD_DIR, file);
      const st = await fsp.stat(full);
      if (now - st.mtimeMs > 60 * 60 * 1000) await fsp.unlink(full).catch(()=>{});
    }
  } catch {}
}, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`TubeConvert running at http://localhost:${PORT}`));
