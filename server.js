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

/* =========================================================
   YOUTUBE URL VALIDATION
========================================================= */

function validYoutubeUrl(raw) {
  try {
    const u = new URL(raw);

    const hosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "www.youtube-nocookie.com"
    ];

    return hosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/* =========================================================
   VIDEO QUALITY
========================================================= */

function qualityFormat(q) {
  const height = {
    "360p": 360,
    "480p": 480,
    "720p": 720,
    "1080p": 1080
  }[q] || 720;

  return `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]`;
}

/* =========================================================
   SAFE FILE NAME
========================================================= */

function safeName(s) {
  return String(s || "video")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "video";
}

/* =========================================================
   RUN YT-DLP
========================================================= */

function runYtdlp(args, onLine) {
  return new Promise((resolve, reject) => {
    console.log("[yt-dlp] Starting:", [YTDLP, ...args].join(" "));

    const child = spawn(YTDLP, args, {
      cwd: ROOT,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (b) => {
      const s = b.toString();

      stdout += s;

      s.split(/\r?\n/).forEach((line) => {
        if (line) {
          console.log("[yt-dlp stdout]", line);
          onLine?.(line);
        }
      });
    });

    child.stderr.on("data", (b) => {
      const s = b.toString();

      stderr += s;

      s.split(/\r?\n/).forEach((line) => {
        if (line) {
          console.error("[yt-dlp stderr]", line);
          onLine?.(line);
        }
      });
    });

    child.on("error", (e) => {
      console.error("[yt-dlp process error]", e);

      reject(
        new Error(`yt-dlp tidak ditemukan atau gagal dijalankan: ${e.message}`)
      );
    });

    child.on("close", (code) => {
      console.log(`[yt-dlp] Process exited with code ${code}`);

      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
      } else {
        reject(
          new Error(
            stderr.trim() ||
            `yt-dlp keluar dengan kode ${code}`
          )
        );
      }
    });
  });
}

/* =========================================================
   YT-DLP COMMON OPTIONS
========================================================= */

function ytdlpInfoArgs(url) {
  return [
    "--dump-single-json",
    "--no-download",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",

    // Enable Node.js JavaScript runtime for YouTube extraction.
    "--js-runtimes",
    "node",

    url
  ];
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    service: "tubeconvert"
  });
});

/* =========================================================
   VIDEO INFORMATION
========================================================= */

app.get("/api/info", async (req, res) => {
  const url = String(req.query.url || "").trim();

  console.log("[API INFO] Request received");

  if (!url) {
    console.error("[API INFO] URL kosong");

    return res.status(400).json({
      error: "URL YouTube tidak diberikan."
    });
  }

  console.log("[API INFO] URL:", url);

  if (!validYoutubeUrl(url)) {
    console.error("[API INFO] URL YouTube tidak valid:", url);

    return res.status(400).json({
      error: "URL YouTube tidak valid."
    });
  }

  try {
    console.log("[API INFO] Mengambil metadata YouTube...");

    const { stdout, stderr } = await runYtdlp(
      ytdlpInfoArgs(url)
    );

    if (stderr) {
      console.log("[API INFO] yt-dlp stderr:", stderr);
    }

    if (!stdout.trim()) {
      throw new Error(
        "yt-dlp tidak mengembalikan metadata video."
      );
    }

    let data;

    try {
      data = JSON.parse(stdout);
    } catch (parseError) {
      console.error(
        "[API INFO] JSON parse error:",
        parseError
      );

      console.error(
        "[API INFO] Raw yt-dlp output:",
        stdout.slice(-2000)
      );

      throw new Error(
        "Output metadata dari yt-dlp tidak valid."
      );
    }

    console.log(
      "[API INFO] Berhasil:",
      data.title || data.id
    );

    res.json({
      id: data.id,
      title: data.title || "YouTube Video",
      uploader: data.uploader || data.channel || "",
      duration: data.duration || 0,
      thumbnail:
        data.thumbnail ||
        `https://img.youtube.com/vi/${data.id}/hqdefault.jpg`,
      webpage_url: data.webpage_url || url
    });

  } catch (e) {
    console.error(
      "[API INFO ERROR]",
      e
    );

    res.status(500).json({
      error: "Gagal membaca informasi video.",
      detail: String(e.message || e).slice(-1000)
    });
  }
});

/* =========================================================
   CONVERT VIDEO
========================================================= */

app.post("/api/convert", async (req, res) => {
  const {
    url,
    quality = "720p"
  } = req.body || {};

  console.log("[API CONVERT] Request received");

  if (!validYoutubeUrl(url)) {
    return res.status(400).json({
      error: "URL YouTube tidak valid."
    });
  }

  if (
    ![
      "360p",
      "480p",
      "720p",
      "1080p"
    ].includes(quality)
  ) {
    return res.status(400).json({
      error: "Kualitas tidak valid."
    });
  }

  const id = crypto.randomUUID();

  jobs.set(id, {
    id,
    status: "starting",
    progress: 0,
    message: "Memulai…",
    createdAt: Date.now()
  });

  res.json({
    jobId: id
  });

  (async () => {
    const outputTemplate =
      path.join(
        DOWNLOAD_DIR,
        `${id}.%(ext)s`
      );

    try {
      console.log(
        `[JOB ${id}] Mengambil metadata...`
      );

      const info = await runYtdlp(
        ytdlpInfoArgs(url)
      );

      if (!info.stdout.trim()) {
        throw new Error(
          "yt-dlp tidak mengembalikan metadata."
        );
      }

      let meta;

      try {
        meta = JSON.parse(info.stdout);
      } catch {
        throw new Error(
          "Metadata video tidak dapat dibaca."
        );
      }

      console.log(
        `[JOB ${id}] Video: ${meta.title}`
      );

      jobs.set(id, {
        ...jobs.get(id),
        title: meta.title || "video",
        thumbnail: meta.thumbnail || ""
      });

      const args = [
        "--no-playlist",
        "--newline",
        "--progress",
        "--no-mtime",
        "--restrict-filenames",

        // Enable Node.js JavaScript runtime.
        "--js-runtimes",
        "node",

        "-f",
        qualityFormat(quality),

        "--merge-output-format",
        "mp4",

        "-o",
        outputTemplate
      ];

      if (FFMPEG_DIR) {
        args.push(
          "--ffmpeg-location",
          FFMPEG_DIR
        );
      }

      args.push(url);

      console.log(
        `[JOB ${id}] Starting download...`
      );

      await runYtdlp(args, (line) => {
        const m = line.match(
          /(\d+(?:\.\d+)?)%/
        );

        const speed = line.match(
          /at\s+([^\s]+)/i
        );

        const eta = line.match(
          /ETA\s+([^\s]+)/i
        );

        const old = jobs.get(id) || {};

        jobs.set(id, {
          ...old,

          status: "downloading",

          progress: m
            ? Math.min(
                100,
                Number(m[1])
              )
            : old.progress || 0,

          message: m
            ? `Mengunduh… ${Number(m[1]).toFixed(1)}%`
            : line.slice(-120),

          speed:
            speed?.[1] ||
            old.speed ||
            "",

          eta:
            eta?.[1] ||
            old.eta ||
            ""
        });
      });

      console.log(
        `[JOB ${id}] Download selesai, mencari MP4...`
      );

      const files =
        (
          await fsp.readdir(
            DOWNLOAD_DIR
          )
        ).filter(
          (x) =>
            x.startsWith(id + ".") &&
            x.endsWith(".mp4")
        );

      if (!files.length) {
        throw new Error(
          "File MP4 hasil konversi tidak ditemukan."
        );
      }

      const filename =
        safeName(meta.title) +
        ".mp4";

      jobs.set(id, {
        ...jobs.get(id),

        status: "done",

        progress: 100,

        message: "Selesai",

        filename,

        file: files[0]
      });

      console.log(
        `[JOB ${id}] Conversion SUCCESS`
      );

    } catch (e) {
      console.error(
        `[JOB ${id}] Conversion ERROR`,
        e
      );

      jobs.set(id, {
        ...jobs.get(id),

        status: "error",

        message: String(
          e.message || e
        ).slice(-1200)
      });
    }
  })();
});

/* =========================================================
   JOB STATUS
========================================================= */

app.get(
  "/api/jobs/:id",
  (req, res) => {
    const job =
      jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        error: "Job tidak ditemukan."
      });
    }

    res.json(job);
  }
);

/* =========================================================
   DOWNLOAD RESULT
========================================================= */

app.get(
  "/api/download/:id",
  async (req, res) => {
    const job =
      jobs.get(req.params.id);

    if (
      !job ||
      job.status !== "done"
    ) {
      return res.status(404).json({
        error: "File belum siap."
      });
    }

    const file =
      path.join(
        DOWNLOAD_DIR,
        job.file
      );

    if (!fs.existsSync(file)) {
      return res.status(404).json({
        error: "File sudah tidak tersedia."
      });
    }

    res.download(
      file,
      job.filename,
      async () => {
        try {
          await fsp.unlink(file);
        } catch {}

        jobs.delete(
          req.params.id
        );
      }
    );
  }
);

/* =========================================================
   CLEANUP
========================================================= */

setInterval(
  async () => {
    try {
      const now =
        Date.now();

      for (
        const [id, job]
        of jobs
      ) {
        if (
          job.status === "done" ||
          job.status === "error"
        ) {
          continue;
        }

        if (
          job.createdAt &&
          now - job.createdAt >
            30 * 60 * 1000
        ) {
          console.log(
            `[CLEANUP] Removing stale job ${id}`
          );

          jobs.delete(id);
        }
      }

      const files =
        await fsp.readdir(
          DOWNLOAD_DIR
        );

      for (
        const file
        of files
      ) {
        const full =
          path.join(
            DOWNLOAD_DIR,
            file
          );

        const st =
          await fsp.stat(full);

        if (
          now - st.mtimeMs >
          60 * 60 * 1000
        ) {
          await fsp
            .unlink(full)
            .catch(() => {});
        }
      }
    } catch (e) {
      console.error(
        "[CLEANUP ERROR]",
        e
      );
    }
  },
  10 * 60 * 1000
);

/* =========================================================
   SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `TubeConvert running on port ${PORT}`
    );
  }
);
