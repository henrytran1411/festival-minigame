// Texas Hold'em Poker — a seventh backup game alongside UNO, Exploding
// Kittens, Go, Đuổi Niên Thú, Ô Ăn Quan, and Battleship. Same "casual side
// activity" contract as those: its own Socket.IO namespace, no leaderboard,
// no admin open/close gating (see server.js). Chips are purely virtual —
// there's no real-money stake, just bragging rights at the table.
//
// Rules: standard No-Limit Texas Hold'em, 2-6 seats. Each hand deals 2 hole
// cards to every player still holding chips, posts a small/big blind from
// the two seats after the dealer button (heads-up: the dealer posts small
// blind and acts first preflop, same as real casino heads-up rules), then
// runs four betting rounds (preflop / flop / turn / river) separated by
// community cards (3, then 1, then 1). Standard hand rankings, side pots
// for uneven all-ins, ties split the pot with any odd chip going to the
// tied winner closest to the dealer's left. A player who reaches 0 chips
// is eliminated from the table; the game ends when only one player still
// has chips.
//
// Betting simplification vs. strict casino rules: a short all-in raise
// (less than a full minimum raise) still reopens the action for every
// other player still in the hand, rather than only letting them call/fold.
// This is slightly more generous than a cardroom would be, but it's a
// common simplification in casual implementations, keeps the action
// logic in this file a lot simpler, and can never let chips be created
// or duplicated — just an occasional "free" extra chance to act.
//
// A per-turn clock is optional (host-configured, like Battleship's): if a
// connected human doesn't act in time, the game auto-checks (if free) or
// auto-folds them so the table keeps moving. A DISCONNECTED human is
// always auto-acted on immediately regardless of the clock setting, so a
// dropped player can't stall the table forever — over enough hands their
// stack simply blinds away to elimination, the same way it would at a
// real table if someone got up and never came back.
//
// Bots decide fold/check/call/raise from a simple hand-strength estimate
// (a preflop heuristic before the flop, actual 7-card hand rank after) vs.
// pot odds, with a little randomness for bluffs/thin value bets — not
// perfect play, just a believable opponent, matching this project's other
// game bots.

const BOT_NAMES = ['🤖 Bot Châu', '🤖 Bot Đăng', '🤖 Bot Giang', '🤖 Bot Khôi', '🤖 Bot Linh'];
const BOT_THINK_MS_MIN = 900;
const BOT_THINK_MS_MAX = 2200;
const RUNOUT_DELAY_MS = 1100; // pause between community cards when everyone left is all-in
const BETWEEN_HAND_SHOWDOWN_DELAY_MS = 6000; // pause showing a revealed showdown before the next hand
const BETWEEN_HAND_UNCONTESTED_DELAY_MS = 2600; // shorter pause when everyone else just folded

const MAX_SEATS_OPTIONS = [2, 3, 4, 5, 6];
const DEFAULT_MAX_SEATS = 6;
const STARTING_CHIPS_OPTIONS = [500, 1000, 2000, 5000];
const DEFAULT_STARTING_CHIPS = 1000;
const SMALL_BLIND_OPTIONS = [5, 10, 25, 50];
const DEFAULT_SMALL_BLIND = 10;
const BLIND_INCREASE_OPTIONS = [0, 5, 10]; // hands; 0 = off
const DEFAULT_BLIND_INCREASE = 0;
const TURN_TIME_OPTIONS = [0, 20, 30, 45, 60]; // seconds; 0 = unlimited
const DEFAULT_TURN_TIME = 0;

// -- Cards / deck --------------------------------------------------------
const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

function rankLabel(rank) {
  return RANK_LABEL[rank] || String(rank);
}

function cardLabel(card) {
  return `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`;
}

function buildDeck() {
  const deck = [];
  for (let rank = 2; rank <= 14; rank += 1) {
    SUITS.forEach((suit) => deck.push({ rank, suit }));
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// -- Hand evaluation -------------------------------------------------------
// evaluate5 returns a tuple whose first element is the hand category
// (0 high card .. 8 straight flush) and whose remaining elements are
// tiebreakers, most significant first. Two tuples from the same category
// always have the same length, so plain lexicographic comparison (see
// compareTuples) is always correct.
const HAND_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

function evaluate5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.suit === cards[0].suit);

  const uniqueRanksDesc = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = null;
  if (uniqueRanksDesc.length === 5) {
    if (uniqueRanksDesc[0] - uniqueRanksDesc[4] === 4) straightHigh = uniqueRanksDesc[0];
    else if (uniqueRanksDesc[0] === 14 && uniqueRanksDesc[1] === 5 && uniqueRanksDesc[2] === 4
      && uniqueRanksDesc[3] === 3 && uniqueRanksDesc[4] === 2) straightHigh = 5; // wheel: A-2-3-4-5
  }

  const counts = {};
  ranks.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (straightHigh && isFlush) return [8, straightHigh];
  if (groups[0].count === 4) return [7, groups[0].rank, groups[1].rank];
  if (groups[0].count === 3 && groups[1].count === 2) return [6, groups[0].rank, groups[1].rank];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0].count === 3) return [3, groups[0].rank, ...groups.slice(1).map((g) => g.rank)];
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairRanks = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
    return [2, pairRanks[0], pairRanks[1], groups[2].rank];
  }
  if (groups[0].count === 2) return [1, groups[0].rank, ...groups.slice(1).map((g) => g.rank)];
  return [0, ...ranks];
}

function compareTuples(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function combinations5(cards) {
  const result = [];
  const n = cards.length;
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      for (let c = b + 1; c < n; c += 1) {
        for (let d = c + 1; d < n; d += 1) {
          for (let e = d + 1; e < n; e += 1) {
            result.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
          }
        }
      }
    }
  }
  return result;
}

// Best 5-card hand out of however many cards are passed (works for the 5-7
// cards a Hold'em player actually has -- hole cards + whatever community
// cards are out so far). Returns { tuple, cards } (the winning 5-card combo).
function bestHandOf(cards) {
  let best = null;
  combinations5(cards).forEach((combo) => {
    const tuple = evaluate5(combo);
    if (!best || compareTuples(tuple, best.tuple) > 0) best = { tuple, cards: combo };
  });
  return best;
}

function handName(tuple) {
  return HAND_NAMES[tuple[0]];
}

// -- Side pots -------------------------------------------------------------
// Standard layered side-pot algorithm: repeatedly peel off the smallest
// remaining contribution as one pot layer (shared by everyone who put in
// at least that much), until every contribution is used up. `entries` is
// [{ id, amount, folded }] -- amount is how much that player put in this
// HAND (across every street), not just the current street.
function computeSidePots(entries) {
  const remaining = entries.filter((e) => e.amount > 0).map((e) => ({ ...e }));
  const pots = [];
  while (remaining.some((p) => p.amount > 0)) {
    const active = remaining.filter((p) => p.amount > 0);
    const minAmt = Math.min(...active.map((p) => p.amount));
    const layerTotal = minAmt * active.length;
    const eligible = active.filter((p) => !p.folded).map((p) => p.id);
    pots.push({ amount: layerTotal, eligible });
    active.forEach((p) => { p.amount -= minAmt; });
  }
  return pots;
}

function sanitizeOptions(raw) {
  const opts = raw || {};
  const maxSeats = MAX_SEATS_OPTIONS.includes(Number(opts.maxSeats)) ? Number(opts.maxSeats) : DEFAULT_MAX_SEATS;
  const startingChips = STARTING_CHIPS_OPTIONS.includes(Number(opts.startingChips)) ? Number(opts.startingChips) : DEFAULT_STARTING_CHIPS;
  const smallBlind = SMALL_BLIND_OPTIONS.includes(Number(opts.smallBlind)) ? Number(opts.smallBlind) : DEFAULT_SMALL_BLIND;
  const blindIncreaseHands = BLIND_INCREASE_OPTIONS.includes(Number(opts.blindIncreaseHands)) ? Number(opts.blindIncreaseHands) : DEFAULT_BLIND_INCREASE;
  const timePerTurn = TURN_TIME_OPTIONS.includes(Number(opts.timePerTurn)) ? (Number(opts.timePerTurn) || null) : (DEFAULT_TURN_TIME || null);
  return { maxSeats, startingChips, smallBlind, blindIncreaseHands, timePerTurn };
}

// -- Bot AI ------------------------------------------------------------------
// Very rough preflop hand-strength estimate (0..1): high cards, pairs,
// suited/connected cards score better. Not a real equity calculation --
// just enough to make bots fold trash and play good hands more often.
function preflopStrength(hole) {
  const [a, b] = hole;
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const pair = a.rank === b.rank;
  const suited = a.suit === b.suit;
  const gap = hi - lo;
  let score = (hi + lo) / 28;
  if (pair) score += 0.35;
  if (suited) score += 0.08;
  if (gap <= 1) score += 0.05;
  else if (gap >= 4) score -= 0.08;
  return Math.max(0, Math.min(1, score));
}

function estimateStrength(room, player) {
  if (!room.community.length) return preflopStrength(player.holeCards);
  const best = bestHandOf([...player.holeCards, ...room.community]);
  return Math.min(1, best.tuple[0] / 8 + 0.12);
}

// Decides one action for a bot to a call amount / raise structure it
// already knows about. Never returns an illegal action (callers still
// clamp amounts the same way a human's action would be clamped).
function decideBotAction(room, player) {
  const callAmount = room.highestBet - player.currentStreetBet;
  const potSize = room.handPlayers.reduce((s, p) => s + p.totalBetThisHand, 0);
  const strength = estimateStrength(room, player);
  const canRaise = player.chips > callAmount;
  const rand = Math.random();

  if (callAmount <= 0) {
    if (strength > 0.72 && canRaise && rand < 0.65) {
      return { action: 'raise', amount: player.currentStreetBet + Math.max(room.bigBlind, Math.round(potSize * (0.5 + rand * 0.5)) || room.bigBlind * 2) };
    }
    if (strength > 0.5 && canRaise && rand < 0.12) {
      return { action: 'raise', amount: player.currentStreetBet + room.bigBlind * 2 };
    }
    return { action: 'check' };
  }
  const potOdds = callAmount / (potSize + callAmount);
  if (strength < potOdds - 0.05 && rand < 0.88) return { action: 'fold' };
  if (strength > 0.8 && canRaise && rand < 0.5) {
    return { action: 'raise', amount: player.currentStreetBet + callAmount + Math.max(room.bigBlind, Math.round(potSize * 0.6) || room.bigBlind * 2) };
  }
  return { action: 'call' };
}

const PHASE_LABEL = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };

class PokerRoom {
  constructor(id, name, password, options) {
    this.id = id;
    this.name = name;
    this.password = password;
    const { maxSeats, startingChips, smallBlind, blindIncreaseHands, timePerTurn } = sanitizeOptions(options);
    this.maxSeats = maxSeats;
    this.startingChips = startingChips;
    this.startingSmallBlind = smallBlind; // kept so newGame() can reset after blind increases
    this.smallBlind = smallBlind;
    this.bigBlind = smallBlind * 2;
    this.blindIncreaseHands = blindIncreaseHands; // 0 = off, else double every N hands
    this.timePerTurn = timePerTurn; // seconds, or null for unlimited
    this.hostPlayerId = null; // set by attachPoker() right after the creator is pushed into players
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // seats, in join order -- never shrinks once the game starts
    this.botCounter = 0;
    this.dealerIndex = -1; // index into this.players; -1 = no hand dealt yet
    this.handNumber = 0;
    this.deck = [];
    this.community = [];
    this.phase = null; // 'preflop' | 'flop' | 'turn' | 'river' | 'between'
    this.handPlayers = []; // this hand's players, reordered starting at the dealer
    this.actingPos = 0; // index into handPlayers
    this.highestBet = 0;
    this.minRaiseIncrement = this.bigBlind;
    this.log = [];
    this.lastHandResult = null;
    this.winnerId = null;
    this.resultText = null;
    this.turnTimer = null;
    this.botTimer = null;
    this.betweenHandTimer = null;
    this.runoutTimer = null;
    this.turnStartedAt = null;
    this.nsp = null;
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 60) this.log.shift();
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
      maxSeats: this.maxSeats,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
    };
  }

  addBot() {
    const botName = BOT_NAMES[this.botCounter % BOT_NAMES.length];
    this.botCounter += 1;
    this.players.push(this.makeSeat(`bot_${this.id}_${this.botCounter}`, botName, null, true));
    this.pushLog(`${botName} joined the table.`);
  }

  makeSeat(id, name, socketId, isBot) {
    return {
      id, name, connected: true, socketId, isBot,
      chips: this.startingChips, eliminated: false,
      holeCards: null, folded: false, allIn: false,
      currentStreetBet: 0, totalBetThisHand: 0, hasActedThisStreet: false,
    };
  }

  // -- Game lifecycle -------------------------------------------------------
  startGame() {
    if (this.status !== 'waiting') return { ok: false, error: 'already-started' };
    if (this.players.length < 2) return { ok: false, error: 'not-enough-players' };
    this.status = 'playing';
    this.handNumber = 0;
    this.dealerIndex = -1;
    this.winnerId = null;
    this.resultText = null;
    this.log = [];
    this.startHand();
    return { ok: true };
  }

  advanceDealerIndex() {
    const n = this.players.length;
    if (this.dealerIndex === -1) {
      this.dealerIndex = this.players.findIndex((p) => !p.eliminated);
      return;
    }
    for (let step = 1; step <= n; step += 1) {
      const idx = (this.dealerIndex + step) % n;
      if (!this.players[idx].eliminated) { this.dealerIndex = idx; return; }
    }
  }

  buildHandPlayers() {
    const n = this.players.length;
    const ordered = [];
    for (let step = 0; step < n; step += 1) {
      const p = this.players[(this.dealerIndex + step) % n];
      if (!p.eliminated) ordered.push(p);
    }
    return ordered;
  }

  startHand() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    clearTimeout(this.betweenHandTimer);
    clearTimeout(this.runoutTimer);
    this.handNumber += 1;
    if (this.blindIncreaseHands > 0 && this.handNumber > 1 && (this.handNumber - 1) % this.blindIncreaseHands === 0) {
      this.smallBlind *= 2;
      this.bigBlind = this.smallBlind * 2;
      this.pushLog(`⬆️ Blinds increased to ${this.smallBlind}/${this.bigBlind}.`);
    }

    this.players.forEach((p) => {
      p.holeCards = null;
      p.folded = false;
      p.allIn = false;
      p.currentStreetBet = 0;
      p.totalBetThisHand = 0;
      p.hasActedThisStreet = false;
    });

    this.advanceDealerIndex();
    this.handPlayers = this.buildHandPlayers();
    const n = this.handPlayers.length;

    this.deck = shuffle(buildDeck());
    this.community = [];
    this.phase = 'preflop';
    this.lastHandResult = null;
    this.handPlayers.forEach((p) => { p.holeCards = [this.deck.pop(), this.deck.pop()]; });

    const sbIdx = n === 2 ? 0 : 1;
    const bbIdx = n === 2 ? 1 : 2;
    this.postBlind(this.handPlayers[sbIdx], this.smallBlind);
    this.postBlind(this.handPlayers[bbIdx], this.bigBlind);
    // Usually the big blind's post IS the highest bet, but if the big
    // blind is even more short-stacked than the small blind, their forced
    // post can end up SMALLER than the small blind's -- the small blind
    // is still the amount everyone else has to match.
    this.highestBet = Math.max(this.handPlayers[sbIdx].currentStreetBet, this.handPlayers[bbIdx].currentStreetBet);
    this.minRaiseIncrement = this.bigBlind;
    this.handPlayers.forEach((p) => { p.hasActedThisStreet = false; }); // posting a blind isn't "acting"

    this.pushLog(`🃏 Hand #${this.handNumber} — blinds ${this.smallBlind}/${this.bigBlind}. Dealer: ${this.handPlayers[0].name}.`);

    const preflopFirst = (bbIdx + 1) % n;
    this.advanceTurn(preflopFirst);
  }

  postBlind(player, amount) {
    const pay = Math.min(amount, player.chips);
    player.chips -= pay;
    player.currentStreetBet = pay;
    player.totalBetThisHand = pay;
    if (player.chips === 0) player.allIn = true;
    this.pushLog(`${player.name} posts ${pay}${pay < amount ? ' (all-in)' : ''}.`);
  }

  // Finds the next handPlayers index (starting AT startPos, inclusive) that
  // still has an action available -- not folded, and holds chips (an
  // all-in player has nothing left to decide). Returns -1 if nobody
  // qualifies (callers only reach this after confirming at least one
  // player still can act).
  findActingPosFrom(startPos) {
    const n = this.handPlayers.length;
    for (let step = 0; step < n; step += 1) {
      const idx = (startPos + step) % n;
      const p = this.handPlayers[idx];
      if (!p.folded && p.chips > 0) return idx;
    }
    return -1;
  }

  // The single place that decides what happens next: end the hand
  // (everyone else folded), move to the next street / showdown (betting
  // round is settled), or hand the turn to whoever's next. `fromPos` is
  // inclusive -- pass the exact seat that should act if nothing else has
  // changed (used both for "activate this specific seat" at the start of
  // a hand/street and "find the next seat after this one" mid-round).
  advanceTurn(fromPos) {
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    const notFolded = this.handPlayers.filter((p) => !p.folded);
    if (notFolded.length === 1) { this.actingPos = 0; this.endHandUncontested(notFolded[0]); return; }
    const canAct = notFolded.filter((p) => p.chips > 0);
    const bettingDone = canAct.length >= 2 && canAct.every((p) => p.currentStreetBet === this.highestBet && p.hasActedThisStreet);
    if (canAct.length <= 1 || bettingDone) { this.actingPos = 0; this.advanceStreetOrShowdown(); return; }

    this.actingPos = this.findActingPosFrom(fromPos);
    const current = this.handPlayers[this.actingPos];
    this.turnStartedAt = null;
    if (!current.connected && !current.isBot) {
      this.autoActForPlayer(current, 'is disconnected');
      return;
    }
    if (current.isBot) {
      this.scheduleBotTurn();
    } else {
      this.turnStartedAt = Date.now();
      if (this.timePerTurn) this.turnTimer = setTimeout(() => this.handleTurnTimeout(current), this.timePerTurn * 1000);
    }
  }

  advanceStreetOrShowdown() {
    clearTimeout(this.runoutTimer);
    if (this.phase === 'river') { this.goToShowdown(); return; }
    if (this.phase === 'preflop') { this.community.push(...[this.deck.pop(), this.deck.pop(), this.deck.pop()]); this.phase = 'flop'; }
    else if (this.phase === 'flop') { this.community.push(this.deck.pop()); this.phase = 'turn'; }
    else if (this.phase === 'turn') { this.community.push(this.deck.pop()); this.phase = 'river'; }

    this.handPlayers.forEach((p) => { p.currentStreetBet = 0; p.hasActedThisStreet = false; });
    this.highestBet = 0;
    this.minRaiseIncrement = this.bigBlind;
    this.pushLog(`— ${PHASE_LABEL[this.phase]}: ${this.community.map(cardLabel).join(' ')}`);

    const notFolded = this.handPlayers.filter((p) => !p.folded);
    const canAct = notFolded.filter((p) => p.chips > 0);
    if (canAct.length <= 1) {
      // Nobody left who can actually bet -- just keep dealing to showdown.
      this.runoutTimer = setTimeout(() => this.advanceStreetOrShowdown(), RUNOUT_DELAY_MS);
      if (this.nsp) this.broadcast(this.nsp);
      return;
    }
    this.advanceTurn(1 % this.handPlayers.length);
  }

  // -- Actions --------------------------------------------------------------
  applyFold(player) {
    player.folded = true;
    player.hasActedThisStreet = true;
    this.pushLog(`${player.name} folds.`);
  }

  applyCheck(player) {
    player.hasActedThisStreet = true;
    this.pushLog(`${player.name} checks.`);
  }

  applyCall(player) {
    const callAmount = Math.max(0, this.highestBet - player.currentStreetBet);
    if (callAmount === 0) { this.applyCheck(player); return; }
    const pay = Math.min(callAmount, player.chips);
    player.chips -= pay;
    player.currentStreetBet += pay;
    player.totalBetThisHand += pay;
    player.hasActedThisStreet = true;
    if (player.chips === 0) player.allIn = true;
    this.pushLog(`${player.name} calls ${pay}${pay < callAmount ? ' (all-in)' : ''}.`);
  }

  // `requestedTotal` is the TOTAL this player wants their bet on this
  // street to become (a "raise to X"), not the extra amount on top.
  applyRaise(player, requestedTotal) {
    const maxTotal = player.currentStreetBet + player.chips;
    const target = Math.max(0, Math.min(Math.floor(requestedTotal) || 0, maxTotal));
    const increment = target - this.highestBet;
    if (increment <= 0) return { ok: false, error: 'raise-too-small' };
    const isAllIn = target === maxTotal;
    if (!isAllIn && increment < this.minRaiseIncrement) return { ok: false, error: 'raise-too-small' };

    const pay = target - player.currentStreetBet;
    player.chips -= pay;
    player.currentStreetBet = target;
    player.totalBetThisHand += pay;
    player.hasActedThisStreet = true;
    if (isAllIn) player.allIn = true;
    const wasOpeningBet = this.highestBet === 0;
    this.highestBet = target;
    this.minRaiseIncrement = Math.max(this.minRaiseIncrement, increment);
    // A raise reopens the action -- everyone else still in the hand gets
    // another chance to respond (see the file-level comment about short
    // all-in raises).
    this.handPlayers.forEach((p) => { if (p !== player) p.hasActedThisStreet = false; });
    this.pushLog(`${player.name} ${wasOpeningBet ? 'bets' : 'raises to'} ${target}${isAllIn ? ' (all-in)' : ''}.`);
    return { ok: true };
  }

  handleAction(player, action, amount) {
    if (this.status !== 'playing' || this.phase === 'between' || this.phase === null) return { ok: false, error: 'not-playing' };
    const current = this.handPlayers[this.actingPos];
    if (!current || current.id !== player.id) return { ok: false, error: 'not-your-turn' };
    if (player.folded || player.chips <= 0) return { ok: false, error: 'cannot-act' };

    const callAmount = Math.max(0, this.highestBet - player.currentStreetBet);
    if (action === 'fold') {
      if (callAmount === 0) return { ok: false, error: 'use-check' };
      this.applyFold(player);
    } else if (action === 'check') {
      if (callAmount !== 0) return { ok: false, error: 'must-call-or-fold' };
      this.applyCheck(player);
    } else if (action === 'call') {
      this.applyCall(player);
    } else if (action === 'raise') {
      const result = this.applyRaise(player, Number(amount));
      if (!result.ok) return result;
    } else {
      return { ok: false, error: 'invalid-action' };
    }

    this.advanceTurn((this.actingPos + 1) % this.handPlayers.length);
    return { ok: true };
  }

  autoActForPlayer(player, reasonLabel) {
    const callAmount = Math.max(0, this.highestBet - player.currentStreetBet);
    if (callAmount === 0) {
      this.pushLog(`⏰ ${player.name} ${reasonLabel} — auto-check.`);
      this.applyCheck(player);
    } else {
      this.pushLog(`⏰ ${player.name} ${reasonLabel} — auto-fold.`);
      this.applyFold(player);
    }
    this.advanceTurn((this.actingPos + 1) % this.handPlayers.length);
  }

  handleTurnTimeout(player) {
    if (this.status !== 'playing') return;
    const current = this.handPlayers[this.actingPos];
    if (!current || current !== player) return;
    this.autoActForPlayer(player, 'ran out of time');
    if (this.nsp) this.broadcast(this.nsp);
  }

  scheduleBotTurn() {
    clearTimeout(this.botTimer);
    const player = this.handPlayers[this.actingPos];
    if (!player || !player.isBot || this.status !== 'playing') return;
    this.botTimer = setTimeout(() => {
      if (this.status !== 'playing') return;
      const current = this.handPlayers[this.actingPos];
      if (!current || current !== player) return;
      const decision = decideBotAction(this, player);
      if (decision.action === 'fold') this.applyFold(player);
      else if (decision.action === 'check') this.applyCheck(player);
      else if (decision.action === 'call') this.applyCall(player);
      else if (decision.action === 'raise') {
        const result = this.applyRaise(player, decision.amount);
        if (!result.ok) this.applyCall(player); // fall back to a plain call if the raise math didn't work out
      }
      this.advanceTurn((this.actingPos + 1) % this.handPlayers.length);
      if (this.nsp) this.broadcast(this.nsp);
    }, BOT_THINK_MS_MIN + Math.random() * (BOT_THINK_MS_MAX - BOT_THINK_MS_MIN));
  }

  // -- Hand resolution --------------------------------------------------------
  endHandUncontested(winner) {
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    const potTotal = this.handPlayers.reduce((s, p) => s + p.totalBetThisHand, 0);
    winner.chips += potTotal;
    this.pushLog(`🏆 ${winner.name} wins the pot of ${potTotal} — everyone else folded.`);
    this.phase = 'between';
    this.lastHandResult = {
      type: 'uncontested',
      pots: [{ amount: potTotal, winners: [{ id: winner.id, name: winner.name, amount: potTotal }] }],
      revealed: [],
      community: this.community,
    };
    this.scheduleNextHandOrFinish(BETWEEN_HAND_UNCONTESTED_DELAY_MS);
  }

  goToShowdown() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    const contestants = this.handPlayers.filter((p) => !p.folded);
    const evals = {};
    contestants.forEach((p) => { evals[p.id] = bestHandOf([...p.holeCards, ...this.community]); });

    const entries = this.handPlayers.map((p) => ({ id: p.id, amount: p.totalBetThisHand, folded: p.folded }));
    const sidePots = computeSidePots(entries);
    const orderIndex = new Map(this.handPlayers.map((p, i) => [p.id, i]));
    const potResults = [];

    sidePots.forEach((pot) => {
      const eligible = pot.eligible.filter((id) => evals[id]);
      if (!eligible.length) return;
      let bestTuple = null;
      eligible.forEach((id) => { if (!bestTuple || compareTuples(evals[id].tuple, bestTuple) > 0) bestTuple = evals[id].tuple; });
      const winners = eligible.filter((id) => compareTuples(evals[id].tuple, bestTuple) === 0)
        .sort((a, b) => orderIndex.get(a) - orderIndex.get(b));
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      const winnerPayouts = winners.map((id) => {
        let amt = share;
        if (remainder > 0) { amt += 1; remainder -= 1; }
        const p = this.findPlayer(id);
        p.chips += amt;
        return { id, name: p.name, amount: amt };
      });
      potResults.push({ amount: pot.amount, winners: winnerPayouts });
    });

    potResults.forEach((pot) => {
      const names = pot.winners.map((w) => `${w.name} (+${w.amount})`).join(', ');
      this.pushLog(`🏆 Pot of ${pot.amount}: ${names}`);
    });

    this.phase = 'between';
    this.lastHandResult = {
      type: 'showdown',
      pots: potResults,
      revealed: contestants.map((p) => ({
        id: p.id, name: p.name, holeCards: p.holeCards,
        handName: handName(evals[p.id].tuple), bestCards: evals[p.id].cards,
      })),
      community: this.community,
    };
    this.scheduleNextHandOrFinish(BETWEEN_HAND_SHOWDOWN_DELAY_MS);
  }

  scheduleNextHandOrFinish(delayMs) {
    clearTimeout(this.betweenHandTimer);
    this.betweenHandTimer = setTimeout(() => {
      this.players.forEach((p) => { if (!p.eliminated && p.chips <= 0) { p.eliminated = true; this.pushLog(`💀 ${p.name} is out of chips — eliminated.`); } });
      const contenders = this.players.filter((p) => !p.eliminated);
      if (contenders.length <= 1) this.finishGame(contenders[0] || null);
      else this.startHand();
      if (this.nsp) this.broadcast(this.nsp);
    }, delayMs);
  }

  finishGame(winner) {
    this.status = 'finished';
    this.winnerId = winner ? winner.id : null;
    this.resultText = winner ? `🏆 ${winner.name} wins the table with ${winner.chips} chips!` : 'Game over.';
    this.pushLog(this.resultText);
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    clearTimeout(this.betweenHandTimer);
    clearTimeout(this.runoutTimer);
  }

  newGame() {
    if (this.status !== 'finished') return { ok: false, error: 'not-finished' };
    this.status = 'waiting';
    this.smallBlind = this.startingSmallBlind;
    this.bigBlind = this.startingSmallBlind * 2;
    this.handNumber = 0;
    this.dealerIndex = -1;
    this.community = [];
    this.phase = null;
    this.lastHandResult = null;
    this.winnerId = null;
    this.resultText = null;
    this.players.forEach((p) => {
      p.chips = this.startingChips;
      p.eliminated = false;
      p.holeCards = null;
      p.folded = false;
      p.allIn = false;
      p.currentStreetBet = 0;
      p.totalBetThisHand = 0;
      p.hasActedThisStreet = false;
    });
    this.pushLog('🔄 New game — back to the lobby to adjust seats before starting.');
    return { ok: true };
  }

  // -- Client state -----------------------------------------------------------
  state(forPlayerId) {
    const me = this.findPlayer(forPlayerId);
    const isShowdownReveal = this.phase === 'between' && this.lastHandResult && this.lastHandResult.type === 'showdown';
    const revealMap = {};
    if (isShowdownReveal) this.lastHandResult.revealed.forEach((r) => { revealMap[r.id] = r.holeCards; });
    const isCurrentTurn = this.status === 'playing' && this.turnStartedAt !== null;
    const elapsed = isCurrentTurn ? Date.now() - this.turnStartedAt : 0;
    const currentActor = this.handPlayers[this.actingPos];
    const dealer = this.handPlayers[0];

    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      maxSeats: this.maxSeats,
      startingChips: this.startingChips,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      blindIncreaseHands: this.blindIncreaseHands,
      timePerTurn: this.timePerTurn,
      handNumber: this.handNumber,
      phase: this.phase,
      hostPlayerId: this.hostPlayerId,
      dealerPlayerId: dealer ? dealer.id : null,
      currentPlayerId: (this.status === 'playing' && this.phase !== 'between' && currentActor) ? currentActor.id : null,
      turnTimeRemainingMs: (this.timePerTurn && isCurrentTurn) ? Math.max(0, this.timePerTurn * 1000 - elapsed) : null,
      community: this.community,
      // Once a hand is settled the pot has already been paid into the
      // winners' chip counts -- showing it again here would double-count
      // it visually against their now-higher stacks. lastHandResult still
      // carries the settled pot breakdown for display during this pause.
      pot: this.phase === 'between' ? 0 : this.handPlayers.reduce((s, p) => s + p.totalBetThisHand, 0),
      log: this.log,
      winnerId: this.winnerId,
      resultText: this.resultText,
      lastHandResult: this.lastHandResult,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isBot: Boolean(p.isBot),
        chips: p.chips,
        eliminated: p.eliminated,
        inHand: this.handPlayers.includes(p),
        folded: p.folded,
        allIn: p.allIn,
        currentStreetBet: p.currentStreetBet,
        totalBetThisHand: p.totalBetThisHand,
        isDealer: dealer === p,
        revealedHoleCards: revealMap[p.id] || null,
      })),
      yourId: forPlayerId || null,
      you: me ? { holeCards: this.handPlayers.includes(me) ? me.holeCards : null } : null,
      actionInfo: (me && currentActor === me && this.status === 'playing' && this.phase !== 'between') ? {
        toCall: Math.max(0, this.highestBet - me.currentStreetBet),
        canCheck: this.highestBet === me.currentStreetBet,
        minRaiseTo: this.highestBet + this.minRaiseIncrement,
        maxRaiseTo: me.currentStreetBet + me.chips,
        highestBet: this.highestBet,
      } : null,
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('poker:state', this.state(p.id));
    });
  }
}

function attachPoker(io) {
  const nsp = io.of('/poker');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].filter((r) => !r.isEmpty()).map((r) => r.summary());
  }

  function broadcastRoomList() {
    nsp.emit('poker:rooms', roomList());
  }

  nsp.on('connection', (socket) => {
    function myRoom() {
      return rooms.get(socket.roomId);
    }

    socket.on('poker:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('poker:createRoom', ({
      roomName, password, playerId, name, maxSeats, startingChips, smallBlind, blindIncreaseHands, timePerTurn,
    }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const room = new PokerRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, {
        maxSeats, startingChips, smallBlind, blindIncreaseHands, timePerTurn,
      });
      room.nsp = nsp;
      room.hostPlayerId = playerId;
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push(room.makeSeat(playerId, clean, socket.id, false));
      room.pushLog(`${clean} created the table.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('poker:joinRoom', ({ roomId, password, playerId, name }, callback) => {
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
        if (room.players.length >= room.maxSeats) { if (typeof callback === 'function') callback({ ok: false, error: 'room-full' }); return; }
        room.players.push(room.makeSeat(playerId, clean, socket.id, false));
        room.pushLog(`${clean} joined the table.`);
      }

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('poker:addBot', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length >= room.maxSeats) { if (typeof callback === 'function') callback({ ok: false, error: 'table-full' }); return; }
      room.addBot();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('poker:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const result = room.startGame();
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('poker:action', ({ action, amount }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.handleAction(player, action, amount);
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('poker:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const result = room.newGame();
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('poker:leave', () => {
      const room = myRoom();
      if (room) {
        const player = room.findPlayer(socket.playerId);
        if (player) {
          if (room.status === 'waiting') {
            room.players = room.players.filter((p) => p.id !== player.id);
            room.pushLog(`${player.name} left the table.`);
          } else {
            player.connected = false;
          }
        }
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

module.exports = attachPoker;
module.exports.PokerRoom = PokerRoom;
module.exports.buildDeck = buildDeck;
module.exports.shuffle = shuffle;
module.exports.evaluate5 = evaluate5;
module.exports.compareTuples = compareTuples;
module.exports.bestHandOf = bestHandOf;
module.exports.computeSidePots = computeSidePots;
module.exports.handName = handName;
module.exports.HAND_NAMES = HAND_NAMES;
module.exports.decideBotAction = decideBotAction;
module.exports.sanitizeOptions = sanitizeOptions;
module.exports.cardLabel = cardLabel;
module.exports.rankLabel = rankLabel;
module.exports.SUIT_SYMBOL = SUIT_SYMBOL;
module.exports.MAX_SEATS_OPTIONS = MAX_SEATS_OPTIONS;
module.exports.DEFAULT_MAX_SEATS = DEFAULT_MAX_SEATS;
module.exports.STARTING_CHIPS_OPTIONS = STARTING_CHIPS_OPTIONS;
module.exports.DEFAULT_STARTING_CHIPS = DEFAULT_STARTING_CHIPS;
module.exports.SMALL_BLIND_OPTIONS = SMALL_BLIND_OPTIONS;
module.exports.DEFAULT_SMALL_BLIND = DEFAULT_SMALL_BLIND;
module.exports.BLIND_INCREASE_OPTIONS = BLIND_INCREASE_OPTIONS;
module.exports.TURN_TIME_OPTIONS = TURN_TIME_OPTIONS;
