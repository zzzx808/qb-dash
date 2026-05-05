# QB Dash shared leaderboard

This optional server makes the leaderboard shared (not just local).

## Run

From `qb-dash/server`:

```bash
npm install
npm run start
```

Then open the game at `http://localhost:5173`.

## API

- `GET /api/leaderboard` → `{ entries }`
- `POST /api/leaderboard` → add `{ name, timeMs, livesLeft }`
- `DELETE /api/leaderboard` → clears leaderboard

## Persistence on Render (and similar hosts)

The default storage is a JSON file under `server/data` (or `DATA_DIR`). On **Render**, **Fly.io**, and many other PaaS hosts, that disk is **ephemeral**: deploys, restarts, or sleeping instances can **wipe the leaderboard** overnight even though saves returned success.

**Fix:** attach a **PostgreSQL** database and set **`DATABASE_URL`** on the web service. The server creates a small table on first run; no manual migrations.

### Wire it on Render (same account as the game)

1. In the Render dashboard: **New** → **PostgreSQL**. Pick a **region** that matches your web service (lowers latency).
2. After the database is live, open it → **Connections** (or **Info**). Copy **Internal Database URL** (starts with `postgresql://`). Use internal URL so traffic stays on Render’s network and auth matches.
3. Open your **QB Dash web service** → **Environment** → **Add Environment Variable**:
   - **Key:** `DATABASE_URL`
   - **Value:** paste the internal URL (entire string).
4. **Save**, then trigger a **Manual Deploy** (or push a commit) so a new instance picks up the variable.
5. In the web service **Logs**, on startup you should see: `Leaderboard storage: PostgreSQL (DATABASE_URL)`. If you still see the file path and the ephemeral warning, the variable name is wrong or the deploy did not restart.

**Render free Postgres note:** free databases have a **limited lifetime** (see [Render free tier](https://render.com/docs/free)); before expiry, upgrade or export. For a hobby leaderboard that must outlast that, **Neon** or **Supabase** (free tier) also work: create a project, copy the `postgresql://…` connection string, set it as `DATABASE_URL` on the web service (use **External** host if Render cannot reach internal-only hosts).

Local development without Postgres continues to use the JSON file; no env var is required.

