// Cờ Vây (Go) — a third backup game alongside UNO and Exploding Kittens.
// Same "casual side activity" contract as those two: its own Socket.IO
// namespace, no leaderboard, no admin open/close gating (see server.js).
//
// Unlike UNO/EK, Go has no hidden information (both players always see the
// whole board), so there's no per-player personalized state — everyone in
// a room gets the exact same broadcast. That keeps this engine considerably
// simpler than the card games: no hands, no deck, just a board + whose turn
// it is + how many consecutive passes have happened.

const BOT_NAMES = ['🤖 Bot An', '🤖 Bot Bình', '🤖 Bot Chi', '🤖 Bot Dũng', '🤖 Bot Giang', '🤖 Bot Hà'];
const VALID_BOARD_SIZES = [9, 13, 19];
const DEFAULT_BOARD_SIZE = 9;
// Standard compensation for Black's first-move advantage, added to White's
// final score. 6.5 (never a whole number) guarantees no draws are possible.
const DEFAULT_KOMI = 6.5;
const BLACK = 1;
const WHITE = 2;

function otherColor(color) {
  return color === BLACK ? WHITE : BLACK;
}

function colorName(color) {
  return color === BLACK ? 'Black' : 'White';
}

// 4-directional orthogonal neighbors of a flat index on an n x n board.
function neighbors(idx, n) {
  const row = Math.floor(idx / n);
  const col = idx % n;
  const result = [];
  if (row > 0) result.push(idx - n);
  if (row < n - 1) result.push(idx + n);
  if (col > 0) result.push(idx - 1);
  if (col < n - 1) result.push(idx + 1);
  return result;
}

// Finds the full connected group sharing board[startIdx]'s color, plus the
// set of liberties (empty points orthogonally adjacent to any stone in that
// group). Assumes board[startIdx] is non-empty.
function findGroup(board, n, startIdx) {
  const color = board[startIdx];
  const stones = new Set([startIdx]);
  const liberties = new Set();
  const stack = [startIdx];
  while (stack.length) {
    const cur = stack.pop();
    for (const nb of neighbors(cur, n)) {
      if (board[nb] === 0) {
        liberties.add(nb);
      } else if (board[nb] === color && !stones.has(nb)) {
        stones.add(nb);
        stack.push(nb);
      }
    }
  }
  return { stones, liberties };
}

// Attempts to place `color` at `idx`. Mutates `board` and `room` (captures,
// koPoint) on success. Returns { ok: true, capturedCount } or
// { ok: false, error }, leaving the board untouched on failure.
function placeStoneAndResolve(room, idx, color) {
  const { board, boardSize: n } = room;
  if (idx < 0 || idx >= board.length) return { ok: false, error: 'out-of-bounds' };
  if (board[idx] !== 0) return { ok: false, error: 'occupied' };
  if (idx === room.koPoint) return { ok: false, error: 'ko' };

  board[idx] = color;
  const opponent = otherColor(color);
  const captured = [];
  for (const nb of neighbors(idx, n)) {
    if (board[nb] === opponent) {
      const group = findGroup(board, n, nb);
      if (group.liberties.size === 0) {
        group.stones.forEach((s) => { board[s] = 0; captured.push(s); });
      }
    }
  }

  const ownGroup = findGroup(board, n, idx);
  if (ownGroup.liberties.size === 0) {
    // Suicide — illegal. Undo the placement AND restore anything captured
    // above (a placement can never legally capture opponent stones while
    // leaving itself with zero liberties AND be reverted incorrectly).
    board[idx] = 0;
    captured.forEach((s) => { board[s] = opponent; });
    return { ok: false, error: 'suicide' };
  }

  // Simplified single-stone ko rule: if this move captured exactly one
  // stone and the placed stone is itself a lone stone with exactly one
  // liberty (the classic ko shape), forbid the opponent from immediately
  // recapturing at that spot next turn. This is NOT full positional
  // superko (which needs board-history hashing) but covers the ko shape
  // that actually comes up in casual play.
  room.koPoint = (captured.length === 1 && ownGroup.stones.size === 1 && ownGroup.liberties.size === 1)
    ? captured[0]
    : null;

  room.captures[color] += captured.length;
  return { ok: true, capturedCount: captured.length };
}

// Simplified Chinese-style area scoring: stones on board + surrounded empty
// territory, no manual dead-stone marking (see the design conversation —
// players are expected to actually capture what they want removed before
// passing). An empty region only counts for a color if EVERY stone
// bordering it is that color; a region touching both colors (or no stones
// at all) is neutral (dame) and scores for nobody.
function scoreBoard(room) {
  const { board, boardSize: n } = room;
  const stoneCount = { [BLACK]: 0, [WHITE]: 0 };
  for (let i = 0; i < board.length; i++) {
    if (board[i]) stoneCount[board[i]] += 1;
  }
  const territory = { [BLACK]: 0, [WHITE]: 0 };
  const visited = new Array(board.length).fill(false);
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== 0 || visited[i]) continue;
    const region = [];
    const borderColors = new Set();
    const stack = [i];
    visited[i] = true;
    while (stack.length) {
      const cur = stack.pop();
      region.push(cur);
      for (const nb of neighbors(cur, n)) {
        if (board[nb] === 0) {
          if (!visited[nb]) { visited[nb] = true; stack.push(nb); }
        } else {
          borderColors.add(board[nb]);
        }
      }
    }
    if (borderColors.size === 1) {
      const [c] = borderColors;
      territory[c] += region.length;
    }
  }
  const blackScore = stoneCount[BLACK] + territory[BLACK];
  const whiteScore = stoneCount[WHITE] + territory[WHITE] + DEFAULT_KOMI;
  return { blackScore, whiteScore, stoneCount, territory, komi: DEFAULT_KOMI };
}

class GoRoom {
  constructor(id, name, password, boardSize) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.boardSize = VALID_BOARD_SIZES.includes(boardSize) ? boardSize : DEFAULT_BOARD_SIZE;
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // { id, name, connected, socketId, isBot, color: 1|2 }
    this.board = null;
    this.currentColor = BLACK;
    this.passCount = 0;
    this.koPoint = null;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.log = [];
    this.winnerId = null;
    this.resultText = null;
    this.scoreSummary = null;
    this.botCounter = 0;
    this.botTimer = null;
    // Alternates which seat is Black on a rematch, so komi's asymmetry
    // doesn't always favor/hurt the same real player across games.
    this.rematchSwap = false;
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 30) this.log.shift();
  }

  findPlayer(playerId) {
    return playerId ? this.players.find((p) => p.id === playerId) : undefined;
  }

  playerByColor(color) {
    return this.players.find((p) => p.color === color) || null;
  }

  currentPlayer() {
    return this.playerByColor(this.currentColor);
  }

  isEmpty() {
    return this.players.length === 0 || this.players.every((p) => !p.connected);
  }

  startGame() {
    const n = this.boardSize;
    this.board = new Array(n * n).fill(0);
    const [first, second] = this.rematchSwap ? [this.players[1], this.players[0]] : this.players;
    if (first) first.color = BLACK;
    if (second) second.color = WHITE;
    this.currentColor = BLACK;
    this.passCount = 0;
    this.koPoint = null;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.status = 'playing';
    this.winnerId = null;
    this.resultText = null;
    this.scoreSummary = null;
    this.log = [];
    this.pushLog(`🎉 Game started on a ${n}x${n} board. ${this.playerByColor(BLACK).name} plays Black, ${this.playerByColor(WHITE).name} plays White.`);
    this.pushLog(`${colorName(this.currentColor)}'s turn.`);
  }

  place(player, idx) {
    const result = placeStoneAndResolve(this, idx, player.color);
    if (!result.ok) return result;
    this.passCount = 0;
    const row = Math.floor(idx / this.boardSize);
    const col = idx % this.boardSize;
    const captureNote = result.capturedCount ? ` and captured ${result.capturedCount} stone${result.capturedCount === 1 ? '' : 's'}!` : '.';
    this.pushLog(`${colorName(player.color)} played at (${row + 1}, ${col + 1})${captureNote}`);
    this.currentColor = otherColor(this.currentColor);
    this.pushLog(`${colorName(this.currentColor)}'s turn.`);
    return result;
  }

  pass(player) {
    this.pushLog(`${colorName(player.color)} passed.`);
    this.passCount += 1;
    this.koPoint = null;
    if (this.passCount >= 2) {
      this.finishByScore();
      return;
    }
    this.currentColor = otherColor(this.currentColor);
    this.pushLog(`${colorName(this.currentColor)}'s turn.`);
  }

  resign(player) {
    const winner = this.playerByColor(otherColor(player.color));
    this.status = 'finished';
    this.winnerId = winner ? winner.id : null;
    this.resultText = `${colorName(player.color)} resigned — ${winner ? winner.name : colorName(otherColor(player.color))} wins.`;
    this.pushLog(`🏳️ ${colorName(player.color)} resigned.`);
    this.pushLog(this.resultText);
  }

  finishByScore() {
    this.status = 'finished';
    const summary = scoreBoard(this);
    this.scoreSummary = summary;
    const diff = Math.abs(summary.blackScore - summary.whiteScore);
    const winnerColor = summary.blackScore > summary.whiteScore ? BLACK : WHITE;
    const winner = this.playerByColor(winnerColor);
    this.winnerId = winner ? winner.id : null;
    this.resultText = `${colorName(winnerColor)} wins by ${diff.toFixed(1)} (Black ${summary.blackScore.toFixed(1)} – White ${summary.whiteScore.toFixed(1)}, komi ${summary.komi}).`;
    this.pushLog('Both players passed — game over.');
    this.pushLog(this.resultText);
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      boardSize: this.boardSize,
      playerCount: this.players.filter((p) => p.connected).length,
    };
  }

  state(forPlayerId) {
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      boardSize: this.boardSize,
      board: this.board,
      currentColor: this.currentColor,
      passCount: this.passCount,
      koPoint: this.koPoint,
      captures: this.captures,
      log: this.log,
      winnerId: this.winnerId,
      resultText: this.resultText,
      scoreSummary: this.scoreSummary,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color || null,
        connected: p.connected,
        isBot: Boolean(p.isBot),
      })),
      yourId: forPlayerId || null,
      yourColor: (this.findPlayer(forPlayerId) || {}).color || null,
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('go:state', this.state(p.id));
    });
  }

  // --- Simple heuristic bot -------------------------------------------
  // Deliberately NOT a strong Go AI (out of scope) — just enough to let one
  // person play solo while waiting: avoids occupied/suicide/ko-illegal
  // points, avoids obviously throwing its own group into atari (1 liberty)
  // unless the move captures something, avoids filling its own simple
  // eyes, and prefers capturing moves when available. Passes once nothing
  // useful is left to do, or once it agrees the game is over (opponent
  // just passed and the bot has no capturing move).
  chooseBotMove() {
    const n = this.boardSize;
    const color = this.currentColor;
    const opponent = otherColor(color);
    const board = this.board;

    // A simple (non-diagonal-checked) real-eye heuristic: an empty point
    // whose every orthogonal neighbor is the bot's own color. Playing here
    // is (almost) always pointless self-damage, so it's excluded from
    // candidates entirely rather than merely deprioritized.
    function isOwnSimpleEye(idx) {
      const nbs = neighbors(idx, n);
      return nbs.length > 0 && nbs.every((nb) => board[nb] === color);
    }

    const capturing = [];
    const safe = [];
    for (let idx = 0; idx < board.length; idx++) {
      if (board[idx] !== 0 || idx === this.koPoint) continue;
      if (isOwnSimpleEye(idx)) continue;
      const trial = this.board.slice();
      const trialRoom = { board: trial, boardSize: n, captures: { [BLACK]: 0, [WHITE]: 0 }, koPoint: this.koPoint };
      const result = placeStoneAndResolve(trialRoom, idx, color);
      if (!result.ok) continue; // occupied/suicide/ko
      if (result.capturedCount > 0) {
        capturing.push(idx);
        continue;
      }
      const group = findGroup(trial, n, idx);
      if (group.liberties.size <= 1) continue; // would leave itself in self-atari for no gain
      safe.push(idx);
    }

    // If the opponent just passed and this bot has nothing to gain by
    // capturing, agree the game is over rather than shuffling stones
    // around pointlessly.
    if (this.passCount >= 1 && capturing.length === 0) return { type: 'pass' };

    const candidates = capturing.length ? capturing : safe;
    if (!candidates.length) return { type: 'pass' };
    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    return { type: 'place', idx };
  }

  runBotTurn(nsp) {
    this.botTimer = null;
    try {
      if (this.status !== 'playing') return;
      const bot = this.currentPlayer();
      if (!bot || !bot.isBot) return;
      const move = this.chooseBotMove();
      if (move.type === 'pass') {
        this.pass(bot);
      } else {
        const result = this.place(bot, move.idx);
        if (!result.ok) {
          // Should not happen (chooseBotMove only offers legal points), but
          // never let a bad bot move wedge the room — fall back to a pass.
          console.error(`[go] bot chose an illegal move in room ${this.id}:`, result.error);
          this.pass(bot);
        }
      }
      this.broadcast(nsp);
      this.scheduleBotTurn(nsp);
    } catch (err) {
      console.error(`[go] bot turn failed in room ${this.id}:`, err);
    }
  }

  scheduleBotTurn(nsp) {
    clearTimeout(this.botTimer);
    this.botTimer = null;
    if (this.status !== 'playing') return;
    const current = this.currentPlayer();
    if (current && current.isBot) {
      this.botTimer = setTimeout(() => this.runBotTurn(nsp), 500 + Math.random() * 700);
    }
  }
}

function attachGo(io) {
  const nsp = io.of('/go');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].map((r) => r.summary());
  }
  function broadcastRoomList() {
    nsp.emit('go:rooms', roomList());
  }
  function deleteRoomIfEmpty(room) {
    if (room && room.isEmpty()) {
      clearTimeout(room.botTimer);
      rooms.delete(room.id);
    }
  }

  nsp.on('connection', (socket) => {
    socket.emit('go:rooms', roomList());

    socket.on('go:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('go:createRoom', ({ roomName, password, playerId, name, boardSize }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const size = VALID_BOARD_SIZES.includes(Number(boardSize)) ? Number(boardSize) : DEFAULT_BOARD_SIZE;
      const room = new GoRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, size);
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, color: null });
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('go:joinRoom', ({ roomId, password, playerId, name }, callback) => {
      const room = rooms.get(roomId);
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-such-room' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      const existing = room.findPlayer(playerId);

      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        existing.name = clean;
      } else {
        if (String(password || '') !== room.password) { if (typeof callback === 'function') callback({ ok: false, error: 'wrong-password' }); return; }
        if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'game-in-progress' }); return; }
        if (room.players.length >= 2) { if (typeof callback === 'function') callback({ ok: false, error: 'room-full' }); return; }
        room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, color: null });
        room.pushLog(`${clean} joined the room.`);
      }

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    function myRoom() {
      return rooms.get(socket.roomId);
    }

    socket.on('go:addBot', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length >= 2) { if (typeof callback === 'function') callback({ ok: false, error: 'table-full' }); return; }
      const botName = BOT_NAMES[room.botCounter % BOT_NAMES.length];
      room.botCounter += 1;
      room.players.push({ id: `bot_${room.id}_${room.botCounter}`, name: botName, connected: true, socketId: null, isBot: true, color: null });
      room.pushLog(`${botName} joined the table.`);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('go:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length < 2) { if (typeof callback === 'function') callback({ ok: false, error: 'not-enough-players' }); return; }
      room.startGame();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotTurn(nsp);
    });

    function requireMyTurn(room, callback) {
      const player = room.findPlayer(socket.playerId);
      if (!player || room.status !== 'playing' || !room.currentPlayer() || room.currentPlayer().id !== socket.playerId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'not-your-turn' });
        return null;
      }
      return player;
    }

    socket.on('go:place', ({ index }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = requireMyTurn(room, callback);
      if (!player) return;
      const result = room.place(player, Number(index));
      if (typeof callback === 'function') callback(result.ok ? { ok: true } : result);
      if (!result.ok) return;
      room.broadcast(nsp);
      room.scheduleBotTurn(nsp);
    });

    socket.on('go:pass', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = requireMyTurn(room, callback);
      if (!player) return;
      room.pass(player);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotTurn(nsp);
    });

    socket.on('go:resign', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player || room.status !== 'playing') { if (typeof callback === 'function') callback({ ok: false, error: 'not-playing' }); return; }
      room.resign(player);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('go:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'finished') { if (typeof callback === 'function') callback({ ok: false, error: 'not-finished' }); return; }
      room.status = 'waiting';
      room.rematchSwap = !room.rematchSwap;
      room.winnerId = null;
      room.resultText = null;
      room.scoreSummary = null;
      room.board = null;
      room.players.forEach((p) => { p.color = null; });
      room.log = [];
      room.pushLog('Ready for a new game — click Start when everyone is in.');
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    function handleLeave() {
      const room = myRoom();
      if (!room) return;
      const player = room.findPlayer(socket.playerId);
      if (player) {
        if (room.status === 'waiting') {
          room.players = room.players.filter((p) => p.id !== socket.playerId);
          room.pushLog(`${player.name} left the room.`);
        } else if (player.socketId === socket.id) {
          player.connected = false;
          room.pushLog(`${player.name} disconnected.`);
        }
        room.broadcast(nsp);
      }
      deleteRoomIfEmpty(room);
      broadcastRoomList();
      socket.roomId = null;
    }

    socket.on('go:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
}

module.exports = attachGo;
// Exposed purely for automated testing of the game-logic pieces without
// needing a live socket server.
module.exports.GoRoom = GoRoom;
module.exports.findGroup = findGroup;
module.exports.placeStoneAndResolve = placeStoneAndResolve;
module.exports.scoreBoard = scoreBoard;
module.exports.neighbors = neighbors;
module.exports.DEFAULT_KOMI = DEFAULT_KOMI;
module.exports.VALID_BOARD_SIZES = VALID_BOARD_SIZES;
module.exports.BLACK = BLACK;
module.exports.WHITE = WHITE;
