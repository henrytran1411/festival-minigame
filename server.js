const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Backup games — casual side activities outside the tournament's scoring
// system entirely (no leaderboard, no admin open/close gating). Each lives
// on its own Socket.IO namespace so it can't collide with the main game
// protocol above.
require('./uno-server.js')(io);

const GAMES = ['sudoku', 'scramble', 'memory', 'proverb'];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'trungthu2026!@';
const JOIN_WINDOW_MS = 2 * 60 * 1000;

// Lifetime attempt cap per game. Games not listed here are unlimited.
const MAX_ATTEMPTS = { sudoku: 3 };

// playerId -> { name, scores: { sudoku, scramble, memory, proverb }, attempts: { ... }, updatedAt }
const players = new Map();

// Recent anti-cheat flags (tab-switch disqualifications, brute-force/impossible-speed
// suspicions), newest last. Visible only to the admin panel, not the public leaderboard.
const cheatFlags = [];
const MAX_CHEAT_FLAGS = 200;
let nextFlagId = 1;
const adminSocketIds = new Set();

function recordCheatFlag({ playerId, name, game, reason, detail }) {
  const flag = {
    id: nextFlagId++,
    playerId,
    name: sanitizeName(name),
    game: GAMES.includes(game) ? game : 'unknown',
    reason: String(reason || 'unknown').slice(0, 60),
    detail: String(detail || '').slice(0, 200),
    at: Date.now(),
  };
  cheatFlags.push(flag);
  if (cheatFlags.length > MAX_CHEAT_FLAGS) cheatFlags.shift();
  adminSocketIds.forEach((id) => io.to(id).emit('admin:cheat-flag', flag));
  return flag;
}

// Per-game gate controlling whether players may start that specific game.
// Each game is closed by default; admin opens one at a time, and it
// auto-closes again after JOIN_WINDOW_MS — independently of the others.
const gameWindows = {};
const closeTimers = {};
GAMES.forEach((g) => {
  gameWindows[g] = { openedAt: null, closesAt: null };
});

// Separate from the join-gating window above: fully hides a game from the
// index page's grid (replaced with a card-back "Open later" placeholder)
// regardless of whether its join window is open/closed. Admin-only, ON by
// default for all 4 games — the admin reveals each one when it's time.
const gameHidden = {};
GAMES.forEach((g) => { gameHidden[g] = true; });

function gameWindowSnapshot(game) {
  const w = gameWindows[game];
  const isOpen = w.closesAt !== null && Date.now() < w.closesAt;
  return { game, isOpen, openedAt: w.openedAt, closesAt: w.closesAt, hidden: Boolean(gameHidden[game]) };
}

function allGameWindowsSnapshot() {
  const result = {};
  GAMES.forEach((g) => {
    result[g] = gameWindowSnapshot(g);
  });
  return result;
}

function broadcastGameWindow(game) {
  io.emit('game-window', gameWindowSnapshot(game));
}

function openGameWindow(game) {
  const now = Date.now();
  gameWindows[game] = { openedAt: now, closesAt: now + JOIN_WINDOW_MS };
  clearTimeout(closeTimers[game]);
  closeTimers[game] = setTimeout(() => broadcastGameWindow(game), JOIN_WINDOW_MS);
  broadcastGameWindow(game);
}

function closeGameWindowNow(game) {
  clearTimeout(closeTimers[game]);
  gameWindows[game] = { ...gameWindows[game], closesAt: Date.now() };
  broadcastGameWindow(game);
}

function clampScore(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1500, Math.round(num)));
}

function sanitizeName(name) {
  const clean = String(name || 'Player').trim().slice(0, 20);
  return clean || 'Player';
}

function sanitizeDetail(detail) {
  return String(detail || '').trim().slice(0, 80);
}

function totalFor(player) {
  return GAMES.reduce((sum, g) => sum + (player.scores[g] || 0), 0);
}

function leaderboardSnapshot() {
  return [...players.entries()]
    .map(([id, p]) => ({
      id,
      name: p.name,
      scores: p.scores,
      details: p.details,
      total: totalFor(p),
      updatedAt: p.updatedAt,
      gameUpdatedAt: p.gameUpdatedAt,
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

// Top N players for one game's score alone, in rank order — used only for
// the admin-triggered reveal ceremony snapshot (see admin:reveal-results).
function topForGame(gameKey, limit) {
  return [...players.values()]
    .filter((p) => (p.scores[gameKey] || 0) > 0)
    .map((p) => ({ name: p.name, total: p.scores[gameKey], detail: p.details[gameKey] || '' }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function getOrCreatePlayer(playerId) {
  let player = players.get(playerId);
  if (!player) {
    player = {
      name: 'Player',
      scores: { sudoku: 0, scramble: 0, memory: 0, proverb: 0 },
      details: { sudoku: '', scramble: '', memory: '', proverb: '' },
      attempts: { sudoku: 0, scramble: 0, memory: 0, proverb: 0 },
      gameUpdatedAt: { sudoku: 0, scramble: 0, memory: 0, proverb: 0 },
      updatedAt: 0,
    };
    players.set(playerId, player);
  }
  return player;
}

// Fake players for previewing the leaderboard UI — never runs automatically
// against real event data (see admin:seed-demo-data / SEED_DEMO_DATA below).
// IDs are prefixed "demo_" so they're easy to find and remove as a group.
const DEMO_PLAYERS = [
  { name: 'Lan Nguyễn', scores: { sudoku: 1500, scramble: 1120, memory: 1400, proverb: 1350 },
    details: { sudoku: '48s · 0 mistakes', scramble: '140s · 12 of 12 words solved', memory: '300s · 150 moves', proverb: '500s · 15 of 15 proverbs solved' } },
  { name: 'Hoa Đỗ', scores: { sudoku: 1490, scramble: 1080, memory: 1350, proverb: 1300 },
    details: { sudoku: '55s · 0 mistakes', scramble: '145s · 12 of 12 words solved', memory: '350s · 160 moves', proverb: '510s · 15 of 15 proverbs solved' } },
  { name: 'Minh Trần', scores: { sudoku: 1420, scramble: 980, memory: 1250, proverb: 1180 },
    details: { sudoku: '52s · 1 mistake', scramble: '150s · 10 of 12 words solved', memory: '410s · 210 moves', proverb: '620s · 13 of 15 proverbs solved' } },
  { name: 'Linh Cao', scores: { sudoku: 1400, scramble: 1000, memory: 1300, proverb: 1150 },
    details: { sudoku: '70s · 1 mistake', scramble: '155s · 11 of 12 words solved', memory: '380s · 180 moves', proverb: '550s · 13 of 15 proverbs solved' } },
  { name: 'Trang Lê', scores: { sudoku: 1350, scramble: 1040, memory: 1150, proverb: 1000 },
    details: { sudoku: '90s · 2 mistakes', scramble: '160s · 11 of 12 words solved', memory: '500s · 240 moves', proverb: '680s · 12 of 15 proverbs solved' } },
  { name: 'Đức Vũ', scores: { sudoku: 1180, scramble: 0, memory: 1480, proverb: 1220 },
    details: { sudoku: '140s · 3 mistakes', scramble: '', memory: '190s · 70 moves', proverb: '560s · 14 of 15 proverbs solved' } },
  { name: 'Thảo Vương', scores: { sudoku: 1250, scramble: 950, memory: 1100, proverb: 1080 },
    details: { sudoku: '120s · 2 mistakes', scramble: '165s · 10 of 12 words solved', memory: '520s · 260 moves', proverb: '600s · 13 of 15 proverbs solved' } },
  { name: 'Tuấn Bùi', scores: { sudoku: 1050, scramble: 1000, memory: 1020, proverb: 0 },
    details: { sudoku: '180s · 4 mistakes', scramble: '170s · 10 of 12 words solved', memory: '600s · 280 moves', proverb: '' } },
  { name: 'Mai Đặng', scores: { sudoku: 0, scramble: 890, memory: 0, proverb: 960 },
    details: { sudoku: '', scramble: '180s · 9 of 12 words solved', memory: '', proverb: "Time's up · 11 of 15 proverbs solved" } },
  { name: 'Hùng Phạm', scores: { sudoku: 980, scramble: 760, memory: 900, proverb: 850 },
    details: { sudoku: '210s · 5 mistakes', scramble: '200s · 8 of 12 words solved', memory: '700s · 320 moves', proverb: '750s · 10 of 15 proverbs solved' } },
  { name: 'Nam Hoàng', scores: { sudoku: 800, scramble: 700, memory: 850, proverb: 780 },
    details: { sudoku: '250s · 6 mistakes', scramble: '210s · 7 of 12 words solved', memory: "Time's up · 51/64 pairs matched · 350 moves", proverb: '800s · 9 of 15 proverbs solved' } },
  { name: 'Khánh Đinh', scores: { sudoku: 600, scramble: 500, memory: 600, proverb: 550 },
    details: { sudoku: '300s · 8 mistakes', scramble: '220s · 6 of 12 words solved', memory: "Time's up · 40/64 pairs matched · 400 moves", proverb: '850s · 7 of 15 proverbs solved' } },
];

function seedDemoData() {
  const now = Date.now();
  DEMO_PLAYERS.forEach((demo, i) => {
    players.set(`demo_${i + 1}`, {
      name: demo.name,
      scores: { sudoku: 0, scramble: 0, memory: 0, proverb: 0, ...demo.scores },
      details: { sudoku: '', scramble: '', memory: '', proverb: '', ...demo.details },
      attempts: { sudoku: 0, scramble: 0, memory: 0, proverb: 0 },
      gameUpdatedAt: { sudoku: now, scramble: now, memory: now, proverb: now },
      updatedAt: now,
    });
  });
  return DEMO_PLAYERS.length;
}

function clearDemoData() {
  let removed = 0;
  [...players.keys()].forEach((id) => {
    if (id.startsWith('demo_')) {
      players.delete(id);
      removed += 1;
    }
  });
  return removed;
}

io.on('connection', (socket) => {
  socket.emit('leaderboard', leaderboardSnapshot());
  socket.emit('game-window-all', allGameWindowsSnapshot());

  socket.on('admin:login', ({ password }, callback) => {
    const ok = typeof password === 'string' && password === ADMIN_PASSWORD;
    if (ok) {
      socket.isAdmin = true;
      adminSocketIds.add(socket.id);
    }
    if (typeof callback === 'function') {
      callback({
        ok,
        state: ok ? allGameWindowsSnapshot() : undefined,
        playerCount: ok ? players.size : undefined,
        flags: ok ? cheatFlags.slice(-50).reverse() : undefined,
      });
    }
  });

  socket.on('admin:open', ({ game }, callback) => {
    if (!socket.isAdmin) {
      if (typeof callback === 'function') callback({ ok: false, error: 'not authorized' });
      return;
    }
    if (!GAMES.includes(game)) {
      if (typeof callback === 'function') callback({ ok: false, error: 'invalid game' });
      return;
    }
    openGameWindow(game);
    if (typeof callback === 'function') callback({ ok: true, state: gameWindowSnapshot(game) });
  });

  socket.on('admin:close', ({ game }, callback) => {
    if (!socket.isAdmin) {
      if (typeof callback === 'function') callback({ ok: false, error: 'not authorized' });
      return;
    }
    if (!GAMES.includes(game)) {
      if (typeof callback === 'function') callback({ ok: false, error: 'invalid game' });
      return;
    }
    closeGameWindowNow(game);
    if (typeof callback === 'function') callback({ ok: true, state: gameWindowSnapshot(game) });
  });

  socket.on('admin:set-hidden', ({ game, hidden }, callback) => {
    if (!socket.isAdmin) {
      if (typeof callback === 'function') callback({ ok: false, error: 'not authorized' });
      return;
    }
    if (!GAMES.includes(game)) {
      if (typeof callback === 'function') callback({ ok: false, error: 'invalid game' });
      return;
    }
    gameHidden[game] = Boolean(hidden);
    broadcastGameWindow(game);
    if (typeof callback === 'function') callback({ ok: true, state: gameWindowSnapshot(game) });
  });

  socket.on('register', ({ playerId, name }) => {
    if (typeof playerId !== 'string' || !playerId) return;
    const player = getOrCreatePlayer(playerId);
    player.name = sanitizeName(name);
    io.emit('leaderboard', leaderboardSnapshot());
  });

  socket.on('score:submit', ({ playerId, name, game, score, detail }) => {
    if (typeof playerId !== 'string' || !playerId) return;
    if (!GAMES.includes(game)) return;

    const player = getOrCreatePlayer(playerId);
    if (name) player.name = sanitizeName(name);
    const incoming = clampScore(score);
    // Only replace the stored detail (time/moves/etc.) when this run matches
    // or beats the recorded best, so it always describes THAT score, not
    // whatever run happened to submit most recently.
    if (incoming >= (player.scores[game] || 0)) {
      player.details[game] = sanitizeDetail(detail);
    }
    player.scores[game] = Math.max(player.scores[game] || 0, incoming);
    const now = Date.now();
    player.updatedAt = now;
    player.gameUpdatedAt[game] = now;

    io.emit('leaderboard', leaderboardSnapshot());
  });

  // Reserves one of the player's lifetime attempts for a game before they're
  // allowed to see the board. Consumed on request, not on completion, so a
  // disqualified (tab-switch) run still costs an attempt like a normal one.
  socket.on('game:start-attempt', ({ playerId, name, game }, callback) => {
    if (typeof playerId !== 'string' || !playerId || !GAMES.includes(game)) {
      if (typeof callback === 'function') callback({ ok: false, error: 'invalid request' });
      return;
    }
    const player = getOrCreatePlayer(playerId);
    if (name) player.name = sanitizeName(name);
    const max = MAX_ATTEMPTS[game] || null;
    const used = player.attempts[game] || 0;
    if (max && used >= max) {
      if (typeof callback === 'function') callback({ ok: false, error: 'max-attempts', attemptsUsed: used, attemptsMax: max });
      return;
    }
    player.attempts[game] = used + 1;
    if (typeof callback === 'function') callback({ ok: true, attemptsUsed: player.attempts[game], attemptsMax: max });
  });

  // Anti-cheat signal from a game page (tab-switch disqualification, brute-force
  // guess pattern, implausible solve speed, ...). Never blocks play server-side —
  // it's surfaced to the admin panel for a human to judge.
  socket.on('cheat:flag', ({ playerId, name, game, reason, detail }) => {
    if (typeof playerId !== 'string' || !playerId) return;
    recordCheatFlag({ playerId, name, game, reason, detail });
  });

  // Clears everyone's used-attempt count for one game (or all games), without
  // touching scores — for undoing lockouts during testing or between rounds.
  socket.on('admin:reset-attempts', ({ game }, callback) => {
    if (!socket.isAdmin) {
      if (typeof callback === 'function') callback({ ok: false, error: 'not authorized' });
      return;
    }
    if (game && !GAMES.includes(game)) {
      if (typeof callback === 'function') callback({ ok: false, error: 'invalid game' });
      return;
    }
    const gamesToReset = game ? [game] : GAMES;
    let playerCount = 0;
    players.forEach((player) => {
      gamesToReset.forEach((g) => { player.attempts[g] = 0; });
      playerCount += 1;
    });
    if (typeof callback === 'function') callback({ ok: true, playerCount, games: gamesToReset });
  });

  // Populates (or clears) the fake players above for previewing the leaderboard
  // UI. Admin-only, and never runs on its own — see SEED_DEMO_DATA below for
  // the opt-in startup version.
  socket.on('admin:seed-demo-data', (payload, callback) => {
    if (!socket.isAdmin) {
      if (typeof callback === 'function') callback({ ok: false, error: 'not authorized' });
      return;
    }
    const count = seedDemoData();
    io.emit('leaderboard', leaderboardSnapshot());
    if (typeof callback === 'function') callback({ ok: true, count });
  });

  socket.on('admin:clear-demo-data', (payload, callback) => {
    if (!socket.isAdmin) {
      if (typeof callback === 'function') callback({ ok: false, error: 'not authorized' });
      return;
    }
    const removed = clearDemoData();
    io.emit('leaderboard', leaderboardSnapshot());
    if (typeof callback === 'function') callback({ ok: true, removed });
  });

  // Snapshots the current top 10 for ONE board ('overall' or a game key) in
  // rank order and broadcasts it so the big-screen leaderboard can run that
  // board's reveal ceremony. The client freezes on this snapshot for the
  // animation — it does not reflect scores that come in mid-ceremony. Each
  // of the 5 boards is revealed independently, on its own admin button.
  socket.on('admin:reveal-results', ({ board }, callback) => {
    if (!socket.isAdmin) {
      if (typeof callback === 'function') callback({ ok: false, error: 'not authorized' });
      return;
    }
    let top10;
    if (board === 'overall') {
      top10 = leaderboardSnapshot().filter((p) => p.total > 0).slice(0, 10);
    } else if (GAMES.includes(board)) {
      top10 = topForGame(board, 10);
    } else {
      if (typeof callback === 'function') callback({ ok: false, error: 'invalid board' });
      return;
    }
    io.emit('reveal-results', { board, top10 });
    if (typeof callback === 'function') callback({ ok: true, count: top10.length });
  });

  socket.on('disconnect', () => {
    adminSocketIds.delete(socket.id);
  });
});

// Opt-in only (never fires by default) — set SEED_DEMO_DATA=1 to preview the
// leaderboard with fake players without needing to log into the admin panel.
if (process.env.SEED_DEMO_DATA) {
  const count = seedDemoData();
  console.log(`Seeded ${count} demo players onto the leaderboard (SEED_DEMO_DATA is set).`);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Autumn Festival Tournament running on port ${PORT}`);
  console.log('On this machine:  http://localhost:' + PORT);
  console.log('For everyone on the same wifi, find this PC\'s LAN IP (ipconfig)');
  console.log('and share:        http://<this-pc-ip>:' + PORT);
  console.log('Big-screen leaderboard: http://<this-pc-ip>:' + PORT + '/leaderboard.html');
  console.log('Admin panel:            http://<this-pc-ip>:' + PORT + '/admin.html');
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`Admin password (default, set ADMIN_PASSWORD env var to change): ${ADMIN_PASSWORD}`);
  }
});
