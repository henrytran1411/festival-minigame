const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const GAMES = ['sudoku', 'scramble', 'memory', 'proverb'];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'trungthu2026';
const JOIN_WINDOW_MS = 2 * 60 * 1000;

// playerId -> { name, scores: { sudoku, scramble, memory, proverb }, updatedAt }
const players = new Map();

// Per-game gate controlling whether players may start that specific game.
// Each game is closed by default; admin opens one at a time, and it
// auto-closes again after JOIN_WINDOW_MS — independently of the others.
const gameWindows = {};
const closeTimers = {};
GAMES.forEach((g) => {
  gameWindows[g] = { openedAt: null, closesAt: null };
});

function gameWindowSnapshot(game) {
  const w = gameWindows[game];
  const isOpen = w.closesAt !== null && Date.now() < w.closesAt;
  return { game, isOpen, openedAt: w.openedAt, closesAt: w.closesAt };
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
  return Math.max(0, Math.min(100, Math.round(num)));
}

function sanitizeName(name) {
  const clean = String(name || 'Player').trim().slice(0, 20);
  return clean || 'Player';
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
      total: totalFor(p),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function getOrCreatePlayer(playerId) {
  let player = players.get(playerId);
  if (!player) {
    player = {
      name: 'Player',
      scores: { sudoku: 0, scramble: 0, memory: 0, proverb: 0 },
      updatedAt: 0,
    };
    players.set(playerId, player);
  }
  return player;
}

io.on('connection', (socket) => {
  socket.emit('leaderboard', leaderboardSnapshot());
  socket.emit('game-window-all', allGameWindowsSnapshot());

  socket.on('admin:login', ({ password }, callback) => {
    const ok = typeof password === 'string' && password === ADMIN_PASSWORD;
    if (ok) socket.isAdmin = true;
    if (typeof callback === 'function') {
      callback({ ok, state: ok ? allGameWindowsSnapshot() : undefined, playerCount: ok ? players.size : undefined });
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

  socket.on('register', ({ playerId, name }) => {
    if (typeof playerId !== 'string' || !playerId) return;
    const player = getOrCreatePlayer(playerId);
    player.name = sanitizeName(name);
    io.emit('leaderboard', leaderboardSnapshot());
  });

  socket.on('score:submit', ({ playerId, name, game, score }) => {
    if (typeof playerId !== 'string' || !playerId) return;
    if (!GAMES.includes(game)) return;

    const player = getOrCreatePlayer(playerId);
    if (name) player.name = sanitizeName(name);
    const incoming = clampScore(score);
    player.scores[game] = Math.max(player.scores[game] || 0, incoming);
    player.updatedAt = Date.now();

    io.emit('leaderboard', leaderboardSnapshot());
  });
});

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
