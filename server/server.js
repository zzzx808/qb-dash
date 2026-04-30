import express from "express";
import morgan from "morgan";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 5173);
const PROJECT_ROOT = path.join(__dirname, "..");

function getWritableDataDir() {
  const preferred = process.env.DATA_DIR ? String(process.env.DATA_DIR) : "";
  const candidates = [
    preferred,
    path.join(PROJECT_ROOT, "server", "data"),
    path.join(PROJECT_ROOT, "data"),
    path.join("/tmp", "qb-dash")
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // keep trying
    }
  }
  // Last resort (should almost never happen)
  return path.join("/tmp", "qb-dash");
}

const DATA_DIR = getWritableDataDir();
const DATA_FILE = path.join(DATA_DIR, "leaderboard.json");
const MAX_ENTRIES = 50;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, "[]", "utf8");
  }
}

function readEntries() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(entries) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2), "utf8");
}

function sanitizeName(name) {
  const s = String(name ?? "").trim();
  if (!s) return "Player";
  return s.slice(0, 18);
}

function sanitizeInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    return (b.livesLeft ?? 0) - (a.livesLeft ?? 0);
  });
}

const app = express();
app.use(morgan("dev"));
app.use(express.json({ limit: "32kb" }));

// Static game files (one level up from /server).
app.use(express.static(PROJECT_ROOT));

app.get("/api/leaderboard", (_req, res) => {
  const entries = sortEntries(readEntries()).slice(0, 10);
  res.json({ entries });
});

app.post("/api/leaderboard", (req, res) => {
  const body = req.body ?? {};
  const entry = {
    name: sanitizeName(body.name),
    timeMs: sanitizeInt(body.timeMs, { min: 0, max: 24 * 60 * 60 * 1000, fallback: 0 }),
    livesLeft: sanitizeInt(body.livesLeft, { min: 0, max: 99, fallback: 0 }),
    createdAt: new Date().toISOString()
  };

  const next = sortEntries([...readEntries(), entry]).slice(0, MAX_ENTRIES);
  writeEntries(next);
  res.status(201).json({ ok: true });
});

app.delete("/api/leaderboard", (_req, res) => {
  writeEntries([]);
  res.json({ ok: true });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`QB Dash server running on port ${PORT}`);
  console.log(`Leaderboard data file: ${DATA_FILE}`);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
  process.exitCode = 1;
});

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", err);
  process.exitCode = 1;
});

