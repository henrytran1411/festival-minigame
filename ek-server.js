// Exploding Kittens — a second "backup game", same spirit as UNO: a casual
// side activity entirely outside the tournament's scoring system (no points,
// no admin gating). Players create or join password-protected rooms (a lobby
// lists open rooms by name/status/player count, but never the password) —
// multiple independent games can run at once instead of one single table.
//
// Seats are keyed by the same stable per-browser player ID the other games
// use (localStorage-based, sent by the client on join) rather than the raw
// socket connection — so a dropped WiFi connection, an accidental refresh,
// or even a full page reload can reconnect into the SAME seat. Each socket's
// resolved (roomId, playerId) is cached on the socket after a successful
// join/create so later events don't need to resend it.
//
// Deliberate simplifications from the official rules:
//   - Nope is single-layer only — a Noped action cannot itself be Noped
//     (no infinite Nope wars). The card is still discarded either way.
//   - Favor blocks the table (no other action can be taken) until the
//     targeted player hands over a card, or a short timer auto-picks a
//     random one for them — keeps the turn flow simple instead of allowing
//     arbitrary interleaving while a Favor is outstanding.
//   - Bots play a simple, not-really-smart heuristic (mostly just draw,
//     occasionally Skip/Attack to end a risky turn early, always Defuse and
//     reinsert randomly) — they don't use Favor, See the Future, or Cat
//     Combos on their own turn, and only reactively Nope an Attack aimed at
//     themselves some of the time. Good enough to fill an empty seat, not a
//     "real" opponent.
//   - Defuse total scales for tables above the official 5-player box
//     (players + 1, so everyone still gets one plus a spare in the deck)
//     rather than sticking to the fixed 6.

// Every genuine "cat" card — no effect alone, combines into a Cat Combo
// (pair/triple/five-different). Lazy Cat and Cute Cat are NOT here even
// though they're drawn as cat-flavored cards visually — they're full action
// cards with their own real effects (see ACTION_COUNTS/CARD_INFO below and
// ek:playLazyCat / the cutecat mimic play), so CAT_KEYS doubles as "the
// combo-eligible types" with no separate filtered list needed.
const CAT_TYPES = [
  { key: 'breadcat', label: 'Bread Cat', emoji: '🍞' },
  { key: 'derpcat', label: 'Derp Cat', emoji: '😝' },
  { key: 'sushicat', label: 'Sushi Cat', emoji: '🍣' },
  { key: 'tacocat', label: 'Tacocat', emoji: '🌮' },
  { key: 'cattermelon', label: 'Cattermelon', emoji: '🍉' },
  { key: 'beardcat', label: 'Beard Cat', emoji: '🧔' },
  { key: 'potatocat', label: 'Hairy Potato Cat', emoji: '🥔' },
  { key: 'rainbowcat', label: 'Rainbow-Ralphing Cat', emoji: '🌈' },
];
const CAT_KEYS = CAT_TYPES.map((c) => c.key);
const CARD_INFO = {
  defuse: { label: 'Defuse', emoji: '🛡️' },
  explodingKitten: { label: 'Exploding Kitten', emoji: '💣' },
  attack: { label: 'Attack', emoji: '⚔️' },
  skip: { label: 'Skip', emoji: '⏭️' },
  favor: { label: 'Favor', emoji: '🤝' },
  shuffle: { label: 'Shuffle', emoji: '🔀' },
  seeFuture: { label: 'See the Future', emoji: '🔮' },
  nope: { label: 'Nope', emoji: '🙅' },
  lazycat: { label: 'Lazy Cat', emoji: '😴' },
  cutecat: { label: 'Cute Cat', emoji: '🥹' },
};
CAT_TYPES.forEach((c) => { CARD_INFO[c.key] = { label: c.label, emoji: c.emoji }; });

function cardLabel(type) {
  const info = CARD_INFO[type];
  return info ? `${info.emoji} ${info.label}` : type;
}

// See the Future's result is private to whoever played it — sent directly
// to their own socket rather than folded into the broadcast state.
function sendSeeFuture(nsp, room, payload) {
  const target = room.findPlayer(payload.forPlayerId);
  if (target && target.connected && target.socketId) {
    nsp.to(target.socketId).emit('ek:seeFutureResult', { top3: payload.top3 });
  }
}

// Lazy Cat / Cute Cat are counted here (not in CAT_TYPES) since they're
// built via the same per-type loop as the other action cards below.
const ACTION_COUNTS = { attack: 4, skip: 4, favor: 4, shuffle: 4, seeFuture: 5, nope: 5, lazycat: 4, cutecat: 4 };
const CAT_COPIES_PER_TYPE = 4;
const BASE_DEFUSE_TOTAL = 6;
const STARTING_HAND_EXTRA = 6; // + 1 guaranteed Defuse = 7 total, matching the official box

const NOPE_WINDOW_MS = 5000;
const FAVOR_RESPONSE_MS = 10000;
const BOT_THINK_MIN_MS = 800;
const BOT_THINK_MAX_MS = 2000;
function randomBotThinkMs() {
  return BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
}
const BOT_NAMES = ['🤖 Bot An', '🤖 Bot Bình', '🤖 Bot Chi', '🤖 Bot Dũng', '🤖 Bot Giang', '🤖 Bot Hà'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildActionAndCatCards(idPrefix = 'c') {
  const cards = [];
  let n = 0;
  const nextId = () => `${idPrefix}${n++}`;
  Object.entries(ACTION_COUNTS).forEach(([type, count]) => {
    for (let i = 0; i < count; i++) cards.push({ id: nextId(), type });
  });
  CAT_KEYS.forEach((key) => {
    for (let i = 0; i < CAT_COPIES_PER_TYPE; i++) cards.push({ id: nextId(), type: key });
  });
  return cards;
}

// The base action/cat pool (66 cards: ACTION_COUNTS' 34 + CAT_KEYS' 8*4=32)
// comfortably covers small-to-mid tables — dealing 6 non-Defuse cards to
// each of N players alone needs N*6. For bigger tables, stack on extra full
// action/cat sets (fresh id prefixes so they don't collide) until there's
// comfortably enough for dealing PLUS a real draw pile left over — the same
// idea as combining physical decks for a big group.
function buildActionAndCatPoolForPlayers(playerCount) {
  let pool = buildActionAndCatCards();
  const needed = playerCount * STARTING_HAND_EXTRA + 20;
  let batch = 1;
  while (pool.length < needed) {
    batch += 1;
    pool = pool.concat(buildActionAndCatCards(`c${batch}_`));
  }
  return pool;
}
function buildDefuseCards(count) {
  const cards = [];
  for (let i = 0; i < count; i++) cards.push({ id: `d${i}`, type: 'defuse' });
  return cards;
}
function buildExplodingKittens(count) {
  const cards = [];
  for (let i = 0; i < count; i++) cards.push({ id: `k${i}`, type: 'explodingKitten' });
  return cards;
}

class EkRoom {
  constructor(id, name, password) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // { id, name, hand, connected, socketId, isBot, alive }
    this.deck = [];
    this.discard = [];
    this.currentPlayerIndex = 0;
    this.turnsOwed = 1; // how many turns (including the current one) this seat must take
    this.log = [];
    this.winnerId = null;
    this.botCounter = 0;
    this.botTimer = null;
    // Exactly one of these three can be active at a time — each represents
    // the table waiting on a specific player before anything else can
    // happen (mirrors UNO's uno:lockEvent / uno:catch style pending state).
    this.pendingAction = null; // { type, actorId, targetId?, requestedType?, discardCardId?, cardIds, deadline }
    this.pendingFavor = null; // { fromId, toId, deadline }
    this.pendingReinsert = null; // { playerId, kitten }
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 30) this.log.shift();
  }

  findPlayer(playerId) {
    return playerId ? this.players.find((p) => p.id === playerId) : undefined;
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  currentPlayer() {
    if (this.currentPlayerIndex >= this.players.length) this.currentPlayerIndex = 0;
    return this.players[this.currentPlayerIndex] || null;
  }

  advanceToNextAlive() {
    const id = this.peekNextAlivePlayerId();
    if (id !== null) this.currentPlayerIndex = this.players.findIndex((p) => p.id === id);
  }

  // Read-only version of the above — who WOULD be next, without mutating
  // currentPlayerIndex. Used to check "does this Attack target me" before
  // the attack has actually been applied.
  peekNextAlivePlayerId() {
    const n = this.players.length;
    let idx = this.currentPlayerIndex;
    for (let i = 0; i < n; i++) {
      idx = (idx + 1) % n;
      if (this.players[idx].alive) return this.players[idx].id;
    }
    return null;
  }

  startGame() {
    const n = this.players.length;
    const defuseTotal = Math.max(BASE_DEFUSE_TOTAL, n + 1);
    const explodingCount = Math.max(1, n - 1);
    const actionCatPool = shuffle(buildActionAndCatPoolForPlayers(n));
    const defusePool = shuffle(buildDefuseCards(defuseTotal));

    this.players.forEach((p) => { p.hand = []; p.alive = true; });
    this.players.forEach((p) => {
      p.hand.push(defusePool.pop());
      for (let i = 0; i < STARTING_HAND_EXTRA; i++) p.hand.push(actionCatPool.pop());
    });

    const explodingKittens = buildExplodingKittens(explodingCount);
    this.deck = shuffle([...actionCatPool, ...defusePool, ...explodingKittens]);
    this.discard = [];
    this.currentPlayerIndex = 0;
    this.turnsOwed = 1;
    this.status = 'playing';
    this.winnerId = null;
    this.log = [];
    this.pendingAction = null;
    this.pendingFavor = null;
    this.pendingReinsert = null;
    this.pushLog(`🎉 Game started with ${this.players.map((p) => p.name).join(', ')}.`);
    this.pushLog(`💣 ${explodingCount} Exploding Kitten${explodingCount === 1 ? '' : 's'} hidden in a ${this.deck.length}-card deck.`);
    this.pushLog(`${this.currentPlayer().name}'s turn.`);
  }

  // Called whenever a player's turn-taking finishes normally (a plain draw
  // that didn't explode, a defused draw, or a Skip) — consumes one of the
  // turns this seat owes, staying on the same seat if more are still owed.
  endTurnNormally() {
    this.turnsOwed -= 1;
    if (this.turnsOwed > 0) {
      this.pushLog(`${this.currentPlayer().name} must take another turn (${this.turnsOwed} left).`);
    } else {
      this.advanceToNextAlive();
      this.turnsOwed = 1;
      if (this.status === 'playing') this.pushLog(`${this.currentPlayer().name}'s turn.`);
    }
  }

  // Attack: ends the current player's turn-taking immediately (regardless of
  // how many turns they still owed) and hands the next seat 2 MORE turns
  // than whatever was left — so an attack played back on the very first of
  // an owed pair stacks to 4 total for the seat after that, and so on.
  // `halvings` (from reactive Lazy Cat plays — see beginPendingAction) floor-
  // divides the resulting turn count that many times, clamped to a minimum
  // of 1 (a single halving always fully cancels a fresh 2-turn Attack back
  // down to a normal turn, never below it).
  applyAttack(player, halvings = 0) {
    const carryOver = this.turnsOwed - 1;
    this.advanceToNextAlive();
    let owed = 2 + carryOver;
    for (let i = 0; i < halvings; i++) owed = Math.floor(owed / 2);
    this.turnsOwed = Math.max(1, owed);
    const halvedNote = halvings ? ` (halved by Lazy Cat x${halvings})` : '';
    this.pushLog(`⚔️ ${player.name} played Attack — ${this.currentPlayer().name} must take ${this.turnsOwed} turn(s)${halvedNote}!`);
  }

  applySkip(player) {
    this.pushLog(`⏭️ ${player.name} played Skip.`);
    this.endTurnNormally();
  }

  applyShuffle(player) {
    this.deck = shuffle(this.deck);
    this.pushLog(`🔀 ${player.name} shuffled the deck.`);
  }

  // Returns the top N cards (in draw order) for the caller to send PRIVATELY
  // to the player who played it — never broadcast to the table. `halvings`
  // (Lazy Cat) floor-divides the normal peek of 3 that many times — e.g. one
  // halving shows 1 card, two halvings shows 0 (you see nothing at all).
  applySeeFuture(halvings = 0) {
    let count = 3;
    for (let i = 0; i < halvings; i++) count = Math.floor(count / 2);
    return count > 0 ? this.deck.slice(-count).reverse() : [];
  }

  applyFavor(player, targetId) {
    const target = this.findPlayer(targetId);
    this.pendingFavor = { fromId: player.id, toId: targetId, deadline: Date.now() + FAVOR_RESPONSE_MS };
    this.pushLog(`🤝 ${player.name} used Favor on ${target.name} — waiting for a card.`);
  }

  resolveFavor(cardId) {
    if (!this.pendingFavor) return;
    const { fromId, toId } = this.pendingFavor;
    const giver = this.findPlayer(toId);
    const receiver = this.findPlayer(fromId);
    this.pendingFavor = null;
    if (!giver || !receiver || !giver.hand.length) return;
    const idx = cardId ? giver.hand.findIndex((c) => c.id === cardId) : Math.floor(Math.random() * giver.hand.length);
    if (idx === -1) return;
    const [card] = giver.hand.splice(idx, 1);
    receiver.hand.push(card);
    this.pushLog(`${giver.name} handed a card to ${receiver.name} (Favor).`);
  }

  applyCatPair(player, targetId) {
    const target = this.findPlayer(targetId);
    if (!target || !target.hand.length) {
      this.pushLog(`🐱🐱 ${player.name} tried a Cat Pair on ${target ? target.name : '?'}, but they had no cards.`);
      return;
    }
    const idx = Math.floor(Math.random() * target.hand.length);
    const [card] = target.hand.splice(idx, 1);
    player.hand.push(card);
    this.pushLog(`🐱🐱 ${player.name} used a Cat Pair on ${target.name} and stole a card!`);
  }

  applyCatTriple(player, targetId, requestedType) {
    const target = this.findPlayer(targetId);
    if (!target) return;
    const idx = target.hand.findIndex((c) => c.type === requestedType);
    if (idx === -1) {
      this.pushLog(`🐱🐱🐱 ${player.name} demanded a ${cardLabel(requestedType)} from ${target.name}, but they didn't have one.`);
      return;
    }
    const [card] = target.hand.splice(idx, 1);
    player.hand.push(card);
    this.pushLog(`🐱🐱🐱 ${player.name} demanded and got a ${cardLabel(requestedType)} from ${target.name}!`);
  }

  applyCatFive(player, discardCardId) {
    const idx = this.discard.findIndex((c) => c.id === discardCardId);
    if (idx === -1) {
      this.pushLog(`${player.name}'s 5-card Cat Combo found nothing to take from the discard pile.`);
      return;
    }
    const [card] = this.discard.splice(idx, 1);
    player.hand.push(card);
    this.pushLog(`🐱🌈 ${player.name} used a 5-card Cat Combo to grab ${cardLabel(card.type)} from the discard pile!`);
  }

  // Draws one card for `player`. Returns { exploded, defused }. Handles the
  // Exploding Kitten / Defuse interaction inline; does NOT itself end the
  // turn (see endTurnNormally / callers) so the reinsert step can happen
  // first when defused.
  drawCard(player) {
    if (!this.deck.length) return { exploded: false, defused: false, empty: true };
    const card = this.deck.pop();
    if (card.type !== 'explodingKitten') {
      player.hand.push(card);
      return { exploded: false, defused: false };
    }
    const defuseIdx = player.hand.findIndex((c) => c.type === 'defuse');
    if (defuseIdx !== -1) {
      const [defuseCard] = player.hand.splice(defuseIdx, 1);
      this.discard.push(defuseCard);
      this.pendingReinsert = { playerId: player.id, kitten: card };
      this.pushLog(`💣 ${player.name} drew an Exploding Kitten but defused it!`);
      return { exploded: false, defused: true };
    }
    // Cute Cat also works as a Defuse substitute -- "the all-encompassing
    // power of cuteness" -- used automatically only when there's no real
    // Defuse to fall back on (survival always wins over saving it for later).
    const cuteCatIdx = player.hand.findIndex((c) => c.type === 'cutecat');
    if (cuteCatIdx !== -1) {
      const [cuteCatCard] = player.hand.splice(cuteCatIdx, 1);
      this.discard.push(cuteCatCard);
      this.pendingReinsert = { playerId: player.id, kitten: card };
      this.pushLog(`😻 ${player.name} drew an Exploding Kitten but used Cute Cat to survive it!`);
      return { exploded: false, defused: true };
    }
    this.discard.push(card);
    player.alive = false;
    this.pushLog(`💥 ${player.name} exploded! Out of the game.`);
    const alive = this.alivePlayers();
    if (alive.length <= 1) {
      this.status = 'finished';
      this.winnerId = alive.length ? alive[0].id : null;
      this.pushLog(alive.length ? `🏆 ${alive[0].name} wins!` : 'Everyone exploded — no winner.');
    }
    return { exploded: true, defused: false };
  }

  // position: 0 = top of the deck (the very next card drawn) up to
  // deck.length = the very bottom. Draws happen via deck.pop() (from the
  // END of the array), so "top" maps to the end here.
  resolveReinsert(position) {
    if (!this.pendingReinsert) return;
    const { playerId, kitten } = this.pendingReinsert;
    const player = this.findPlayer(playerId);
    this.pendingReinsert = null;
    const clamped = Math.max(0, Math.min(this.deck.length, Number(position) || 0));
    this.deck.splice(this.deck.length - clamped, 0, kitten);
    this.pushLog(`${player ? player.name : 'Someone'} secretly slipped the kitten back into the deck.`);
    this.endTurnNormally();
  }

  // Actually applies a pending action's effect once it's confirmed to go
  // through (Nope window expired / no one could Nope). Returns any private
  // payload the actor alone should see (currently only See the Future).
  resolvePendingActionEffect() {
    const a = this.pendingAction;
    this.pendingAction = null;
    if (!a) return null;
    const player = this.findPlayer(a.actorId);
    if (!player) return null;
    switch (a.type) {
      case 'attack': this.applyAttack(player, a.halvings || 0); return null;
      case 'skip': this.applySkip(player); return null;
      case 'shuffle': this.applyShuffle(player); return null;
      case 'seeFuture': return { forPlayerId: a.actorId, top3: this.applySeeFuture(a.halvings || 0) };
      case 'favor': this.applyFavor(player, a.targetId); return null;
      case 'catPair': this.applyCatPair(player, a.targetId); return null;
      case 'catTriple': this.applyCatTriple(player, a.targetId, a.requestedType); return null;
      case 'catFive': this.applyCatFive(player, a.discardCardId); return null;
      // Cute Cat: "the all-encompassing power of cuteness" — mimics whichever
      // action the player chose at play time. Deliberately NOT composed with
      // Lazy Cat halvings even if it mimics attack/seeFuture, to keep the two
      // mechanics independent instead of a deep interaction matrix.
      case 'cutecat':
        if (a.mimicType === 'attack') { this.applyAttack(player); return null; }
        if (a.mimicType === 'skip') { this.applySkip(player); return null; }
        if (a.mimicType === 'shuffle') { this.applyShuffle(player); return null; }
        if (a.mimicType === 'seeFuture') return { forPlayerId: a.actorId, top3: this.applySeeFuture() };
        if (a.mimicType === 'favor') { this.applyFavor(player, a.targetId); return null; }
        return null;
      default: return null;
    }
  }

  // verb/emoji differ for a regular Nope vs. a Cute Cat countering another
  // Cute Cat (the only thing that CAN stop one — see ek:nope's rejection of
  // cutecat and the dedicated ek:counterCuteCat handler).
  cancelPendingAction(noperName, { verb = 'Noped', emoji = '🙅' } = {}) {
    const a = this.pendingAction;
    this.pendingAction = null;
    if (!a) return;
    clearTimeout(a.timer);
    const actor = this.findPlayer(a.actorId);
    const isCatCombo = ['catPair', 'catTriple', 'catFive'].includes(a.type);
    const cardName = a.type === 'cutecat' ? cardLabel('cutecat') : cardLabel(isCatCombo ? 'nope' : a.type);
    this.pushLog(`${emoji} ${noperName} ${verb} ${actor ? actor.name + "'s" : 'that'} ${cardName}! Nothing happens.`);
  }

  // Simple, deliberately not-smart bot Nope check: a bot only ever
  // considers Noping an Attack aimed squarely at itself, and even then only
  // some of the time. Returns true if it noped (and mutates state). Must be
  // called BEFORE the pending action resolves — applyAttack() is what
  // actually advances the seat, so "who would be attacked" is figured out
  // via peekNextAlivePlayerId() rather than currentPlayer() (which is still
  // the ACTOR at this point, not the target).
  maybeBotNope() {
    const a = this.pendingAction;
    if (!a) return false;
    const attackTargetId = a.type === 'attack' ? this.peekNextAlivePlayerId() : null;
    for (const p of this.players) {
      if (!p.isBot || !p.connected || p.id === a.actorId) continue;
      const nopeIdx = p.hand.findIndex((c) => c.type === 'nope');
      if (nopeIdx === -1) continue;
      if (a.type === 'attack' && p.id === attackTargetId && Math.random() < 0.4) {
        const [card] = p.hand.splice(nopeIdx, 1);
        this.discard.push(card);
        this.cancelPendingAction(p.name);
        return true;
      }
    }
    return false;
  }

  // Single entry point for putting ANY Nope-able action into the pending
  // state and running the same resolution pipeline every time — whether the
  // card was played by a human (ek:playCard) or by a bot on its own turn
  // (runBotTurn). Previously bots short-circuited straight to applyAttack/
  // applySkip, which meant a bot's own Attack or Skip could never be Noped
  // by anyone, human or bot — this is the fix for that.
  beginPendingAction(nsp, type, actorId, extra = {}) {
    const actor = this.findPlayer(actorId);
    this.pendingAction = {
      type,
      actorId,
      targetId: extra.targetId || null,
      requestedType: extra.requestedType || null,
      discardCardId: extra.discardCardId || null,
      mimicType: extra.mimicType || null,
      halvings: 0,
      deadline: Date.now() + NOPE_WINDOW_MS,
      timer: null,
    };
    const labelType = type === 'cutecat' ? 'cutecat' : (['catPair', 'catTriple', 'catFive'].includes(type) ? (extra.catType || type) : type);
    const waitingNote = type === 'cutecat' ? 'waiting to see if another Cute Cat stops it...' : 'waiting to see if anyone Nopes...';
    this.pushLog(`${actor ? actor.name : 'Someone'} played ${cardLabel(labelType)}${type.startsWith('cat') && type !== 'cutecat' ? ' (Cat Combo)' : ''} — ${waitingNote}`);
    this.broadcast(nsp);

    if (this.maybeBotNope()) {
      this.broadcast(nsp);
      this.scheduleBotAction(nsp);
      return;
    }

    if (this.anyoneCanReact(actorId)) {
      this.pendingAction.timer = setTimeout(() => {
        try {
          if (!this.pendingAction) return;
          this.resolvePendingAndBroadcast(nsp);
        } catch (err) {
          console.error(`[ek] Nope-window timeout failed in room ${this.id}:`, err);
        }
      }, NOPE_WINDOW_MS);
      return;
    }

    this.resolvePendingAndBroadcast(nsp);
  }

  // Whether the reactive window should stay open at all: a regular Nope
  // works on anything EXCEPT a Cute Cat play (which only another Cute Cat
  // can counter); Lazy Cat only ever reacts to attack/seeFuture.
  anyoneCanReact(actorId) {
    const type = this.pendingAction && this.pendingAction.type;
    if (!type) return false;
    return this.players.some((p) => {
      if (!p.connected || p.isBot || p.id === actorId) return false;
      if (type === 'cutecat') return p.hand.some((c) => c.type === 'cutecat');
      const canNope = p.hand.some((c) => c.type === 'nope');
      const canHalve = ['attack', 'seeFuture'].includes(type) && p.hand.some((c) => c.type === 'lazycat');
      return canNope || canHalve;
    });
  }

  resolvePendingAndBroadcast(nsp) {
    const payload = this.resolvePendingActionEffect();
    this.broadcast(nsp);
    if (payload) sendSeeFuture(nsp, this, payload);
    this.scheduleBotAction(nsp);
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
    };
  }

  personalizedState(forPlayerId) {
    const me = this.findPlayer(forPlayerId);
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      deckCount: this.deck.length,
      discardTop: this.discard[this.discard.length - 1] || null,
      discard: this.discard,
      currentPlayerId: this.players.length ? this.currentPlayer().id : null,
      turnsOwed: this.turnsOwed,
      log: this.log,
      winnerId: this.winnerId,
      pendingAction: this.pendingAction ? {
        type: this.pendingAction.type,
        actorId: this.pendingAction.actorId,
        targetId: this.pendingAction.targetId || null,
        mimicType: this.pendingAction.mimicType || null,
        halvings: this.pendingAction.halvings || 0,
        deadline: this.pendingAction.deadline,
      } : null,
      pendingFavor: this.pendingFavor,
      pendingReinsert: this.pendingReinsert ? { playerId: this.pendingReinsert.playerId } : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        connected: p.connected,
        alive: p.alive,
      })),
      yourId: forPlayerId || null,
      yourHand: me ? me.hand : [],
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('ek:state', this.personalizedState(p.id));
    });
  }

  // Central dispatcher: schedules whichever pending thing needs a bot (or a
  // disconnected human, treated the same way so the room never stalls) to
  // act on its own. Called after every state-changing operation.
  scheduleBotAction(nsp) {
    clearTimeout(this.botTimer);
    this.botTimer = null;
    if (this.status !== 'playing') return;

    if (this.pendingReinsert) {
      const p = this.findPlayer(this.pendingReinsert.playerId);
      if (p && (p.isBot || !p.connected)) {
        this.botTimer = setTimeout(() => this.autoResolveReinsert(nsp), randomBotThinkMs());
      }
      return;
    }
    if (this.pendingFavor) {
      const p = this.findPlayer(this.pendingFavor.toId);
      if (p && (p.isBot || !p.connected)) {
        this.botTimer = setTimeout(() => this.autoResolveFavor(nsp), randomBotThinkMs());
      }
      return;
    }
    if (this.pendingAction) return; // waiting on a human Nope window (its own timer) or already settled
    const cp = this.currentPlayer();
    if (cp && (cp.isBot || !cp.connected)) {
      this.botTimer = setTimeout(() => this.runBotTurn(nsp), randomBotThinkMs());
    }
  }

  // A bug in any of these three bot-driven paths would otherwise throw
  // inside a bare setTimeout callback and crash the ENTIRE server process —
  // taking down every other room, UNO, and all 4 scored games with it, not
  // just this one Exploding Kittens table. Caught and logged instead so the
  // rest of the event keeps running even if one room's bot logic hits an
  // edge case; that one room is left as-is for a human to investigate/leave.
  safeBotStep(nsp, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[ek] bot step failed in room ${this.id}:`, err);
    }
  }

  autoResolveReinsert(nsp) {
    this.botTimer = null;
    this.safeBotStep(nsp, () => {
      if (this.status !== 'playing' || !this.pendingReinsert) return;
      this.resolveReinsert(Math.floor(Math.random() * (this.deck.length + 1)));
      this.broadcast(nsp);
      this.scheduleBotAction(nsp);
    });
  }

  autoResolveFavor(nsp) {
    this.botTimer = null;
    this.safeBotStep(nsp, () => {
      if (this.status !== 'playing' || !this.pendingFavor) return;
      // Prefer giving away a duplicate-ish / low-value card: a combo-only
      // cat card first (Lazy Cat/Cute Cat are real action cards now, not
      // fodder — excluded here on purpose), otherwise whatever's first in
      // hand. Never hands over its own last Nope/Defuse if anything else is
      // available.
      const giver = this.findPlayer(this.pendingFavor.toId);
      let cardId = null;
      if (giver) {
        const preferred = giver.hand.find((c) => CAT_KEYS.includes(c.type))
          || giver.hand.find((c) => c.type !== 'defuse' && c.type !== 'nope' && c.type !== 'lazycat' && c.type !== 'cutecat')
          || giver.hand[0];
        cardId = preferred ? preferred.id : null;
      }
      this.resolveFavor(cardId);
      this.broadcast(nsp);
      this.scheduleBotAction(nsp);
    });
  }

  // Deliberately simple: mostly just draws. Occasionally ends its turn
  // early with Skip/Attack if it's holding one (reduces explosion risk
  // without any real hand-reading strategy). Always defuses + reinserts
  // randomly when it draws an Exploding Kitten.
  runBotTurn(nsp) {
    this.botTimer = null;
    this.safeBotStep(nsp, () => {
      if (this.status !== 'playing') return;
      const bot = this.currentPlayer();
      if (!bot || !(bot.isBot || !bot.connected)) return;

      const attackCard = bot.hand.find((c) => c.type === 'attack');
      const skipCard = bot.hand.find((c) => c.type === 'skip');
      if (attackCard && Math.random() < 0.35) {
        bot.hand = bot.hand.filter((c) => c.id !== attackCard.id);
        this.discard.push(attackCard);
        this.beginPendingAction(nsp, 'attack', bot.id); // Nope-able, same as a human playing it
        return;
      } else if (skipCard && Math.random() < 0.35) {
        bot.hand = bot.hand.filter((c) => c.id !== skipCard.id);
        this.discard.push(skipCard);
        this.beginPendingAction(nsp, 'skip', bot.id); // Nope-able, same as a human playing it
        return;
      } else {
        const result = this.drawCard(bot);
        if (!result.defused && !result.exploded) this.endTurnNormally();
        // exploded: turn/seat already moved on inside drawCard via advanceToNextAlive-equivalent (status check below).
        if (result.exploded && this.status === 'playing') {
          // The seat that just exploded is no longer alive; move on to the next.
          this.advanceToNextAlive();
          this.turnsOwed = 1;
          this.pushLog(`${this.currentPlayer().name}'s turn.`);
        }
        // defused: pendingReinsert now set, handled by scheduleBotAction next.
      }
      this.broadcast(nsp);
      this.scheduleBotAction(nsp);
    });
  }
}

function attachEk(io) {
  const nsp = io.of('/ek');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].map((r) => r.summary());
  }
  function broadcastRoomList() {
    nsp.emit('ek:rooms', roomList());
  }
  function deleteRoomIfEmpty(room) {
    if (room && room.isEmpty()) {
      clearTimeout(room.botTimer);
      if (room.pendingAction) clearTimeout(room.pendingAction.timer);
      rooms.delete(room.id);
    }
  }

  nsp.on('connection', (socket) => {
    socket.emit('ek:rooms', roomList());

    socket.on('ek:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('ek:createRoom', ({ roomName, password, playerId, name }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const room = new EkRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword);
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({ id: playerId, name: clean, hand: [], connected: true, socketId: socket.id, alive: true });
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('ek:joinRoom', ({ roomId, password, playerId, name }, callback) => {
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
        if (room.players.length >= 10) { if (typeof callback === 'function') callback({ ok: false, error: 'room-full' }); return; }
        room.players.push({ id: playerId, name: clean, hand: [], connected: true, socketId: socket.id, alive: true });
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

    socket.on('ek:addBots', ({ count }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const n = Math.max(1, Math.min(6, Number(count) || 3));
      if (room.players.length + n > 10) { if (typeof callback === 'function') callback({ ok: false, error: 'table-full' }); return; }
      for (let i = 0; i < n; i++) {
        const botName = BOT_NAMES[room.botCounter % BOT_NAMES.length];
        room.botCounter += 1;
        room.players.push({
          id: `bot_${room.id}_${room.botCounter}`,
          name: botName,
          hand: [],
          connected: true,
          socketId: null,
          isBot: true,
          alive: true,
        });
        room.pushLog(`${botName} joined the table.`);
      }
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('ek:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length < 2) { if (typeof callback === 'function') callback({ ok: false, error: 'not-enough-players' }); return; }
      room.startGame();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotAction(nsp);
    });

    function requireMyTurn(room, callback) {
      const player = room.findPlayer(socket.playerId);
      if (!player || room.status !== 'playing' || !room.currentPlayer() || room.currentPlayer().id !== socket.playerId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'not-your-turn' });
        return null;
      }
      if (room.pendingAction || room.pendingFavor || room.pendingReinsert) {
        if (typeof callback === 'function') callback({ ok: false, error: 'action-pending' });
        return null;
      }
      return player;
    }

    socket.on('ek:draw', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = requireMyTurn(room, callback);
      if (!player) return;
      const result = room.drawCard(player);
      if (typeof callback === 'function') callback({ ok: true });
      if (!result.defused && !result.exploded) {
        room.endTurnNormally();
      } else if (result.exploded && room.status === 'playing') {
        room.advanceToNextAlive();
        room.turnsOwed = 1;
        room.pushLog(`${room.currentPlayer().name}'s turn.`);
      }
      room.broadcast(nsp);
      room.scheduleBotAction(nsp);
    });

    socket.on('ek:reinsertKitten', ({ position }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (!room.pendingReinsert || room.pendingReinsert.playerId !== socket.playerId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'nothing-pending' });
        return;
      }
      room.resolveReinsert(position);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotAction(nsp);
    });

    socket.on('ek:giveFavorCard', ({ cardId }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (!room.pendingFavor || room.pendingFavor.toId !== socket.playerId) {
        if (typeof callback === 'function') callback({ ok: false, error: 'nothing-pending' });
        return;
      }
      room.resolveFavor(cardId);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotAction(nsp);
    });

    // Unified entry point for every "played" card other than the implicit
    // draw: cardIds.length selects which kind of action it is (1 = a single
    // action card, 2/3/5 = a Cat Combo of that size).
    socket.on('ek:playCard', ({ cardIds, targetId, requestedType, discardCardId, mimicType }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = requireMyTurn(room, callback);
      if (!player) return;

      const ids = Array.isArray(cardIds) ? [...new Set(cardIds)] : [];
      const cards = ids.map((id) => player.hand.find((c) => c.id === id)).filter(Boolean);
      if (cards.length !== ids.length || ![1, 2, 3, 5].includes(cards.length)) {
        if (typeof callback === 'function') callback({ ok: false, error: 'invalid-cards' });
        return;
      }

      let type;
      if (cards.length === 1) {
        type = cards[0].type;
        if (type === 'cutecat') {
          if (!['attack', 'skip', 'favor', 'shuffle', 'seeFuture'].includes(mimicType)) {
            if (typeof callback === 'function') callback({ ok: false, error: 'invalid-mimic-type' });
            return;
          }
          if (mimicType === 'favor' && (!targetId || !room.findPlayer(targetId) || !room.findPlayer(targetId).alive || targetId === player.id)) {
            if (typeof callback === 'function') callback({ ok: false, error: 'invalid-target' });
            return;
          }
        } else if (!['attack', 'skip', 'favor', 'shuffle', 'seeFuture'].includes(type)) {
          if (typeof callback === 'function') callback({ ok: false, error: 'not-playable-alone' });
          return;
        } else if (type === 'favor' && (!targetId || !room.findPlayer(targetId) || !room.findPlayer(targetId).alive || targetId === player.id)) {
          if (typeof callback === 'function') callback({ ok: false, error: 'invalid-target' });
          return;
        }
      } else if (cards.length === 2) {
        if (cards[0].type !== cards[1].type || !CAT_KEYS.includes(cards[0].type)) {
          if (typeof callback === 'function') callback({ ok: false, error: 'not-a-matching-pair' });
          return;
        }
        if (!targetId || !room.findPlayer(targetId) || !room.findPlayer(targetId).alive || targetId === player.id) {
          if (typeof callback === 'function') callback({ ok: false, error: 'invalid-target' });
          return;
        }
        type = 'catPair';
      } else if (cards.length === 3) {
        if (!cards.every((c) => c.type === cards[0].type) || !CAT_KEYS.includes(cards[0].type)) {
          if (typeof callback === 'function') callback({ ok: false, error: 'not-a-matching-triple' });
          return;
        }
        if (!targetId || !room.findPlayer(targetId) || !room.findPlayer(targetId).alive || targetId === player.id) {
          if (typeof callback === 'function') callback({ ok: false, error: 'invalid-target' });
          return;
        }
        if (!requestedType || !CARD_INFO[requestedType]) {
          if (typeof callback === 'function') callback({ ok: false, error: 'invalid-requested-type' });
          return;
        }
        type = 'catTriple';
      } else {
        const distinctTypes = new Set(cards.map((c) => c.type));
        if (distinctTypes.size !== 5 || ![...distinctTypes].every((t) => CAT_KEYS.includes(t))) {
          if (typeof callback === 'function') callback({ ok: false, error: 'not-five-different-cats' });
          return;
        }
        if (!discardCardId || !room.discard.some((c) => c.id === discardCardId)) {
          if (typeof callback === 'function') callback({ ok: false, error: 'invalid-discard-choice' });
          return;
        }
        type = 'catFive';
      }

      player.hand = player.hand.filter((c) => !ids.includes(c.id));
      cards.forEach((c) => room.discard.push(c));

      if (typeof callback === 'function') callback({ ok: true });

      room.beginPendingAction(nsp, type, player.id, {
        targetId: type === 'cutecat' && mimicType !== 'favor' ? null : targetId,
        requestedType,
        discardCardId,
        catType: cards[0].type,
        mimicType,
      });
    });

    socket.on('ek:nope', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!room.pendingAction || !player) { if (typeof callback === 'function') callback({ ok: false, error: 'nothing-pending' }); return; }
      if (room.pendingAction.type === 'cutecat') {
        // "The all-encompassing power of cuteness" -- a regular Nope can't
        // touch a Cute Cat play. Only another Cute Cat can (ek:counterCuteCat).
        if (typeof callback === 'function') callback({ ok: false, error: 'nope-cannot-stop-cutecat' });
        return;
      }
      const nopeIdx = player.hand.findIndex((c) => c.type === 'nope');
      if (nopeIdx === -1) { if (typeof callback === 'function') callback({ ok: false, error: 'no-nope-card' }); return; }
      clearTimeout(room.pendingAction.timer);
      const [card] = player.hand.splice(nopeIdx, 1);
      room.discard.push(card);
      room.cancelPendingAction(player.name);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotAction(nsp);
    });

    // Lazy Cat: reactive, only usable against a pending Attack or See the
    // Future (not a cancel like Nope -- it HALVES the eventual effect, and
    // stacks if played more than once against the same pending action).
    socket.on('ek:playLazyCat', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!room.pendingAction || !player) { if (typeof callback === 'function') callback({ ok: false, error: 'nothing-pending' }); return; }
      if (!['attack', 'seeFuture'].includes(room.pendingAction.type)) {
        if (typeof callback === 'function') callback({ ok: false, error: 'not-halvable' });
        return;
      }
      if (room.pendingAction.actorId === player.id) {
        if (typeof callback === 'function') callback({ ok: false, error: 'cannot-halve-own-card' });
        return;
      }
      const lazyIdx = player.hand.findIndex((c) => c.type === 'lazycat');
      if (lazyIdx === -1) { if (typeof callback === 'function') callback({ ok: false, error: 'no-lazycat-card' }); return; }
      const [card] = player.hand.splice(lazyIdx, 1);
      room.discard.push(card);
      room.pendingAction.halvings = (room.pendingAction.halvings || 0) + 1;
      room.pushLog(`😴 ${player.name} played Lazy Cat — halving the effect!`);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    // Cute Cat: the only thing that can stop another Cute Cat's play.
    socket.on('ek:counterCuteCat', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!room.pendingAction || room.pendingAction.type !== 'cutecat' || !player) {
        if (typeof callback === 'function') callback({ ok: false, error: 'nothing-pending' });
        return;
      }
      const idx = player.hand.findIndex((c) => c.type === 'cutecat');
      if (idx === -1) { if (typeof callback === 'function') callback({ ok: false, error: 'no-cutecat-card' }); return; }
      clearTimeout(room.pendingAction.timer);
      const [card] = player.hand.splice(idx, 1);
      room.discard.push(card);
      room.cancelPendingAction(player.name, { verb: 'countered', emoji: '😻' });
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.scheduleBotAction(nsp);
    });

    socket.on('ek:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'finished') { if (typeof callback === 'function') callback({ ok: false, error: 'not-finished' }); return; }
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
          player.connected = false;
          room.pushLog(`${player.name} disconnected.`);
        }
        room.broadcast(nsp);
        room.scheduleBotAction(nsp);
      }
      deleteRoomIfEmpty(room);
      broadcastRoomList();
      socket.roomId = null;
    }

    socket.on('ek:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
}

module.exports = attachEk;
// Exposed purely for automated testing of the game-logic pieces without
// needing a live socket server.
module.exports.EkRoom = EkRoom;
module.exports.CAT_KEYS = CAT_KEYS;
module.exports.CARD_INFO = CARD_INFO;
module.exports.cardLabel = cardLabel;
module.exports.ACTION_COUNTS = ACTION_COUNTS;
module.exports.CAT_COPIES_PER_TYPE = CAT_COPIES_PER_TYPE;
module.exports.BASE_DEFUSE_TOTAL = BASE_DEFUSE_TOTAL;
