const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const GAMES = ['sudoku', 'scramble', 'memory', 'proverb'];

// playerId -> { name, scores: { sudoku, scramble, memory, proverb }, updatedAt }
const players = new Map();

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
});
