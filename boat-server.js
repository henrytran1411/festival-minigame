// Chèo Thuyền (Dragon Boat Race) — a backup game alongside UNO/Đuổi Niên
// Thú/Đua Tốc Độ etc. Same "casual side activity" contract as those: its own
// Socket.IO namespace, no leaderboard, no admin open/close gating.
//
// Real-time ASYMMETRIC team game: each crew (6 or 8 players) splits into 3
// very different roles sharing one boat:
//   - Leader: sees the track's upcoming turns and repeatedly calls one
//     direction every 0.5s -- 5 correct calls "in a row" (a wrong call only
//     knocks the streak down by 1, not back to 0) confirms that turn for
//     the crew's queue (max 3 deep).
//   - Drummer: taps along with the SAME rowing-cycle phases as the Rowers
//     (raise/active/cooldown) -- tapping during raise gives the crew a big
//     energy boost, active a normal boost, cooldown a small penalty.
//   - Rowers (4 or 6): row in a synchronized 5s cycle (1s raise / 2s active
//     window / 2s cooldown), holding Left/Right/Both to match whatever
//     direction is currently at the front of the Leader's confirmed queue.
// A room starts with 2 boats but the host (or anyone in the waiting room)
// can add more, up to MAX_BOATS, and rename any of them -- every boat races
// the SAME randomly-generated turn sequence at once, first to the finish
// line wins. `boat:addBots` fills any empty role/slot so a solo player can
// try any one role immediately.
//
// The host picks a river theme at room-creation time (purely cosmetic, a
// background image behind the horizontal race scene) -- reuses the exact
// same 18 map keys/labels Battleship already defines, so there's only one
// list of Vietnamese river/island names to maintain.

const { MAP_THEMES, DEFAULT_MAP_THEME } = require('./battleship-server.js');

const TICK_MS = 100; // 10Hz — plenty smooth for 5s rowing cycles.
const TEAM_SIZES = [6, 8];
const DEFAULT_TEAM_SIZE = 6;
const STARTING_BOAT_COUNT = 2;
const MAX_BOATS = 15;
const MAX_BOAT_NAME_LENGTH = 24;

// Rowing cycle phases (spec: 5s total = 1s + 2s + 2s).
const RAISE_MS = 1000;
const ACTIVE_MS = 2000;
const COOLDOWN_MS = 2000;

const ENERGY_MAX = 100;
const E_ROW = 20; // energy spent per completed rowing cycle -- was 12 (net energy-POSITIVE under continuous rowing, no real pressure); 20 nets -1/sec sustained
const E_LEAD = 5; // energy spent per leader signal attempt (right or wrong) -- was 8, too harsh vs. Rowers/Drummer at that rate
const R_BASE = 3; // base energy regen / sec
const STUN_MS = 3000; // "kiệt sức" duration once energy hits 0

const V_UNIT = 8; // speed impact per rower per cycle (+ for good/perfect, - for miss)
const SUPER_BOOST_MULTIPLIER = 1.5; // whole crew hit the SAME window well
const BASE_SPEED = 14; // units/sec with nobody rowing
const MIN_SPEED = 4;

const TRACK_TURN_COUNT = 12;
const TURN_SPACING = 90;
const FINISH_STRETCH = 90;
// Host-selectable race-length multiplier: scales BOTH the number of turns
// and the total distance proportionally, so a longer race also means more
// navigation content for the Leader/Rowers, not just a longer flat stretch.
const RACE_LENGTH_MULTIPLIERS = [1, 2, 3, 5, 8];
const DEFAULT_RACE_LENGTH_MULTIPLIER = 1;
const TURN_LOOKAHEAD_WINDOW = 40; // a turn resolves once the boat is this close to its marker
const TURN_MISS_GRACE = 10; // distance past a marker before it's auto-scored "missed" if never called
const PENALTY_MS = 3000; // wrong/missed turn -- speed debuff duration
const PENALTY_MULTIPLIER = 0.4;
const QUEUE_MAX = 3; // spec: max 3 confirmed directions stacked up for the Rowers

// Leader: one signal attempt allowed every LEADER_SIGNAL_COOLDOWN_MS: a
// correct call raises the streak (capped at LEADER_STREAK_TARGET), a wrong
// call only knocks it down by 1 (not back to 0) -- reaching the target
// confirms that turn's direction into the crew's queue and resets to 0 for
// the next one.
const LEADER_SIGNAL_COOLDOWN_MS = 500;
const LEADER_STREAK_TARGET = 5;

// Drummer: taps are rate-limited to one per DRUM_TAP_COOLDOWN_MS (a 0.1s
// countdown), and each accepted tap's energy effect on the whole crew
// (leader + rowers) depends on whichever rowing-cycle phase is active the
// instant it lands. Each tap also costs the Drummer their OWN energy
// (DRUM_TAP_ENERGY_COST) -- like Leader/Rowers, they now have a real energy
// pool with passive regen and a stun once it hits 0, so tapping as fast as
// possible forever isn't free.
const DRUM_TAP_COOLDOWN_MS = 100;
const DRUM_TAP_ENERGY_RAISE = 2;
const DRUM_TAP_ENERGY_ACTIVE = 1;
const DRUM_TAP_ENERGY_COOLDOWN_PENALTY = 1;
const DRUM_TAP_ENERGY_COST = 2; // was 4 -- still punishing at bot/max tap rate, much more forgiving at a realistic human tap pace

const MAX_RACE_MS_BASE = 8 * 60 * 1000; // safety cap so a stalled race still ends -- scaled by the race-length multiplier
const DIRECTIONS = ['trai', 'phai', 'thang'];
const BOT_NAMES = ['🤖 Bot An', '🤖 Bot Bình', '🤖 Bot Chi', '🤖 Bot Dũng', '🤖 Bot Giang', '🤖 Bot Hà', '🤖 Bot Khoa', '🤖 Bot Linh', '🤖 Bot Minh', '🤖 Bot Nam', '🤖 Bot Oanh', '🤖 Bot Phúc'];

function rowerSlotsFor(teamSize) { return teamSize - 2; }

function generateTrack(multiplier) {
  const turnCount = TRACK_TURN_COUNT * multiplier;
  const turns = [];
  for (let i = 0; i < turnCount; i += 1) {
    turns.push({ position: (i + 1) * TURN_SPACING, direction: DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)] });
  }
  return { turns, length: turnCount * TURN_SPACING + FINISH_STRETCH };
}

function freshRowerState() {
  return { energy: ENERGY_MAX, stunnedUntil: 0, held: { left: false, right: false }, heldCorrectMs: 0, lastResult: null };
}

function sanitizeBoatName(name) {
  return String(name || '').trim().slice(0, MAX_BOAT_NAME_LENGTH);
}

function freshBoatState(rowerSlots, name) {
  return {
    name,
    leaderId: null,
    drummerId: null,
    rowerIds: new Array(rowerSlots).fill(null),
    progress: 0,
    speed: BASE_SPEED,
    nextTurnIndex: 0,
    rowerQueue: [],
    leaderEnergy: ENERGY_MAX,
    leaderStunnedUntil: 0,
    // How far the LEADER has confirmed turns -- independent of nextTurnIndex
    // (how far the BOAT has physically resolved them by position). The
    // Leader works ahead, filling rowerQueue up to QUEUE_MAX.
    leaderProgress: { turnIndex: 0, streak: 0, lastSignalAt: 0 },
    drummerLastTapAt: 0,
    drummerEnergy: ENERGY_MAX,
    drummerStunnedUntil: 0,
    rowCycle: { phase: 'waiting', phaseEndsAt: 0, currentDirection: null, cycleIndex: 0 },
    rowers: new Array(rowerSlots).fill(null).map(freshRowerState),
    penaltyUntil: 0,
    finishedAt: null,
    finishRank: null,
    turnResults: [],
  };
}

class BoatRoom {
  constructor(id, name, password, teamSize, mapTheme, raceLengthMultiplier) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.teamSize = TEAM_SIZES.includes(Number(teamSize)) ? Number(teamSize) : DEFAULT_TEAM_SIZE;
    this.rowerSlots = rowerSlotsFor(this.teamSize);
    this.mapTheme = MAP_THEMES[mapTheme] ? mapTheme : DEFAULT_MAP_THEME;
    this.raceLengthMultiplier = RACE_LENGTH_MULTIPLIERS.includes(Number(raceLengthMultiplier))
      ? Number(raceLengthMultiplier)
      : DEFAULT_RACE_LENGTH_MULTIPLIER;
    this.status = 'waiting'; // 'waiting' | 'racing' | 'finished'
    this.players = []; // { id, name, connected, socketId, isBot }
    this.botCounter = 0;
    this.track = generateTrack(this.raceLengthMultiplier);
    this.boats = {};
    this.boatOrder = []; // ordered boat keys -- rendering/ranking order
    this.boatCounter = 0;
    this.raceStartedAt = null;
    this.log = [];
    this.tickTimer = null;
    for (let i = 0; i < STARTING_BOAT_COUNT; i += 1) this.addBoat();
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 30) this.log.shift();
  }

  addBoat(customName) {
    if (this.boatOrder.length >= MAX_BOATS) return { ok: false, error: 'max-boats' };
    this.boatCounter += 1;
    const key = `boat_${this.boatCounter}`;
    const name = sanitizeBoatName(customName) || `Boat ${this.boatOrder.length + 1}`;
    this.boats[key] = freshBoatState(this.rowerSlots, name);
    this.boatOrder.push(key);
    this.pushLog(`🚣 ${name} added to the race.`);
    return { ok: true, boatKey: key };
  }

  renameBoat(boatKey, newName) {
    const boat = this.boats[boatKey];
    if (!boat) return { ok: false, error: 'invalid-boat' };
    const clean = sanitizeBoatName(newName);
    if (!clean) return { ok: false, error: 'invalid-name' };
    boat.name = clean;
    return { ok: true };
  }

  findPlayer(playerId) {
    return playerId ? this.players.find((p) => p.id === playerId) : undefined;
  }

  // Bots never disconnect (they have no real socket) so they must be
  // ignored here -- otherwise a room with any bot in it could never be
  // cleaned up, even once every real human player has left for good.
  isEmpty() {
    const humans = this.players.filter((p) => !p.isBot);
    return humans.length === 0 || humans.every((p) => !p.connected);
  }

  summary() {
    const filled = this.boatOrder.reduce((sum, k) => {
      const b = this.boats[k];
      return sum + (b.leaderId ? 1 : 0) + (b.drummerId ? 1 : 0) + b.rowerIds.filter(Boolean).length;
    }, 0);
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      teamSize: this.teamSize,
      boatCount: this.boatOrder.length,
      mapTheme: this.mapTheme,
      mapThemeLabel: MAP_THEMES[this.mapTheme],
      raceLengthMultiplier: this.raceLengthMultiplier,
      playerCount: this.players.filter((p) => p.connected).length,
      slotsFilled: filled,
      slotsTotal: this.teamSize * this.boatOrder.length,
    };
  }

  // Finds which boat (and role/slot) a player currently occupies, if any.
  locate(playerId) {
    for (const key of this.boatOrder) {
      const boat = this.boats[key];
      if (boat.leaderId === playerId) return { boatKey: key, role: 'leader' };
      if (boat.drummerId === playerId) return { boatKey: key, role: 'drummer' };
      const idx = boat.rowerIds.indexOf(playerId);
      if (idx !== -1) return { boatKey: key, role: 'rower', slotIndex: idx };
    }
    return null;
  }

  clearAssignment(playerId) {
    const loc = this.locate(playerId);
    if (!loc) return;
    const boat = this.boats[loc.boatKey];
    if (loc.role === 'leader') boat.leaderId = null;
    else if (loc.role === 'drummer') boat.drummerId = null;
    else boat.rowerIds[loc.slotIndex] = null;
  }

  selectRole(playerId, boatKey, role, slotIndex) {
    if (this.status !== 'waiting') return { ok: false, error: 'already-started' };
    if (!this.boats[boatKey]) return { ok: false, error: 'invalid-boat' };
    const boat = this.boats[boatKey];
    this.clearAssignment(playerId);
    if (role === 'leader') {
      if (boat.leaderId) return { ok: false, error: 'slot-taken' };
      boat.leaderId = playerId;
    } else if (role === 'drummer') {
      if (boat.drummerId) return { ok: false, error: 'slot-taken' };
      boat.drummerId = playerId;
    } else if (role === 'rower') {
      const idx = Number(slotIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= boat.rowerIds.length) return { ok: false, error: 'invalid-slot' };
      if (boat.rowerIds[idx]) return { ok: false, error: 'slot-taken' };
      boat.rowerIds[idx] = playerId;
    } else {
      return { ok: false, error: 'invalid-role' };
    }
    return { ok: true };
  }

  allSlotsFilled() {
    return this.boatOrder.length > 0 && this.boatOrder.every((k) => {
      const b = this.boats[k];
      return b.leaderId && b.drummerId && b.rowerIds.every(Boolean);
    });
  }

  addBots() {
    const fillIds = [];
    this.boatOrder.forEach((k) => {
      const boat = this.boats[k];
      const claim = () => {
        this.botCounter += 1;
        const id = `bot_${this.id}_${this.botCounter}`;
        const name = BOT_NAMES[(this.botCounter - 1) % BOT_NAMES.length];
        this.players.push({ id, name, connected: true, socketId: null, isBot: true });
        fillIds.push(id);
        return id;
      };
      if (!boat.leaderId) boat.leaderId = claim();
      if (!boat.drummerId) boat.drummerId = claim();
      boat.rowerIds.forEach((v, i) => { if (!v) boat.rowerIds[i] = claim(); });
    });
    if (fillIds.length) this.pushLog(`Added ${fillIds.length} bot(s) to fill empty seats.`);
    return fillIds.length;
  }

  startRace() {
    this.status = 'racing';
    this.raceStartedAt = Date.now();
    this.pushLog('🚣 The race begins!');
  }

  // -- Shared mutation helpers (used by both real socket input and bot AI,
  // so both drive identical game logic). ------------------------------

  submitLeaderSignal(boatKey, direction) {
    const boat = this.boats[boatKey];
    const now = Date.now();
    if (boat.leaderStunnedUntil > now) return { ok: false, error: 'stunned' };
    if (now - boat.leaderProgress.lastSignalAt < LEADER_SIGNAL_COOLDOWN_MS) return { ok: false, error: 'cooldown' };
    boat.leaderProgress.lastSignalAt = now;

    boat.leaderEnergy = Math.max(0, boat.leaderEnergy - E_LEAD);
    if (boat.leaderEnergy <= 0) boat.leaderStunnedUntil = now + STUN_MS;

    const turn = this.track.turns[boat.leaderProgress.turnIndex];
    if (!turn) return { ok: true, correct: null, streak: boat.leaderProgress.streak, confirmed: false };

    const correct = direction === turn.direction;
    boat.leaderProgress.streak = correct
      ? Math.min(LEADER_STREAK_TARGET, boat.leaderProgress.streak + 1)
      : Math.max(0, boat.leaderProgress.streak - 1);

    let confirmed = false;
    if (boat.leaderProgress.streak >= LEADER_STREAK_TARGET && boat.rowerQueue.length < QUEUE_MAX) {
      boat.rowerQueue.push(turn.direction);
      boat.leaderProgress.turnIndex += 1;
      boat.leaderProgress.streak = 0;
      confirmed = true;
    }
    return { ok: true, correct, streak: boat.leaderProgress.streak, confirmed };
  }

  submitDrumTap(boatKey) {
    const boat = this.boats[boatKey];
    const now = Date.now();
    if (boat.drummerStunnedUntil > now) return { ok: false, error: 'stunned' };
    if (now - boat.drummerLastTapAt < DRUM_TAP_COOLDOWN_MS) return { ok: false, error: 'cooldown' };
    boat.drummerLastTapAt = now;

    const phase = boat.rowCycle.phase;
    let delta = 0;
    if (phase === 'raise') delta = DRUM_TAP_ENERGY_RAISE;
    else if (phase === 'active') delta = DRUM_TAP_ENERGY_ACTIVE;
    else if (phase === 'cooldown') delta = -DRUM_TAP_ENERGY_COOLDOWN_PENALTY;

    if (delta !== 0) {
      if (boat.leaderId) boat.leaderEnergy = Math.max(0, Math.min(ENERGY_MAX, boat.leaderEnergy + delta));
      boat.rowers.forEach((r) => { r.energy = Math.max(0, Math.min(ENERGY_MAX, r.energy + delta)); });
    }

    boat.drummerEnergy = Math.max(0, boat.drummerEnergy - DRUM_TAP_ENERGY_COST);
    if (boat.drummerEnergy <= 0) boat.drummerStunnedUntil = now + STUN_MS;

    return { ok: true, phase, delta };
  }

  // -- Bot AI: drives the same mutation paths a real player would use. --

  driveBots() {
    const now = Date.now();
    this.boatOrder.forEach((k) => {
      const boat = this.boats[k];
      if (boat.finishedAt) return;

      // Leader bot: knows the track truth (that's literally the role's job)
      // and attempts a signal every LEADER_SIGNAL_COOLDOWN_MS, same as a
      // real Leader would, with a small chance of fumbling the call.
      const leaderPlayer = this.findPlayer(boat.leaderId);
      if (leaderPlayer && leaderPlayer.isBot) {
        const turn = this.track.turns[boat.leaderProgress.turnIndex];
        if (turn && now - boat.leaderProgress.lastSignalAt >= LEADER_SIGNAL_COOLDOWN_MS) {
          const correct = Math.random() < 0.9;
          const direction = correct ? turn.direction : DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
          this.submitLeaderSignal(k, direction);
        }
      }

      // Drummer bot: taps as fast as the rate limit allows, but skips the
      // cooldown phase (tapping then is a penalty) -- a sensibly "smart"
      // bot rather than a maxed-out perfect one.
      const drummerPlayer = this.findPlayer(boat.drummerId);
      if (drummerPlayer && drummerPlayer.isBot) {
        if (boat.rowCycle.phase !== 'cooldown' && now - boat.drummerLastTapAt >= DRUM_TAP_COOLDOWN_MS) {
          this.submitDrumTap(k);
        }
      }

      // Rower bots: decide once per active-phase whether they nail the
      // current direction, then hold the matching buttons for its duration.
      boat.rowerIds.forEach((id, i) => {
        const player = this.findPlayer(id);
        if (!player || !player.isBot) return;
        const rower = boat.rowers[i];
        if (rower.stunnedUntil > now) { rower.held.left = false; rower.held.right = false; return; }
        if (boat.rowCycle.phase !== 'active') { rower.held.left = false; rower.held.right = false; return; }
        if (rower._botDecidedForCycle !== boat.rowCycle.cycleIndex) {
          rower._botDecidedForCycle = boat.rowCycle.cycleIndex;
          rower._botCorrect = Math.random() < 0.85;
        }
        const dir = rower._botCorrect ? boat.rowCycle.currentDirection : DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
        rower.held.left = dir === 'trai' || dir === 'thang';
        rower.held.right = dir === 'phai' || dir === 'thang';
      });
    });
  }

  tickBoat(boatKey) {
    const boat = this.boats[boatKey];
    if (boat.finishedAt) return;
    const now = Date.now();
    const dt = TICK_MS / 1000;
    // Passive base regen only -- the Drummer's contribution is now a
    // discrete per-tap energy injection (see submitDrumTap), not a
    // continuous rate multiplier.
    if (boat.leaderId) {
      if (boat.leaderStunnedUntil && now >= boat.leaderStunnedUntil) boat.leaderStunnedUntil = 0;
      if (!boat.leaderStunnedUntil) boat.leaderEnergy = Math.min(ENERGY_MAX, boat.leaderEnergy + R_BASE * dt);
    }
    boat.rowers.forEach((r) => {
      if (r.stunnedUntil && now >= r.stunnedUntil) r.stunnedUntil = 0;
      if (!r.stunnedUntil) r.energy = Math.min(ENERGY_MAX, r.energy + R_BASE * dt);
    });
    if (boat.drummerId) {
      if (boat.drummerStunnedUntil && now >= boat.drummerStunnedUntil) boat.drummerStunnedUntil = 0;
      if (!boat.drummerStunnedUntil) boat.drummerEnergy = Math.min(ENERGY_MAX, boat.drummerEnergy + R_BASE * dt);
    }

    const cyc = boat.rowCycle;
    if (cyc.phase === 'waiting') {
      if (boat.rowerQueue.length > 0) {
        cyc.currentDirection = boat.rowerQueue.shift();
        cyc.phase = 'raise';
        cyc.phaseEndsAt = now + RAISE_MS;
      }
    } else if (cyc.phase === 'raise') {
      if (now >= cyc.phaseEndsAt) {
        cyc.phase = 'active';
        cyc.phaseEndsAt = now + ACTIVE_MS;
        boat.rowers.forEach((r) => { r.heldCorrectMs = 0; });
      }
    } else if (cyc.phase === 'active') {
      boat.rowers.forEach((r) => {
        if (r.stunnedUntil) return;
        const wantsBoth = cyc.currentDirection === 'thang';
        const matches = wantsBoth
          ? (r.held.left && r.held.right)
          : cyc.currentDirection === 'trai'
            ? (r.held.left && !r.held.right)
            : (r.held.right && !r.held.left);
        if (matches) r.heldCorrectMs += TICK_MS;
      });
      if (now >= cyc.phaseEndsAt) {
        let allGoodOrBetter = true;
        let totalImpact = 0;
        boat.rowers.forEach((r) => {
          const frac = r.heldCorrectMs / ACTIVE_MS;
          let quality;
          let impact;
          if (r.stunnedUntil) { quality = 'miss'; impact = -V_UNIT; }
          else if (frac >= 0.8) { quality = 'perfect'; impact = V_UNIT; }
          else if (frac >= 0.4) { quality = 'good'; impact = V_UNIT * 0.6; }
          else { quality = 'miss'; impact = -V_UNIT; }
          r.lastResult = quality;
          totalImpact += impact;
          if (quality === 'miss') allGoodOrBetter = false;
          if (!r.stunnedUntil) {
            r.energy = Math.max(0, r.energy - E_ROW);
            if (r.energy <= 0) r.stunnedUntil = now + STUN_MS;
          }
        });
        const synergyMultiplier = allGoodOrBetter ? SUPER_BOOST_MULTIPLIER : 1;
        boat.speed = Math.max(MIN_SPEED, BASE_SPEED + totalImpact * synergyMultiplier);

        const turn = this.track.turns[boat.nextTurnIndex];
        if (turn && boat.progress >= turn.position - TURN_LOOKAHEAD_WINDOW) {
          const correct = cyc.currentDirection === turn.direction;
          boat.turnResults.push({ index: boat.nextTurnIndex, called: cyc.currentDirection, truth: turn.direction, correct });
          if (!correct) boat.penaltyUntil = now + PENALTY_MS;
          boat.nextTurnIndex += 1;
        }

        cyc.phase = 'cooldown';
        cyc.phaseEndsAt = now + COOLDOWN_MS;
        cyc.cycleIndex += 1;
      }
    } else if (cyc.phase === 'cooldown') {
      if (now >= cyc.phaseEndsAt) {
        cyc.phase = 'waiting';
        cyc.currentDirection = null;
      }
    }

    const effectiveSpeed = now < boat.penaltyUntil ? boat.speed * PENALTY_MULTIPLIER : boat.speed;
    boat.progress = Math.min(this.track.length, boat.progress + effectiveSpeed * dt);

    while (boat.nextTurnIndex < this.track.turns.length && boat.progress >= this.track.turns[boat.nextTurnIndex].position + TURN_MISS_GRACE) {
      const turn = this.track.turns[boat.nextTurnIndex];
      boat.turnResults.push({ index: boat.nextTurnIndex, called: null, truth: turn.direction, correct: false });
      boat.penaltyUntil = now + PENALTY_MS;
      boat.nextTurnIndex += 1;
    }

    if (!boat.finishedAt && boat.progress >= this.track.length) {
      boat.finishedAt = now;
    }
  }

  tick() {
    this.driveBots();
    this.boatOrder.forEach((k) => this.tickBoat(k));

    const allDone = this.boatOrder.every((k) => this.boats[k].finishedAt);
    const timedOut = Boolean(this.raceStartedAt) && Date.now() - this.raceStartedAt > MAX_RACE_MS_BASE * this.raceLengthMultiplier;

    // Ranks are only ever assigned once, right when the race actually
    // concludes (every boat finished, or the safety timeout hits) --
    // assigning a rank early (the moment just one boat finishes) would
    // block the others from ever getting ranked once THEY finish too.
    if (allDone || timedOut) {
      const alreadyRanked = this.boatOrder.some((k) => this.boats[k].finishRank);
      if (!alreadyRanked) {
        const order = [...this.boatOrder].sort((x, y) => {
          const bx = this.boats[x];
          const by = this.boats[y];
          // Finished boats rank ahead of unfinished ones (timeout case);
          // among finished boats, earlier finishedAt wins; among unfinished
          // boats (all timed out without finishing), further progress wins.
          if (Boolean(bx.finishedAt) !== Boolean(by.finishedAt)) return bx.finishedAt ? -1 : 1;
          if (bx.finishedAt && by.finishedAt) return bx.finishedAt - by.finishedAt;
          return by.progress - bx.progress;
        });
        order.forEach((key, i) => { this.boats[key].finishRank = i + 1; });
        this.pushLog(`🏁 Race finished! ${this.boats[order[0]].name} wins!`);
      }
      this.status = 'finished';
    }
  }

  startTicking(nsp) {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      try {
        this.tick();
        this.broadcast(nsp);
      } catch (err) {
        console.error(`[boat] tick failed in room ${this.id}:`, err);
      }
      if (this.status !== 'racing' && this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
    }, TICK_MS);
  }

  boatView(boatKey, forPlayerId, role) {
    const boat = this.boats[boatKey];
    const nameFor = (id) => (this.findPlayer(id) || {}).name || null;
    const base = {
      name: boat.name,
      progress: Math.round(boat.progress),
      length: this.track.length,
      speed: Math.round(boat.speed * 10) / 10,
      rowCycle: { phase: boat.rowCycle.phase, phaseEndsAt: boat.rowCycle.phaseEndsAt, currentDirection: boat.rowCycle.currentDirection },
      finishedAt: boat.finishedAt,
      finishRank: boat.finishRank,
      leader: { name: nameFor(boat.leaderId), energy: Math.round(boat.leaderEnergy), stunnedUntil: boat.leaderStunnedUntil },
      drummer: {
        name: nameFor(boat.drummerId),
        nextTapReadyAt: boat.drummerLastTapAt + DRUM_TAP_COOLDOWN_MS,
        energy: Math.round(boat.drummerEnergy * 10) / 10,
        stunnedUntil: boat.drummerStunnedUntil,
      },
      rowers: boat.rowers.map((r, i) => ({ name: nameFor(boat.rowerIds[i]), energy: Math.round(r.energy), stunnedUntil: r.stunnedUntil, lastResult: r.lastResult })),
      queue: boat.rowerQueue.slice(0, QUEUE_MAX),
      lastTurnResults: boat.turnResults.slice(-3),
    };
    // Only the Leader gets the track's true upcoming directions ahead of
    // time (and their own confirm-streak progress) -- Rowers only ever see
    // what's already been queued (which may be wrong, if the Leader
    // misread the track or never got to 5/5 for it).
    if (forPlayerId && role === 'leader' && boat.leaderId === forPlayerId) {
      base.upcomingTruth = this.track.turns.slice(boat.leaderProgress.turnIndex, boat.leaderProgress.turnIndex + 2).map((t) => t.direction);
      base.leaderProgress = {
        streak: boat.leaderProgress.streak,
        target: LEADER_STREAK_TARGET,
        nextSignalReadyAt: boat.leaderProgress.lastSignalAt + LEADER_SIGNAL_COOLDOWN_MS,
      };
    }
    return base;
  }

  state(forPlayerId) {
    const loc = this.locate(forPlayerId);
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      teamSize: this.teamSize,
      rowerSlots: this.rowerSlots,
      mapTheme: this.mapTheme,
      mapThemeLabel: MAP_THEMES[this.mapTheme],
      raceLengthMultiplier: this.raceLengthMultiplier,
      raceStartedAt: this.raceStartedAt,
      rowPhaseDurations: { raise: RAISE_MS, active: ACTIVE_MS, cooldown: COOLDOWN_MS },
      leaderSignalCooldownMs: LEADER_SIGNAL_COOLDOWN_MS,
      leaderStreakTarget: LEADER_STREAK_TARGET,
      drumTapCooldownMs: DRUM_TAP_COOLDOWN_MS,
      drumTapEffects: { raise: DRUM_TAP_ENERGY_RAISE, active: DRUM_TAP_ENERGY_ACTIVE, cooldown: -DRUM_TAP_ENERGY_COOLDOWN_PENALTY, waiting: 0 },
      maxBoats: MAX_BOATS,
      boatOrder: this.boatOrder,
      boats: this.boatOrder.reduce((acc, key) => {
        const boat = this.boats[key];
        acc[key] = {
          leaderId: boat.leaderId,
          drummerId: boat.drummerId,
          rowerIds: boat.rowerIds,
          ...this.boatView(key, forPlayerId, loc && loc.boatKey === key ? loc.role : null),
        };
        return acc;
      }, {}),
      players: this.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, isBot: Boolean(p.isBot) })),
      log: this.log,
      yourId: forPlayerId || null,
      yourAssignment: loc,
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('boat:state', this.state(p.id));
    });
  }
}

function attachBoat(io) {
  const nsp = io.of('/boat');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].map((r) => r.summary());
  }
  function broadcastRoomList() {
    nsp.emit('boat:rooms', roomList());
  }
  function deleteRoomIfEmpty(room) {
    if (room && room.isEmpty()) {
      clearInterval(room.tickTimer);
      rooms.delete(room.id);
    }
  }

  nsp.on('connection', (socket) => {
    socket.emit('boat:rooms', roomList());

    socket.on('boat:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('boat:createRoom', ({ roomName, password, playerId, name, teamSize, mapTheme, raceLengthMultiplier }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const room = new BoatRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, teamSize, mapTheme, raceLengthMultiplier);
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false });
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('boat:joinRoom', ({ roomId, password, playerId, name }, callback) => {
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
        if (room.players.length >= room.teamSize * 2) { if (typeof callback === 'function') callback({ ok: false, error: 'room-full' }); return; }
        room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false });
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

    socket.on('boat:selectRole', ({ boat, role, slotIndex }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const result = room.selectRole(socket.playerId, boat, role, slotIndex);
      if (typeof callback === 'function') callback(result);
      if (result.ok) { room.broadcast(nsp); broadcastRoomList(); }
    });

    socket.on('boat:addBoat', ({ name }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const result = room.addBoat(name);
      if (typeof callback === 'function') callback(result);
      if (result.ok) { room.broadcast(nsp); broadcastRoomList(); }
    });

    socket.on('boat:renameBoat', ({ boatKey, name }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const result = room.renameBoat(boatKey, name);
      if (typeof callback === 'function') callback(result);
      if (result.ok) { room.broadcast(nsp); broadcastRoomList(); }
    });

    socket.on('boat:addBots', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const added = room.addBots();
      if (typeof callback === 'function') callback({ ok: true, added });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('boat:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (!room.allSlotsFilled()) { if (typeof callback === 'function') callback({ ok: false, error: 'seats-empty' }); return; }
      room.startRace();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.startTicking(nsp);
      broadcastRoomList();
    });

    socket.on('boat:leaderSignal', ({ direction }, callback) => {
      const room = myRoom();
      if (!room || room.status !== 'racing') { if (typeof callback === 'function') callback({ ok: false, error: 'not-racing' }); return; }
      const loc = room.locate(socket.playerId);
      if (!loc || loc.role !== 'leader') { if (typeof callback === 'function') callback({ ok: false, error: 'not-leader' }); return; }
      if (!DIRECTIONS.includes(direction)) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-direction' }); return; }
      const result = room.submitLeaderSignal(loc.boatKey, direction);
      if (typeof callback === 'function') callback(result);
    });

    socket.on('boat:drumTap', (payload, callback) => {
      const room = myRoom();
      if (!room || room.status !== 'racing') { if (typeof callback === 'function') callback({ ok: false, error: 'not-racing' }); return; }
      const loc = room.locate(socket.playerId);
      if (!loc || loc.role !== 'drummer') { if (typeof callback === 'function') callback({ ok: false, error: 'not-drummer' }); return; }
      const result = room.submitDrumTap(loc.boatKey);
      if (typeof callback === 'function') callback(result);
    });

    socket.on('boat:rowerHold', ({ side, pressed }) => {
      const room = myRoom();
      if (!room || room.status !== 'racing') return;
      const loc = room.locate(socket.playerId);
      if (!loc || loc.role !== 'rower') return;
      if (side !== 'left' && side !== 'right') return;
      room.boats[loc.boatKey].rowers[loc.slotIndex].held[side] = Boolean(pressed);
    });

    // Shared by 'boat:leave' (client expects an ack callback) and
    // 'disconnect' (fires with just a reason string, no callback) --
    // callback is only invoked when one was actually given.
    function handleLeave(payload, callback) {
      const room = myRoom();
      if (room) {
        const player = room.findPlayer(socket.playerId);
        if (player) {
          if (room.status === 'waiting') {
            room.clearAssignment(socket.playerId);
            room.players = room.players.filter((p) => p.id !== socket.playerId);
            room.pushLog(`${player.name} left the room.`);
          } else if (player.socketId === socket.id) {
            player.connected = false;
          }
          room.broadcast(nsp);
        }
        deleteRoomIfEmpty(room);
        broadcastRoomList();
      }
      socket.roomId = null;
      if (typeof callback === 'function') callback({ ok: true });
    }

    socket.on('boat:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
}

module.exports = attachBoat;
module.exports.BoatRoom = BoatRoom;
module.exports.TEAM_SIZES = TEAM_SIZES;
module.exports.TICK_MS = TICK_MS;
module.exports.RAISE_MS = RAISE_MS;
module.exports.ACTIVE_MS = ACTIVE_MS;
module.exports.COOLDOWN_MS = COOLDOWN_MS;
module.exports.ENERGY_MAX = ENERGY_MAX;
module.exports.QUEUE_MAX = QUEUE_MAX;
module.exports.LEADER_SIGNAL_COOLDOWN_MS = LEADER_SIGNAL_COOLDOWN_MS;
module.exports.LEADER_STREAK_TARGET = LEADER_STREAK_TARGET;
module.exports.DRUM_TAP_COOLDOWN_MS = DRUM_TAP_COOLDOWN_MS;
module.exports.DRUM_TAP_ENERGY_RAISE = DRUM_TAP_ENERGY_RAISE;
module.exports.DRUM_TAP_ENERGY_ACTIVE = DRUM_TAP_ENERGY_ACTIVE;
module.exports.DRUM_TAP_ENERGY_COOLDOWN_PENALTY = DRUM_TAP_ENERGY_COOLDOWN_PENALTY;
module.exports.DRUM_TAP_ENERGY_COST = DRUM_TAP_ENERGY_COST;
module.exports.MAX_BOATS = MAX_BOATS;
module.exports.RACE_LENGTH_MULTIPLIERS = RACE_LENGTH_MULTIPLIERS;
module.exports.DEFAULT_RACE_LENGTH_MULTIPLIER = DEFAULT_RACE_LENGTH_MULTIPLIER;
module.exports.STARTING_BOAT_COUNT = STARTING_BOAT_COUNT;
module.exports.generateTrack = generateTrack;
module.exports.rowerSlotsFor = rowerSlotsFor;
