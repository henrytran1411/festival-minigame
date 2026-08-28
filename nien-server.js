// Đuổi Niên Thú (Nien Monster Chase) — a fourth backup game alongside UNO,
// Exploding Kittens, and Go. Same "casual side activity" contract as those
// three: its own Socket.IO namespace, no leaderboard, no admin open/close
// gating (see server.js).
//
// Unlike the turn-based games, this is a real-time shared arena: players
// move continuously and throw firecrackers to scare a server-controlled
// Niên Thú into dropping gifts. This is the MVP slice of the full GDD
// (public/midautumnevent.md) — Phases 1+2 (core loop + networking) only.
// The pre-game stat loadout (Phase 3) is deliberately deferred; every
// player/bot uses the same fixed movement speed / firecracker stats for
// now. Bots ARE included (added early, ahead of the GDD's Phase 3) purely
// to make multiplayer testable without needing several real people — their
// AI is a simple "chase the nearest useful thing" heuristic, not the GDD's
// eventual A* pathfinding (there are no obstacles in this arena yet for
// pathfinding to matter).

const TICK_MS = 80; // ~12.5 updates/sec — plenty smooth for a LAN event, low bandwidth.
const MAX_PLAYERS = 8;
const BOT_NAMES = ['🤖 Bot An', '🤖 Bot Bình', '🤖 Bot Chi', '🤖 Bot Dũng', '🤖 Bot Giang', '🤖 Bot Hà'];

const PLAYER_SPEED = 160; // px/sec
const PLAYER_RADIUS = 16;
const PICKUP_RADIUS = 26;
// Standing still inside PICKUP_RADIUS of an item for this long actually
// collects it — walking through it, or switching to a different item,
// resets the hold rather than grabbing it on the fly (see tick()).
const PICKUP_HOLD_MS = 500;
// How far from the Niên Thú dropped loot lands -- far enough that players
// have to actually run to it rather than it landing right in the middle
// of the fight.
const LOOT_DROP_RADIUS = 500;

const MONSTER_RADIUS = 24;
const MONSTER_FLEE_SPEED = 190;
const MONSTER_FLEE_MS = 2200;
const MONSTER_RESPAWN_DELAY_MS = 60000; // matches the GDD's "every 60 seconds"

// Zone-tile items (Trung/Thu/Vui/Vẻ) are a SEPARATE drop stream from the
// 3 classic prizes below -- not a random weighted roll, but reserved
// picks awarded to whoever's currently topping the damage race. See
// dropReservedZoneTiles()/rankContributions().
const ZONE_TILE_TOP_N = 3; // top 1-3 ranked players each get one reserved tile per decile
const ZONE_TILE_RESERVATION_MS = 10000; // reserved to that player only for this long; open to anyone after
const ZONE_TILE_FULL_SET_BONUS = 100; // awarded each time a player completes another full set of all 4 distinct tiles
// After the Niên Thú fully flees at 100% HP, nobody can hit it (so no new
// damage ranking can form) for the whole MONSTER_RESPAWN_DELAY_MS window.
// Loot still needs to keep flowing through that window per the design
// brief, at double volume: classic items drop on a timer (no monster
// position to scale "nearby" by, so everyone connected counts), and zone
// tiles keep reserving to whichever top-3 ranking was current when it
// fled (the last completed decile's contributions) since no fresher one
// can ever be computed while it's gone.
const FLED_DROP_INTERVAL_MS = 8000;
const FLED_VOLUME_MULTIPLIER = 2;

// Skill "Sư Tử Hống" (Lion's Roar): every LION_ROAR_HP_STEP of raw HP
// dropped (0.5% of the pool), the Niên Thú roars in place — stunning every
// player/bot within LION_ROAR_RADIUS for LION_ROAR_STUN_MS, then (once that
// stun window closes) bolting away at double its normal flee speed. Only
// fires once per hit even if a single huge hit crosses several 0.5% steps
// at once — the escape itself doesn't need to repeat.
const LION_ROAR_HP_STEP = 500;
const LION_ROAR_RADIUS = 500;
const LION_ROAR_STUN_MS = 5000;
const LION_ROAR_FLEE_SPEED_MULTIPLIER = 2;
// If nobody lands a hit for this long after the Niên Thú becomes visible,
// it slips back into hiding at its CURRENT position (no teleport — that
// only happens on a 10%-fear relocation, see DECILE_MILESTONES below).
const MONSTER_HIDE_AFTER_MS = 10000;

// The instant it STARTS hiding (initial spawn, a decile relocation, giving
// up on being seen, or settling in after a Lion's Roar bolt), it doesn't
// immediately go fully still -- it wanders randomly for a few seconds
// first, confined to whichever zone it just started hiding in, before
// finally settling down completely for the rest of that hidden stretch.
const MONSTER_HIDDEN_WANDER_MS = 4000;
const MONSTER_HIDDEN_WANDER_SPEED = 45;

// The arena is split into 4 quadrants. Every time the Niên Thú appears or
// relocates, it picks one at random, but the SAME zone can never be
// picked 3 times in a row — after landing in the same zone twice
// consecutively, the third pick is forced to exclude it.
const ZONE_KEYS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
// Themed zone names -- read in quadrant order (top-left, top-right,
// bottom-left, bottom-right) they spell out "Trung Thu Vui Vẻ" (Happy
// Mid-Autumn Festival).
const ZONE_LABELS = {
  topLeft: 'Trung', topRight: 'Thu', bottomLeft: 'Vui', bottomRight: 'Vẻ',
};

function pickZone(room) {
  const lastTwo = room.zoneHistory.slice(-2);
  const candidates = (lastTwo.length === 2 && lastTwo[0] === lastTwo[1])
    ? ZONE_KEYS.filter((z) => z !== lastTwo[0])
    : ZONE_KEYS;
  const zone = candidates[Math.floor(Math.random() * candidates.length)];
  room.zoneHistory.push(zone);
  if (room.zoneHistory.length > 2) room.zoneHistory.shift(); // only the last 2 picks matter for the rule
  return zone;
}

function zoneOrigin(mapWidth, mapHeight, zone) {
  return {
    x: (zone === 'topRight' || zone === 'bottomRight') ? mapWidth / 2 : 0,
    y: (zone === 'bottomLeft' || zone === 'bottomRight') ? mapHeight / 2 : 0,
  };
}

function zoneCenter(mapWidth, mapHeight, zone) {
  const origin = zoneOrigin(mapWidth, mapHeight, zone);
  return { x: origin.x + mapWidth / 4, y: origin.y + mapHeight / 4 };
}

function randomPositionInZone(mapWidth, mapHeight, zone, radius) {
  const origin = zoneOrigin(mapWidth, mapHeight, zone);
  const halfW = mapWidth / 2;
  const halfH = mapHeight / 2;
  const x = origin.x + radius + Math.random() * Math.max(0, halfW - radius * 2);
  const y = origin.y + radius + Math.random() * Math.max(0, halfH - radius * 2);
  return { x, y };
}

const FIRECRACKER_RANGE = 190; // max distance from the thrower a target point may be — same for every type in this pass

// Flat penalty (independent of firecracker type) for holding a burned-out
// firecracker too long without throwing it: it goes off in the player's
// hands and stuns them (can't move) for this long.
const SELF_DETONATE_STUN_MS = 3000;

// Pre-game loadout catalog: each player spends a shared point budget on a
// mix of these before the chase starts. Radius/fear/cost are tuned so a
// Large firecracker roughly trades 2.5x the cost of a Small one for ~3x the
// AoE area and ~3x the fear damage — a real but not overwhelming edge.
//
// Throwing one is a 3-phase action (all times in seconds):
//   1. timeToBurn — lighting it. The thrower is ROOTED (cannot move) for
//      this whole phase, human or bot alike.
//   2. timeBeforeExplosion — once burned out, it's "armed": lit and ready,
//      sitting in the thrower's hand. They're free to move during this
//      window while aiming, and must click a target to actually throw it
//      (an immediate, instant-resolving release — no further delay) before
//      this window runs out. Let it run out and it goes off in their
//      hands instead: no damage to the Niên Thú, just the flat
//      SELF_DETONATE_STUN_MS stun above.
//   3. nextBurnTime — cooldown, counted from the moment the firecracker
//      actually leaves their hand (thrown OR self-detonated), before they
//      can start lighting another one (any type).
//
// purchaseUnit (default 1 when omitted) is how many individual firecrackers
// one shop "click" actually buys/sells — every type here is sold by the
// pack (100 at a time), same as real Tet stalls, so e.g. 5 points buys a
// full pack of 100 Pháo tép rather than a single one. cost is always PER
// PACK (i.e. per purchaseUnit), not per individual firecracker — see
// totalLoadoutCost().
const FIRECRACKER_TYPES = {
  small: { key: 'small', label: 'Pháo tép', emoji: '🧨', radius: 50, fear: 12, cost: 5, purchaseUnit: 100, timeToBurn: 1, timeBeforeExplosion: 2, nextBurnTime: 0.5 },
  medium: { key: 'medium', label: 'Pháo chuột', emoji: '🎆', radius: 75, fear: 20, cost: 10, purchaseUnit: 100, timeToBurn: 2, timeBeforeExplosion: 3, nextBurnTime: 1 },
  large: { key: 'large', label: 'Pháo cối', emoji: '💣', radius: 110, fear: 35, cost: 25, purchaseUnit: 100, timeToBurn: 5, timeBeforeExplosion: 5, nextBurnTime: 3 },
};
const FIRECRACKER_KEYS = Object.keys(FIRECRACKER_TYPES);
const DEFAULT_LOADOUT_BUDGET = 100; // matches the GDD's own example budget
const LOADOUT_BUDGET_OPTIONS = [50, 100, 150, 200]; // presets the room host can pick from at creation

// Playable characters, picked pre-game (see nien:selectCharacter). `image`
// is the static portrait drawn on the arena and in the character picker
// (see nien.js); `emoji` is the fallback used if that image ever fails to
// load, and stays the stand-in for any distinct move/burn/throw/stun
// animations per character — planned, but not built yet. Not exclusive:
// more than one player can pick the same one. Paths are relative to
// public/games/ (same convention as EK's explodingkitten/cards/ art).
const CHARACTERS = {
  chiHang: { key: 'chiHang', label: 'Chị Hằng', emoji: '🌕', image: 'nienmonster/characters/chị hằng.png' },
  chuCuoi: { key: 'chuCuoi', label: 'Chú Cuội', emoji: '🌳', image: 'nienmonster/characters/chú cuội.png' },
  ongDia: { key: 'ongDia', label: 'Ông Địa', emoji: '👴', image: 'nienmonster/characters/ông địa.png' },
  thoNgoc: { key: 'thoNgoc', label: 'Thỏ Ngọc', emoji: '🐇', image: 'nienmonster/characters/thỏ ngọc.png' },
};
const CHARACTER_KEYS = Object.keys(CHARACTERS);
const DEFAULT_CHARACTER = CHARACTER_KEYS[0];

// The Niên Thú's "fear" field is now literal raw HP dropped (0 up to
// MONSTER_MAX_HP), NOT a percentage — a firecracker's `fear` stat (12/20/35)
// is exactly how many HP it deals per hit, full stop. This used to be a
// 0-100 percentage (so a Pháo tép hit dropped 12% = 12,000 HP in one go),
// which made the very first hit of a match feel absurdly punishing; as raw
// HP against a 100,000-point pool, the same 12-point hit is what it looks
// like it should be — a small dent, not a fifth of its health bar.
const MONSTER_MAX_HP = 100000;

// Every whole 1,000 HP dropped (i.e. crossing another 1% of the pool, even
// though we no longer track fear AS a percentage — a single big firecracker
// can still cross more than one of these in one hit if it's ever buffed
// past 1,000) drops loot scaled to how crowded the monster's current spot
// is: count connected players/bots within this radius and multiply by the
// rate below. Numbers are placeholders per the design brief ("drop rate
// will be config later") — easy to retune without touching the logic.
const MONSTER_LOOT_RADIUS = 300;
const LOOT_DROP_RATE_PER_NEARBY = 2; // e.g. 10 nearby -> 20 items per 1,000 HP crossed
const LOOT_MILESTONE_HP = 1000; // one loot-drop milestone per this many raw HP dropped (= 1% of MONSTER_MAX_HP)

// Every 10% of the HP pool is its own separate milestone system, for the
// recurring "who's scaring it the most RIGHT NOW" mini-competition: each
// crossing pays out ranked rewards based on HP damage dealt since the last
// crossing, then (below 100%) hides + relocates the Niên Thú to a new
// zone. 100% is shared with the existing "fully scared away" behavior
// (full disappearance + scheduled respawn), so it doesn't ALSO relocate
// in place — see scareMonster(). Expressed directly in raw HP now that
// fear no longer is a percentage.
const DECILE_MILESTONES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => (pct / 100) * MONSTER_MAX_HP);

// Ranked reward tiers, evaluated fresh at every decile crossing, based on
// each player's total fear damage dealt to the Niên Thú since the
// previous crossing. Ranks not covered by a tier (i.e., past 20th place)
// still get the flat SCARE_REWARD_ANY consolation as long as they landed
// at least one hit. Point values are arbitrary defaults — easy to retune.
const SCARE_REWARD_TIERS = [
  { minRank: 1, maxRank: 1, points: 50 },
  { minRank: 2, maxRank: 3, points: 30 },
  { minRank: 4, maxRank: 10, points: 15 },
  { minRank: 11, maxRank: 20, points: 5 },
];
const SCARE_REWARD_ANY = 1;
// One-time bonus for whoever lands the very first successful hit of the
// entire match — separate from (and in addition to) the recurring
// decile-tier rewards above.
const FIRST_HIT_BONUS = 25;
// That very first hit is also special in a second way, regardless of which
// firecracker type landed it: it only "grazes" the Niên Thú for a token
// amount of HP instead of the firecracker's real damage (so the match
// doesn't immediately blow past the 10% decile — and its hide + relocate —
// on turn one, before anyone's even seen it move). It's still a genuine
// hit: the monster is revealed to everyone exactly like any other. Now that
// fear IS raw HP, this needs no unit conversion — it's just applied as-is.
const FIRST_HIT_HP_OVERRIDE = 5;

function totalLoadoutCost(loadout) {
  if (!loadout) return 0;
  // loadout[key] is a raw firecracker count; cost is per PACK (purchaseUnit
  // firecrackers), so divide back down to packs before pricing.
  return FIRECRACKER_KEYS.reduce((sum, key) => {
    const def = FIRECRACKER_TYPES[key];
    const unit = def.purchaseUnit || 1;
    return sum + ((loadout[key] || 0) / unit) * def.cost;
  }, 0);
}

function emptyLoadout() {
  return { small: 0, medium: 0, large: 0 };
}

// Used when a player (human or bot) never visited the shop before Start is
// clicked, so nobody ever begins a match with zero usable firecrackers.
// Humans get the simplest possible spend (all-in on the cheapest type);
// bots get a randomized mix so their AI actually exercises every type
// across enough test games.
function autoFillLoadout(budget, { randomized = false } = {}) {
  const loadout = emptyLoadout();
  if (!randomized) {
    const def = FIRECRACKER_TYPES.small;
    const packs = Math.floor(budget / def.cost);
    loadout.small = packs * (def.purchaseUnit || 1);
    return loadout;
  }
  let remaining = budget;
  let guard = 0; // safety valve — budgets are small enough this never realistically triggers
  while (remaining > 0 && guard < 1000) {
    guard += 1;
    const affordable = FIRECRACKER_KEYS.filter((key) => FIRECRACKER_TYPES[key].cost <= remaining);
    if (!affordable.length) break;
    const key = affordable[Math.floor(Math.random() * affordable.length)];
    loadout[key] += FIRECRACKER_TYPES[key].purchaseUnit || 1;
    remaining -= FIRECRACKER_TYPES[key].cost;
  }
  return loadout;
}

// No cap on how much loot a match can drop in total -- it keeps flowing
// for as long as the match runs (including through the post-100%
// "fled" window, see the fled-drop loop in tick()). The only thing that
// ends a match automatically now is this safety net, so a room can't run
// forever.
const MAX_GAME_DURATION_MS = 6 * 60 * 1000;

// The classic Mid-Autumn prizes -- these are the only items in the plain
// random-weighted drop (pickLootType()); the zone tiles below are a
// wholly separate, reservation-based drop stream (see
// dropReservedZoneTiles()), not part of this weighted roll at all.
// `image` is the real portrait drawn on the arena (nien.js); `emoji` is
// the fallback if that image ever fails to load. Paths are relative to
// public/games/ (same convention as the character portraits under
// nienmonster/characters/).
const CLASSIC_LOOT_TYPES = [
  { type: 'denOngSao', label: 'Đèn Ông Sao', emoji: '⭐', image: 'nienmonster/items/Đèn Ông Sao.png', value: 10, weight: 3 },
  { type: 'banhTrungThu', label: 'Bánh Trung Thu', emoji: '🥮', image: 'nienmonster/items/Bánh Trung Thu.png', value: 20, weight: 1 },
  { type: 'nen', label: 'Nến', emoji: '🕯️', image: 'nienmonster/items/Nến.png', value: 5, weight: 3 },
];

// Themed to whichever zone the Niên Thú is in when a batch drops (see
// dropReservedZoneTiles()) -- collecting a full "Trung Thu Vui Vẻ" set
// across all 4 zones earns ZONE_TILE_FULL_SET_BONUS, repeatably. `image`
// is the real portrait for the tile; `emoji` (the zone's own text) is the
// fallback if it fails to load.
const ZONE_LOOT_TYPES = {};
ZONE_KEYS.forEach((zone) => {
  ZONE_LOOT_TYPES[zone] = {
    type: `zone_${zone}`, label: ZONE_LABELS[zone], emoji: ZONE_LABELS[zone],
    image: `nienmonster/items/${ZONE_LABELS[zone]}.png`, value: 30,
  };
});

// Rolls one of the 3 classic prizes for a single drop.
function pickLootType() {
  const pool = CLASSIC_LOOT_TYPES;
  const totalWeight = pool.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const t of pool) {
    roll -= t.weight;
    if (roll <= 0) return t;
  }
  return pool[0];
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Map grows with the table so a full room doesn't feel cramped, but caps
// out so a huge crowd doesn't turn it into an empty walking simulator.
function computeMapSize(playerCount) {
  const size = clamp(520 + (playerCount - 1) * 140, 520, 1400);
  return { width: size, height: size };
}

class NienRoom {
  constructor(id, name, password, loadoutBudget) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.loadoutBudget = LOADOUT_BUDGET_OPTIONS.includes(Number(loadoutBudget)) ? Number(loadoutBudget) : DEFAULT_LOADOUT_BUDGET;
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // { id, name, connected, socketId, isBot, x, y, dir, score, burning, armed, stunnedUntil, nextBurnAt, loadout, inventory }
    this.botCounter = 0;
    this.mapWidth = 0;
    this.mapHeight = 0;
    this.monster = null; // { x, y, zone, visible, lastHitAt, fear, fleeDir, fleeUntil, milestonesHit, decileHit, contributions }
    this.zoneHistory = []; // last 2 zones the monster appeared/relocated in, for the no-3-in-a-row rule
    this.firstHitAwarded = false;
    this.loot = []; // { id, type, label, emoji, value, x, y, reservedFor?, reservedUntil? }
    this.lootCounter = 0; // also doubles as "total items ever dropped" for the HUD
    this.startedAt = null;
    this.lastDecileRanking = []; // playerIds, highest damage-since-last-decile first -- reused during the fled window
    this.lastMonsterZone = null; // zone the Niên Thú was last in -- themes fled-window zone-tile drops
    this.fledUntil = 0; // Date.now() cutoff for the post-100% "gone, respawning" window; 0 = not currently fled
    this.nextFledDropAt = 0; // next scheduled fled-window drop, while fledUntil is active
    this.log = [];
    this.winnerId = null;
    this.resultText = null;
    this.tickTimer = null;
    this.monsterSpawnTimer = null;
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 30) this.log.shift();
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
    };
  }

  startGame() {
    const n = this.players.length;
    const { width, height } = computeMapSize(n);
    this.mapWidth = width;
    this.mapHeight = height;
    this.players.forEach((p) => {
      p.x = PLAYER_RADIUS + Math.random() * (width - PLAYER_RADIUS * 2);
      p.y = PLAYER_RADIUS + Math.random() * (height - PLAYER_RADIUS * 2);
      p.dir = { x: 0, y: 0 };
      p.score = 0;
      p.burning = null;
      p.armed = null;
      p.stunnedUntil = 0;
      p.nextBurnAt = 0;
      p.pickupProgress = null;
      p.zoneTileCounts = { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 };
      // Anyone (human or bot) who never spent any points at the shop gets
      // an automatic loadout so nobody starts the match with zero
      // firecrackers just because they forgot to visit the shop.
      if (!p.loadout || totalLoadoutCost(p.loadout) === 0) {
        p.loadout = autoFillLoadout(this.loadoutBudget, { randomized: Boolean(p.isBot) });
      }
      p.inventory = { ...p.loadout };
      // Same idea for character: anyone who never picked one (forgot, or
      // joined after the picker existed) gets a random one so the arena
      // never has to render an unset character.
      if (!p.character || !CHARACTERS[p.character]) {
        p.character = CHARACTER_KEYS[Math.floor(Math.random() * CHARACTER_KEYS.length)];
      }
    });
    this.loot = [];
    this.lootCounter = 0;
    this.monster = null;
    this.zoneHistory = [];
    this.lastDecileRanking = [];
    this.lastMonsterZone = null;
    this.fledUntil = 0;
    this.nextFledDropAt = 0;
    this.firstHitAwarded = false;
    clearTimeout(this.monsterSpawnTimer);
    this.status = 'playing';
    this.startedAt = Date.now();
    this.winnerId = null;
    this.resultText = null;
    this.log = [];
    this.pushLog(`🎉 The chase begins on a ${width}x${height} map!`);
    this.spawnMonster();
  }

  // Single entry point for "it just started being hidden" — arms the brief
  // random-wander window (see MONSTER_HIDDEN_WANDER_MS) that always kicks
  // in the instant hiding begins, whatever the reason. Mutates the passed
  // monster object; does NOT touch m.visible/m.zone/m.x/m.y itself since
  // callers set those differently (a fresh spot vs. hiding in place).
  armHiddenWander(m) {
    m.visible = false;
    m.hiddenWanderUntil = Date.now() + MONSTER_HIDDEN_WANDER_MS;
    m.wanderDir = null;
  }

  // A fresh appearance (initial spawn, or the respawn 60s after being
  // fully scared away) — always hidden, always in a freshly-picked zone.
  spawnMonster() {
    const zone = pickZone(this);
    const { x, y } = randomPositionInZone(this.mapWidth, this.mapHeight, zone, MONSTER_RADIUS);
    this.monster = {
      x, y, zone,
      visible: false,
      hiddenWanderUntil: 0,
      wanderDir: null,
      lastHitAt: 0,
      fear: 0,
      fleeDir: null,
      fleeUntil: 0,
      fleeSpeedMultiplier: 1,
      roaring: false,
      roarEndsAt: 0,
      fleeWaypoints: null, // post-roar bolt route: [mapCenter, {x,y,zone}] -- see tick()
      roarMilestonesHit: [],
      milestonesHit: [],
      decileHit: [],
      contributions: {}, // playerId -> fear damage dealt since the last decile payout
    };
    this.armHiddenWander(this.monster);
    this.fledUntil = 0; // it's back -- the fled-window drop loop (tick()) stops here
    this.nextFledDropAt = 0;
    this.pushLog(`👹 The Niên Thú has appeared somewhere in the ${ZONE_LABELS[zone]} zone!`);
  }

  // Mid-chase relocation (every 10% fear below 100%): hides it and moves
  // it to a freshly-picked zone WITHOUT the 60s respawn delay — the
  // chase continues immediately, just from a new hiding spot.
  relocateMonster() {
    const m = this.monster;
    if (!m) return;
    const zone = pickZone(this);
    const { x, y } = randomPositionInZone(this.mapWidth, this.mapHeight, zone, MONSTER_RADIUS);
    m.zone = zone;
    m.x = x;
    m.y = y;
    this.armHiddenWander(m);
    m.fleeDir = null;
    m.fleeUntil = 0;
    m.fleeSpeedMultiplier = 1;
    m.roaring = false;
    m.roarEndsAt = 0;
    m.fleeWaypoints = null;
    this.pushLog(`👻 The Niên Thú vanished and reappeared somewhere in the ${ZONE_LABELS[zone]} zone!`);
  }

  // Player IDs who dealt damage this decile segment, ranked highest-first
  // — shared by distributeScareRewards() (points) and
  // dropReservedZoneTiles() (who the reserved tiles go to), so both use
  // the exact same "who's topping the damage race right now" snapshot.
  rankContributions(monster) {
    return Object.entries(monster.contributions)
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([playerId, amount]) => ({ playerId, amount }));
  }

  // Ranked payout at a single decile crossing, based on each player's raw
  // HP damage dealt to the Niên Thú since the PREVIOUS crossing (reset
  // right after — see scareMonster()), not their whole-match total. This
  // is what makes it a fresh mini-competition every 10%, not a single
  // early leader coasting to the same result every time.
  distributeScareRewards(ranked, decileHp) {
    const pct = Math.round((decileHp / MONSTER_MAX_HP) * 100);
    ranked.forEach(({ playerId, amount }, idx) => {
      const rank = idx + 1;
      const player = this.findPlayer(playerId);
      if (!player) return;
      const tier = SCARE_REWARD_TIERS.find((t) => rank >= t.minRank && rank <= t.maxRank);
      const points = tier ? tier.points : SCARE_REWARD_ANY;
      player.score += points;
      this.pushLog(`🏆 ${player.name} ranked #${rank} scaring the Niên Thú to ${pct}% (dealt ${Math.round(amount).toLocaleString()} HP) — +${points} pts!`);
    });
  }

  // Drops one reserved zone-tile item per player in `rankedIds` (already
  // sliced to the top ZONE_TILE_TOP_N) -- for ZONE_TILE_RESERVATION_MS,
  // ONLY that specific player can pick their tile up (see the pickup loop
  // in tick()); anyone can once it expires. `multiplier` drops that many
  // tiles per ranked player instead of 1 (used for the doubled fled-window
  // rate). Themed to `zone` (whichever the Niên Thú was in, or last known
  // to be in if it's currently fled) and centered near (centerX, centerY).
  dropReservedZoneTiles(rankedIds, zone, centerX, centerY, multiplier = 1) {
    const t = ZONE_LOOT_TYPES[zone] || ZONE_LOOT_TYPES.topLeft;
    const topIds = rankedIds.slice(0, ZONE_TILE_TOP_N);
    const now = Date.now();
    topIds.forEach((playerId) => {
      for (let i = 0; i < multiplier; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 40 + Math.random() * 80;
        const x = clamp(centerX + Math.cos(angle) * dist, 10, this.mapWidth - 10);
        const y = clamp(centerY + Math.sin(angle) * dist, 10, this.mapHeight - 10);
        this.lootCounter += 1;
        this.loot.push({
          id: `loot_${this.lootCounter}`, type: t.type, label: t.label, emoji: t.emoji, image: t.image || null,
          value: t.value, x, y, reservedFor: playerId, reservedUntil: now + ZONE_TILE_RESERVATION_MS,
        });
      }
    });
    if (topIds.length) {
      const names = topIds.map((id) => (this.findPlayer(id) || { name: '?' }).name).join(', ');
      this.pushLog(`🎁 A ${t.label} tile dropped, reserved for ${names} (open to anyone after ${ZONE_TILE_RESERVATION_MS / 1000}s)!`);
    }
  }

  scheduleMonsterSpawn() {
    clearTimeout(this.monsterSpawnTimer);
    this.monsterSpawnTimer = setTimeout(() => {
      this.monsterSpawnTimer = null;
      if (this.status === 'playing') this.spawnMonster();
    }, MONSTER_RESPAWN_DELAY_MS);
  }

  setPlayerInput(player, dx, dy) {
    const mag = Math.hypot(dx, dy);
    if (!Number.isFinite(mag) || mag === 0) {
      player.dir = { x: 0, y: 0 };
      return;
    }
    const scale = mag > 1 ? 1 / mag : 1;
    player.dir = { x: dx * scale, y: dy * scale };
  }

  // Pre-game shop: delta is +1/-1 per click. Rejects anything that would
  // go negative or blow the room's shared point budget, leaving the
  // player's loadout untouched on failure.
  adjustLoadout(player, type, delta) {
    const def = FIRECRACKER_TYPES[type];
    if (!def || !Number.isInteger(delta) || delta === 0) return { ok: false, error: 'invalid-request' };
    if (!player.loadout) player.loadout = emptyLoadout();
    // delta is in shop CLICKS (+1/-1 per button press); each click buys or
    // sells a whole pack (purchaseUnit firecrackers), e.g. one click of
    // Pháo tép is +1000, not +1.
    const change = delta * (def.purchaseUnit || 1);
    const newCount = player.loadout[type] + change;
    if (newCount < 0) return { ok: false, error: 'invalid-count' };
    const newLoadout = { ...player.loadout, [type]: newCount };
    if (totalLoadoutCost(newLoadout) > this.loadoutBudget) return { ok: false, error: 'budget-exceeded' };
    player.loadout = newLoadout;
    return { ok: true, loadout: newLoadout };
  }

  // Cosmetic pre-game pick, not exclusive -- more than one player can pick
  // the same character (see CHARACTERS above).
  selectCharacter(player, character) {
    if (!CHARACTERS[character]) return { ok: false, error: 'invalid-character' };
    player.character = character;
    return { ok: true, character };
  }

  dropLoot(centerX, centerY, count) {
    // LOOT_DROP_RADIUS (500) is tuned for a full, large table (maps scale
    // up to 1400px). Smaller tables (as few as 1-2 players) play on maps
    // as small as 520px, where a flat 500px offset from the monster would
    // push almost every drop straight into a clamped map edge/corner
    // regardless of the random angle -- landing them all on top of each
    // other instead of spread around the arena, which reads as "nothing
    // dropped" even though it technically did. Scale the radius down to a
    // fraction of the smaller map dimension so it always lands well
    // inside the arena; the clamp() below is just the final safety net
    // for a monster that's already near an actual edge.
    const effectiveRadius = Math.min(LOOT_DROP_RADIUS, Math.min(this.mapWidth, this.mapHeight) * 0.4);
    for (let i = 0; i < count; i++) {
      const t = pickLootType();
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.max(60, effectiveRadius + (Math.random() - 0.5) * (effectiveRadius * 0.2));
      const x = clamp(centerX + Math.cos(angle) * dist, 10, this.mapWidth - 10);
      const y = clamp(centerY + Math.sin(angle) * dist, 10, this.mapHeight - 10);
      this.lootCounter += 1;
      this.loot.push({ id: `loot_${this.lootCounter}`, type: t.type, label: t.label, emoji: t.emoji, image: t.image || null, value: t.value, x, y });
    }
  }

  // Skill "Sư Tử Hống" (Lion's Roar): stuns everyone currently within
  // LION_ROAR_RADIUS, then — once that stun window closes, see tick() —
  // bolts off along a fixed escape route (map center, then a freshly
  // picked zone) at double speed, arriving there hidden in a whole new
  // spot. The stun lands immediately and can't be undone; the route
  // itself is only picked once the roar window actually closes (tick()
  // needs the monster's position AT THAT TIME as the starting point).
  triggerLionRoar(m) {
    const now = Date.now();
    this.players.forEach((p) => {
      if (p.connected && distance(p, m) <= LION_ROAR_RADIUS) {
        p.stunnedUntil = Math.max(p.stunnedUntil || 0, now + LION_ROAR_STUN_MS);
      }
    });
    m.roaring = true;
    m.roarEndsAt = now + LION_ROAR_STUN_MS;
    m.fleeWaypoints = null;
    // The roar supersedes whatever ordinary flee scareMonster() just armed
    // above -- it stands still and roars first, not flee immediately.
    m.fleeUntil = 0;
    this.pushLog(`🦁 The Niên Thú unleashes "Sư Tử Hống"! Everyone within ${LION_ROAR_RADIUS}px is stunned for ${LION_ROAR_STUN_MS / 1000}s!`);
  }

  // playerId identifies who threw the firecracker that landed this hit —
  // used for the first-hit bonus and the decile-tier reward ranking.
  scareMonster(explosionX, explosionY, fearAmount, playerId) {
    const m = this.monster;
    if (!m) return;
    const isFirstHit = !this.firstHitAwarded;
    // The very first successful hit of the match only grazes it for a
    // token amount, no matter which firecracker type actually landed —
    // see FIRST_HIT_HP_OVERRIDE above. fearAmount/m.fear are raw HP now,
    // so this needs no scaling.
    const appliedFearAmount = isFirstHit ? FIRST_HIT_HP_OVERRIDE : fearAmount;
    const oldFear = m.fear;
    m.fear = Math.min(MONSTER_MAX_HP, m.fear + appliedFearAmount);
    const appliedFear = m.fear - oldFear;

    // A hit always reveals it (or keeps it revealed) and resets the
    // "given up searching" clock — see tick()'s MONSTER_HIDE_AFTER_MS check.
    m.visible = true;
    m.lastHitAt = Date.now();

    if (playerId && appliedFear > 0) {
      m.contributions[playerId] = (m.contributions[playerId] || 0) + appliedFear;
    }

    if (isFirstHit) {
      this.firstHitAwarded = true;
      const scorer = this.findPlayer(playerId);
      if (scorer) {
        scorer.score += FIRST_HIT_BONUS;
        this.pushLog(`🥇 ${scorer.name} was the first to land a hit on the Niên Thú! +${FIRST_HIT_BONUS} pts! (a graze — just ${FIRST_HIT_HP_OVERRIDE} HP — but it's revealed now)`);
      }
    }

    const dx = m.x - explosionX;
    const dy = m.y - explosionY;
    const dist = Math.hypot(dx, dy) || 1;
    m.fleeDir = { x: dx / dist, y: dy / dist };
    m.fleeUntil = Date.now() + MONSTER_FLEE_MS;
    m.fleeSpeedMultiplier = 1; // a fresh ordinary flee always resets any leftover roar speed boost
    m.fleeWaypoints = null; // a fresh hit interrupts any in-progress post-roar bolt journey
    const hpRemaining = MONSTER_MAX_HP - m.fear;
    this.pushLog(`😱 The Niên Thú's HP dropped to ${Math.round(hpRemaining).toLocaleString()} / ${MONSTER_MAX_HP.toLocaleString()}!`);

    // Skill "Sư Tử Hống": every LION_ROAR_HP_STEP of HP dropped, roar --
    // fires at most once per hit even if this single hit crossed several
    // steps at once (the escape doesn't need to repeat). Overrides the
    // ordinary flee started just above: see triggerLionRoar() and tick().
    const oldRoarStep = Math.floor(oldFear / LION_ROAR_HP_STEP);
    const newRoarStep = Math.floor(m.fear / LION_ROAR_HP_STEP);
    if (newRoarStep > oldRoarStep) {
      this.triggerLionRoar(m);
    }

    // Every whole LOOT_MILESTONE_HP (1,000 = 1% of the pool) crossed —
    // not just every hit, in case a future retune makes a single throw
    // cross more than one at once — drops loot scaled to however many
    // players/bots are currently standing within MONSTER_LOOT_RADIUS of
    // it. Nearby count is read once per crossed milestone since it can't
    // change within this same synchronous hit.
    const oldMilestone = Math.floor(oldFear / LOOT_MILESTONE_HP);
    const newMilestone = Math.floor(m.fear / LOOT_MILESTONE_HP);
    for (let ms = oldMilestone + 1; ms <= newMilestone; ms++) {
      if (m.milestonesHit.includes(ms)) continue;
      m.milestonesHit.push(ms);
      const nearby = this.players.filter((p) => p.connected && distance(p, m) <= MONSTER_LOOT_RADIUS).length;
      this.dropLoot(m.x, m.y, nearby * LOOT_DROP_RATE_PER_NEARBY);
    }

    // Every 10% of the pool pays out the ranked "who's scaring it the most
    // right now" rewards AND drops a reserved zone tile per top-3 rank
    // (see dropReservedZoneTiles()), then resets contributions for the
    // next 10% segment. A single big hit can cross more than one decile
    // at once — each crossed decile gets its own payout using the same
    // contributions snapshot, then it's reset once. this.lastDecileRanking
    // keeps the most recent ranking around so the fled-window drop loop
    // (see tick()) has a "top 3" to reserve against once the Niên Thú is
    // gone and no fresh damage/ranking can happen for ~60s.
    const decileCrossed = DECILE_MILESTONES.filter((ms) => m.fear >= ms && !m.decileHit.includes(ms));
    decileCrossed.forEach((ms) => {
      m.decileHit.push(ms);
      const ranked = this.rankContributions(m);
      this.distributeScareRewards(ranked, ms);
      this.dropReservedZoneTiles(ranked.map((r) => r.playerId), m.zone, m.x, m.y);
      this.lastDecileRanking = ranked.map((r) => r.playerId);
    });
    if (decileCrossed.length) m.contributions = {};

    if (m.fear >= MONSTER_MAX_HP) {
      this.pushLog('🏃 The Niên Thú fled completely! It will return in 60 seconds.');
      this.lastMonsterZone = m.zone;
      this.fledUntil = Date.now() + MONSTER_RESPAWN_DELAY_MS;
      this.nextFledDropAt = Date.now() + FLED_DROP_INTERVAL_MS;
      this.monster = null;
      this.scheduleMonsterSpawn();
    } else if (decileCrossed.length) {
      // 100% already relocates via the full disappear-and-respawn path
      // above; anything below that gets an immediate hide + relocate
      // instead, keeping the chase going without the 60s wait.
      this.relocateMonster();
    }
  }

  // Starts LIGHTING a firecracker — no target yet, and nothing explodes by
  // itself. The player is rooted (see tick()'s movement loop, which skips
  // anyone with `burning` set) until timeToBurn elapses, at which point
  // resolveFirecrackers() arms it (see releaseFirecracker()). Ammo is
  // spent the moment the burn is accepted, not when it eventually
  // resolves (thrown or fizzled in-hand).
  startBurning(player, type) {
    const def = FIRECRACKER_TYPES[type];
    if (!def) return { ok: false, error: 'invalid-type' };
    if (player.burning || player.armed) return { ok: false, error: 'busy' };
    const now = Date.now();
    if (player.stunnedUntil && now < player.stunnedUntil) return { ok: false, error: 'stunned' };
    if (player.nextBurnAt && now < player.nextBurnAt) return { ok: false, error: 'cooldown' };
    if (!player.inventory || !player.inventory[type]) return { ok: false, error: 'out-of-ammo' };

    player.inventory[type] -= 1;
    player.burning = { type, burnEndsAt: now + def.timeToBurn * 1000 };
    this.pushLog(`🔥 ${player.name} is lighting a ${def.label}...`);
    return { ok: true };
  }

  // Actually throws an ARMED firecracker at a target — the payoff of the
  // burn/arm sequence above. Resolves immediately (no further delay):
  // the AoE check happens right now, against wherever the Niên Thú
  // currently is. Starts the nextBurnTime cooldown on success.
  releaseFirecracker(player, targetX, targetY) {
    if (!player.armed) return { ok: false, error: 'not-armed' };
    const { type } = player.armed;
    const def = FIRECRACKER_TYPES[type];

    const dx = targetX - player.x;
    const dy = targetY - player.y;
    const dist = Math.hypot(dx, dy);
    let tx = targetX;
    let ty = targetY;
    if (dist > FIRECRACKER_RANGE) {
      const ratio = FIRECRACKER_RANGE / dist;
      tx = player.x + dx * ratio;
      ty = player.y + dy * ratio;
    }
    tx = clamp(tx, 0, this.mapWidth);
    ty = clamp(ty, 0, this.mapHeight);

    player.armed = null;
    player.nextBurnAt = Date.now() + def.nextBurnTime * 1000;
    this.pushLog(`💥 ${player.name} threw a ${def.label}!`);

    let hitMonster = false;
    if (this.monster) {
      const d = Math.hypot(this.monster.x - tx, this.monster.y - ty);
      if (d <= def.radius + MONSTER_RADIUS) {
        hitMonster = true;
        this.scareMonster(tx, ty, def.fear, player.id);
      }
    }

    return { ok: true, explosion: { x: tx, y: ty, radius: def.radius, hitMonster, type } };
  }

  // Advances every player's firecracker state by whatever just happened
  // this tick: (1) a burn that just finished ARMS the firecracker —
  // lit and ready, sitting in the thrower's hand, who is free to move
  // again immediately while deciding where to throw; (2) an armed
  // firecracker whose throw window just ran out without being released
  // goes off in the thrower's own hands instead — no damage to the Niên
  // Thú, just the flat SELF_DETONATE_STUN_MS stun (and it still starts
  // the normal nextBurnTime cooldown). Returns { selfDetonations } for
  // the caller to broadcast as a 'nien:selfdetonate' event.
  resolveFirecrackers(now) {
    const selfDetonations = [];
    this.players.forEach((p) => {
      if (p.burning && now >= p.burning.burnEndsAt) {
        const def = FIRECRACKER_TYPES[p.burning.type];
        p.armed = { type: p.burning.type, readyUntil: now + def.timeBeforeExplosion * 1000 };
        p.burning = null;
        this.pushLog(`✨ ${p.name}'s ${def.label} is lit and ready to throw!`);
      } else if (p.armed && now >= p.armed.readyUntil) {
        const def = FIRECRACKER_TYPES[p.armed.type];
        p.armed = null;
        p.stunnedUntil = now + SELF_DETONATE_STUN_MS;
        p.nextBurnAt = now + def.nextBurnTime * 1000;
        this.pushLog(`💥 ${p.name} held the ${def.label} too long — it went off in their hands! Stunned!`);
        selfDetonations.push({ playerId: p.id, x: p.x, y: p.y, type: def.key });
      }
    });
    return { selfDetonations };
  }

  // Simple heuristic bot AI, run once per tick before the normal movement
  // step: chase the monster if one's alive, otherwise beeline for the
  // nearest loot on the ground, otherwise wander gently. This is
  // deliberately simpler than the GDD's eventual A* pathfinding — there
  // are no obstacles in this arena for pathfinding to route around, so a
  // straight-line target is equivalent. Bots throw firecrackers at the
  // monster whenever it's in range and off cooldown, exactly like a human
  // would via a click. Returns any explosions produced (for broadcasting).
  // Returns any explosions bots produced this tick by releasing an armed
  // firecracker (for the caller to broadcast as 'nien:boom', same as a
  // human's release).
  // Bots deliberately do NOT cheat by reading the Niên Thú's true
  // position while it's hidden — same as a human, all they know is which
  // zone it last appeared/relocated in. They head for that zone's center
  // and, once close enough, start blindly tossing firecrackers around
  // themselves to sweep the area. Once someone reveals it (or a bot's own
  // sweep does), everyone — bots included — can see and aim at it exactly.
  updateBotAI() {
    const now = Date.now();
    const explosions = [];
    this.players.forEach((p) => {
      if (!p.isBot || !p.connected) return;
      if (p.burning) return; // mid-light and rooted — nothing to decide
      if (p.stunnedUntil && now < p.stunnedUntil) return; // stunned, can't act or move

      // Patrol a roaming point inside the announced zone instead of
      // camping its exact center — picks a fresh random spot once the
      // bot arrives near its current one (or doesn't have one yet), so
      // repeated blind sweeps actually cover different parts of the
      // zone over time rather than only ever reaching where a single
      // fixed-radius sweep from dead-center happens to land.
      let searchPoint = null;
      if (this.monster && !this.monster.visible) {
        if (!p.searchTarget || distance(p, p.searchTarget) < 40) {
          p.searchTarget = randomPositionInZone(this.mapWidth, this.mapHeight, this.monster.zone, MONSTER_RADIUS);
        }
        searchPoint = p.searchTarget;
      }

      let target = null;
      let targetIsLoot = false;
      if (this.monster) {
        target = this.monster.visible ? this.monster : searchPoint;
      } else if (this.loot.length) {
        target = this.loot.reduce((closest, item) => (
          !closest || distance(p, item) < distance(p, closest) ? item : closest
        ), null);
        targetIsLoot = true;
      }

      if (target && targetIsLoot && distance(p, target) <= PICKUP_RADIUS) {
        // Close enough to grab it -- stand still so the stationary pickup
        // hold (see tick()) can actually complete, instead of endlessly
        // re-aiming a tiny step closer every tick.
        this.setPlayerInput(p, 0, 0);
      } else if (target) {
        this.setPlayerInput(p, target.x - p.x, target.y - p.y);
      } else {
        if (!p.botWanderDir || Math.random() < 0.03) {
          const angle = Math.random() * Math.PI * 2;
          p.botWanderDir = { x: Math.cos(angle), y: Math.sin(angle) };
        }
        this.setPlayerInput(p, p.botWanderDir.x, p.botWanderDir.y);
      }

      // Within throwing range of either the real (visible) monster, or
      // its last-known zone (hidden) — close enough to actually search it.
      const inRangeOfMonster = this.monster && (
        this.monster.visible
          ? distance(p, this.monster) <= FIRECRACKER_RANGE + MONSTER_RADIUS
          : distance(p, searchPoint) <= FIRECRACKER_RANGE * 1.5
      );

      if (p.armed) {
        // Holding a lit one — bots don't hesitate, they release the
        // instant they're in position rather than risk fizzling it.
        // Visible: aim right at it. Hidden: toss blindly nearby to sweep.
        if (inRangeOfMonster) {
          let tx;
          let ty;
          if (this.monster.visible) {
            tx = this.monster.x; ty = this.monster.y;
          } else {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * FIRECRACKER_RANGE;
            tx = p.x + Math.cos(angle) * dist;
            ty = p.y + Math.sin(angle) * dist;
          }
          const result = this.releaseFirecracker(p, tx, ty);
          if (result.ok) explosions.push(result.explosion);
        }
        return;
      }

      if (this.monster && inRangeOfMonster) {
        const canBurn = !p.nextBurnAt || now >= p.nextBurnAt;
        // Prefer the strongest type still in stock — bots don't ration
        // ammo, they just use the best they have until it runs out.
        const chosenType = [...FIRECRACKER_KEYS]
          .sort((a, b) => FIRECRACKER_TYPES[b].fear - FIRECRACKER_TYPES[a].fear)
          .find((key) => p.inventory && p.inventory[key] > 0);
        if (chosenType && canBurn) {
          this.startBurning(p, chosenType);
        }
      }
    });
    return explosions;
  }

  // One tick's worth of Niên Thú movement/state, factored out of tick()
  // itself purely to keep that function's branching manageable. Handles,
  // in priority order: standing still mid-roar (then arming the post-roar
  // bolt route once the roar window closes), chasing that route waypoint
  // by waypoint, an ordinary hit-triggered flee, and finally the "gave up
  // being seen" auto-hide check.
  // While hiding (whichever way it got there), it doesn't stop dead right
  // away -- it keeps shuffling around at random for a few more seconds,
  // strictly confined to the zone it started hiding in, before finally
  // going fully still. See MONSTER_HIDDEN_WANDER_MS/armHiddenWander().
  wanderWithinZone(m, dt) {
    if (!m.wanderDir || Math.random() < 0.05) {
      const angle = Math.random() * Math.PI * 2;
      m.wanderDir = { x: Math.cos(angle), y: Math.sin(angle) };
    }
    const origin = zoneOrigin(this.mapWidth, this.mapHeight, m.zone);
    const xMin = origin.x + MONSTER_RADIUS;
    const xMax = origin.x + this.mapWidth / 2 - MONSTER_RADIUS;
    const yMin = origin.y + MONSTER_RADIUS;
    const yMax = origin.y + this.mapHeight / 2 - MONSTER_RADIUS;
    m.x = clamp(m.x + m.wanderDir.x * MONSTER_HIDDEN_WANDER_SPEED * dt, xMin, xMax);
    m.y = clamp(m.y + m.wanderDir.y * MONSTER_HIDDEN_WANDER_SPEED * dt, yMin, yMax);
  }

  // Once the roar's stun window closes, arms the fixed escape route --
  // straight through the middle of the map, then on into a freshly-picked
  // (different) zone to hide in, not just a random direction away from
  // wherever it was hit.
  armPostRoarBolt(m) {
    m.roaring = false;
    m.fleeSpeedMultiplier = LION_ROAR_FLEE_SPEED_MULTIPLIER;
    const newZone = pickZone(this);
    const dest = randomPositionInZone(this.mapWidth, this.mapHeight, newZone, MONSTER_RADIUS);
    m.fleeWaypoints = [
      { x: this.mapWidth / 2, y: this.mapHeight / 2 },
      { x: dest.x, y: dest.y, zone: newZone },
    ];
    this.pushLog('🐆 The Niên Thú bolts through the center of the map at double speed!');
  }

  // Chases the post-roar escape route one waypoint at a time (called only
  // while m.fleeWaypoints is non-empty).
  chaseFleeWaypoint(m, dt) {
    const speed = MONSTER_FLEE_SPEED * (m.fleeSpeedMultiplier || 1);
    const step = speed * dt;
    const target = m.fleeWaypoints[0];
    const dx = target.x - m.x;
    const dy = target.y - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist > step) {
      m.x = clamp(m.x + (dx / dist) * step, MONSTER_RADIUS, this.mapWidth - MONSTER_RADIUS);
      m.y = clamp(m.y + (dy / dist) * step, MONSTER_RADIUS, this.mapHeight - MONSTER_RADIUS);
      return;
    }
    m.x = target.x;
    m.y = target.y;
    m.fleeWaypoints.shift();
    if (target.zone) {
      // Arrived at the final waypoint -- settle into hiding there, same
      // end state relocateMonster() reaches via teleport.
      m.zone = target.zone;
      this.armHiddenWander(m);
      m.fleeSpeedMultiplier = 1;
      this.pushLog(`👻 The Niên Thú slips into hiding in the ${ZONE_LABELS[target.zone]} zone.`);
    }
  }

  advanceMonster(now, dt) {
    const m = this.monster;
    if (m.roaring) {
      // Standing completely still mid-roar -- the stun already landed the
      // instant triggerLionRoar() fired; this is just the window players
      // have to watch it happen before it bolts.
      if (now >= m.roarEndsAt) this.armPostRoarBolt(m);
    } else if (m.fleeWaypoints?.length) {
      this.chaseFleeWaypoint(m, dt);
    } else if (m.fleeUntil && now < m.fleeUntil) {
      // It only ever moves while actively fleeing a fresh hit (or the
      // post-roar bolt above). Otherwise — whether hidden or just sitting
      // there revealed waiting to be found again — it stays completely
      // put at its current spot in the zone until something scares it (a
      // firecracker hit) or relocateMonster() teleports it (a 10% HP dip).
      const speed = MONSTER_FLEE_SPEED * (m.fleeSpeedMultiplier || 1);
      m.x = clamp(m.x + m.fleeDir.x * speed * dt, MONSTER_RADIUS, this.mapWidth - MONSTER_RADIUS);
      m.y = clamp(m.y + m.fleeDir.y * speed * dt, MONSTER_RADIUS, this.mapHeight - MONSTER_RADIUS);
    } else if (!m.visible && m.hiddenWanderUntil && now < m.hiddenWanderUntil) {
      this.wanderWithinZone(m, dt);
    }
    // Nobody's landed a hit in a while — it gives up being seen and slips
    // back into hiding right where it currently is (no teleport; that
    // only happens via relocateMonster() on a 10% dip, or by actually
    // arriving somewhere new via the roar's bolt above).
    const midBolt = m.roaring || m.fleeWaypoints?.length;
    if (!midBolt && m.visible && now - m.lastHitAt >= MONSTER_HIDE_AFTER_MS) {
      this.armHiddenWander(m);
      this.pushLog(`👻 The Niên Thú slipped back into hiding in the ${ZONE_LABELS[m.zone]} zone...`);
    }
  }

  // Advances the world by one tick's worth of time. Deliberately takes no
  // arguments and does no broadcasting — kept pure so tests can call it
  // directly without real timers or a live Socket.IO server. Returns any
  // explosions bots threw this tick, so the caller can broadcast 'nien:boom'
  // for them the same way a human's throw does.
  tick() {
    if (this.status !== 'playing') return { explosions: [], selfDetonations: [] };
    const dt = TICK_MS / 1000;
    const now = Date.now();

    const explosions = this.updateBotAI();

    this.players.forEach((p) => {
      if (!p.connected || !p.dir) return;
      if (p.burning) return; // rooted while lighting a firecracker
      if (p.stunnedUntil && now < p.stunnedUntil) return; // rooted after fizzling one in their hands
      p.x = clamp(p.x + p.dir.x * PLAYER_SPEED * dt, PLAYER_RADIUS, this.mapWidth - PLAYER_RADIUS);
      p.y = clamp(p.y + p.dir.y * PLAYER_SPEED * dt, PLAYER_RADIUS, this.mapHeight - PLAYER_RADIUS);
    });

    if (this.monster) this.advanceMonster(now, dt);

    // Fled window: the Niên Thú just got fully scared away (100% HP) and
    // won't be back for MONSTER_RESPAWN_DELAY_MS -- nobody can deal fresh
    // damage in the meantime, but loot still needs to keep flowing per the
    // design brief, at double volume. Classic items drop on a timer here
    // (no monster position to scale "nearby" by, so everyone connected
    // counts instead); zone tiles keep reserving to whichever top-3
    // ranking was current the moment it fled, since no fresher one can
    // ever be computed while it's gone.
    if (this.fledUntil && now < this.fledUntil) {
      if (now >= this.nextFledDropAt) {
        this.nextFledDropAt = now + FLED_DROP_INTERVAL_MS;
        const centerX = this.mapWidth / 2;
        const centerY = this.mapHeight / 2;
        const connectedCount = this.players.filter((p) => p.connected).length;
        this.dropLoot(centerX, centerY, connectedCount * LOOT_DROP_RATE_PER_NEARBY * FLED_VOLUME_MULTIPLIER);
        if (this.lastDecileRanking.length) {
          this.dropReservedZoneTiles(this.lastDecileRanking, this.lastMonsterZone || 'topLeft', centerX, centerY, FLED_VOLUME_MULTIPLIER);
        }
      }
    } else {
      this.nextFledDropAt = 0;
    }

    const { selfDetonations } = this.resolveFirecrackers(now);

    // Collecting an item takes standing still (no movement input) inside
    // PICKUP_RADIUS of it for PICKUP_HOLD_MS -- walking through it, or
    // switching which item is nearest, resets the hold rather than
    // grabbing it on the fly. Each player tracks their own progress
    // toward their own current item independently. A reserved zone tile
    // (item.reservedFor set, see dropReservedZoneTiles()) is invisible to
    // this "nearby" search for anyone else until reservedUntil passes --
    // they just can't start (or continue) a hold on it at all until then.
    this.players.forEach((p) => {
      if (!p.connected) { p.pickupProgress = null; return; }
      const stationary = Boolean(p.dir) && p.dir.x === 0 && p.dir.y === 0;
      const nearby = stationary ? this.loot.find((item) => distance(p, item) <= PICKUP_RADIUS
        && (!item.reservedFor || item.reservedFor === p.id || now >= item.reservedUntil)) : null;
      if (!nearby) {
        p.pickupProgress = null;
      } else if (!p.pickupProgress || p.pickupProgress.itemId !== nearby.id) {
        p.pickupProgress = { itemId: nearby.id, startedAt: now };
      }
    });
    this.loot = this.loot.filter((item) => {
      const collector = this.players.find((p) => (
        p.connected && p.pickupProgress && p.pickupProgress.itemId === item.id
        && now - p.pickupProgress.startedAt >= PICKUP_HOLD_MS
      ));
      if (collector) {
        collector.score += item.value;
        collector.pickupProgress = null;
        this.pushLog(`${collector.name} collected a ${item.label} (+${item.value})!`);
        if (item.type.startsWith('zone_')) {
          const zoneKey = item.type.slice('zone_'.length);
          if (!collector.zoneTileCounts) collector.zoneTileCounts = { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 };
          const before = Math.min(...ZONE_KEYS.map((z) => collector.zoneTileCounts[z] || 0));
          collector.zoneTileCounts[zoneKey] = (collector.zoneTileCounts[zoneKey] || 0) + 1;
          const after = Math.min(...ZONE_KEYS.map((z) => collector.zoneTileCounts[z] || 0));
          if (after > before) {
            collector.score += ZONE_TILE_FULL_SET_BONUS;
            this.pushLog(`🎉 ${collector.name} completed a full "Trung Thu Vui Vẻ" set! +${ZONE_TILE_FULL_SET_BONUS} pts!`);
          }
        }
        return false;
      }
      return true;
    });

    if (this.startedAt && now - this.startedAt >= MAX_GAME_DURATION_MS) {
      this.finishGame("⏰ Time's up!");
    }
    return { explosions, selfDetonations };
  }

  finishGame(reason) {
    this.status = 'finished';
    clearTimeout(this.monsterSpawnTimer);
    this.monsterSpawnTimer = null;
    const ranking = [...this.players].sort((a, b) => b.score - a.score);
    this.winnerId = ranking.length && ranking[0].score > 0 ? ranking[0].id : null;
    const winner = this.winnerId ? this.findPlayer(this.winnerId) : null;
    this.resultText = winner ? `${reason} ${winner.name} wins with ${winner.score} points!` : `${reason} No one scored — no winner.`;
    this.pushLog(this.resultText);
  }

  startTicking(nsp) {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      try {
        const { explosions, selfDetonations } = this.tick();
        this.broadcast(nsp);
        (explosions || []).forEach((ev) => this.broadcastEvent(nsp, 'nien:boom', ev));
        (selfDetonations || []).forEach((ev) => this.broadcastEvent(nsp, 'nien:selfdetonate', ev));
      } catch (err) {
        console.error(`[nien] tick failed in room ${this.id}:`, err);
      }
      if (this.status !== 'playing' && this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
    }, TICK_MS);
  }

  state(forPlayerId) {
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
      loadoutBudget: this.loadoutBudget,
      firecrackerTypes: FIRECRACKER_TYPES,
      characters: CHARACTERS,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        score: p.score,
        connected: p.connected,
        isBot: Boolean(p.isBot),
        character: p.character || null,
        loadout: p.loadout || emptyLoadout(),
        inventory: p.inventory || null,
        burning: p.burning ? { type: p.burning.type, burnEndsAt: p.burning.burnEndsAt } : null,
        armed: p.armed ? { type: p.armed.type, readyUntil: p.armed.readyUntil } : null,
        stunnedUntil: p.stunnedUntil || 0,
        nextBurnAt: p.nextBurnAt || 0,
        // When they're mid-hold picking up an item: the timestamp the
        // hold finishes at, so the client can draw a progress indicator.
        pickupHoldUntil: p.pickupProgress ? p.pickupProgress.startedAt + PICKUP_HOLD_MS : null,
        zoneTileCounts: p.zoneTileCounts || { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 },
      })),
      // x/y are only sent while visible — while hidden, the client (and
      // an honest bot) only gets to know the zone, same as the log
      // notification told everyone when it last appeared/relocated there.
      monster: this.monster ? {
        fear: this.monster.fear,
        maxHp: MONSTER_MAX_HP,
        hp: Math.round(MONSTER_MAX_HP - this.monster.fear),
        zone: this.monster.zone,
        visible: this.monster.visible,
        roaring: this.monster.roaring,
        x: this.monster.visible ? this.monster.x : null,
        y: this.monster.visible ? this.monster.y : null,
      } : null,
      loot: this.loot.map((l) => ({
        id: l.id, type: l.type, label: l.label, emoji: l.emoji, image: l.image || null, value: l.value, x: l.x, y: l.y,
        reservedFor: l.reservedFor || null, reservedUntil: l.reservedFor ? l.reservedUntil : null,
      })),
      lootDropped: this.lootCounter,
      log: this.log,
      winnerId: this.winnerId,
      resultText: this.resultText,
      yourId: forPlayerId || null,
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('nien:state', this.state(p.id));
    });
  }

  broadcastEvent(nsp, event, payload) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit(event, payload);
    });
  }
}

function attachNien(io) {
  const nsp = io.of('/nien');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].map((r) => r.summary());
  }
  function broadcastRoomList() {
    nsp.emit('nien:rooms', roomList());
  }
  function deleteRoomIfEmpty(room) {
    if (room && room.isEmpty()) {
      clearInterval(room.tickTimer);
      clearTimeout(room.monsterSpawnTimer);
      rooms.delete(room.id);
    }
  }

  nsp.on('connection', (socket) => {
    socket.emit('nien:rooms', roomList());

    socket.on('nien:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('nien:createRoom', ({ roomName, password, playerId, name, loadoutBudget }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const room = new NienRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, loadoutBudget);
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, x: 0, y: 0, dir: { x: 0, y: 0 }, score: 0, burning: null, armed: null, stunnedUntil: 0, nextBurnAt: 0, loadout: emptyLoadout(), character: null, pickupProgress: null, zoneTileCounts: { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 } });
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('nien:joinRoom', ({ roomId, password, playerId, name }, callback) => {
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
        room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, x: 0, y: 0, dir: { x: 0, y: 0 }, score: 0, burning: null, armed: null, stunnedUntil: 0, nextBurnAt: 0, loadout: emptyLoadout(), character: null, pickupProgress: null, zoneTileCounts: { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 } });
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

    socket.on('nien:addBots', ({ count }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const n = Math.max(1, Math.min(3, Number(count) || 3));
      if (room.players.length + n > MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'table-full' }); return; }
      for (let i = 0; i < n; i++) {
        const botName = BOT_NAMES[room.botCounter % BOT_NAMES.length];
        room.botCounter += 1;
        room.players.push({
          id: `bot_${room.id}_${room.botCounter}`, name: botName, connected: true, socketId: null, isBot: true,
          x: 0, y: 0, dir: { x: 0, y: 0 }, score: 0, burning: null, armed: null, stunnedUntil: 0, nextBurnAt: 0, loadout: emptyLoadout(),
          character: CHARACTER_KEYS[room.botCounter % CHARACTER_KEYS.length],
          pickupProgress: null,
          zoneTileCounts: { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 },
        });
        room.pushLog(`${botName} joined the table.`);
      }
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('nien:buyFirecracker', ({ type, delta }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.adjustLoadout(player, type, Number(delta));
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('nien:selectCharacter', ({ character }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.selectCharacter(player, character);
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('nien:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length < 1) { if (typeof callback === 'function') callback({ ok: false, error: 'not-enough-players' }); return; }
      room.startGame();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.startTicking(nsp);
    });

    socket.on('nien:input', ({ dx, dy }) => {
      const room = myRoom();
      if (!room || room.status !== 'playing') return;
      const player = room.findPlayer(socket.playerId);
      if (!player) return;
      room.setPlayerInput(player, Number(dx) || 0, Number(dy) || 0);
    });

    socket.on('nien:startBurn', ({ type }, callback) => {
      const room = myRoom();
      if (!room || room.status !== 'playing') { if (typeof callback === 'function') callback({ ok: false, error: 'not-playing' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.startBurning(player, type);
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('nien:release', ({ x, y }, callback) => {
      const room = myRoom();
      if (!room || room.status !== 'playing') { if (typeof callback === 'function') callback({ ok: false, error: 'not-playing' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.releaseFirecracker(player, Number(x) || 0, Number(y) || 0);
      if (typeof callback === 'function') callback(result.ok ? { ok: true } : result);
      if (result.ok) {
        room.broadcast(nsp);
        room.broadcastEvent(nsp, 'nien:boom', result.explosion);
      }
    });

    socket.on('nien:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'finished') { if (typeof callback === 'function') callback({ ok: false, error: 'not-finished' }); return; }
      room.status = 'waiting';
      room.winnerId = null;
      room.resultText = null;
      room.monster = null;
      room.loot = [];
      room.log = [];
      room.pushLog('Ready for another chase — click Start when everyone is in.');
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
          player.dir = { x: 0, y: 0 };
          room.pushLog(`${player.name} disconnected.`);
        }
        room.broadcast(nsp);
      }
      deleteRoomIfEmpty(room);
      broadcastRoomList();
      socket.roomId = null;
    }

    socket.on('nien:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
}

module.exports = attachNien;
// Exposed purely for automated testing of the game-logic pieces without
// needing a live socket server.
module.exports.NienRoom = NienRoom;
module.exports.computeMapSize = computeMapSize;
module.exports.MONSTER_MAX_HP = MONSTER_MAX_HP;
module.exports.MONSTER_LOOT_RADIUS = MONSTER_LOOT_RADIUS;
module.exports.LOOT_DROP_RATE_PER_NEARBY = LOOT_DROP_RATE_PER_NEARBY;
module.exports.LOOT_MILESTONE_HP = LOOT_MILESTONE_HP;
module.exports.FIRECRACKER_RANGE = FIRECRACKER_RANGE;
module.exports.FIRECRACKER_TYPES = FIRECRACKER_TYPES;
module.exports.CHARACTERS = CHARACTERS;
module.exports.CHARACTER_KEYS = CHARACTER_KEYS;
module.exports.DEFAULT_CHARACTER = DEFAULT_CHARACTER;
module.exports.FIRECRACKER_KEYS = FIRECRACKER_KEYS;
module.exports.SELF_DETONATE_STUN_MS = SELF_DETONATE_STUN_MS;
module.exports.DEFAULT_LOADOUT_BUDGET = DEFAULT_LOADOUT_BUDGET;
module.exports.LOADOUT_BUDGET_OPTIONS = LOADOUT_BUDGET_OPTIONS;
module.exports.totalLoadoutCost = totalLoadoutCost;
module.exports.autoFillLoadout = autoFillLoadout;
module.exports.PLAYER_SPEED = PLAYER_SPEED;
module.exports.PICKUP_RADIUS = PICKUP_RADIUS;
module.exports.TICK_MS = TICK_MS;
module.exports.ZONE_LOOT_TYPES = ZONE_LOOT_TYPES;
module.exports.CLASSIC_LOOT_TYPES = CLASSIC_LOOT_TYPES;
module.exports.pickLootType = pickLootType;
module.exports.LOOT_DROP_RADIUS = LOOT_DROP_RADIUS;
module.exports.PICKUP_HOLD_MS = PICKUP_HOLD_MS;
module.exports.ZONE_KEYS = ZONE_KEYS;
module.exports.ZONE_LABELS = ZONE_LABELS;
module.exports.DECILE_MILESTONES = DECILE_MILESTONES;
module.exports.SCARE_REWARD_TIERS = SCARE_REWARD_TIERS;
module.exports.SCARE_REWARD_ANY = SCARE_REWARD_ANY;
module.exports.FIRST_HIT_BONUS = FIRST_HIT_BONUS;
module.exports.FIRST_HIT_HP_OVERRIDE = FIRST_HIT_HP_OVERRIDE;
module.exports.MONSTER_HIDE_AFTER_MS = MONSTER_HIDE_AFTER_MS;
module.exports.LION_ROAR_HP_STEP = LION_ROAR_HP_STEP;
module.exports.LION_ROAR_RADIUS = LION_ROAR_RADIUS;
module.exports.LION_ROAR_STUN_MS = LION_ROAR_STUN_MS;
module.exports.LION_ROAR_FLEE_SPEED_MULTIPLIER = LION_ROAR_FLEE_SPEED_MULTIPLIER;
module.exports.MONSTER_FLEE_SPEED = MONSTER_FLEE_SPEED;
module.exports.MONSTER_HIDDEN_WANDER_MS = MONSTER_HIDDEN_WANDER_MS;
module.exports.MONSTER_HIDDEN_WANDER_SPEED = MONSTER_HIDDEN_WANDER_SPEED;
module.exports.MONSTER_RADIUS = MONSTER_RADIUS;
module.exports.pickZone = pickZone;
module.exports.zoneOrigin = zoneOrigin;
module.exports.zoneCenter = zoneCenter;
module.exports.randomPositionInZone = randomPositionInZone;
module.exports.MONSTER_MAX_HP = MONSTER_MAX_HP;
module.exports.MONSTER_RESPAWN_DELAY_MS = MONSTER_RESPAWN_DELAY_MS;
module.exports.CLASSIC_LOOT_TYPES = CLASSIC_LOOT_TYPES;
module.exports.ZONE_LOOT_TYPES = ZONE_LOOT_TYPES;
module.exports.ZONE_TILE_TOP_N = ZONE_TILE_TOP_N;
module.exports.ZONE_TILE_RESERVATION_MS = ZONE_TILE_RESERVATION_MS;
module.exports.ZONE_TILE_FULL_SET_BONUS = ZONE_TILE_FULL_SET_BONUS;
module.exports.FLED_DROP_INTERVAL_MS = FLED_DROP_INTERVAL_MS;
module.exports.FLED_VOLUME_MULTIPLIER = FLED_VOLUME_MULTIPLIER;
module.exports.FIRECRACKER_TYPES = FIRECRACKER_TYPES;
