// Ô Ăn Quan (Mandarin Square Capturing) — a fifth backup game alongside
// UNO, Exploding Kittens, Go, and Đuổi Niên Thú. Same "casual side
// activity" contract as those four: its own Socket.IO namespace, no
// leaderboard, no admin open/close gating (see server.js).
//
// Board model: a 12-cell LOOP, indices 0-11, matching the physical board
// (2 rows of 5 small "dân" pits, with a big "quan" pit at each end
// spanning both rows):
//
//   index:   0     1   2   3   4   5     6     7   8   9  10  11
//   pit:   QuanA  A0  A1  A2  A3  A4   QuanB  B4  B3  B2  B1  B0
//
// Going in increasing index order (wrapping 11 -> 0) traces the loop
// CLOCKWISE as physically laid out: across player A's row left-to-right,
// down through Quan B, back across player B's row right-to-left, up
// through Quan A. That's why B's pits are stored "backwards" (B4 first) —
// it keeps the loop a simple +1/-1 walk with no per-row special-casing.
//
// Rules implemented (the traditional ruleset plus four "harder/longer
// game" variants the player opted into -- see oaq.html's rules modal for
// the player-facing explanation):
//   - Each player owns one row of 5 dân pits (5 seeds each to start) and
//     the Quan pit at "their" end. A Quan pit's `pits[]` entry tracks
//     ONLY its accompanying dân seeds (5 to start -- the "heavy" setup
//     variant); the big Quan stone's own fixed value (QUAN_BASE_VALUE,
//     20) is never stored in the array -- it's added to a player's score
//     only at the moment that Quan is actually captured or, if it never
//     is, swept to its owner when the game ends.
//   - A move: pick one of YOUR OWN non-empty dân pits, sow all its seeds
//     one-per-pit around the loop in a chosen direction (clockwise or
//     counter-clockwise) — passing through Quan pits along the way like
//     any other pit (they can never be picked up from as a move's
//     starting pit, but otherwise behave like a regular pit).
//   - Relay (rải nối tiếp): after your last seed lands in pit A, look at
//     pit B -- the very NEXT pit, not A itself. If B is a dân pit with
//     seeds already in it, pick up ALL of B's seeds (never a seed is
//     dropped into B itself) and keep sowing them starting from the pit
//     after B. This can chain through several pits in one turn. If B is
//     a Quan pit -- with seeds or without, doesn't matter -- you can
//     never pick it up: your turn stops immediately, no capture check at
//     all. Sowing only reaches the capture check below when B turns out
//     to be an empty dân pit.
//   - Capture: once B is confirmed to be an empty dân pit, hop over it
//     and capture whatever's in the pit beyond it. If that pit is empty
//     too, or B was occupied to begin with, nothing is captured. The
//     chain keeps alternating "hop an empty gap, capture the next
//     occupied pit" for as long as that pattern holds, stopping the
//     moment a gap turns out to be a Quan pit or already occupied.
//   - "Không ăn Quan non" (no eating an unripe Quan): a Quan pit is only
//     a legal capture target once it holds at least QUAN_RIPENESS_
//     THRESHOLD (5) accompanying dân seeds. An unripe Quan is treated
//     exactly like an empty pit would be for capture purposes -- the
//     chain just stops there, banking whatever was captured earlier in
//     the same chain, without erroring.
//   - Opening Quan-capture ban: for the first OPENING_QUAN_BAN_TURNS (8)
//     moves of the game combined (both players together), a Quan pit
//     can never be captured no matter how ripe it is -- same "treat it
//     like an empty pit, chain just stops" handling as an unripe Quan.
//   - Bón dân (borrowing): if it becomes a player's turn and all 5 of
//     their own dân pits are empty, but the game isn't over yet, they
//     borrow 5 seeds from their own already-captured score and drop 1
//     into each of their own pits, then play continues. If they don't
//     have 5 points to borrow, the game ends immediately.
//   - Game end: unlike the simpler ruleset, both Quan pits being eaten
//     does NOT end the game by itself -- play continues over the
//     remaining dân until one side's row is empty AND they can't afford
//     to borrow (see above). At that point whatever's left on the board
//     sweeps to whichever player owns that pit -- including each
//     not-yet-eaten Quan's full value (base + accompanying dân). Higher
//     total score wins (a tie is a draw).

const BOT_NAMES = ['🤖 Bot An', '🤖 Bot Bình', '🤖 Bot Chi'];
// Deliberately slow, human-feeling "thinking" pause before a bot plays --
// gives the player time to actually watch the previous move's sow
// animation finish and read the board before the bot moves again.
const BOT_THINK_MS_MIN = 1800;
const BOT_THINK_MS_MAX = 3500;
const MAX_PLAYERS = 2;

const QUAN_A = 0;
const QUAN_B = 6;
const DAN_PITS = {
  0: [1, 2, 3, 4, 5], // player index 0 ("A") owns these dân pits + QuanA
  1: [7, 8, 9, 10, 11], // player index 1 ("B") owns these dân pits + QuanB
};
const QUAN_OF = { 0: QUAN_A, 1: QUAN_B };
const STARTING_DAN_SEEDS = 5;
// "Heavy" Quan setup variant: each Quan pit starts holding this many
// accompanying dân seeds (its `pits[]` entry -- the big stone's own
// fixed value lives separately in QUAN_BASE_VALUE, never in this array).
const STARTING_QUAN_SEEDS = 5;
// The big Quan stone's own fixed worth, added to a player's score only
// when that Quan is actually captured (or swept at game end) -- on top
// of whatever accompanying dân seeds were sitting in the pit.
const QUAN_BASE_VALUE = 20;
// "Không ăn Quan non": a Quan pit needs at least this many accompanying
// dân seeds before it's a legal capture target.
const QUAN_RIPENESS_THRESHOLD = 5;
// Quan captures are completely banned for this many moves total (both
// players combined) at the start of every game.
const OPENING_QUAN_BAN_TURNS = 8;
// Host-selectable caps on total moves (both players combined) for a
// room; `null` (not in this list) always means unlimited.
const TURN_LIMIT_OPTIONS = [50, 70, 100];

function isQuanPit(index) {
  return index === QUAN_A || index === QUAN_B;
}

// Whichever player owns this pit (0 or 1) -- every pit belongs to exactly
// one side, Quan included.
function ownerOfPit(index) {
  if (index === QUAN_A) return 0;
  if (index === QUAN_B) return 1;
  return index >= 1 && index <= 5 ? 0 : 1;
}

function freshPits() {
  const pits = new Array(12).fill(0);
  pits[QUAN_A] = STARTING_QUAN_SEEDS;
  pits[QUAN_B] = STARTING_QUAN_SEEDS;
  DAN_PITS[0].forEach((i) => { pits[i] = STARTING_DAN_SEEDS; });
  DAN_PITS[1].forEach((i) => { pits[i] = STARTING_DAN_SEEDS; });
  return pits;
}

// Pure sow+relay+capture resolution -- mutates the given `pits` array
// directly (callers pass either the room's real board, or a scratch copy
// for bot move evaluation) and returns what happened, so the caller
// decides what to do with the result (apply score, log it, etc.) rather
// than this function reaching into room/player state itself.
//
// Relay ("rải nối tiếp"), precisely: after your last seed lands in pit A,
// look at pit B (the very next pit, same direction) -- NOT at A's own
// content. Three-way split on B:
//   - B is a Quan pit (whether it holds seeds or not): stop immediately.
//     No relay, no capture check at all -- your turn just ends.
//   - B is a dân pit WITH seeds: pick up ALL of B's seeds (its own
//     pre-existing pile -- you never drop a seed into B itself) and sow
//     them one by one starting at the pit after B (call it C). This can
//     repeat: whatever pit that new batch's last seed lands in becomes
//     the new "A", and B is re-derived from there, chaining onward.
//   - B is a dân pit that's EMPTY: sowing is done. Move to the capture
//     check (see below) using this A as the landing spot.
function resolveSow(pits, startIndex, direction, options) {
  const quanCaptureAllowed = !options || options.quanCaptureAllowed !== false;
  const quanEaten = (options && options.quanEaten) || {};
  let seeds = pits[startIndex];
  pits[startIndex] = 0;
  let idx = startIndex;
  let totalSeedsSown = 0; // across all relay batches, for logging/UI
  const path = []; // every pit a seed was actually dropped into, in order -- lets the client animate the drop step by step
  // Each entry marks a relay pickup: `afterPathIndex` is the path
  // position of A (the last drop before the pickup) and `pitIndex` is B
  // (the pit whose pre-existing pile got scooped up -- B itself never
  // gets a `path` entry of its own, since no seed is ever dropped into
  // it). The client uses this to show B being emptied between animating
  // the two batches, instead of the board just silently disagreeing with
  // what the animation showed.
  const relaySteps = [];
  // Whether sowing stopped because B turned out to be a Quan pit -- if
  // so, the capture check never runs at all (see the rule above).
  let blockedByQuan = false;
  // Relay chains are bounded in any real game (board holds a few dozen
  // seeds total), but this is otherwise unbounded recursion over board
  // state, so a defensive cap keeps a pathological/adversarial state
  // from hanging the server; normal play never comes close to it.
  let relayGuard = 0;
  for (;;) {
    totalSeedsSown += seeds;
    for (let remaining = seeds; remaining > 0; remaining -= 1) {
      idx = (idx + direction + 12) % 12;
      pits[idx] += 1;
      path.push(idx);
    }
    const nextPit = (idx + direction + 12) % 12; // "B" -- the pit right after this landing spot ("A")
    if (isQuanPit(nextPit)) {
      blockedByQuan = true;
      break;
    }
    if (pits[nextPit] === 0) break; // B is an empty dân pit -- sowing stops, move to the capture check
    relayGuard += 1;
    if (relayGuard > 200) break;
    relaySteps.push({ afterPathIndex: path.length - 1, pitIndex: nextPit });
    seeds = pits[nextPit];
    pits[nextPit] = 0;
    idx = nextPit; // next batch starts sowing at nextPit + direction, i.e. "C"
  }
  const landingIndex = idx;
  const { captured, capturedPits } = blockedByQuan
    ? { captured: 0, capturedPits: [] }
    : runCaptureChain(pits, landingIndex, direction, quanCaptureAllowed, quanEaten);
  return {
    landingIndex, captured, capturedPits, seedsSown: totalSeedsSown, path, relaySteps,
  };
}

// Capture check, reached only once sowing has stopped on an empty dân
// pit (see resolveSow): look at the pit right after the landing spot.
// If it's already occupied, nothing is captured -- turn just ends. If
// it's EMPTY, hop over it and capture whatever's in the pit after THAT
// one (Quan pits included -- capturing one marks it "eaten," subject to
// "Không ăn Quan non" and the opening ban below). The chain then keeps
// alternating "empty gap, capture" for as long as that pattern holds,
// stopping the moment a gap turns out to be a Quan pit or occupied.
function runCaptureChain(pits, landingIndex, direction, quanCaptureAllowed, quanEaten) {
  let captured = 0;
  const capturedPits = [];
  let checkIdx = landingIndex;
  for (;;) {
    const gapIdx = (checkIdx + direction + 12) % 12;
    if (isQuanPit(gapIdx) || pits[gapIdx] !== 0) break;
    const captureIdx = (gapIdx + direction + 12) % 12;
    if (pits[captureIdx] === 0) break; // nothing to capture beyond the gap
    // "Không ăn Quan non" + opening ban: an unripe Quan, or ANY Quan
    // during the opening ban window, is off-limits as a capture target
    // -- treated just like an empty pit would be, so the chain simply
    // stops here without erroring.
    if (isQuanPit(captureIdx) && (!quanCaptureAllowed || pits[captureIdx] < QUAN_RIPENESS_THRESHOLD)) break;
    // The 20-point base value is the big stone's own one-time worth --
    // award it only the first time this particular Quan is captured. A
    // Quan can absolutely be captured again later (once it re-ripens),
    // but that recapture only banks its accompanying dân, not a second
    // helping of the base value.
    const alreadyEaten = isQuanPit(captureIdx) && quanEaten[captureIdx];
    captured += pits[captureIdx] + (isQuanPit(captureIdx) && !alreadyEaten ? QUAN_BASE_VALUE : 0);
    capturedPits.push(captureIdx);
    pits[captureIdx] = 0;
    checkIdx = captureIdx;
  }
  return { captured, capturedPits };
}

// Bot heuristic: try every legal (pit, direction) combination on a
// scratch copy of the board, and greedily pick whichever captures the
// most seeds this turn (ties broken randomly so it isn't fully
// deterministic). Falls back to a random legal move if nothing captures
// anything. This is intentionally simple -- same "not perfect play, just
// a believable opponent" spirit as the other games' bot AI.
function chooseBotMove(pits, playerIndex, options) {
  const candidates = [];
  DAN_PITS[playerIndex].forEach((pitIndex) => {
    if (pits[pitIndex] <= 0) return;
    [1, -1].forEach((direction) => {
      const scratch = pits.slice();
      const result = resolveSow(scratch, pitIndex, direction, options);
      candidates.push({ pitIndex, direction, captured: result.captured });
    });
  });
  if (!candidates.length) return null;
  const bestCaptured = Math.max(...candidates.map((c) => c.captured));
  const best = candidates.filter((c) => c.captured === bestCaptured);
  return best[Math.floor(Math.random() * best.length)];
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

class OaqRoom {
  constructor(id, name, password, turnLimit) {
    this.id = id;
    this.name = name;
    this.password = password;
    // Optional host-configured cap on total moves (both players
    // combined) -- once moveSeq reaches this, the game ends immediately
    // via finishGame() regardless of whose turn it is or whether they
    // could still borrow. Falsy (0/null/undefined) means unlimited.
    this.turnLimit = turnLimit || null;
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // { id, name, connected, socketId, isBot, score }
    this.botCounter = 0;
    this.pits = freshPits();
    this.currentPlayerIndex = 0;
    this.log = [];
    this.winnerId = null;
    this.resultText = null;
    this.botTimer = null;
    this.rematchSwap = false; // alternate who goes first on "New Game"
    // The most recent move's full sow path -- purely so the client can
    // animate the drop step by step instead of just snapping to the new
    // board. `seq` lets the client tell "a new move happened" apart from
    // "the same move's state got rebroadcast again" (e.g. a reconnect).
    this.moveSeq = 0;
    this.lastMove = null; // { seq, playerId, startPit, direction, path, capturedPits }
    // Whether each Quan pit has ever been captured (eaten). Once true it
    // stays true for the rest of the game -- this is the game's actual
    // end condition (see checkGameEnd()), independent of whether the pit
    // has since reaccumulated seeds from later sows passing through it.
    this.quanEaten = { [QUAN_A]: false, [QUAN_B]: false };
    // Set once, right after construction (see attachOaq()) -- lets
    // scheduleBotTurn()'s setTimeout callback broadcast a bot's move on
    // its own, without every internal call site having to thread `nsp`
    // through startGame()/sow() just for this one purpose.
    this.nsp = null;
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 40) this.log.shift();
  }

  findPlayer(playerId) {
    return playerId ? this.players.find((p) => p.id === playerId) : undefined;
  }

  isEmpty() {
    return this.players.length === 0 || this.players.every((p) => !p.connected);
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      playerCount: this.players.filter((p) => p.connected).length,
      turnLimit: this.turnLimit,
    };
  }

  currentPlayer() {
    return this.players[this.currentPlayerIndex] || null;
  }

  // Whether the move about to be made (moveSeq + 1) falls after the
  // opening Quan-capture ban window. Shared by sow() (the real move) and
  // chooseBotMove()'s evaluation (via scheduleBotTurn()) so the bot's
  // idea of "is this capture worth it" matches what will actually happen.
  quanCaptureAllowedNow() {
    return this.moveSeq + 1 > OPENING_QUAN_BAN_TURNS;
  }

  startGame() {
    this.pits = freshPits();
    this.players.forEach((p) => { p.score = 0; });
    this.status = 'playing';
    this.currentPlayerIndex = this.rematchSwap ? 1 : 0;
    this.winnerId = null;
    this.resultText = null;
    this.log = [];
    this.moveSeq = 0;
    this.lastMove = null;
    this.quanEaten = { [QUAN_A]: false, [QUAN_B]: false };
    this.pushLog(`🎉 The game begins! ${this.players[this.currentPlayerIndex].name} goes first.`);
    clearTimeout(this.botTimer);
    this.scheduleBotTurn();
  }

  // Applies one legal move for whoever's turn it currently is. Returns
  // { ok: true } or { ok: false, error } -- callers (the socket handler
  // and the bot-turn timer) both funnel through here so a bot's move and
  // a human's move are validated and resolved identically.
  sow(player, pitIndex, direction) {
    if (this.status !== 'playing') return { ok: false, error: 'not-playing' };
    if (this.currentPlayer().id !== player.id) return { ok: false, error: 'not-your-turn' };
    const playerIndex = this.players.indexOf(player);
    if (!DAN_PITS[playerIndex].includes(pitIndex)) return { ok: false, error: 'not-your-pit' };
    if (this.pits[pitIndex] <= 0) return { ok: false, error: 'empty-pit' };
    if (direction !== 1 && direction !== -1) return { ok: false, error: 'invalid-direction' };

    const result = resolveSow(this.pits, pitIndex, direction, {
      quanCaptureAllowed: this.quanCaptureAllowedNow(), quanEaten: this.quanEaten,
    });
    this.moveSeq += 1;
    this.lastMove = {
      seq: this.moveSeq,
      playerId: player.id,
      startPit: pitIndex,
      direction,
      path: result.path,
      capturedPits: result.capturedPits,
      relaySteps: result.relaySteps,
    };
    if (result.relaySteps.length) {
      const times = result.relaySteps.length === 1 ? 'once' : `${result.relaySteps.length} times`;
      this.pushLog(`🔁 ${player.name}'s last seed landed in an occupied pit -- relay! Picked up and kept sowing ${times} before stopping.`);
    }
    if (result.captured > 0) {
      player.score += result.captured;
      const ateQuan = result.capturedPits.filter(isQuanPit);
      ateQuan.forEach((quanIndex) => { this.quanEaten[quanIndex] = true; });
      const quanNote = ateQuan.length ? ' (including a Quan pit!)' : '';
      this.pushLog(`🌾 ${player.name} sowed and captured ${result.captured} seed${result.captured === 1 ? '' : 's'}${quanNote}!`);
    } else {
      this.pushLog(`${player.name} sowed ${result.seedsSown} seed${result.seedsSown === 1 ? '' : 's'} — no capture.`);
    }

    this.currentPlayerIndex = (playerIndex + 1) % 2;
    this.checkGameEnd();
    if (this.status === 'playing') this.scheduleBotTurn();
    return { ok: true, result };
  }

  // "Play until the board is fully swept" variant: both Quan pits being
  // eaten no longer ends the game by itself -- the ONLY end conditions
  // are (a) an optional host-configured turn limit being reached, or (b)
  // a player's turn coming up with an empty row they can't afford to
  // borrow into (see finishGame() for how any still-un-eaten Quan's full
  // value still gets credited at that point).
  checkGameEnd() {
    if (this.turnLimit && this.moveSeq >= this.turnLimit) {
      this.pushLog(`⏱️ Turn limit of ${this.turnLimit} reached.`);
      this.finishGame();
      return;
    }

    const nextIndex = this.currentPlayerIndex;
    const hasMove = DAN_PITS[nextIndex].some((i) => this.pits[i] > 0);
    if (hasMove) return;

    const player = this.players[nextIndex];
    if (player.score >= STARTING_DAN_SEEDS) {
      player.score -= STARTING_DAN_SEEDS;
      DAN_PITS[nextIndex].forEach((i) => { this.pits[i] = 1; });
      this.pushLog(`🌱 ${player.name}'s row was empty -- borrowed ${STARTING_DAN_SEEDS} seeds from their own score to keep playing.`);
      return;
    }

    this.finishGame();
  }

  // Sweeps whatever's left on the board to its owner's score and settles
  // the result. Called when a player's row is empty and they can't
  // afford to borrow. Any Quan pit that was never captured still counts
  // its full value here (base + whatever accompanying dân it collected)
  // -- an eaten Quan's base value was already awarded at capture time,
  // so only its residual accompanying dân (if any) sweeps normally.
  finishGame() {
    for (let i = 0; i < 12; i += 1) {
      let value = this.pits[i];
      if (isQuanPit(i) && !this.quanEaten[i]) value += QUAN_BASE_VALUE;
      if (value <= 0) continue;
      const owner = ownerOfPit(i);
      this.players[owner].score += value;
      this.pits[i] = 0;
    }
    this.status = 'finished';
    const [a, b] = this.players;
    if (a.score > b.score) {
      this.winnerId = a.id;
      this.resultText = `${a.name} wins ${a.score} – ${b.score}!`;
    } else if (b.score > a.score) {
      this.winnerId = b.id;
      this.resultText = `${b.name} wins ${b.score} – ${a.score}!`;
    } else {
      this.winnerId = null;
      this.resultText = `It's a draw, ${a.score} – ${b.score}!`;
    }
    this.pushLog(`🏁 ${this.resultText}`);
    clearTimeout(this.botTimer);
  }

  newGame() {
    if (this.status !== 'finished') return { ok: false, error: 'not-finished' };
    this.rematchSwap = !this.rematchSwap;
    this.startGame();
    return { ok: true };
  }

  // Bots move after a short human-like delay, same pattern as Go's
  // scheduleBotTurn -- only ever schedules for the CURRENT player if
  // they're a bot; a no-op otherwise. Uses this.nsp (set once in
  // attachOaq() right after the room is created) to broadcast the bot's
  // move on its own -- sow() itself re-schedules the NEXT bot turn too,
  // so a bot-vs-bot game keeps ticking on its own without any human
  // input required.
  scheduleBotTurn() {
    clearTimeout(this.botTimer);
    const player = this.currentPlayer();
    if (!player || !player.isBot || this.status !== 'playing') return;
    this.botTimer = setTimeout(() => {
      if (this.status !== 'playing') return;
      const playerIndex = this.players.indexOf(player);
      const move = chooseBotMove(this.pits, playerIndex, {
        quanCaptureAllowed: this.quanCaptureAllowedNow(), quanEaten: this.quanEaten,
      });
      if (!move) return; // shouldn't happen -- checkGameEnd() would have caught an empty row already
      this.sow(player, move.pitIndex, move.direction);
      if (this.nsp) this.broadcast(this.nsp);
    }, BOT_THINK_MS_MIN + Math.random() * (BOT_THINK_MS_MAX - BOT_THINK_MS_MIN));
  }

  addBot() {
    const botName = BOT_NAMES[this.botCounter % BOT_NAMES.length];
    this.botCounter += 1;
    this.players.push({
      id: `bot_${this.id}_${this.botCounter}`, name: botName, connected: true, socketId: null, isBot: true, score: 0,
    });
    this.pushLog(`${botName} joined the table.`);
  }

  state(forPlayerId) {
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      pits: this.pits,
      quanIndices: [QUAN_A, QUAN_B],
      quanEaten: this.quanEaten,
      quanBaseValue: QUAN_BASE_VALUE,
      quanRipenessThreshold: QUAN_RIPENESS_THRESHOLD,
      quanCaptureAllowed: this.quanCaptureAllowedNow(),
      movesUntilQuanCaptureAllowed: Math.max(0, OPENING_QUAN_BAN_TURNS - this.moveSeq),
      turnLimit: this.turnLimit,
      moveSeq: this.moveSeq,
      danPits: DAN_PITS,
      currentPlayerId: this.players.length ? this.currentPlayer().id : null,
      log: this.log,
      winnerId: this.winnerId,
      resultText: this.resultText,
      lastMove: this.lastMove,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, connected: p.connected, isBot: Boolean(p.isBot), score: p.score,
      })),
      yourId: forPlayerId || null,
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('oaq:state', this.state(p.id));
    });
  }
}

function attachOaq(io) {
  const nsp = io.of('/oaq');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].filter((r) => !r.isEmpty()).map((r) => r.summary());
  }

  function broadcastRoomList() {
    nsp.emit('oaq:rooms', roomList());
  }

  nsp.on('connection', (socket) => {
    function myRoom() {
      return rooms.get(socket.roomId);
    }

    socket.on('oaq:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('oaq:createRoom', ({ roomName, password, playerId, name, turnLimit }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }
      const cleanTurnLimit = TURN_LIMIT_OPTIONS.includes(Number(turnLimit)) ? Number(turnLimit) : null;

      roomCounter += 1;
      const room = new OaqRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, cleanTurnLimit);
      room.nsp = nsp;
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, score: 0 });
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('oaq:joinRoom', ({ roomId, password, playerId, name }, callback) => {
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
        if (room.players.length >= MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'room-full' }); return; }
        room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, score: 0 });
        room.pushLog(`${clean} joined the room.`);
      }

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('oaq:addBot', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length >= MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'table-full' }); return; }
      room.addBot();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('oaq:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length < 2) { if (typeof callback === 'function') callback({ ok: false, error: 'not-enough-players' }); return; }
      room.startGame();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('oaq:sow', ({ pitIndex, direction }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.sow(player, Number(pitIndex), Number(direction));
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('oaq:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const result = room.newGame();
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('oaq:leave', () => {
      const room = myRoom();
      if (room) {
        const player = room.findPlayer(socket.playerId);
        if (player) player.connected = false;
        room.broadcast(nsp);
        broadcastRoomList();
      }
      socket.roomId = null;
      socket.playerId = null;
    });

    socket.on('disconnect', () => {
      const room = myRoom();
      if (room) {
        const player = room.findPlayer(socket.playerId);
        if (player) player.connected = false;
        room.broadcast(nsp);
        broadcastRoomList();
      }
    });
  });
}

module.exports = attachOaq;
module.exports.OaqRoom = OaqRoom;
module.exports.resolveSow = resolveSow;
module.exports.chooseBotMove = chooseBotMove;
module.exports.freshPits = freshPits;
module.exports.isQuanPit = isQuanPit;
module.exports.ownerOfPit = ownerOfPit;
module.exports.DAN_PITS = DAN_PITS;
module.exports.QUAN_A = QUAN_A;
module.exports.QUAN_B = QUAN_B;
module.exports.STARTING_DAN_SEEDS = STARTING_DAN_SEEDS;
module.exports.STARTING_QUAN_SEEDS = STARTING_QUAN_SEEDS;
module.exports.MAX_PLAYERS = MAX_PLAYERS;
module.exports.QUAN_BASE_VALUE = QUAN_BASE_VALUE;
module.exports.QUAN_RIPENESS_THRESHOLD = QUAN_RIPENESS_THRESHOLD;
module.exports.OPENING_QUAN_BAN_TURNS = OPENING_QUAN_BAN_TURNS;
module.exports.TURN_LIMIT_OPTIONS = TURN_LIMIT_OPTIONS;
