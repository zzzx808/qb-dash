import express from "express";
import morgan from "morgan";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "pg";

const { Pool } = pkg;

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
  return path.join("/tmp", "qb-dash");
}

const DATA_DIR = getWritableDataDir();
const DATA_FILE = path.join(DATA_DIR, "leaderboard.json");
const MAX_ENTRIES = 50;

let pool = null;

function createPool() {
  const conn = process.env.DATABASE_URL ? String(process.env.DATABASE_URL).trim() : "";
  if (!conn) {
    return null;
  }
  const isLocal =
    conn.includes("localhost") || conn.includes("127.0.0.1") || conn.includes("socket:");
  const ssl = isLocal ? false : { rejectUnauthorized: false };
  return new Pool({ connectionString: conn, ssl });
}

async function initDatabase() {
  pool = createPool();
  if (!pool) {
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qb_dash_leaderboard_state (
      id INT PRIMARY KEY DEFAULT 1,
      entries JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await pool.query(
    `INSERT INTO qb_dash_leaderboard_state (id, entries) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING`
  );
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, "[]", "utf8");
  }
}

function readEntriesFromFile() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntriesToFile(entries) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2), "utf8");
}

async function readEntries() {
  if (pool) {
    const r = await pool.query("SELECT entries FROM qb_dash_leaderboard_state WHERE id = 1");
    const row = r.rows[0];
    const parsed = row?.entries;
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  }
  return readEntriesFromFile();
}

async function writeEntries(entries) {
  if (pool) {
    await pool.query("UPDATE qb_dash_leaderboard_state SET entries = $1::jsonb WHERE id = 1", [
      JSON.stringify(entries)
    ]);
    return;
  }
  writeEntriesToFile(entries);
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

app.use(express.static(PROJECT_ROOT));

app.get("/api/leaderboard", async (_req, res) => {
  try {
    const entries = sortEntries(await readEntries()).slice(0, 10);
    res.json({ entries });
  } catch (err) {
    console.error("GET /api/leaderboard", err);
    res.status(500).json({ error: "failed to read leaderboard" });
  }
});

app.post("/api/leaderboard", async (req, res) => {
  try {
    const body = req.body ?? {};
    const entry = {
      name: sanitizeName(body.name),
      timeMs: sanitizeInt(body.timeMs, { min: 0, max: 24 * 60 * 60 * 1000, fallback: 0 }),
      livesLeft: sanitizeInt(body.livesLeft, { min: 0, max: 99, fallback: 0 }),
      createdAt: new Date().toISOString()
    };

    const next = sortEntries([...(await readEntries()), entry]).slice(0, MAX_ENTRIES);
    await writeEntries(next);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("POST /api/leaderboard", err);
    res.status(500).json({ error: "failed to save leaderboard" });
  }
});

app.delete("/api/leaderboard", async (_req, res) => {
  try {
    await writeEntries([]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/leaderboard", err);
    res.status(500).json({ error: "failed to clear leaderboard" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

async function start() {
  try {
    await initDatabase();
  } catch (err) {
    console.error("Database init failed; falling back to file storage if no DATABASE_URL, else exiting.", err);
    if (pool) {
      process.exitCode = 1;
      throw err;
    }
  }

  app.listen(PORT, () => {
    console.log(`QB Dash server running on port ${PORT}`);
    if (pool) {
      console.log("Leaderboard storage: PostgreSQL (DATABASE_URL)");
    } else {
      console.log(`Leaderboard storage: file (${DATA_FILE})`);
      console.warn(
        "File storage is ephemeral on hosts like Render. Set DATABASE_URL to a Postgres instance for persistent scores."
      );
    }
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
  process.exitCode = 1;
});

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", err);
  process.exitCode = 1;
});
