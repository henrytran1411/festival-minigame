// Full multiplayer UNO — a casual "backup game" that lives entirely outside
// the tournament's scoring/leaderboard system (no points, no admin gating).
// Players create or join password-protected rooms (a lobby lists open
// rooms by name/status/player count, but never the password) — multiple
// independent games can run at once instead of one single shared table.
//
// Seats are keyed by the same stable per-browser player ID the other 4 games
// use (localStorage-based, sent by the client on join) rather than the raw
// socket connection — so a dropped WiFi connection, an accidental refresh,
// or even a full page reload can reconnect into the SAME seat (and skips
// the password prompt, since already-seated reconnects are trusted). Each
// socket's resolved (roomId, playerId) is cached on the socket after a
// successful join/create so later events don't need to resend it.
//
// Deliberate simplifications from official rules: no card-stacking on
// Draw Two/Draw Four, no "jump-in", no 7-0 house rules, and Wild Draw Four
// is honor-system (not blocked if you're holding a matching color). If it
// becomes a disconnected player's turn, they're auto-skipped (draw one +
// pass) so the room never stalls waiting on someone who left. An empty room
// (no seats, or every seat disconnected) is deleted automatically.

const COLORS = ['red', 'yellow', 'green', 'blue'];
const ACTIONS = ['skip', 'reverse', 'draw2'];
const BOT_NAMES = ['🤖 Bot Minh', '🤖 Bot Lan', '🤖 Bot Huy', '🤖 Bot Trang', '🤖 Bot Đức', '🤖 Bot Mai'];
const BOT_THINK_MS = 1200;

function buildDeck() {
  const deck = [];
  let n = 0;
  const nextId = () => `c${n++}`;
  COLORS.forEach((color) => {
    deck.push({ id: nextId(), color, value: '0' });
    for (let v = 1; v <= 9; v++) {
      deck.push({ id: nextId(), color, value: String(v) });
      deck.push({ id: nextId(), color, value: String(v) });
    }
    ACTIONS.forEach((action) => {
      deck.push({ id: nextId(), color, value: action });
      deck.push({ id: nextId(), color, value: action });
    });
  });
  for (let i = 0; i < 4; i++) {
    deck.push({ id: nextId(), color: 'wild', value: 'wild' });
    deck.push({ id: nextId(), color: 'wild', value: 'wild4' });
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canPlay(card, topCard, currentColor) {
  if (card.color === 'wild') return true;
  if (card.color === currentColor) return true;
  if (topCard && card.value === topCard.value) return true;
  return false;
}

function cardLabel(card) {
  const names = { skip: 'Skip', reverse: 'Reverse', draw2: 'Draw Two', wild: 'Wild', wild4: 'Wild Draw Four' };
  const label = names[card.value] || card.value;
  if (card.color === 'wild') return label;
  return `${card.color[0].toUpperCase()}${card.color.slice(1)} ${label}`;
}

// Simple heuristic, not a real strategy: prefer a playable non-wild card
// (saves wilds for when there's genuinely no other option) over a wild.
function pickBotCard(hand, topCard, currentColor) {
  const nonWild = hand.filter((c) => c.color !== 'wild' && canPlay(c, topCard, currentColor));
  if (nonWild.length) return nonWild[Math.floor(Math.random() * nonWild.length)];
  const wilds = hand.filter((c) => c.color === 'wild');
  if (wilds.length) return wilds[Math.floor(Math.random() * wilds.length)];
  return null;
}

// Picks whichever real color the bot is holding the most of, so a chosen
// Wild color is at least somewhat likely to help their own next turn too.
function pickBotColor(remainingHand) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  remainingHand.forEach((c) => { if (c.color in counts) counts[c.color] += 1; });
  return COLORS.reduce((best, c) => (counts[c] > counts[best] ? c : best), COLORS[0]);
}

class UnoRoom {
  constructor(id, name, password) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // { id: stable playerId, name, hand, calledUno, connected, socketId, isBot }
    this.deck = [];
    this.discard = [];
    this.currentColor = null;
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.turnHasDrawn = false;
    this.log = [];
    this.winnerId = null;
    this.botCounter = 0;
    this.botTimer = null;
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 30) this.log.shift();
  }

  findPlayer(playerId) {
    return playerId ? this.players.find((p) => p.id === playerId) : undefined;
  }

  reshuffleFromDiscard() {
    if (this.discard.length <= 1) return;
    const top = this.discard.pop();
    this.deck = shuffle(this.discard);
    this.discard = [top];
    this.pushLog('🔄 Reshuffled the discard pile into a new draw pile.');
  }

  drawCards(player, count) {
    for (let i = 0; i < count; i++) {
      if (this.deck.length === 0) this.reshuffleFromDiscard();
      if (this.deck.length === 0) break; // deck + discard both exhausted (won't happen in practice)
      player.hand.push(this.deck.pop());
    }
  }

  advance(steps) {
    const n = this.players.length;
    this.currentPlayerIndex = ((this.currentPlayerIndex + this.direction * steps) % n + n) % n;
    this.turnHasDrawn = false;
  }

  currentPlayer() {
    // Defensive clamp: a 'waiting' room's seat list can shrink (someone
    // leaves) without currentPlayerIndex being touched — it's only reset by
    // startGame(). Without this, a stale index from a previous game (or one
    // that simply outran a shrunk array) reads past the end and returns
    // undefined, crashing every caller that assumes a player comes back.
    if (this.currentPlayerIndex >= this.players.length) this.currentPlayerIndex = 0;
    return this.players[this.currentPlayerIndex];
  }

  startGame() {
    const deck = shuffle(buildDeck());
    this.players.forEach((p) => { p.hand = []; p.calledUno = false; });
    for (let i = 0; i < 7; i++) {
      this.players.forEach((p) => p.hand.push(deck.pop()));
    }
    // Flip a starting card. If it's a wild/action card, discard it unplayed
    // and keep flipping until a plain number card starts the pile — avoids
    // special-casing "what does Draw Two on turn 0 even mean" edge cases.
    const preDiscard = [];
    let starter = null;
    while (deck.length > 0) {
      const candidate = deck.pop();
      if (candidate.color !== 'wild' && !ACTIONS.includes(candidate.value)) {
        starter = candidate;
        break;
      }
      preDiscard.push(candidate);
    }
    this.deck = deck;
    this.discard = starter ? [...preDiscard, starter] : preDiscard;
    this.currentColor = starter ? starter.color : COLORS[0];
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.turnHasDrawn = false;
    this.status = 'playing';
    this.winnerId = null;
    this.log = [];
    this.pushLog(`🎉 Game started with ${this.players.map((p) => p.name).join(', ')}.`);
    this.pushLog(`${this.currentPlayer().name}'s turn.`);
  }

  applyPlay(player, card, chosenColor) {
    player.hand = player.hand.filter((c) => c.id !== card.id);
    this.discard.push(card);
    this.currentColor = card.color === 'wild' ? chosenColor : card.color;
    if (player.hand.length !== 1) player.calledUno = false;

    const colorNote = card.color === 'wild' ? ` (${chosenColor})` : '';
    this.pushLog(`${player.name} played ${cardLabel(card)}${colorNote}.`);

    if (player.hand.length === 0) {
      this.status = 'finished';
      this.winnerId = player.id;
      this.pushLog(`🏆 ${player.name} wins!`);
      return;
    }

    if (card.value === 'skip') {
      this.advance(2);
      this.pushLog(`${this.currentPlayer().name} was skipped.`);
    } else if (card.value === 'reverse') {
      if (this.players.length === 2) {
        this.advance(2); // reverse with only 2 players plays exactly like skip
      } else {
        this.direction *= -1;
        this.advance(1);
      }
    } else if (card.value === 'draw2') {
      this.advance(1);
      const victim = this.currentPlayer();
      this.drawCards(victim, 2);
      this.pushLog(`${victim.name} drew 2 cards.`);
      this.advance(1);
    } else if (card.value === 'wild4') {
      this.advance(1);
      const victim = this.currentPlayer();
      this.drawCards(victim, 4);
      this.pushLog(`${victim.name} drew 4 cards.`);
      this.advance(1);
    } else {
      this.advance(1);
    }

    if (this.status === 'playing') this.pushLog(`${this.currentPlayer().name}'s turn.`);
  }

  // Safety net so a disconnected player's turn doesn't stall the room
  // forever — they auto-draw one card and pass. Bounded so an all-offline
  // room doesn't spin forever.
  maybeAutoSkipDisconnected() {
    if (this.status !== 'playing') return;
    let guard = 0;
    while (this.players.length && !this.currentPlayer().connected && guard <= this.players.length) {
      const p = this.currentPlayer();
      this.drawCards(p, 1);
      this.pushLog(`${p.name} is disconnected — auto-drew a card and passed.`);
      this.advance(1);
      guard += 1;
    }
  }

  // Bots always call UNO the instant they hit 1 card — keeps them simple and
  // never gives a human a "free" catch against a bot.
  runBotTurn(nsp) {
    this.botTimer = null;
    if (this.status !== 'playing') return;
    const bot = this.currentPlayer();
    if (!bot || !bot.isBot) return;

    const topCard = this.discard[this.discard.length - 1];
    const card = pickBotCard(bot.hand, topCard, this.currentColor);

    if (card) {
      const chosenColor = card.color === 'wild' ? pickBotColor(bot.hand.filter((c) => c.id !== card.id)) : undefined;
      this.applyPlay(bot, card, chosenColor);
      if (bot.hand.length === 1) bot.calledUno = true;
    } else {
      this.drawCards(bot, 1);
      this.pushLog(`${bot.name} drew a card.`);
      const drawn = bot.hand[bot.hand.length - 1];
      if (drawn && canPlay(drawn, topCard, this.currentColor)) {
        const chosenColor = drawn.color === 'wild' ? pickBotColor(bot.hand.filter((c) => c.id !== drawn.id)) : undefined;
        this.applyPlay(bot, drawn, chosenColor);
        if (bot.hand.length === 1) bot.calledUno = true;
      } else {
        this.advance(1);
        if (this.status === 'playing') this.pushLog(`${this.currentPlayer().name}'s turn.`);
      }
    }

    this.maybeAutoSkipDisconnected();
    this.broadcast(nsp);
    this.scheduleBotTurnIfNeeded(nsp);
  }

  // Called after every action that might change whose turn it is. Bots act
  // on a short delay so their move doesn't feel instant/robotic, and so
  // several bots in a row don't all resolve within the same tick.
  scheduleBotTurnIfNeeded(nsp) {
    clearTimeout(this.botTimer);
    this.botTimer = null;
    if (this.status !== 'playing') return;
    const cp = this.currentPlayer();
    if (cp && cp.isBot) this.botTimer = setTimeout(() => this.runBotTurn(nsp), BOT_THINK_MS);
  }

  personalizedState(forPlayerId) {
    const me = this.findPlayer(forPlayerId);
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      currentColor: this.currentColor,
      discardTop: this.discard[this.discard.length - 1] || null,
      currentPlayerId: this.players.length ? this.currentPlayer().id : null,
      direction: this.direction,
      deckCount: this.deck.length,
      log: this.log,
      winnerId: this.winnerId,
      turnHasDrawn: this.turnHasDrawn,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        calledUno: p.calledUno,
        connected: p.connected,
      })),
      yourId: forPlayerId || null,
      yourHand: me ? me.hand : [],
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) {
        nsp.to(p.socketId).emit('uno:state', this.personalizedState(p.id));
      }
    });
  }

  isEmpty() {
    return this.players.length === 0 || this.players.every((p) => !p.connected);
  }

  // What the lobby shows — deliberately excludes the password and any hand
  // data.
  summary() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      playerCount: this.players.filter((p) => p.connected).length,
    };
  }
}

module.exports = function attachUno(io) {
  const nsp = io.of('/uno');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].map((r) => r.summary());
  }

  function broadcastRoomList() {
    nsp.emit('uno:rooms', roomList());
  }

  function deleteRoomIfEmpty(room) {
    if (room && room.isEmpty()) {
      clearTimeout(room.botTimer);
      rooms.delete(room.id);
    }
  }

  nsp.on('connection', (socket) => {
    socket.emit('uno:rooms', roomList());

    socket.on('uno:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('uno:createRoom', ({ roomName, password, playerId, name }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) {
        if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' });
        return;
      }
      if (!cleanPassword) {
        if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' });
        return;
      }
      if (typeof playerId !== 'string' || !playerId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' });
        return;
      }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) {
        if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' });
        return;
      }

      roomCounter += 1;
      const room = new UnoRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword);
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({ id: playerId, name: clean, hand: [], calledUno: false, connected: true, socketId: socket.id });
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('uno:joinRoom', ({ roomId, password, playerId, name }, callback) => {
      const room = rooms.get(roomId);
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-such-room' });
        return;
      }
      if (typeof playerId !== 'string' || !playerId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' });
        return;
      }
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      const existing = room.findPlayer(playerId);

      if (existing) {
        // Reclaiming a seat — same browser/player, new socket connection
        // (reconnect after a dropped WiFi connection, page refresh, or just
        // clicking Join again). No password needed: already being a known
        // seat in this room IS the credential here.
        existing.socketId = socket.id;
        existing.connected = true;
        existing.name = clean;
      } else {
        if (String(password || '') !== room.password) {
          if (typeof callback === 'function') callback({ ok: false, error: 'wrong-password' });
          return;
        }
        if (room.status !== 'waiting') {
          if (typeof callback === 'function') callback({ ok: false, error: 'game-in-progress' });
          return;
        }
        if (room.players.length >= 10) {
          if (typeof callback === 'function') callback({ ok: false, error: 'room-full' });
          return;
        }
        room.players.push({ id: playerId, name: clean, hand: [], calledUno: false, connected: true, socketId: socket.id });
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

    // Adds bot-controlled seats so a lone player can practice/play solo
    // without needing other real people at the table.
    socket.on('uno:addBots', ({ count }, callback) => {
      const room = myRoom();
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-room' });
        return;
      }
      if (room.status !== 'waiting') {
        if (typeof callback === 'function') callback({ ok: false, error: 'already-started' });
        return;
      }
      const n = Math.max(1, Math.min(6, Number(count) || 3));
      if (room.players.length + n > 10) {
        if (typeof callback === 'function') callback({ ok: false, error: 'table-full' });
        return;
      }
      for (let i = 0; i < n; i++) {
        const botName = BOT_NAMES[room.botCounter % BOT_NAMES.length];
        room.botCounter += 1;
        room.players.push({
          id: `bot_${room.id}_${room.botCounter}`,
          name: botName,
          hand: [],
          calledUno: false,
          connected: true,
          socketId: null,
          isBot: true,
        });
        room.pushLog(`${botName} joined the table.`);
      }
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('uno:start', (payload, callback) => {
      const room = myRoom();
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-room' });
        return;
      }
      if (room.status !== 'waiting') {
        if (typeof callback === 'function') callback({ ok: false, error: 'already-started' });
        return;
      }
      if (room.players.length < 2) {
        if (typeof callback === 'function') callback({ ok: false, error: 'need-more-players' });
        return;
      }
      room.startGame();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotTurnIfNeeded(nsp);
    });

    socket.on('uno:play', ({ cardId, chosenColor }, callback) => {
      const room = myRoom();
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-room' });
        return;
      }
      const player = room.findPlayer(socket.playerId);
      if (!player || room.status !== 'playing' || room.currentPlayer().id !== socket.playerId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'not-your-turn' });
        return;
      }
      const card = player.hand.find((c) => c.id === cardId);
      if (!card) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-such-card' });
        return;
      }
      const topCard = room.discard[room.discard.length - 1];
      if (!canPlay(card, topCard, room.currentColor)) {
        if (typeof callback === 'function') callback({ ok: false, error: 'invalid-card' });
        return;
      }
      if (card.color === 'wild' && !COLORS.includes(chosenColor)) {
        if (typeof callback === 'function') callback({ ok: false, error: 'need-color' });
        return;
      }
      room.applyPlay(player, card, chosenColor);
      room.maybeAutoSkipDisconnected();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotTurnIfNeeded(nsp);
    });

    socket.on('uno:draw', (payload, callback) => {
      const room = myRoom();
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-room' });
        return;
      }
      const player = room.findPlayer(socket.playerId);
      if (!player || room.status !== 'playing' || room.currentPlayer().id !== socket.playerId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'not-your-turn' });
        return;
      }
      if (room.turnHasDrawn) {
        if (typeof callback === 'function') callback({ ok: false, error: 'already-drawn' });
        return;
      }
      room.drawCards(player, 1);
      room.turnHasDrawn = true;
      room.pushLog(`${player.name} drew a card.`);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('uno:pass', (payload, callback) => {
      const room = myRoom();
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-room' });
        return;
      }
      const player = room.findPlayer(socket.playerId);
      if (!player || room.status !== 'playing' || room.currentPlayer().id !== socket.playerId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'not-your-turn' });
        return;
      }
      if (!room.turnHasDrawn) {
        if (typeof callback === 'function') callback({ ok: false, error: 'must-draw-first' });
        return;
      }
      room.advance(1);
      room.maybeAutoSkipDisconnected();
      room.pushLog(`${room.currentPlayer().name}'s turn.`);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotTurnIfNeeded(nsp);
    });

    socket.on('uno:callUno', (payload, callback) => {
      const room = myRoom();
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-room' });
        return;
      }
      const player = room.findPlayer(socket.playerId);
      if (!player || player.hand.length !== 1) {
        if (typeof callback === 'function') callback({ ok: false, error: 'not-eligible' });
        return;
      }
      player.calledUno = true;
      room.pushLog(`${player.name} called UNO!`);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('uno:catch', ({ targetId }, callback) => {
      const room = myRoom();
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-room' });
        return;
      }
      const target = room.findPlayer(targetId);
      const accuser = room.findPlayer(socket.playerId);
      if (!target || !accuser || target.hand.length !== 1 || target.calledUno) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-catch' });
        return;
      }
      room.drawCards(target, 2);
      target.calledUno = false;
      room.pushLog(`${accuser.name} caught ${target.name} without UNO — ${target.name} drew 2 cards.`);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('uno:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-room' });
        return;
      }
      if (room.status !== 'finished') {
        if (typeof callback === 'function') callback({ ok: false, error: 'not-finished' });
        return;
      }
      room.status = 'waiting';
      room.winnerId = null;
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
          // Only drop connected-status if this is still their active socket
          // — an old, already-superseded connection disconnecting shouldn't
          // mark a since-reconnected seat as offline.
          player.connected = false;
          room.pushLog(`${player.name} disconnected.`);
          room.maybeAutoSkipDisconnected();
        }
        room.broadcast(nsp);
        room.scheduleBotTurnIfNeeded(nsp);
      }
      deleteRoomIfEmpty(room);
      broadcastRoomList();
      socket.roomId = null;
    }

    socket.on('uno:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
};
