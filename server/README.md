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

