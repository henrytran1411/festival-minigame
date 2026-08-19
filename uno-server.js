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
//
// Optional "advance cards" (none selected by default, picked per-room in
// the waiting room before start — players choose ANY SUBSET of the 6 house-
// rule card types, not all-or-nothing) add cards on top of the standard
// deck — see buildAdvanceCards() and the applyPlay() branches for each.
// (A 7th, Number Wild, was tried and removed — see buildAdvanceCards().)

const COLORS = ['red', 'yellow', 'green', 'blue'];
const ACTIONS = ['skip', 'reverse', 'draw2'];
// Copies of EACH of the 4 colors — minus2: 2/color = 8 total; switchPos: 1/color = 4 total.
const COLOR_ACTION_COPIES_PER_COLOR = { minus2: 2, switchPos: 1 };
const NEW_COLOR_ACTION_VALUES = Object.keys(COLOR_ACTION_COPIES_PER_COLOR);
const NEW_WILD_ACTION_COUNTS = { actionWild: 4, lock: 4, switchWild: 4, plusWild: 4 };
const ALL_ACTION_VALUES = [...ACTIONS, ...NEW_COLOR_ACTION_VALUES];
// The full set of selectable advance-card type keys, for validating a
// room's uno:setAdvanceCards selection payload.
const ADVANCE_CARD_TYPES = new Set([...NEW_COLOR_ACTION_VALUES, ...Object.keys(NEW_WILD_ACTION_COUNTS)]);
const LOCK_DICE_WEIGHTS = [{ value: 1, weight: 60 }, { value: 2, weight: 30 }, { value: 3, weight: 10 }];
const BOT_NAMES = ['🤖 Bot Minh', '🤖 Bot Lan', '🤖 Bot Huy', '🤖 Bot Trang', '🤖 Bot Đức', '🤖 Bot Mai'];
const BOT_THINK_MIN_MS = 1000;
const BOT_THINK_MAX_MS = 3000;
function randomBotThinkMs() {
  return BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
}

// Mirrors the timings in showLockAnimation() (uno.js) so the server holds
// bots back for as long as the reveal actually takes on screen — not a
// flat worst-case guess. Keep these two in sync if either side's timing
// changes: dice spin (5000) + pause (500), per-round wheel spin (4800) +
// pause (600), final hold (1000), plus slack for socket delivery latency.
const LOCK_REVEAL_DICE_MS = 5500;
const LOCK_REVEAL_ROUND_MS = 5400;
const LOCK_REVEAL_FINAL_HOLD_MS = 1000;
const LOCK_REVEAL_NETWORK_BUFFER_MS = 1500;

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

// Optional house-rule cards (see file header) — each room picks any subset
// of these, and only the SELECTED types' cards get added on top of the
// standard 108:
//   -2                     2 of each of the 4 colors  =  8
//   Switch Position        1 of each of the 4 colors  =  4
//   Action Wild            4  (wild, no color)         =  4
//   Lock                   4  (wild, no color)         =  4
//   Switch Position Wild   4  (wild, no color)         =  4
//   Plus Wild              4  (wild, no color)         =  4
// (All 6 selected at once -> 28 extra cards, 108 -> 136.)
//
// Number Wild (choose a color, plays as a plain colored card, no effect)
// was tried and removed: tying it to a specific number and restricting
// when it could be played would have made it the only "wild" in the game
// that ISN'T always playable — confusing, and it fights the core meaning
// of a wild card. Left out rather than shipped half-right.
function buildAdvanceCards(selectedTypes) {
  const cards = [];
  let n = 0;
  const nextId = () => `a${n++}`;
  Object.entries(COLOR_ACTION_COPIES_PER_COLOR).forEach(([value, copiesPerColor]) => {
    if (!selectedTypes.has(value)) return;
    COLORS.forEach((color) => {
      for (let i = 0; i < copiesPerColor; i++) cards.push({ id: nextId(), color, value });
    });
  });
  Object.entries(NEW_WILD_ACTION_COUNTS).forEach(([value, count]) => {
    if (!selectedTypes.has(value)) return;
    for (let i = 0; i < count; i++) cards.push({ id: nextId(), color: 'wild', value });
  });
  return cards;
}

// Large tables burn through the shared deck faster per lap, triggering more
// frequent reshuffles. Not broken (reshuffleFromDiscard covers it), but for
// more margin at big tables, pad in extra plain number cards (never actions/
// wilds, so the extra chaos density per player doesn't also climb) — one
// full "run" of number cards per band of 4 players above the baseline of 4
// (never a smooth per-player trickle). The first run includes 0 (0-9 once
// per color = 40 cards); every run after that skips 0 (1-9 once per color =
// 36 cards), since the base deck already carries 2 copies of 1-9 per color
// but only 1 zero.
//   4 players or fewer: +0    (108 total)
//   5-8 players:        +40  (148 total)
//   9-12 players:        +76  (184 total — the room cap of 10 means this is
//                        the highest actually reachable today)
const PLAYER_SCALING_BASELINE = 4;
const PLAYER_SCALING_BAND_SIZE = 4;
function buildPlayerScalingCards(playerCount) {
  const bandsAboveBaseline = Math.ceil(Math.max(0, playerCount - PLAYER_SCALING_BASELINE) / PLAYER_SCALING_BAND_SIZE);
  if (!bandsAboveBaseline) return [];
  const cards = [];
  let n = 0;
  const nextId = () => `s${n++}`;
  for (let band = 0; band < bandsAboveBaseline; band++) {
    const values = band === 0 ? ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] : ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    values.forEach((value) => COLORS.forEach((color) => cards.push({ id: nextId(), color, value })));
  }
  return cards;
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
  const names = {
    skip: 'Skip', reverse: 'Reverse', draw2: 'Draw Two', wild: 'Wild', wild4: 'Wild Draw Four',
    minus2: 'Minus Two', switchPos: 'Switch Position',
    actionWild: 'Action Wild', lock: 'Lock', switchWild: 'Switch Position Wild', plusWild: 'Plus Wild',
  };
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

// Picks one item at random, weighted by weightFn(item). Assumes the total
// weight is > 0 (true for every call site here — an empty candidate list is
// always checked before calling this).
function weightedRandomPick(items, weightFn) {
  const total = items.reduce((sum, it) => sum + weightFn(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// Shared "how dangerous is this player" tier, used two ways: Lock uses it as
// a random-pick WEIGHT (so a player one card from winning is the juiciest
// target), and Plus Wild uses the exact same number as a DRAW COUNT (so
// that same player gets hit hardest by the card dump too) — one scale,
// two different house-rule cards built on top of it.
function handSizeTier(player) {
  if (player.hand.length === 1) return 3;
  if (player.hand.length <= 5) return 2;
  return 1;
}

function rollLockDice() {
  return weightedRandomPick(LOCK_DICE_WEIGHTS, (w) => w.weight).value;
}

class UnoRoom {
  constructor(id, name, password) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // { id: stable playerId, name, hand, calledUno, connected, socketId, isBot, lockedTurns }
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
    // Keyed by playerId (a Map, not a single slot) because with 3+ human
    // players it's possible for a second player to drop to 1 card while an
    // earlier player's 3s window is still ticking — each needs its own
    // independent deadline/timer rather than one clobbering the other.
    this.unoWindows = new Map(); // playerId -> { deadline, timer }
    this.unoPenaltyCounter = 0;
    this.lastUnoPenaltyPlayerId = null;
    this.advanceCardTypes = new Set(); // subset of ADVANCE_CARD_TYPES, picked in the waiting room
    this.lastActionType = null; // last genuine skip/reverse/draw2 played — for Action Wild
    // The card actually just played, separate from discardTop: a minus2 dump
    // pushes its bonus cards on top of the minus2 itself, so discardTop would
    // show one of THOSE afterward — this stays pinned to the real play so the
    // client's per-card callout sound (see uno.js) doesn't miss it.
    this.lastPlayedCard = null;
    // While a Lock card's dice+wheel reveal is playing on every client (see
    // showLockAnimation in uno.js), bots must not act either — otherwise the
    // server keeps advancing turns in real time underneath the animation and
    // a bot can play a card the whole table is blocked from reacting to.
    // Humans are already blocked locally by lockAnimationActive, but bots
    // have no client, so this timestamp is the server-side equivalent.
    this.botsPausedUntil = 0;
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 30) this.log.shift();
  }

  // Starts (or restarts) a 3-second "call UNO or pay for it" window for a
  // player who just dropped to 1 card without calling it. Other players can
  // still catch them manually before this fires (see uno:catch); if nobody
  // does, the timeout below applies the same 2-card penalty automatically.
  startUnoWindow(player, nsp) {
    this.clearUnoWindow(player.id);
    const timer = setTimeout(() => this.expireUnoWindow(player.id, nsp), 3000);
    this.unoWindows.set(player.id, { deadline: Date.now() + 3000, timer });
  }

  clearUnoWindow(playerId) {
    const w = this.unoWindows.get(playerId);
    if (w) {
      clearTimeout(w.timer);
      this.unoWindows.delete(playerId);
    }
  }

  clearAllUnoWindows() {
    this.unoWindows.forEach((w) => clearTimeout(w.timer));
    this.unoWindows.clear();
  }

  expireUnoWindow(playerId, nsp) {
    this.unoWindows.delete(playerId);
    const player = this.findPlayer(playerId);
    // Re-check everything: by the time this fires, the game could have
    // ended, the player could have called UNO, or already been caught —
    // any of which makes the timeout a no-op instead of a double penalty.
    if (!player || this.status !== 'playing' || player.hand.length !== 1 || player.calledUno) return;
    this.drawCards(player, 2);
    player.calledUno = false;
    this.unoPenaltyCounter += 1;
    this.lastUnoPenaltyPlayerId = player.id;
    this.pushLog(`⏰ ${player.name} forgot to call UNO in time — drew 2 penalty cards.`);
    this.broadcast(nsp);
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
    const advanceExtra = this.advanceCardTypes.size ? buildAdvanceCards(this.advanceCardTypes) : [];
    const scalingExtra = buildPlayerScalingCards(this.players.length);
    const deck = shuffle([...buildDeck(), ...advanceExtra, ...scalingExtra]);
    this.players.forEach((p) => { p.hand = []; p.calledUno = false; p.lockedTurns = 0; });
    // Starting hand grows with how many advance card types are in play (7
    // with none selected, up to 10 with all 6) so the new mechanics actually
    // show up in an opening hand instead of being diluted across 130+ cards.
    const handSize = 7 + Math.ceil(this.advanceCardTypes.size / 2);
    for (let i = 0; i < handSize; i++) {
      this.players.forEach((p) => p.hand.push(deck.pop()));
    }
    // Flip a starting card. If it's a wild/action card, discard it unplayed
    // and keep flipping until a plain number card starts the pile — avoids
    // special-casing "what does Draw Two on turn 0 even mean" edge cases.
    const preDiscard = [];
    let starter = null;
    while (deck.length > 0) {
      const candidate = deck.pop();
      if (candidate.color !== 'wild' && !ALL_ACTION_VALUES.includes(candidate.value)) {
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
    this.lastActionType = null;
    this.lastPlayedCard = null;
    this.pushLog(`🎉 Game started with ${this.players.map((p) => p.name).join(', ')}.`);
    if (this.advanceCardTypes.size) this.pushLog(`🃏 Advance cards in the deck: ${[...this.advanceCardTypes].join(', ')}. Starting hand size: ${handSize}.`);
    if (scalingExtra.length) this.pushLog(`🎴 Big table (${this.players.length} players) — added ${scalingExtra.length} extra number cards to the deck.`);
    this.pushLog(`${this.currentPlayer().name}'s turn.`);
  }

  // Permanently swaps two players' seats in the fixed turn order (Switch
  // Position / Switch Position Wild). Turn flow afterward keeps moving
  // seat-by-seat as normal — the two named players have just traded chairs.
  swapSeats(idA, idB) {
    const i = this.players.findIndex((p) => p.id === idA);
    const j = this.players.findIndex((p) => p.id === idB);
    if (i === -1 || j === -1 || i === j) return null;
    const nameA = this.players[i].name;
    const nameB = this.players[j].name;
    [this.players[i], this.players[j]] = [this.players[j], this.players[i]];
    this.pushLog(`🔀 ${nameA} and ${nameB} swapped seats!`);
    return { idA, nameA, idB, nameB };
  }

  // Switch Position (colored): unlike its Wild counterpart, this one is
  // pure chaos — 2 random players at the table (anyone, including whoever
  // played it) get swapped, no choice involved.
  swapRandomPair() {
    if (this.players.length < 2) return null;
    const i = Math.floor(Math.random() * this.players.length);
    let j = Math.floor(Math.random() * this.players.length);
    while (j === i) j = Math.floor(Math.random() * this.players.length);
    return this.swapSeats(this.players[i].id, this.players[j].id);
  }

  // Lock card: roll a weighted d3 (60/30/10 for 1/2/3), then repeatedly do a
  // weighted-without-replacement draw (see handSizeTier) to pick that many
  // OTHER players whose next turn gets skipped. Returns the full round-by-
  // round breakdown so the client can animate a dice + spinning-wheel
  // reveal instead of just seeing the end result.
  //
  // Each round also carries baselineLockedTurns — that player's count
  // BEFORE this pick — captured here rather than left for the client to
  // infer later. The client's reveal animation takes 5-20+ real seconds,
  // but this room keeps running in real time underneath it (bots keep
  // playing), so a just-locked player's turn can arrive and get auto-
  // skipped (consuming the lock) before the client ever shows it. Without
  // a captured baseline, "current value minus 1" would already be wrong by
  // the time the client reads it, and the reveal would silently show
  // nothing instead of confirming the pick.
  applyLockCard(player) {
    const diceResult = rollLockDice();
    let pool = this.players.filter((p) => p.id !== player.id);
    const rounds = [];
    const count = Math.min(diceResult, pool.length);
    for (let i = 0; i < count; i++) {
      const candidates = pool.map((p) => ({ id: p.id, name: p.name, weight: handSizeTier(p) }));
      const picked = weightedRandomPick(pool, handSizeTier);
      const baselineLockedTurns = picked.lockedTurns || 0;
      rounds.push({ candidates, pickedId: picked.id, baselineLockedTurns });
      picked.lockedTurns = baselineLockedTurns + 1;
      pool = pool.filter((p) => p.id !== picked.id);
    }
    const lockedNames = rounds.map((r) => this.findPlayer(r.pickedId)?.name).filter(Boolean);
    this.pushLog(`🎲 ${player.name} played Lock — rolled a ${diceResult}! Locked: ${lockedNames.join(', ') || 'no one'}.`);
    return { playerName: player.name, diceResult, rounds };
  }

  // Plus Wild: every OTHER player draws cards based on the same
  // handSizeTier scale Lock uses (UNO status = 3, 2-5 cards = 2, 6+ = 1) —
  // deterministic, no randomness, but the client still animates it (one
  // flying card per unit of `amount`, per affected player), so this returns
  // the same {playerName, affected} shape for the caller to broadcast.
  applyPlusWildCard(player) {
    const affected = this.players
      .filter((p) => p.id !== player.id)
      .map((p) => ({ id: p.id, name: p.name, amount: handSizeTier(p) }));
    affected.forEach((a) => this.drawCards(this.findPlayer(a.id), a.amount));
    const summary = affected.map((a) => `${a.name} +${a.amount}`).join(', ');
    this.pushLog(`💥 ${player.name} played Plus Wild — ${summary || 'no one else at the table'}.`);
    return { playerName: player.name, affected };
  }

  // Returns a bot's choice of extra info a card needs beyond color — only
  // Switch Position Wild needs a chosen pair (Switch Position itself is
  // fully random server-side now, no target needed). Bots never use Minus
  // Two's bonus multi-discard, to keep their logic simple.
  buildBotExtra(bot, card) {
    if (card.value === 'switchWild') {
      const others = this.players.filter((p) => p.id !== bot.id);
      if (others.length < 2) return {};
      const shuffled = shuffle(others);
      return { targetPlayerIds: [shuffled[0].id, shuffled[1].id] };
    }
    return {};
  }

  // extra: { extraCards?: Card[] (Minus Two bonus discards, already
  // validated by the caller), targetPlayerIds? (Switch Position Wild's
  // chosen pair) }. Switch Position (colored) needs nothing — it picks its
  // own random pair. Returns { lockResult, switchResult } for the caller to
  // broadcast separately (either may be null).
  applyPlay(player, card, chosenColor, extra = {}) {
    player.hand = player.hand.filter((c) => c.id !== card.id);
    this.discard.push(card);
    this.lastPlayedCard = { id: card.id, value: card.value, color: card.color };
    this.currentColor = card.color === 'wild' ? chosenColor : card.color;

    const extraDiscarded = card.value === 'minus2' && Array.isArray(extra.extraCards) ? extra.extraCards : [];
    if (extraDiscarded.length) {
      const extraIds = new Set(extraDiscarded.map((c) => c.id));
      player.hand = player.hand.filter((c) => !extraIds.has(c.id));
      extraDiscarded.forEach((c) => this.discard.push(c));
    }

    if (player.hand.length !== 1) player.calledUno = false;

    const colorNote = card.color === 'wild' ? ` (${chosenColor})` : '';
    this.pushLog(`${player.name} played ${cardLabel(card)}${colorNote}.`);
    if (extraDiscarded.length) {
      this.pushLog(`${player.name} also dumped ${extraDiscarded.length} more ${card.color} card${extraDiscarded.length === 1 ? '' : 's'}.`);
    }

    if (player.hand.length === 0) {
      this.status = 'finished';
      this.winnerId = player.id;
      this.pushLog(`🏆 ${player.name} wins!`);
      return { lockResult: null, switchResult: null, plusWildResult: null };
    }

    let switchResult = null;
    if (card.value === 'switchPos') {
      switchResult = this.swapRandomPair();
    }
    if (card.value === 'switchWild' && Array.isArray(extra.targetPlayerIds) && extra.targetPlayerIds.length === 2) {
      switchResult = this.swapSeats(extra.targetPlayerIds[0], extra.targetPlayerIds[1]);
    }

    let lockResult = null;
    if (card.value === 'lock') {
      lockResult = this.applyLockCard(player);
    }
    let plusWildResult = null;
    if (card.value === 'plusWild') {
      plusWildResult = this.applyPlusWildCard(player);
    }

    if (ACTIONS.includes(card.value)) this.lastActionType = card.value;
    const effectiveValue = card.value === 'actionWild' ? this.lastActionType : card.value;

    if (effectiveValue === 'skip') {
      this.advance(2);
      this.pushLog(`${this.currentPlayer().name} was skipped.`);
    } else if (effectiveValue === 'reverse') {
      if (this.players.length === 2) {
        this.advance(2); // reverse with only 2 players plays exactly like skip
      } else {
        this.direction *= -1;
        this.advance(1);
      }
    } else if (effectiveValue === 'draw2') {
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
    return { lockResult, switchResult, plusWildResult };
  }

  broadcastLockEvent(nsp, payload) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('uno:lockEvent', payload);
    });
  }

  broadcastPlusWildEvent(nsp, payload) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('uno:plusWildEvent', payload);
    });
  }

  broadcastSwitchEvent(nsp, payload) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('uno:switchEvent', payload);
    });
  }

  // Safety net so a disconnected or Lock-skipped player's turn doesn't stall
  // the room forever. Disconnected: auto-draw one card and pass. Locked:
  // consume one lock charge and pass with no draw. Bounded so an all-stuck
  // room doesn't spin forever.
  resolveAutoSkips() {
    if (this.status !== 'playing') return;
    let guard = 0;
    while (this.players.length && guard <= this.players.length * 2) {
      const p = this.currentPlayer();
      if (!p.connected) {
        this.drawCards(p, 1);
        this.pushLog(`${p.name} is disconnected — auto-drew a card and passed.`);
        this.advance(1);
      } else if (p.lockedTurns > 0) {
        p.lockedTurns -= 1;
        this.pushLog(`🔒 ${p.name}'s turn was locked — skipped.`);
        this.advance(1);
      } else {
        break;
      }
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
    let lockResult = null;
    let switchResult = null;
    let plusWildResult = null;

    if (card) {
      const chosenColor = card.color === 'wild' ? pickBotColor(bot.hand.filter((c) => c.id !== card.id)) : undefined;
      ({ lockResult, switchResult, plusWildResult } = this.applyPlay(bot, card, chosenColor, this.buildBotExtra(bot, card)));
      if (bot.hand.length === 1) bot.calledUno = true;
    } else {
      this.drawCards(bot, 1);
      this.pushLog(`${bot.name} drew a card.`);
      const drawn = bot.hand[bot.hand.length - 1];
      if (drawn && canPlay(drawn, topCard, this.currentColor)) {
        const chosenColor = drawn.color === 'wild' ? pickBotColor(bot.hand.filter((c) => c.id !== drawn.id)) : undefined;
        ({ lockResult, switchResult, plusWildResult } = this.applyPlay(bot, drawn, chosenColor, this.buildBotExtra(bot, drawn)));
        if (bot.hand.length === 1) bot.calledUno = true;
      } else {
        this.advance(1);
        if (this.status === 'playing') this.pushLog(`${this.currentPlayer().name}'s turn.`);
      }
    }

    this.resolveAutoSkips();
    this.broadcast(nsp);
    if (lockResult) {
      this.pauseBotsForLockReveal(lockResult.rounds.length);
      this.broadcastLockEvent(nsp, lockResult);
    }
    if (switchResult) this.broadcastSwitchEvent(nsp, switchResult);
    if (plusWildResult) this.broadcastPlusWildEvent(nsp, plusWildResult);
    this.scheduleBotTurnIfNeeded(nsp);
  }

  // Extends botsPausedUntil to cover this Lock reveal's real on-screen
  // duration (see LOCK_REVEAL_* above) — called wherever a lockResult comes
  // back from applyPlay, whether the player was human or a bot.
  pauseBotsForLockReveal(roundCount) {
    const durationMs = LOCK_REVEAL_DICE_MS + roundCount * LOCK_REVEAL_ROUND_MS
      + LOCK_REVEAL_FINAL_HOLD_MS + LOCK_REVEAL_NETWORK_BUFFER_MS;
    this.botsPausedUntil = Math.max(this.botsPausedUntil, Date.now() + durationMs);
  }

  // Called after every action that might change whose turn it is. Bots act
  // on a random 1-3s "thinking" delay so their move doesn't feel instant/
  // robotic, and so several bots in a row don't all resolve within the same
  // tick or in an obviously identical rhythm — except while a Lock reveal is
  // still playing on screen, when they're held back until it's done (see
  // botsPausedUntil / pauseBotsForLockReveal).
  scheduleBotTurnIfNeeded(nsp) {
    clearTimeout(this.botTimer);
    this.botTimer = null;
    if (this.status !== 'playing') return;
    const cp = this.currentPlayer();
    if (!cp || !cp.isBot) return;
    const lockHoldRemaining = Math.max(0, this.botsPausedUntil - Date.now());
    this.botTimer = setTimeout(() => this.runBotTurn(nsp), lockHoldRemaining + randomBotThinkMs());
  }

  personalizedState(forPlayerId) {
    const me = this.findPlayer(forPlayerId);
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      currentColor: this.currentColor,
      discardTop: this.discard[this.discard.length - 1] || null,
      lastPlayedCard: this.lastPlayedCard,
      currentPlayerId: this.players.length ? this.currentPlayer().id : null,
      direction: this.direction,
      deckCount: this.deck.length,
      log: this.log,
      winnerId: this.winnerId,
      turnHasDrawn: this.turnHasDrawn,
      advanceCardTypes: [...this.advanceCardTypes],
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        calledUno: p.calledUno,
        connected: p.connected,
        lockedTurns: p.lockedTurns || 0,
      })),
      yourId: forPlayerId || null,
      yourHand: me ? me.hand : [],
      unoWindows: [...this.unoWindows.entries()].map(([playerId, w]) => ({ playerId, deadline: w.deadline })),
      unoPenaltyCounter: this.unoPenaltyCounter,
      lastUnoPenaltyPlayerId: this.lastUnoPenaltyPlayerId,
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

function attachUno(io) {
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
      room.clearAllUnoWindows();
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

    // Waiting-room picker for the 6 optional house-rule cards (see file
    // header) — a player chooses ANY SUBSET (0 to 6), not all-or-nothing.
    // Anyone still in the waiting room can change it, matching how
    // Add Bots/Start already work without a "host" concept.
    socket.on('uno:setAdvanceCards', ({ selected }, callback) => {
      const room = myRoom();
      if (!room) {
        if (typeof callback === 'function') callback({ ok: false, error: 'no-room' });
        return;
      }
      if (room.status !== 'waiting') {
        if (typeof callback === 'function') callback({ ok: false, error: 'already-started' });
        return;
      }
      if (!Array.isArray(selected)) {
        if (typeof callback === 'function') callback({ ok: false, error: 'invalid-selection' });
        return;
      }
      room.advanceCardTypes = new Set(selected.filter((v) => ADVANCE_CARD_TYPES.has(v)));
      room.pushLog(room.advanceCardTypes.size
        ? `Advance cards selected for the next game: ${[...room.advanceCardTypes].join(', ')}.`
        : 'Advance cards turned off for the next game.');
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

    socket.on('uno:play', ({ cardId, chosenColor, extraCardIds, targetPlayerIds }, callback) => {
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

      const extra = {};

      if (card.value === 'minus2' && Array.isArray(extraCardIds) && extraCardIds.length) {
        if (extraCardIds.length > 2 || new Set(extraCardIds).size !== extraCardIds.length) {
          if (typeof callback === 'function') callback({ ok: false, error: 'invalid-extra-cards' });
          return;
        }
        if (player.hand.length < 5) {
          if (typeof callback === 'function') callback({ ok: false, error: 'not-enough-cards-to-dump' });
          return;
        }
        const extraCards = [];
        for (const id of extraCardIds) {
          const c = player.hand.find((c2) => c2.id === id && c2.id !== card.id);
          if (!c || c.color !== card.color) {
            if (typeof callback === 'function') callback({ ok: false, error: 'invalid-extra-cards' });
            return;
          }
          extraCards.push(c);
        }
        extra.extraCards = extraCards;
      }

      if (card.value === 'switchWild') {
        const validPair = Array.isArray(targetPlayerIds) && targetPlayerIds.length === 2
          && targetPlayerIds[0] !== targetPlayerIds[1]
          && room.findPlayer(targetPlayerIds[0]) && room.findPlayer(targetPlayerIds[1]);
        if (!validPair) {
          if (typeof callback === 'function') callback({ ok: false, error: 'invalid-targets' });
          return;
        }
        extra.targetPlayerIds = targetPlayerIds;
      }

      const { lockResult, switchResult, plusWildResult } = room.applyPlay(player, card, chosenColor, extra);
      room.resolveAutoSkips();
      if (room.status === 'playing' && player.hand.length === 1 && !player.calledUno) {
        room.startUnoWindow(player, nsp);
      }
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      if (lockResult) {
        room.pauseBotsForLockReveal(lockResult.rounds.length);
        room.broadcastLockEvent(nsp, lockResult);
      }
      if (switchResult) room.broadcastSwitchEvent(nsp, switchResult);
      if (plusWildResult) room.broadcastPlusWildEvent(nsp, plusWildResult);
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
      const topCardForDraw = room.discard[room.discard.length - 1];
      if (player.hand.some((c) => canPlay(c, topCardForDraw, room.currentColor))) {
        if (typeof callback === 'function') callback({ ok: false, error: 'must-play-if-able' });
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
      // The rule above (uno:draw) only ever lets a draw happen when nothing
      // in hand was playable, so the only card that could have just BECOME
      // playable is the one drawn — it's always the last card pushed onto
      // the hand by drawCards().
      const topCardForPass = room.discard[room.discard.length - 1];
      const drawnCard = player.hand[player.hand.length - 1];
      if (drawnCard && canPlay(drawnCard, topCardForPass, room.currentColor)) {
        if (typeof callback === 'function') callback({ ok: false, error: 'must-play-drawn-card' });
        return;
      }
      room.advance(1);
      room.resolveAutoSkips();
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
      room.clearUnoWindow(player.id);
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
      room.clearUnoWindow(target.id);
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
      room.lastActionType = null;
      room.players.forEach((p) => { p.lockedTurns = 0; });
      room.clearAllUnoWindows();
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
          room.resolveAutoSkips();
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
}

module.exports = attachUno;
// Exposed purely for automated testing of the game-logic pieces without
// needing a live socket server — attachUno(io) above is the real entry
// point used by server.js and is unaffected by these extra properties.
module.exports.UnoRoom = UnoRoom;
module.exports.buildDeck = buildDeck;
module.exports.buildAdvanceCards = buildAdvanceCards;
module.exports.canPlay = canPlay;
module.exports.weightedRandomPick = weightedRandomPick;
module.exports.handSizeTier = handSizeTier;
module.exports.rollLockDice = rollLockDice;
