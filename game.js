const field = document.getElementById("field");
const qb = document.getElementById("quarterback");
const overlay = document.getElementById("overlay");
const confettiCanvas = document.getElementById("confettiCanvas");
const recaptureBtn = document.getElementById("recaptureBtn");
const roundValue = document.getElementById("roundValue");
const maxRoundsValue = document.getElementById("maxRoundsValue");
const livesValue = document.getElementById("livesValue");
const maxLivesValue = document.getElementById("maxLivesValue");
const timerValue = document.getElementById("timerValue");
const totalTimerValue = document.getElementById("totalTimerValue");
const statusValue = document.getElementById("statusValue");
const winPanel = document.getElementById("winPanel");
const winTimeValue = document.getElementById("winTimeValue");
const winLivesValue = document.getElementById("winLivesValue");
const winForm = document.getElementById("winForm");
const playerNameInput = document.getElementById("playerNameInput");
const leaderboardList = document.getElementById("leaderboardList");
let audioCtx = null;
let confettiRafId = 0;
let confettiStopAt = 0;
let confettiLastTs = 0;
let confettiParticles = [];
let confettiCtx = null;
let leaderboardSubmitLocked = false;
let lastWinStamp = 0;

const state = {
  running: false,
  countdownActive: false,
  round: 1,
  lives: 3,
  qb: { x: 50, y: 50, radius: 12 },
  defenders: [],
  lastFrame: 0,
  rafId: 0,
  mouseUnlockAt: 0,
  mouseControlArmed: false,
  pointerLocked: false,
  lastMouseX: 0,
  lastMouseY: 0,
  roundTimeLeft: 0,
  gameTimeElapsed: 0,
  gameTimerActive: false,
  collisionsEnabledAt: 0,
  settings: {
    baseDefenders: 4,
    baseSpeed: 70,
    maxSpeed: 260,
    separationDistance: 38,
    separationForce: 1.3,
    roamJitterIntervalMs: 700,
    spawnLockMs: 450,
    maxRounds: 20,
    maxLives: 3,
    spawnGraceMs: 900,
    roundTimeStartSec: 15,
    roundTimeDropPerRoundSec: 0.4,
    minRoundTimeSec: 7
  }
};

const LEADERBOARD_KEY = "qbDashLeaderboardV1";
const REMOTE_TIMEOUT_MS = 1200;
let leaderboardMode = "unknown"; // "remote" | "local" | "unknown"

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function formatElapsed(seconds) {
  const total = Math.max(0, seconds);
  const mins = Math.floor(total / 60);
  const secs = total - mins * 60;
  const secsInt = Math.floor(secs);
  const tenths = Math.floor((secs - secsInt) * 10);
  return `${mins}:${String(secsInt).padStart(2, "0")}.${tenths}`;
}

function readLocalLeaderboard() {
  try {
    const raw = localStorage.getItem(LEADERBOARD_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalLeaderboard(entries) {
  try {
    localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(entries));
  } catch {
    // ignore storage errors
  }
}

function sortLeaderboard(entries) {
  return [...entries].sort((a, b) => {
    if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    return (b.livesLeft ?? 0) - (a.livesLeft ?? 0);
  });
}

async function detectLeaderboardMode() {
  if (leaderboardMode !== "unknown") {
    return leaderboardMode;
  }
  try {
    const res = await withTimeout(fetch("/api/leaderboard", { method: "GET" }), REMOTE_TIMEOUT_MS);
    if (res.ok) {
      leaderboardMode = "remote";
      return leaderboardMode;
    }
  } catch {
    // ignore
  }
  leaderboardMode = "local";
  return leaderboardMode;
}

async function getLeaderboardEntries() {
  const mode = await detectLeaderboardMode();
  if (mode === "remote") {
    try {
      const res = await withTimeout(fetch("/api/leaderboard"), REMOTE_TIMEOUT_MS);
      if (!res.ok) {
        throw new Error("bad response");
      }
      const data = await res.json();
      return Array.isArray(data?.entries) ? data.entries : [];
    } catch {
      // If remote is flaky, fall back to local for this render.
      return readLocalLeaderboard();
    }
  }
  return readLocalLeaderboard();
}

async function addLeaderboardEntry(entry) {
  const mode = await detectLeaderboardMode();
  if (mode === "remote") {
    try {
      const res = await withTimeout(
        fetch("/api/leaderboard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry)
        }),
        REMOTE_TIMEOUT_MS
      );
      if (res.ok) {
        return;
      }
    } catch {
      // fall through to local
    }
  }

  const next = sortLeaderboard([...readLocalLeaderboard(), entry]).slice(0, 50);
  writeLocalLeaderboard(next);
}

async function renderLeaderboard() {
  if (!leaderboardList) {
    return;
  }
  const entries = sortLeaderboard(await getLeaderboardEntries()).slice(0, 10);
  leaderboardList.innerHTML = "";

  if (entries.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="lb-meta">No scores yet. Win the game to add one.</span>`;
    leaderboardList.appendChild(li);
    return;
  }

  for (const e of entries) {
    const li = document.createElement("li");
    const name = String(e.name || "Player").slice(0, 18);
    const time = formatElapsed((e.timeMs || 0) / 1000);
    const lives = `${e.livesLeft ?? 0}/${state.settings.maxLives}`;
    li.innerHTML = `<span class="lb-name">${escapeHtml(name)}</span><span class="lb-meta">— ${time} · lives ${lives}</span>`;
    leaderboardList.appendChild(li);
  }
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resizeConfettiCanvas() {
  if (!confettiCanvas) {
    return;
  }
  const rect = field.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  confettiCanvas.width = Math.max(1, Math.floor(rect.width * ratio));
  confettiCanvas.height = Math.max(1, Math.floor(rect.height * ratio));
  confettiCanvas.style.width = `${rect.width}px`;
  confettiCanvas.style.height = `${rect.height}px`;
  confettiCtx = confettiCanvas.getContext("2d");
  if (confettiCtx) {
    confettiCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
}

function stopConfetti() {
  cancelAnimationFrame(confettiRafId);
  confettiRafId = 0;
  confettiStopAt = 0;
  confettiLastTs = 0;
  confettiParticles = [];
  if (confettiCtx && confettiCanvas) {
    confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  }
}

function startConfetti(durationMs = 4200) {
  if (!confettiCanvas) {
    return;
  }
  resizeConfettiCanvas();
  if (!confettiCtx) {
    return;
  }
  stopConfetti();

  const rect = field.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const count = Math.min(220, Math.floor(90 + state.round * 3));
  const colors = ["#ff3b3b", "#2f7bff", "#ffe45e", "#7dff6a", "#ff77e1", "#ffffff"];

  confettiParticles = Array.from({ length: count }, () => {
    const size = 4 + Math.random() * 6;
    return {
      x: Math.random() * width,
      y: -20 - Math.random() * height * 0.4,
      vy: 70 + Math.random() * 190,
      vx: -50 + Math.random() * 100,
      w: size,
      h: size * (0.55 + Math.random() * 0.75),
      rot: Math.random() * Math.PI * 2,
      vr: (-2 + Math.random() * 4) * 2.2,
      color: colors[Math.floor(Math.random() * colors.length)],
      sway: 10 + Math.random() * 25,
      swaySpeed: 2 + Math.random() * 4
    };
  });

  confettiStopAt = performance.now() + durationMs;
  confettiLastTs = performance.now();

  const loop = (ts) => {
    if (!confettiCtx) {
      return;
    }
    const dt = Math.min(0.05, (ts - confettiLastTs) / 1000);
    confettiLastTs = ts;

    confettiCtx.clearRect(0, 0, width, height);

    for (const p of confettiParticles) {
      p.rot += p.vr * dt;
      p.y += p.vy * dt;
      p.x += p.vx * dt + Math.sin(ts / 1000 * p.swaySpeed) * p.sway * dt;
      p.vy += 35 * dt;

      if (p.y > height + 30) {
        p.y = -20;
        p.x = Math.random() * width;
        p.vy = 70 + Math.random() * 190;
        p.vx = -50 + Math.random() * 100;
      }

      confettiCtx.save();
      confettiCtx.translate(p.x, p.y);
      confettiCtx.rotate(p.rot);
      confettiCtx.fillStyle = p.color;
      confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      confettiCtx.restore();
    }

    if (ts < confettiStopAt) {
      confettiRafId = requestAnimationFrame(loop);
    } else {
      stopConfetti();
    }
  };

  confettiRafId = requestAnimationFrame(loop);
}

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }
    audioCtx = new AudioContextClass();
  }
  return audioCtx;
}

function ensureAudioReady() {
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }
  if (ctx.state === "suspended") {
    ctx.resume();
  }
}

function playWhistle() {
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = "square";
  osc.frequency.setValueAtTime(1450, now);
  osc.frequency.linearRampToValueAtTime(1720, now + 0.12);
  osc.frequency.linearRampToValueAtTime(1530, now + 0.24);

  filter.type = "bandpass";
  filter.frequency.value = 1700;
  filter.Q.value = 10;

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.3);
}

function playTouchdownApplause() {
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }
  const now = ctx.currentTime;
  const duration = 0.85;
  const sampleRate = ctx.sampleRate;
  const frameCount = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(1, frameCount, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < frameCount; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.exp(-3.3 * t);
    const flutter = 0.5 + 0.5 * Math.sin(2 * Math.PI * (8 + t * 14) * t);
    data[i] = (Math.random() * 2 - 1) * envelope * flutter;
  }

  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.value = 1300;
  filter.Q.value = 0.8;

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  source.start(now);
  source.stop(now + duration);
}

function setOverlay(text, visible = true) {
  overlay.textContent = text;
  overlay.classList.toggle("hidden", !visible);
}

function setStatus(text) {
  statusValue.textContent = text;
}

function updateHud() {
  roundValue.textContent = String(state.round);
  livesValue.textContent = String(state.lives);
  timerValue.textContent = `${state.roundTimeLeft.toFixed(1)}s`;
  if (totalTimerValue) {
    totalTimerValue.textContent = formatElapsed(state.gameTimeElapsed);
  }
}

function getRoundTimeForRound(round) {
  const t = state.settings.roundTimeStartSec - (round - 1) * state.settings.roundTimeDropPerRoundSec;
  return Math.max(state.settings.minRoundTimeSec, t);
}

function fieldRect() {
  return field.getBoundingClientRect();
}

function renderQB() {
  qb.style.left = `${state.qb.x}px`;
  qb.style.top = `${state.qb.y}px`;
}

function clearDefenders() {
  for (const d of state.defenders) {
    d.el.remove();
  }
  state.defenders = [];
}

function spawnRoundDefenders() {
  clearDefenders();
  const rect = fieldRect();
  const count = state.settings.baseDefenders + (state.round - 1) * 2;
  const speedBoost = (state.round - 1) * 20;
  const blackCount = Math.max(1, Math.round(count * 0.28));
  const redCount = Math.max(1, Math.round(count * 0.44));
  const blueCount = Math.max(1, count - blackCount - redCount);
  let created = 0;

  function nextType() {
    if (created < blackCount) {
      created += 1;
      return "anchor";
    }
    if (created < blackCount + redCount) {
      created += 1;
      return "chaser";
    }
    created += 1;
    return "roamer";
  }

  for (let i = 0; i < count; i += 1) {
    const defenderEl = document.createElement("div");
    const type = nextType();
    defenderEl.className = `defender defender--${type}`;
    field.appendChild(defenderEl);

    const x = rect.width - 26 - Math.random() * (rect.width * 0.5);
    const y = 20 + Math.random() * (rect.height - 40);
    let speedMultiplier = 1;
    if (type === "anchor") {
      speedMultiplier = 0.35;
    } else if (type === "roamer") {
      speedMultiplier = 0.75;
    } else {
      speedMultiplier = 1.08;
    }
    const speed = Math.min(state.settings.maxSpeed, (state.settings.baseSpeed + speedBoost + Math.random() * 35) * speedMultiplier);

    state.defenders.push({
      el: defenderEl,
      x,
      y,
      radius: 12,
      speed,
      type,
      vx: 0,
      vy: 0,
      homeX: x,
      homeY: y,
      roamTargetX: x,
      roamTargetY: y,
      roamRetargetAt: 0
    });
  }
}

function renderDefenders() {
  for (const d of state.defenders) {
    d.el.style.left = `${d.x}px`;
    d.el.style.top = `${d.y}px`;
  }
}

function resetQBStartPosition() {
  const rect = fieldRect();
  state.qb.x = 32;
  state.qb.y = rect.height / 2;
  renderQB();
}

function exitPointerLockSafe() {
  try {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  } catch {
    // Ignore pointer lock exit errors (browser-dependent behavior).
  }
}

function resetToStartMenu(statusText = "Ready") {
  state.running = false;
  state.countdownActive = false;
  cancelAnimationFrame(state.rafId);
  stopConfetti();

  exitPointerLockSafe();
  state.pointerLocked = false;
  state.mouseControlArmed = false;

  state.round = 1;
  state.lives = state.settings.maxLives;
  state.roundTimeLeft = getRoundTimeForRound(1);
  state.gameTimeElapsed = 0;
  state.gameTimerActive = false;

  clearDefenders();
  resetQBStartPosition();

  setStatus(statusText);
  setOverlay("CLICK TO START", true);
  if (winPanel) {
    winPanel.classList.add("hidden");
  }
  leaderboardSubmitLocked = false;
  lastWinStamp = 0;
  updateHud();
}

function startCountdown() {
  if (state.countdownActive) {
    return;
  }
  state.countdownActive = true;
  state.running = false;
  setStatus("Countdown...");

  let count = 3;
  setOverlay(String(count), true);

  const timer = setInterval(() => {
    count -= 1;
    if (count > 0) {
      setOverlay(String(count), true);
      return;
    }

    clearInterval(timer);
    state.countdownActive = false;
    setOverlay("GO!", true);

    setTimeout(() => {
      setOverlay("", false);
      startRound();
    }, 500);
  }, 1000);
}

function startRound() {
  spawnRoundDefenders();
  resetQBStartPosition();
  renderDefenders();
  playWhistle();
  state.roundTimeLeft = getRoundTimeForRound(state.round);
  updateHud();

  if (state.round === 1) {
    state.gameTimerActive = true;
  }
  state.mouseUnlockAt = performance.now() + state.settings.spawnLockMs;
  state.collisionsEnabledAt = performance.now() + state.settings.spawnGraceMs;
  state.mouseControlArmed = false;
  state.pointerLocked = document.pointerLockElement != null;
  state.running = true;
  setStatus("Run!");
  state.lastFrame = performance.now();
  cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(gameLoop);
}

function loseLife(reason = "Tackled!") {
  state.lives -= 1;
  updateHud();
  state.running = false;
  cancelAnimationFrame(state.rafId);

  if (state.lives <= 0) {
    setStatus("Game Over");
    setOverlay("Game Over - CLICK TO START", true);
    return;
  }

  setStatus(reason);
  setOverlay(reason, true);
  setTimeout(() => startCountdown(), 900);
}

function winRound() {
  playTouchdownApplause();
  if (state.round >= state.settings.maxRounds) {
    state.running = false;
    cancelAnimationFrame(state.rafId);
    startConfetti();
    state.gameTimerActive = false;
    setStatus("Champion!");
    setOverlay("You Won All 20 Rounds!\nCLICK TO START AGAIN", true);
    if (winPanel && winTimeValue && winLivesValue) {
      winTimeValue.textContent = formatElapsed(state.gameTimeElapsed);
      winLivesValue.textContent = `${state.lives}/${state.settings.maxLives}`;
      winPanel.classList.remove("hidden");
      // New win session; allow a single submission for this win.
      leaderboardSubmitLocked = false;
      lastWinStamp = Date.now();
      playerNameInput?.focus?.();
    }
    return;
  }
  state.round += 1;
  updateHud();
  state.running = false;
  cancelAnimationFrame(state.rafId);
  setStatus("Round Cleared");
  setOverlay(`Round ${state.round - 1} complete!`, true);
  setTimeout(() => startCountdown(), 1100);
}

function separationVector(defender, allDefenders) {
  let separateX = 0;
  let separateY = 0;
  const separationDistance = state.settings.separationDistance;

  for (const other of allDefenders) {
    if (other === defender) {
      continue;
    }

    const ox = defender.x - other.x;
    const oy = defender.y - other.y;
    const d = Math.hypot(ox, oy);
    if (d <= 0.001 || d > separationDistance) {
      continue;
    }

    const closeness = (separationDistance - d) / separationDistance;
    separateX += (ox / d) * closeness;
    separateY += (oy / d) * closeness;
  }

  return { x: separateX, y: separateY };
}

function normalizedOr(x, y, fallbackX = 0, fallbackY = 0) {
  const len = Math.hypot(x, y);
  if (len > 0.001) {
    return { x: x / len, y: y / len };
  }
  const fbLen = Math.hypot(fallbackX, fallbackY) || 1;
  return { x: fallbackX / fbLen, y: fallbackY / fbLen };
}

function defenderMove(defender, dt, allDefenders, bounds, now) {
  const toQBX = state.qb.x - defender.x;
  const toQBY = state.qb.y - defender.y;
  const toQB = normalizedOr(toQBX, toQBY, 1, 0);
  const separateRaw = separationVector(defender, allDefenders);
  const separate = normalizedOr(separateRaw.x, separateRaw.y, 0, 0);

  let moveX = 0;
  let moveY = 0;

  if (defender.type === "chaser") {
    moveX = toQB.x * 0.9 + separate.x * state.settings.separationForce * 0.4;
    moveY = toQB.y * 0.9 + separate.y * state.settings.separationForce * 0.4;
  } else if (defender.type === "anchor") {
    const sway =
      state.round >= 15
        ? Math.sin(now / 380 + defender.homeY * 0.035 + defender.homeX * 0.01) * 10
        : 0;
    const homeX = clamp(defender.homeX + sway, defender.radius, bounds.width - defender.radius);
    const toHome = normalizedOr(homeX - defender.x, defender.homeY - defender.y, 0, 0);
    const qbNear = Math.hypot(toQBX, toQBY) < 140;
    moveX = toHome.x * 0.95 + separate.x * 0.65 + (qbNear ? toQB.x * 0.2 : 0);
    moveY = toHome.y * 0.95 + separate.y * 0.65 + (qbNear ? toQB.y * 0.2 : 0);
  } else {
    if (now >= defender.roamRetargetAt) {
      defender.roamTargetX = clamp(
        defender.x + (Math.random() * 2 - 1) * 170,
        defender.radius,
        bounds.width - defender.radius
      );
      defender.roamTargetY = clamp(
        defender.y + (Math.random() * 2 - 1) * 130,
        defender.radius,
        bounds.height - defender.radius
      );
      defender.roamRetargetAt = now + state.settings.roamJitterIntervalMs + Math.random() * 450;
    }
    const toRoam = normalizedOr(defender.roamTargetX - defender.x, defender.roamTargetY - defender.y, 0, 0);
    const lateral = normalizedOr(-toQB.y, toQB.x, 0, 0);
    const lateralSign = Math.sin(now / 260 + defender.x * 0.02) > 0 ? 1 : -1;
    moveX = toRoam.x * 0.55 + lateral.x * 0.28 * lateralSign + toQB.x * 0.35 + separate.x * 0.8;
    moveY = toRoam.y * 0.55 + lateral.y * 0.28 * lateralSign + toQB.y * 0.35 + separate.y * 0.8;
  }

  const move = normalizedOr(moveX, moveY, toQB.x, toQB.y);
  const desiredVX = move.x * defender.speed;
  const desiredVY = move.y * defender.speed;
  const smoothing = defender.type === "chaser" ? 0.22 : 0.14;
  defender.vx = defender.vx * (1 - smoothing) + desiredVX * smoothing;
  defender.vy = defender.vy * (1 - smoothing) + desiredVY * smoothing;

  defender.x += defender.vx * dt;
  defender.y += defender.vy * dt;

  defender.x = clamp(defender.x, defender.radius, bounds.width - defender.radius);
  defender.y = clamp(defender.y, defender.radius, bounds.height - defender.radius);
}

function resolveDefenderOverlaps(allDefenders, bounds) {
  for (let i = 0; i < allDefenders.length; i += 1) {
    for (let j = i + 1; j < allDefenders.length; j += 1) {
      const a = allDefenders[i];
      const b = allDefenders[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.001;
      const minDist = a.radius + b.radius + 2;

      if (dist >= minDist) {
        continue;
      }

      const overlap = ((minDist - dist) / 2) * 0.65;
      const nx = dx / dist;
      const ny = dy / dist;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;

      a.x = clamp(a.x, a.radius, bounds.width - a.radius);
      a.y = clamp(a.y, a.radius, bounds.height - a.radius);
      b.x = clamp(b.x, b.radius, bounds.width - b.radius);
      b.y = clamp(b.y, b.radius, bounds.height - b.radius);
    }
  }
}

function didCollide(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const distance = Math.hypot(dx, dy);
  return distance < a.radius + b.radius;
}

function segmentCircleCollide(ax, ay, bx, by, cx, cy, radius) {
  const abx = bx - ax;
  const aby = by - ay;
  const acx = cx - ax;
  const acy = cy - ay;

  const abLen2 = abx * abx + aby * aby;
  let t = 0;
  if (abLen2 > 0.000001) {
    t = (acx * abx + acy * aby) / abLen2;
    t = clamp(t, 0, 1);
  }
  const px = ax + abx * t;
  const py = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy < radius * radius;
}

function gameLoop(timestamp) {
  if (!state.running) {
    return;
  }

  const dt = (timestamp - state.lastFrame) / 1000;
  state.lastFrame = timestamp;
  const now = performance.now();
  if (state.gameTimerActive) {
    state.gameTimeElapsed += dt;
  }
  state.roundTimeLeft = Math.max(0, state.roundTimeLeft - dt);
  updateHud();
  if (state.roundTimeLeft <= 0) {
    resetToStartMenu("Time Up!");
    return;
  }

  const bounds = fieldRect();
  for (const d of state.defenders) {
    defenderMove(d, dt, state.defenders, bounds, now);
    if (now >= state.collisionsEnabledAt && didCollide(state.qb, d)) {
      loseLife();
      return;
    }
  }
  resolveDefenderOverlaps(state.defenders, bounds);

  if (state.qb.x >= bounds.width - 20) {
    winRound();
    return;
  }

  renderDefenders();
  state.rafId = requestAnimationFrame(gameLoop);
}

function resetGame() {
  state.round = 1;
  state.lives = state.settings.maxLives;
  state.running = false;
  state.countdownActive = false;
  stopConfetti();
  state.roundTimeLeft = getRoundTimeForRound(1);
  state.gameTimeElapsed = 0;
  state.gameTimerActive = false;
  updateHud();
  clearDefenders();
  resetQBStartPosition();
  setStatus("Ready");
  if (winPanel) {
    winPanel.classList.add("hidden");
  }
  startCountdown();
}

function handleStartRequest() {
  if (state.countdownActive || state.running) {
    return;
  }
  ensureAudioReady();
  if (field.requestPointerLock) {
    field.requestPointerLock();
  }
  resetGame();
}

function handleRecaptureRequest() {
  if (!state.running) {
    return;
  }
  ensureAudioReady();
  field.focus?.();
  if (field.requestPointerLock) {
    field.requestPointerLock();
    setTimeout(() => {
      if (document.pointerLockElement == null) {
        // Some browsers only allow pointer-lock from clicking the game area itself.
        setStatus("Click the field to re-capture mouse");
        setTimeout(() => {
          if (state.running) {
            setStatus("Run!");
          }
        }, 1200);
      }
    }, 150);
  }
}

field.addEventListener("mousemove", (event) => {
  if (!state.running) {
    return;
  }
  if (performance.now() < state.mouseUnlockAt) {
    return;
  }
  if (!state.mouseControlArmed) {
    state.mouseControlArmed = true;
    state.lastMouseX = event.clientX;
    state.lastMouseY = event.clientY;
    return;
  }
  let dx = 0;
  let dy = 0;
  if (state.pointerLocked) {
    dx = event.movementX;
    dy = event.movementY;
  } else {
    dx = event.clientX - state.lastMouseX;
    dy = event.clientY - state.lastMouseY;
    state.lastMouseX = event.clientX;
    state.lastMouseY = event.clientY;
  }

  const rect = fieldRect();
  const fromX = state.qb.x;
  const fromY = state.qb.y;
  const toX = clamp(state.qb.x + dx, 12, rect.width - 12);
  const toY = clamp(state.qb.y + dy, 12, rect.height - 12);

  const now = performance.now();
  if (now >= state.collisionsEnabledAt) {
    const qbR = state.qb.radius ?? 12;
    for (const d of state.defenders) {
      const r = qbR + (d.radius ?? 12);
      if (segmentCircleCollide(fromX, fromY, toX, toY, d.x, d.y, r)) {
        loseLife();
        return;
      }
    }
  }

  state.qb.x = toX;
  state.qb.y = toY;
  renderQB();
});

document.addEventListener("pointerlockchange", () => {
  state.pointerLocked = document.pointerLockElement != null;
});

field.addEventListener("click", handleStartRequest);
overlay.addEventListener("click", handleStartRequest);
if (recaptureBtn) {
  recaptureBtn.addEventListener("click", handleRecaptureRequest);
}

window.addEventListener("resize", () => {
  const rect = fieldRect();
  state.qb.x = clamp(state.qb.x, 12, rect.width - 12);
  state.qb.y = clamp(state.qb.y, 12, rect.height - 12);
  renderQB();
  renderDefenders();
  resizeConfettiCanvas();
});

if (maxRoundsValue) {
  maxRoundsValue.textContent = String(state.settings.maxRounds);
}
if (maxLivesValue) {
  maxLivesValue.textContent = String(state.settings.maxLives);
}
updateHud();
resetQBStartPosition();
renderQB();
resizeConfettiCanvas();
renderLeaderboard();

if (winForm) {
  winForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Only allow saving when the win panel is actually shown.
    if (winPanel && winPanel.classList.contains("hidden")) {
      return;
    }
    // Prevent rapid multi-submit (e.g. holding Enter).
    if (leaderboardSubmitLocked) {
      return;
    }
    leaderboardSubmitLocked = true;

    const submitBtn = winForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
    }

    const name = (playerNameInput?.value || "").trim() || "Player";
    const entry = {
      name,
      timeMs: Math.round(state.gameTimeElapsed * 1000),
      livesLeft: state.lives,
      createdAt: new Date().toISOString()
    };
    await addLeaderboardEntry(entry);
    if (playerNameInput) {
      playerNameInput.value = "";
    }
    renderLeaderboard();
    setStatus("Saved to leaderboard");

    // Keep the lock on for this win session (one score per win).
    // If the user restarts and wins again, `winRound()` resets the lock.
    if (submitBtn) {
      submitBtn.disabled = true;
    }
    setTimeout(() => {
      if (!state.running) {
        setStatus("Champion!");
      }
    }, 1100);
  });
}
