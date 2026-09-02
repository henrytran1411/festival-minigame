// Đua Tốc Độ (Speed Race) — a backup game alongside UNO, Exploding Kittens,
// Go, Đuổi Niên Thú, Ô Ăn Quan, and Battleship. Same "casual side activity"
// contract as those: its own Socket.IO namespace, no leaderboard, no admin
// open/close gating (see server.js).
//
// Mechanic: a real top-down lap race. The host picks one of 6 tracks (see
// TRACKS below), each a stylized loop inspired by a real Vietnamese
// mountain pass — not a literal survey, but a switchback climb from a base
// town up to the pass's real summit landmark, then back down the other
// side, closing into a lappable loop. Real-world length/elevation numbers
// live in each track's `blurb` for flavor; the in-game geometry is
// normalized so every track plays in roughly the same time regardless of
// the real pass's actual length.
//
// Every track is built by buildSwitchbackLoop() (below), not hand-picked
// coordinates: an ASCEND column of checkpoints strictly confined to the
// left half of the map and a DESCEND column strictly confined to the right
// half, meeting only at two shared points (the start/finish at the bottom
// and the summit at the top). That split, plus each column's checkpoints
// being in strict monotonic y order, is what guarantees the resulting road
// never crosses or runs alongside itself — there is exactly one way to
// drive from any checkpoint to the next (see the geometric proof in that
// function's own comment). MAX_PLAYERS is small now (see below), so each
// track can afford noticeably more checkpoints/road length than an earlier
// version of this game that had to also stay legible with dozens of
// racers on screen at once.
//
// Racers steer freely in 2D (WASD/arrows/on-screen joystick — same direct
// direction-vector movement as nien-server.js's arena, no momentum/turning
// physics) through the checkpoints in order; completing the loop the
// track's own `lapsToWin` times finishes the race. Unlike nien's open
// arena, movement here is confined to a walled ROAD corridor (see
// closestPointOnLoop()/the collision step in tick()) — straying off the
// centerline by more than the track's own trackWidth/2 gets pushed back to
// the corridor edge, so cutting across hairpins through the "off-road"
// terrain isn't possible. Steering direction is only half of movement —
// actual speed is a racer's own `speedKmh` (0..MAX_SPEED_KMH, see
// setGasHeld()/SPEED_BANDS), which climbs while they hold a single gas
// control and falls back down when they let go (starts at 0, so a racer
// who never touches it never moves). Items come from checkpoints instead
// of fixed map spots: whenever
// a racer reaches a checkpoint, THEY are granted one random item (⛽ max
// gas / 💫 stun / 🛡️ shield — see ITEM_TYPES) straight into their own
// inventory (see grantRandomItem()) — a guaranteed personal reward, not a
// pickup another nearby racer could grab instead. It's added to their
// inventory by type rather than applied immediately — they choose when to
// spend it via racing:useItem (see useItem()). Placeholder character art is the
// same 4 Mid-Autumn mascots borrowed from Đuổi Niên Thú (see CHARACTERS
// below) — this game's own copy of that data, not a shared reference, so
// the two rosters can diverge later.

const TICK_MS = 100; // 10 updates/sec — smooth enough for a casual arcade racer, low bandwidth.
// Kept intentionally small: with each track's road now single-width and
// non-overlapping (see buildSwitchbackLoop()) rather than the old wide,
// forgiving corridor, a crowd of dozens all threading the same narrow
// hairpins would be more chaos than fun. A small table is the point now.
const MAX_PLAYERS = 10;
const BOT_NAMES = ['An', 'Bình', 'Chi', 'Dũng', 'Giang'];

// Every spatial value in the game — map size, road width, every checkpoint/
// landmark/item coordinate, player radius, movement speed — is multiplied
// by this once, in the TRACKS post-processing pass below and at each
// constant's own definition, rather than hand-authoring 8x-bigger numbers
// everywhere. Speed scales by the same factor as distance specifically so
// race PACING is a deliberate, separate choice (see PLAYER_SPEED below),
// not an accident of this scale-up. This is also what makes a
// player-centered camera worth having: the whole map is far too large to
// show all at once (see racing.js's drawTrack() camera transform and
// drawMinimap()).
const WORLD_SCALE = 8;

// Smaller than an earlier version of this game (was 16) — a smaller racer
// reads better on the now-slimmer, single-width roads (see TRACKS' own
// trackWidth values) and makes precise driving around a hairpin feel like
// it matters.
const PLAYER_RADIUS = 10 * WORLD_SCALE;
// Baseline speed (no boost active) — same for every track. Slower than an
// earlier version of this game (was 140) on top of these longer, narrower
// tracks, so a race is a deliberate, unhurried drive rather than a dash.
const PLAYER_SPEED = 95 * WORLD_SCALE;

const COUNTDOWN_MS = 3000;
const MAX_RACE_DURATION_MS = 240000; // safety net so a room can't stall forever on a slow/afk racer

// How close a racer needs to get to their NEXT required checkpoint (in
// order) to count it as reached. Only used for the client-facing progress
// smoothing now (see progressFraction()) -- the ACTUAL capture radius used
// in tick() is CHECKPOINT_EDGE_MARGIN below, derived per-track from that
// track's own corridor width instead of this one fixed value, so a racer
// who stays on the road (anywhere across its full width) at a checkpoint
// always triggers it. This fixed value used to also BE the capture
// radius, but it was noticeably smaller than every track's own drivable
// corridor half-width (trackWidth/2 - a margin, see tick()'s
// corridorHalfWidth) — up to a ~200-world-unit-wide strip along the edges
// of the wider tracks where a racer visibly on the road still wouldn't
// trigger the checkpoint, forcing a confusing backtrack.
const CHECKPOINT_RADIUS = 20 * WORLD_SCALE;
// How far below the corridor edge (never AT or beyond it) the real capture
// radius stays, per-track (see tick()'s checkpointRadius). Deliberately
// kept as a MARGIN below the corridor rather than matching or exceeding it
// outright — a capture radius wider than the corridor itself let a racer
// trigger a checkpoint from well off to the side, still positioned along
// the PREVIOUS segment rather than the one actually leading to it.
// Immediately re-aiming from there at the next checkpoint could point
// almost exactly along that previous segment's outward wall normal — a
// direction with zero sideways component to slide along, which froze bots
// solid at a real dead angle (found on Đèo Mã Pí Lèng's summit, where two
// segments meet at a sharp angle) since there was nothing left to slide.
// This margin keeps that same safety property (capture always strictly
// inside the corridor) while shrinking the previously oversized gap.
const CHECKPOINT_EDGE_MARGIN = 4 * WORLD_SCALE;

// Gas control (see setGasHeld()): a single button/key, not an up/down pair
// — held down, speed (tracked directly in km/h, see `speedKmh` below)
// climbs; released, it falls back toward 0, same "let off the pedal and it
// coasts down" feel as a real car, no separate brake control. Race starts
// at 0 km/h (see newPlayer()/startRace()) — unlike the old gas-dial design,
// a racer who never touches the control never moves.
//
// The rate of change isn't flat — it depends on the CURRENT speed band, so
// climbing from a stop feels different than climbing at speed. Each band's
// rate is specified per 200ms of continuous holding (or releasing), then
// converted to per-second in speedRateKmhPerSec() since tick() runs at
// TICK_MS regardless of that 200ms figure. The same table is used for
// deceleration (releasing) as for acceleration (holding) — there's no
// separate "how fast it coasts down" spec, so it falls at the same rate
// for whichever band it's currently in.
const MAX_SPEED_KMH = 400;
const SPEED_BANDS = [
  { upTo: 60, kmhPer200ms: 4 },
  { upTo: 150, kmhPer200ms: 3 },
  { upTo: 250, kmhPer200ms: 5 },
  { upTo: 400, kmhPer200ms: 8 }, // continues the original 2,3,5,8 progression -- no rate was specified for this top band, so it keeps the same "each band climbs faster" shape as the rest
];
function speedRateKmhPerSec(speedKmh) {
  const band = SPEED_BANDS.find((b) => speedKmh <= b.upTo) || SPEED_BANDS[SPEED_BANDS.length - 1];
  return band.kmhPer200ms * (1000 / 200);
}

// Movement inertia: a racer's actual heading (`moveDir`, see tick()) chases
// the raw steering input (`dir`, unchanged by this — still set directly by
// setPlayerInput()) instead of snapping to it every tick. How fast it
// chases depends on CURRENT speed: near-instant at a standstill, much
// slower at top speed, so redirecting into a different heading gets
// noticeably harder the faster a racer is already going. Blended nlerp-
// style (a straight linear blend of the two unit vectors, not a true
// angular slerp) since that's simple and cheap; a side effect at high
// inertia + a sharp turn is the blended vector's length dipping below 1
// mid-turn (it's a chord of the arc between two unit vectors) — this reads
// as a natural scrub/slowdown through a hard direction change rather than
// an artifact to fix.
//
// Eased by speed SQUARED (not linear) rather than a flat taper: most WASD
// driving is small, gradual adjustments (following the road's own curve,
// or a diagonal-key combo swap), which converge close enough to feel
// "instant" even at a fairly sluggish lerp value, so a flat taper made the
// effect nearly invisible in normal play — only a full reversal made it
// obvious. Squaring keeps low/mid speed snappy (matching a real car that
// still steers fine well under its top speed) while making the falloff
// sharply, unmistakably heavier specifically in the upper end of the speed
// range, where it's supposed to matter most.
const TURN_LERP_AT_MIN_SPEED = 1; // effectively instant at a standstill
const TURN_LERP_AT_MAX_SPEED = 0.05; // noticeably heavy at top speed
function turnLerpFactor(speedKmh) {
  const t = clamp(speedKmh / MAX_SPEED_KMH, 0, 1);
  const eased = t * t;
  return TURN_LERP_AT_MIN_SPEED + (TURN_LERP_AT_MAX_SPEED - TURN_LERP_AT_MIN_SPEED) * eased;
}

// Barrier-hit damage: scales with how fast a racer was going at the moment
// of impact (see DAMAGE_BANDS) rather than a flat penalty — clipping the
// guardrail at speed is far more punishing than grazing it at a crawl.
// Cooled down (BARRIER_HIT_COOLDOWN_MS) so grinding along a wall for
// several consecutive ticks in a row counts as one hit, not a fresh one
// every TICK_MS. Reaching 100% disables the car for REPAIR_DURATION_MS
// (completely frozen, same as a 💫 stun — see tick()'s early-out), after
// which damage clears and the car restarts from a dead stop (0 km/h), same
// as the very start of the race.
const DAMAGE_BANDS = [
  { upTo: 60, damagePercent: 10 },
  { upTo: 150, damagePercent: 20 },
  { upTo: 250, damagePercent: 45 },
  { upTo: 400, damagePercent: 70 },
];
function damagePercentForSpeed(speedKmh) {
  const band = DAMAGE_BANDS.find((b) => speedKmh <= b.upTo) || DAMAGE_BANDS[DAMAGE_BANDS.length - 1];
  return band.damagePercent;
}
const BARRIER_HIT_COOLDOWN_MS = 700;
const REPAIR_DURATION_MS = 5000;

// 🕳️ Potholes: static road hazards, scattered at random points directly on
// the road (see RacingRoom.buildPotholes()) fresh each race — unlike
// items, they're never picked up or removed; anyone who drives over one
// takes damage (see POTHOLE_DAMAGE_BANDS, deliberately lighter than a
// barrier hit — this is a bump in the road, not slamming into a
// guardrail) AND loses a flat 20% of whatever speed they had at the
// moment of impact. Cooled down per-racer (POTHOLE_HIT_COOLDOWN_MS), same
// idea as the barrier's own hit cooldown, so straddling one for several
// consecutive ticks only counts as one hit.
const POTHOLE_COUNT = 8;
const POTHOLE_RADIUS = 16 * WORLD_SCALE;
const POTHOLE_HIT_COOLDOWN_MS = 1000;
const POTHOLE_SPEED_MULTIPLIER = 0.8; // -20%
const POTHOLE_DAMAGE_BANDS = [
  { upTo: 60, damagePercent: 5 },
  { upTo: 150, damagePercent: 10 },
  { upTo: 250, damagePercent: 15 },
  { upTo: 400, damagePercent: 20 },
];
function potholeDamagePercentForSpeed(speedKmh) {
  const band = POTHOLE_DAMAGE_BANDS.find((b) => speedKmh <= b.upTo) || POTHOLE_DAMAGE_BANDS[POTHOLE_DAMAGE_BANDS.length - 1];
  return band.damagePercent;
}

// 🛡️ Shield: unlike the other two items, this is a timed status (see
// `shieldUntil` on the player) rather than an instant one-shot effect —
// using it immediately repairs all current damage back to 0%, THEN makes
// the racer fully immune to any further damage (barrier hits, potholes)
// and to being targeted by a 💫 stun for this long. Replaces the old
// "blocks exactly the next stun" charge system with a flat time window,
// consistent with how ⛽ Max Gas and 💫 Stun are already timed effects
// rather than counters.
const SHIELD_PROTECTION_DURATION_MS = 5000;

// Checkpoint-triggered items (replaces the old fixed-spot speed-boost
// items): whenever a racer reaches a checkpoint, they're granted one random
// item straight into their own inventory (see grantRandomItem()) — NOT a
// pickup-able object placed on the map. An earlier version dropped a shared
// item at the checkpoint for whoever was nearest to grab, but with racers
// often bunched up at the same hairpin, `this.players.find()` could hand a
// spot's item to a DIFFERENT racer than the one who actually reached the
// checkpoint — denying them their own item. Direct granting guarantees
// every checkpoint crossing gives THAT racer one item, and never blocks a
// later racer's own crossing of the same checkpoint.
const ITEM_TYPES = ['maxGas', 'stun', 'shield'];
// Emoji + label per type, used for server log lines below.
const ITEM_DEFS = {
  maxGas: { emoji: '⛽', label: 'Max Gas' },
  stun: { emoji: '💫', label: 'Stun' },
  shield: { emoji: '🛡️', label: 'Shield' },
};
const ITEM_LABELS = Object.fromEntries(ITEM_TYPES.map((t) => [t, `${ITEM_DEFS[t].emoji} ${ITEM_DEFS[t].label}`]));

// ⛽ Max Gas: instantly jumps speed to MAX_GAS_ITEM_PEAK_KMH — ABOVE the
// normal MAX_SPEED_KMH ceiling, a real speed boost rather than just
// "floor it" — then decays back down at a flat rate (regardless of
// whether the gas control is held) for MAX_GAS_ITEM_DURATION_MS, landing
// EXACTLY on MAX_SPEED_KMH the moment it expires: the peak/duration/decay
// rate are chosen so peak - decayRate*duration = MAX_SPEED_KMH exactly
// (500 - 10*10 = 400), so control smoothly hands back to the normal gas
// bands at precisely the speed they'd expect, no sudden drop.
const MAX_GAS_ITEM_DURATION_MS = 10000;
const MAX_GAS_ITEM_PEAK_KMH = 500;
const MAX_GAS_DECAY_KMH_PER_SEC = 10;
// 💫 Stun: picks a random racer from the CURRENT top STUN_TOP_N in the room
// (ranking — see rankedPlayers()) and freezes them (no movement at all,
// see tick()'s early-out) for this long — unless a 🛡️ shield blocks it.
const STUN_DURATION_MS = 5000;
const STUN_TOP_N = 5;

// x for row `i` (1..rows) of one column, tracing a named curve `pattern`.
// The ONLY thing that actually matters for buildSwitchbackLoop()'s
// non-crossing guarantee (see its own comment below) is that every value
// stays within [min(xNear,xFar), max(xNear,xFar)] — it never needs to
// reach past that column's boundary with the gap. The SHAPE traced inside
// that boundary is completely free, which is what lets each track have a
// visually and mechanically distinct road character (tight hairpins vs.
// smooth sweeping curves vs. a widening "fan") while every one of them is
// still built by the exact same, exactly-as-safe generator.
function columnX(pattern, i, rows, xNear, xFar, cycles) {
  const t = rows > 0 ? i / (rows + 1) : 0; // 0..1 progress up the column
  const mid = (xNear + xFar) / 2;
  const amp = Math.abs(xNear - xFar) / 2; // always positive regardless of which of xNear/xFar is numerically larger
  if (pattern === 'wave') {
    // Smooth sine sweep — reads as flowing, sweeping curves rather than
    // sharp hairpin corners. Fewer `cycles` over the same row count means
    // wider, more graceful curves; more cycles means tighter, more
    // frequent direction changes.
    return mid + amp * Math.sin(t * Math.PI * 2 * cycles);
  }
  if (pattern === 'fan') {
    // A zigzag whose amplitude grows from near-zero at the bottom to full
    // swing at the top — starts as gentle wiggling, "fans out" into wide
    // dramatic switchbacks higher up.
    const growingAmp = amp * t;
    return i % 2 === 1 ? mid - growingAmp : mid + growingAmp;
  }
  // 'zigzag' (default): sharp alternating hairpins at fixed full amplitude.
  return i % 2 === 1 ? xNear : xFar;
}

// One column's worth of checkpoints (strictly monotonic in y — see
// buildSwitchbackLoop()'s own comment for why that's what actually matters
// for safety, not the x pattern traced).
function buildColumn({ rows, xNear, xFar, yFrom, yTo, pattern = 'zigzag', cycles = 2.5 }) {
  const points = [];
  const yStep = (yTo - yFrom) / (rows + 1);
  for (let i = 1; i <= rows; i++) {
    points.push({ x: columnX(pattern, i, rows, xNear, xFar, cycles), y: yFrom + yStep * i });
  }
  return points;
}

// Builds one closed-loop track as two switchback "columns" of checkpoints
// meeting at a shared start/finish (bottom) and summit (top):
//
//        summit (center, y=padding)
//       /                          \
//   ascend column                descend column
//  (x <= centerX - gap/2)      (x >= centerX + gap/2)
//       \                          /
//        start/finish (center, y=mapHeight-padding)
//
// Why this can never cross itself: every ascend-side checkpoint (including
// the two shared ones) has x <= centerX, and every descend-side checkpoint
// has x >= centerX — the two halves only ever meet at the exact line
// x === centerX, and only AT the two shared vertices, where adjacent
// segments are expected to touch. Within one column, checkpoints are in
// strict monotonic y order (ascending column: y strictly decreasing;
// descending column: y strictly increasing), so any two segments in that
// column occupy disjoint (non-adjacent) or merely touching (adjacent) y
// ranges regardless of their x pattern (zigzag, wave, or fan — see
// columnX() above) — two segments can only cross if both their x ranges
// AND y ranges overlap, so neither of those failure modes is possible
// here. That combination (disjoint x halves + monotonic y per half) holds
// for any row counts, map size, or per-column curve pattern, which is what
// makes this a generator rather than hand-tuned, individually-verified
// coordinates.
function buildSwitchbackLoop({
  mapWidth, mapHeight, ascendRows, descendRows, padding = 110, gapWidth = 140,
  ascendPattern = 'zigzag', descendPattern = 'zigzag', ascendCycles = 2.5, descendCycles = 2.5,
}) {
  const centerX = mapWidth / 2;
  const ascendXFar = padding; // outer edge of the ascend column
  const ascendXNear = centerX - gapWidth / 2; // inner edge, closest to the gap
  const descendXNear = centerX + gapWidth / 2;
  const descendXFar = mapWidth - padding;
  const yBottom = mapHeight - padding;
  const yTop = padding;

  const checkpoints = [{ x: centerX, y: yBottom }]; // 0: start/finish

  checkpoints.push(...buildColumn({
    rows: ascendRows, xNear: ascendXNear, xFar: ascendXFar, yFrom: yBottom, yTo: yTop,
    pattern: ascendPattern, cycles: ascendCycles,
  }));

  const summitIndex = checkpoints.length;
  checkpoints.push({ x: centerX, y: yTop }); // summit

  checkpoints.push(...buildColumn({
    rows: descendRows, xNear: descendXNear, xFar: descendXFar, yFrom: yTop, yTo: yBottom,
    pattern: descendPattern, cycles: descendCycles,
  }));

  return { checkpoints, summitIndex };
}

// The 6 selectable tracks, one per real Vietnamese mountain pass. Each is a
// closed loop: checkpoint 0 is the start/finish (a base town at the foot of
// the pass), the checkpoints climb to the pass's real summit landmark, then
// descend back down to checkpoint 0 — walked in order 0,1,2,...,N-1,0,...
// `lapsToWin` varies per track (more laps for the short/easy pass, fewer
// for the longer ones) so every track's total race length lands in a
// similar ballpark despite the real passes' very different lengths.
// `bgFrom`/`bgTo` are the client's canvas background gradient (see
// racing.js's drawTrack()) — a loose color nod to each pass's real
// landscape, not a literal one.
// Each track's own `landmarkSpecs` references checkpoint INDICES rather
// than coordinates, since buildSwitchbackLoop() (not a hand-placed list)
// decides the actual positions below. Index layout is always: 0 =
// start/finish, 1..ascendRows = the ascend column, ascendRows+1 = the
// summit, ascendRows+2..end = the descend column.
const TRACKS = {
  haiVan: {
    label: 'Đèo Hải Vân',
    blurb: '21km · 496m · Đà Nẵng ↔ Huế — coastal hairpins, sea on one side',
    mapWidth: 1800,
    mapHeight: 2700,
    trackWidth: 90,
    lapsToWin: 1, // one lap is already a long, elaborate drive at this size
    ascendRows: 10,
    descendRows: 10, // total checkpoints: 1 + 10 + 1 + 10 = 22
    // Flowing, sweeping curves rather than sharp corners -- reads as a
    // road hugging a winding coastline, not a series of switchbacks.
    ascendPattern: 'wave',
    descendPattern: 'wave',
    ascendCycles: 2,
    descendCycles: 2,
    bgFrom: '#16321f',
    bgTo: '#0d2b3d',
    decorationEmojis: ['🌴', '🌲', '🪨', '🌊', '⛵'],
    farDecorationEmojis: ['🏔️', '☁️'],
    landmarkSpecs: [
      { label: 'Đà Nẵng', icon: '🏙️', atIndex: 0, offsetY: 60 },
      { label: 'Hải Vân Quan', icon: '⛩️', atIndex: 11, offsetY: -50 }, // summit (ascendRows+1)
      { label: 'Lăng Cô', icon: '🌊', atIndex: 16, offsetX: 50 },
    ],
  },

  maPhuc: {
    label: 'Đèo Mã Phục',
    blurb: '3.5km · 620m · Cao Bằng — short, 7 hairpins, twin "kneeling horse" peaks',
    mapWidth: 1400,
    mapHeight: 1800,
    trackWidth: 70,
    lapsToWin: 2, // still the shortest, easiest real pass -- extra lap to match the others' total length
    ascendRows: 5,
    descendRows: 5, // total checkpoints: 1 + 5 + 1 + 5 = 12
    padding: 90,
    gapWidth: 120,
    bgFrom: '#2f3a1f',
    bgTo: '#4a3b1f',
    decorationEmojis: ['🪨', '🌲', '🐴', '🌸'],
    farDecorationEmojis: ['⛰️', '🌤️'],
    landmarkSpecs: [
      { label: 'Trà Lĩnh', icon: '🏘️', atIndex: 0, offsetY: 50 },
      { label: 'Cổng Trời Mã Phục', icon: '⛰️', atIndex: 6, offsetY: -40 }, // summit
      { label: 'Trùng Khánh', icon: '🏞️', atIndex: 9, offsetX: 40 },
    ],
  },

  khauPha: {
    label: 'Đèo Khau Phạ',
    blurb: '35km · 1,300m · Mù Cang Chải — terraced rice fields, sea of clouds',
    mapWidth: 1800,
    mapHeight: 3000,
    trackWidth: 90,
    lapsToWin: 1,
    ascendRows: 11,
    descendRows: 11, // total checkpoints: 1 + 11 + 1 + 11 = 24
    // Widening switchbacks -- gentle wiggling near the rice-terrace base,
    // fanning out into wide dramatic turns higher up toward the clouds.
    ascendPattern: 'fan',
    descendPattern: 'fan',
    bgFrom: '#1f3a24',
    bgTo: '#4a545c',
    decorationEmojis: ['🌾', '☁️', '🌲', '🌱', '🐃'],
    farDecorationEmojis: ['🏔️', '🌤️'],
    landmarkSpecs: [
      { label: 'Tú Lệ', icon: '🌾', atIndex: 0, offsetY: 60 },
      { label: 'Khau Phạ - Biển Mây', icon: '☁️', atIndex: 12, offsetY: -50 }, // summit
      { label: 'Mù Cang Chải', icon: '🌄', atIndex: 18, offsetX: 50 },
    ],
  },

  phaDin: {
    label: 'Đèo Pha Đin',
    blurb: '32km · 1,648m · Sơn La ↔ Điện Biên — historic, long sweeping S-curves',
    mapWidth: 2000,
    mapHeight: 3000,
    trackWidth: 100,
    lapsToWin: 1,
    ascendRows: 7,
    descendRows: 7, // total checkpoints: 1 + 7 + 1 + 7 = 16
    // Fewer, WIDER sweeps than any other track -- matches the real pass's
    // description as long, graceful S-curves rather than tight hairpins.
    ascendPattern: 'wave',
    descendPattern: 'wave',
    ascendCycles: 1.3,
    descendCycles: 1.3,
    gapWidth: 160,
    bgFrom: '#2a2410',
    bgTo: '#4a3a12',
    decorationEmojis: ['🌲', '🪨', '🍃', '🦋'],
    farDecorationEmojis: ['⛰️', '🌥️'],
    landmarkSpecs: [
      { label: 'Tuần Giáo', icon: '🏘️', atIndex: 0, offsetY: 60 },
      { label: 'Đỉnh Pha Đin (1.648m)', icon: '🚩', atIndex: 8, offsetY: -50 }, // summit
      { label: 'Điện Biên', icon: '🎖️', atIndex: 12, offsetX: 50 },
    ],
  },

  maPiLeng: {
    label: 'Đèo Mã Pí Lèng',
    blurb: '20km · 1,200m · Hà Giang — "king of passes", cliffside above the Nho Quế canyon',
    mapWidth: 1800,
    mapHeight: 3200,
    trackWidth: 65, // narrowest -- a treacherous cliff-edge road
    lapsToWin: 1,
    // Asymmetric on purpose: a long winding climb (the canyon wall), packed
    // with the tightest, most frequent hairpins of any track, then a
    // shorter, more direct return leg — distinct from every other track's
    // roughly symmetric up-and-down shape. Still built by the very same
    // generator; buildSwitchbackLoop()'s non-crossing guarantee never
    // assumed the two columns needed equal row counts or the same pattern.
    ascendRows: 12,
    descendRows: 5, // total checkpoints: 1 + 12 + 1 + 5 = 19
    ascendPattern: 'zigzag',
    descendPattern: 'zigzag',
    gapWidth: 110,
    bgFrom: '#3a1f1f',
    bgTo: '#1f2a3a',
    decorationEmojis: ['🪨', '🏞️', '🦅', '🍂'],
    farDecorationEmojis: ['⛰️', '🌫️'],
    landmarkSpecs: [
      { label: 'Mèo Vạc', icon: '🏘️', atIndex: 0, offsetY: 60 },
      { label: 'Hẻm Nho Quế', icon: '🏞️', atIndex: 7, offsetX: -45 }, // mid-climb canyon viewpoint
      { label: 'Đồng Văn', icon: '🗿', atIndex: 13, offsetY: -50 }, // summit
    ],
  },

  oQuyHo: {
    label: 'Đèo Ô Quy Hồ',
    blurb: '50km · 2,000m · Sa Pa ↔ Tam Đường — "King of mountain passes", near Fansipan, often foggy',
    mapWidth: 2000,
    mapHeight: 3400, // the longest, highest real pass -- the biggest map, and the most hairpins of any track
    trackWidth: 70, // narrow, high-altitude road
    lapsToWin: 1,
    ascendRows: 13,
    descendRows: 6, // total checkpoints: 1 + 13 + 1 + 6 = 21
    ascendPattern: 'zigzag',
    descendPattern: 'zigzag',
    bgFrom: '#1f2a3a',
    bgTo: '#5a6b7a', // foggy blue-grey
    decorationEmojis: ['☁️', '🌲', '🪨', '❄️'],
    farDecorationEmojis: ['🏔️', '🌫️'],
    landmarkSpecs: [
      { label: 'Sa Pa', icon: '🏔️', atIndex: 0, offsetY: 60 },
      { label: 'Cổng Trời (2.000m)', icon: '🌫️', atIndex: 14, offsetY: -50 }, // summit
      { label: 'Tam Đường', icon: '🏘️', atIndex: 18, offsetX: 50 },
    ],
  },
};

// Scatters purely-decorative scenery (no gameplay effect), offset clear of
// the road-edge barrier (trackWidth/2 + a margin). A switchback track's
// segments loop back close to each other (that's the whole point of a
// hairpin), so an offset computed from just ONE segment's local normal can
// still land close to a totally different nearby segment — checked and
// nudged away from the closest point on the WHOLE loop, not just its own
// segment, and dropped entirely (rather than clamped into the road) if it
// still can't find a clear spot within the map. Needs closestPointOnLoop(),
// defined further down — fine since this only ever runs from the TRACKS
// post-processing loop below, well after module load finishes.
//
// Two layers: a NEAR one (track's own `decorationEmojis`) at every segment,
// close enough to the road to read as roadside scenery, and a sparser FAR
// one (`farDecorationEmojis`, falling back to the near list if a track
// doesn't define its own) placed noticeably further out — every 3rd
// segment, on the opposite side from that same segment's near piece so
// both sides of the road get some over the length of the track. The
// client uses the `layer` tag to render far-layer pieces a bit hazier,
// for a sense of depth rather than everything sitting at one flat distance.
function scatterDecorations(track) {
  const nearEmojis = track.decorationEmojis || ['🌲'];
  const farEmojis = track.farDecorationEmojis || nearEmojis;
  const pts = track.checkpoints;
  const n = pts.length;
  const half = track.trackWidth / 2;
  const nearClearance = half + 40 * WORLD_SCALE;
  const farClearance = half + 110 * WORLD_SCALE;
  const minClearance = half + 12 * WORLD_SCALE; // accepted fallback -- just needs to clear the barrier, not the full margin

  // Places one decoration `clearance` world units out from segment
  // midpoint (mx,my) along normal (nx,ny) * side, nudging away from
  // whatever's actually nearest on the WHOLE loop (see this function's
  // own comment above) and clamping to the map bounds. Returns null
  // (skip this one) if even after clamping it still can't clear
  // minClearance -- happens on compact/tightly-packed tracks where the
  // full desired margin never fits.
  function place(mx, my, nx, ny, side, clearance) {
    let x = mx + nx * clearance * side;
    let y = my + ny * clearance * side;
    for (let iter = 0; iter < 8; iter++) {
      const { point, dist } = closestPointOnLoop({ x, y }, pts);
      if (dist >= clearance) break;
      const pushX = x - point.x;
      const pushY = y - point.y;
      const pushLen = Math.hypot(pushX, pushY) || 1;
      x = point.x + (pushX / pushLen) * (clearance + 5 * WORLD_SCALE);
      y = point.y + (pushY / pushLen) * (clearance + 5 * WORLD_SCALE);
    }
    x = clamp(x, 20 * WORLD_SCALE, track.mapWidth - 20 * WORLD_SCALE);
    y = clamp(y, 20 * WORLD_SCALE, track.mapHeight - 20 * WORLD_SCALE);
    if (closestPointOnLoop({ x, y }, pts).dist < minClearance) return null;
    return { x, y };
  }

  const decorations = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const side = i % 2 === 0 ? 1 : -1;

    const near = place(mx, my, nx, ny, side, nearClearance);
    if (near) decorations.push({ x: near.x, y: near.y, emoji: nearEmojis[i % nearEmojis.length], layer: 'near' });

    if (i % 3 === 0) {
      const far = place(mx, my, nx, ny, -side, farClearance);
      if (far) decorations.push({ x: far.x, y: far.y, emoji: farEmojis[Math.floor(i / 3) % farEmojis.length], layer: 'far' });
    }
  }
  return decorations;
}

Object.keys(TRACKS).forEach((key) => {
  const t = TRACKS[key];
  t.key = key;

  // Generate the actual checkpoint geometry (see buildSwitchbackLoop()'s
  // own comment for why the result can never cross itself), in natural
  // (pre-WORLD_SCALE) units.
  const { checkpoints, summitIndex } = buildSwitchbackLoop({
    mapWidth: t.mapWidth, mapHeight: t.mapHeight,
    ascendRows: t.ascendRows, descendRows: t.descendRows,
    padding: t.padding, gapWidth: t.gapWidth,
    ascendPattern: t.ascendPattern, descendPattern: t.descendPattern,
    ascendCycles: t.ascendCycles, descendCycles: t.descendCycles,
  });
  t.checkpoints = checkpoints;
  t.summitIndex = summitIndex;

  // Resolve each named landmark to a concrete point near its checkpoint
  // (still in natural units, before the scaling pass below).
  t.landmarks = (t.landmarkSpecs || []).map((l) => ({
    label: l.label,
    icon: l.icon,
    x: t.checkpoints[l.atIndex].x + (l.offsetX || 0),
    y: t.checkpoints[l.atIndex].y + (l.offsetY || 0),
  }));

  // Scale every spatial value up by WORLD_SCALE (see its own definition
  // above) now that the natural-unit geometry above is finalized — map
  // size, road width, and every checkpoint/landmark coordinate.
  t.mapWidth *= WORLD_SCALE;
  t.mapHeight *= WORLD_SCALE;
  t.trackWidth *= WORLD_SCALE;
  t.checkpoints = t.checkpoints.map((c) => ({ x: c.x * WORLD_SCALE, y: c.y * WORLD_SCALE }));
  t.landmarks = t.landmarks.map((l) => ({ ...l, x: l.x * WORLD_SCALE, y: l.y * WORLD_SCALE }));

  t.numCheckpoints = t.checkpoints.length;
  t.totalCheckpointsToFinish = t.lapsToWin * t.numCheckpoints;
  t.decorations = scatterDecorations(t);
});
const TRACK_KEYS = Object.keys(TRACKS);
const DEFAULT_TRACK_KEY = TRACK_KEYS[0];

// Playable characters, picked pre-race (see racing:selectCharacter). Not
// exclusive — more than one player can pick the same one. Same 4
// Mid-Autumn mascots as Đuổi Niên Thú's own CHARACTERS in nien-server.js,
// but with this game's OWN art under public/games/racing/characters/ (not
// a reference to nienmonster's copy) — this game's own roster, so the two
// can diverge later without touching each other. `emoji` stays the
// fallback if an image ever fails to load (see racing.js's
// character-picker/track rendering).
const CHARACTERS = {
  chiHang: { key: 'chiHang', label: 'Chị Hằng', emoji: '🌕', image: 'racing/characters/chị hằng.png' },
  chuCuoi: { key: 'chuCuoi', label: 'Chú Cuội', emoji: '🌳', image: 'racing/characters/chú cuội.png' },
  ongDia: { key: 'ongDia', label: 'Ông Địa', emoji: '👴', image: 'racing/characters/ông địa.png' },
  thoNgoc: { key: 'thoNgoc', label: 'Thỏ Ngọc', emoji: '🐇', image: 'racing/characters/thỏ ngọc.png' },
};
const CHARACTER_KEYS = Object.keys(CHARACTERS);

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Closest point to `p` on the segment a->b, and how far away it is — the
// building block for the road-edge barrier below. Standard projection-onto-
// segment math: clamp the projection parameter t to [0,1] so the result
// never falls outside the segment itself.
function closestPointOnSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq : 0;
  t = clamp(t, 0, 1);
  return { x: a.x + abx * t, y: a.y + aby * t };
}

// Closest point to `p` on the CLOSED loop of checkpoints (i.e. the track's
// centerline, wrapping from the last checkpoint back to the first) and the
// distance to it. The region within `trackWidth/2` of this loop is exactly
// the drivable road — a stroked polyline with round joins/caps, same shape
// racing.js draws it as — so "distance to the loop > trackWidth/2" is
// precisely "off the road" (see the barrier step in tick()).
function closestPointOnLoop(p, checkpoints) {
  let best = null;
  let bestDist = Infinity;
  const n = checkpoints.length;
  for (let i = 0; i < n; i++) {
    const candidate = closestPointOnSegment(p, checkpoints[i], checkpoints[(i + 1) % n]);
    const d = distance(p, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return { point: best, dist: bestDist };
}

// Index of the checkpoint a racer must reach NEXT, given how many they've
// already passed since the race started (see startRace()'s player reset)
// and the current track's checkpoint count. checkpointsPassed=0 -> target
// checkpoint 1 (0 is the start/finish line they begin standing on);
// reaching the last checkpoint -> target wraps to 0, completing a lap.
// Repeats identically for every subsequent lap.
function nextCheckpointIndex(checkpointsPassed, numCheckpoints) {
  return (checkpointsPassed + 1) % numCheckpoints;
}

class RacingRoom {
  constructor(id, name, password, trackKey) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.trackKey = TRACKS[trackKey] ? trackKey : DEFAULT_TRACK_KEY;
    this.status = 'waiting'; // 'waiting' | 'countdown' | 'racing' | 'finished'
    // { id, name, connected, socketId, isBot, character, x, y, dir,
    //   moveDir, checkpointsPassed, finishedAt, finishRank, speedKmh,
    //   gasHeld, maxGasUntil, stunnedUntil, shieldUntil, damage,
    //   repairingUntil, lastBarrierHitAt, lastPotholeHitAt,
    //   inventory: { maxGas, stun, shield } }
    this.players = [];
    this.potholes = []; // see buildPotholes() -- populated fresh in startRace()
    this.botCounter = 0;
    this.finishCounter = 0;
    this.raceStartsAt = null; // countdown target timestamp
    this.raceStartedAt = null; // when 'racing' actually began (countdown over)
    this.winnerId = null;
    this.resultText = null;
    this.log = [];
    this.tickTimer = null;
    this.countdownTimer = null;
  }

  get track() {
    return TRACKS[this.trackKey];
  }

  // Host-less lobby (same as every other action here — no player has
  // special authority), so any player may change the pick, same as
  // selectCharacter(). Only meaningful pre-race, so callers gate this on
  // status === 'waiting'.
  setTrack(trackKey) {
    if (!TRACKS[trackKey]) return { ok: false, error: 'invalid-track' };
    this.trackKey = trackKey;
    return { ok: true, trackKey };
  }

  // Scatters POTHOLE_COUNT hazards at random points directly on THIS
  // track's own road (a random segment + a random fraction along it, same
  // {from,frac}-on-the-centerline trick the old fixed item spawns used to
  // use, just randomized instead of hand-placed) — called fresh at the
  // start of every race (see startRace()) rather than once per track, so
  // the exact spots differ race to race. frac is kept away from the very
  // ends of each segment (0.15..0.85) purely so a pothole never lands
  // essentially on top of a checkpoint's own marker.
  buildPotholes() {
    const track = this.track;
    const n = track.checkpoints.length;
    const potholes = [];
    for (let i = 0; i < POTHOLE_COUNT; i++) {
      const from = Math.floor(Math.random() * n);
      const a = track.checkpoints[from];
      const b = track.checkpoints[(from + 1) % n];
      const frac = 0.15 + Math.random() * 0.7;
      potholes.push({ id: `pothole_${i}`, x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac });
    }
    return potholes;
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
      trackKey: this.trackKey,
      trackLabel: this.track.label,
    };
  }

  startRace() {
    const track = this.track;
    const start = track.checkpoints[0];
    this.players.forEach((p) => {
      // Small random spread around the start/finish line so a full room
      // doesn't start as one exact stack of overlapping racers.
      p.x = clamp(start.x + (Math.random() - 0.5) * 90 * WORLD_SCALE, PLAYER_RADIUS, track.mapWidth - PLAYER_RADIUS);
      p.y = clamp(start.y + (Math.random() - 0.5) * 90 * WORLD_SCALE, PLAYER_RADIUS, track.mapHeight - PLAYER_RADIUS);
      p.dir = { x: 0, y: 0 };
      p.moveDir = { x: 0, y: 0 };
      p.checkpointsPassed = 0;
      p.finishedAt = null;
      p.finishRank = null;
      // Starts stationary -- speed only climbs once the racer holds the
      // gas control themselves (see setGasHeld()/tick()).
      p.speedKmh = 0;
      p.gasHeld = false;
      p.maxGasUntil = 0;
      p.stunnedUntil = 0;
      p.shieldUntil = 0;
      p.damage = 0;
      p.repairingUntil = 0;
      p.lastBarrierHitAt = 0;
      p.lastPotholeHitAt = 0;
      p.inventory = { maxGas: 0, stun: 0, shield: 0 };
      // Anyone who never picked a character (forgot, or joined after the
      // picker existed) gets a random one so the track never has to
      // render an unset racer.
      if (!p.character || !CHARACTERS[p.character]) {
        p.character = CHARACTER_KEYS[Math.floor(Math.random() * CHARACTER_KEYS.length)];
      }
    });
    this.potholes = this.buildPotholes();
    this.finishCounter = 0;
    this.winnerId = null;
    this.resultText = null;
    this.log = [];
    this.status = 'countdown';
    this.raceStartsAt = Date.now() + COUNTDOWN_MS;
    this.raceStartedAt = null;
    this.pushLog(`🏁 On your marks for ${track.label}... ${track.lapsToWin} laps to win!`);
    clearTimeout(this.countdownTimer);
    this.countdownTimer = setTimeout(() => {
      this.countdownTimer = null;
      if (this.status !== 'countdown') return; // room emptied out / reset mid-countdown
      this.status = 'racing';
      this.raceStartedAt = Date.now();
      this.pushLog('🏁 GO!');
    }, COUNTDOWN_MS);
  }

  // Steering input — a normalized (or zero) direction vector, same
  // "direct velocity direction, no momentum" model as nien-server.js's
  // setPlayerInput(). Changing direction is instant; only actual movement
  // speed (baseline vs. boosted) varies (see tick()).
  setPlayerInput(player, dx, dy) {
    const mag = Math.hypot(dx, dy);
    if (!Number.isFinite(mag) || mag === 0) {
      player.dir = { x: 0, y: 0 };
      return;
    }
    const scale = mag > 1 ? 1 / mag : 1;
    player.dir = { x: dx * scale, y: dy * scale };
  }

  // Gas control — a single held/released boolean (one button, no separate
  // brake), applied gradually over time in tick() via SPEED_BANDS rather
  // than snapping speed directly, so it reads like a real pedal rather
  // than an instant on/off switch.
  setGasHeld(player, held) {
    player.gasHeld = Boolean(held);
  }

  // Cosmetic pre-race pick, not exclusive (see CHARACTERS above).
  selectCharacter(player, character) {
    if (!CHARACTERS[character]) return { ok: false, error: 'invalid-character' };
    player.character = character;
    return { ok: true, character };
  }

  // Live ranking (finished racers first, ordered by finish rank; then
  // unfinished racers ordered by how far around the loop they've gotten) —
  // same ordering the client's Standings list shows. Needed live (not just
  // at race end like finishRace()'s own ranking) so a 💫 stun can target
  // "the current top N" mid-race.
  rankedPlayers() {
    return [...this.players].sort((a, b) => {
      if (a.finishedAt && b.finishedAt) return a.finishRank - b.finishRank;
      if (a.finishedAt) return -1;
      if (b.finishedAt) return 1;
      return this.progressFraction(b) - this.progressFraction(a);
    });
  }

  // Eligible 💫 stun targets: the current top STUN_TOP_N, minus whoever's
  // using the item (stunning yourself would be pointless) and anyone
  // disconnected or already finished (nothing left to slow down for them).
  getStunCandidates(excludePlayerId) {
    return this.rankedPlayers()
      .slice(0, STUN_TOP_N)
      .filter((p) => p.connected && !p.finishedAt && p.id !== excludePlayerId);
  }

  // Spends one item from `player`'s own inventory (see state()'s
  // `inventory` field) — items are never applied automatically on pickup,
  // only on this explicit call (see racing:useItem below).
  useItem(player, type) {
    if (!ITEM_TYPES.includes(type)) return { ok: false, error: 'invalid-item' };
    if (!player.inventory || (player.inventory[type] || 0) <= 0) return { ok: false, error: 'no-item' };
    const now = Date.now();

    if (type === 'maxGas') {
      player.inventory.maxGas -= 1;
      player.maxGasUntil = now + MAX_GAS_ITEM_DURATION_MS;
      player.speedKmh = MAX_GAS_ITEM_PEAK_KMH;
      this.pushLog(`⛽ ${player.name} floored it — ${MAX_GAS_ITEM_PEAK_KMH}km/h!`);
      return { ok: true };
    }

    if (type === 'shield') {
      player.inventory.shield -= 1;
      player.damage = 0; // instant full repair
      player.shieldUntil = now + SHIELD_PROTECTION_DURATION_MS;
      this.pushLog(`🛡️ ${player.name} raised a shield — fully repaired and protected for ${SHIELD_PROTECTION_DURATION_MS / 1000}s!`);
      return { ok: true };
    }

    // type === 'stun'
    const candidates = this.getStunCandidates(player.id);
    if (!candidates.length) return { ok: false, error: 'no-target' }; // not consumed -- nobody to hit yet
    player.inventory.stun -= 1;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (now < (target.shieldUntil || 0)) {
      this.pushLog(`🛡️ ${target.name}'s shield blocked a stun from ${player.name}!`);
    } else {
      target.stunnedUntil = now + STUN_DURATION_MS;
      target.dir = { x: 0, y: 0 };
      this.pushLog(`💫 ${player.name} stunned ${target.name}!`);
    }
    return { ok: true, targetId: target.id };
  }

  // Grants `player` one random item straight into their own inventory —
  // called whenever THAT player reaches a checkpoint (see tick()). See the
  // comment on ITEM_TYPES above for why this is a direct grant rather than
  // a shared pickup placed on the map.
  grantRandomItem(player) {
    const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
    player.inventory[type] = (player.inventory[type] || 0) + 1;
    this.pushLog(`🎁 ${player.name} got ${ITEM_LABELS[type]} at the checkpoint!`);
  }

  // Simple bot AI: steer straight for whichever checkpoint is next in their
  // own sequence, run once per tick before movement. Deliberately simpler
  // than any real pathfinding/racing-line logic — same "chase the useful
  // thing in a straight line" spirit as nien-server.js's bots — and makes
  // no special effort to detour for items (a bot that happens to pass one
  // still picks it up via the normal proximity check in tick()).
  //
  // A REAL player who finds themselves not moving would just try a
  // different direction — but a bot repeats the exact same aim forever, so
  // on the rare angle where that aim has (near enough) zero component
  // along the road's local wall (see tick()'s wall-slide comment) even the
  // tangential-preserving barrier physics has nothing to slide the bot
  // along, and it would otherwise sit frozen. The escape below is
  // deliberately bot-only rather than a change to the shared movement
  // physics real players also use: track how long each bot has gone
  // without meaningfully moving, and once that crosses a threshold, rotate
  // its aim off-axis (alternating direction) until it finds a heading with
  // enough tangential component to actually slide.
  updateBotAI() {
    const track = this.track;
    this.players.forEach((p) => {
      if (!p.isBot || !p.connected || p.finishedAt) return;
      // Bots have no socket to ever send racing:gasInput -- without this
      // they'd sit at 0 km/h forever under the gas-control model (which
      // starts everyone stationary and only builds speed while held).
      // Simplest bot throttle: always floor it.
      p.gasHeld = true;
      const target = track.checkpoints[nextCheckpointIndex(p.checkpointsPassed, track.numCheckpoints)];
      let dx = target.x - p.x;
      let dy = target.y - p.y;

      if (p._lastPos && distance(p, p._lastPos) < 2) {
        p._stuckTicks = (p._stuckTicks || 0) + 1;
      } else {
        p._stuckTicks = 0;
      }
      p._lastPos = { x: p.x, y: p.y };
      if (p._stuckTicks > 20) {
        const angle = (Math.floor(p._stuckTicks / 20) % 2 === 0 ? 1 : -1) * 0.6; // ~34 degrees, alternating side
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rotatedX = dx * cos - dy * sin;
        const rotatedY = dx * sin + dy * cos;
        dx = rotatedX;
        dy = rotatedY;
      }

      this.setPlayerInput(p, dx, dy);
    });
  }

  // Advances the world by one tick's worth of time. Deliberately takes no
  // arguments and does no broadcasting — kept pure so tests can call it
  // directly without real timers or a live Socket.IO server.
  tick() {
    if (this.status !== 'racing') return;
    const track = this.track;
    const dt = TICK_MS / 1000;
    const now = Date.now();

    this.updateBotAI();

    // How far off the road's centerline a racer may stray before the
    // barrier below pushes them back — half the visual road width, minus a
    // small margin so a racer's own drawn radius doesn't visually poke
    // through the guardrail (see racing.js's drawRoadEdges()).
    const corridorHalfWidth = track.trackWidth / 2 - PLAYER_RADIUS * 0.4;
    // Checkpoint capture radius, derived from THIS track's own corridor
    // (see CHECKPOINT_EDGE_MARGIN's own comment) rather than one fixed
    // value shared across all 6 — covers the road's full drivable width
    // at a checkpoint on every track, not just the narrowest one.
    const checkpointRadius = corridorHalfWidth - CHECKPOINT_EDGE_MARGIN;

    this.players.forEach((p) => {
      if (!p.connected || p.finishedAt || !p.dir) return;

      // 🔧 Repair finishing: clear it out BEFORE the freeze check right
      // below, so the very tick repair completes, the racer can move again
      // immediately rather than waiting one extra tick. Restarts from a
      // dead stop (0 km/h), same as the start of the race.
      if (p.repairingUntil && now >= p.repairingUntil) {
        p.repairingUntil = 0;
        p.damage = 0;
        p.speedKmh = 0;
        this.pushLog(`🔧 ${p.name}'s car is back on the road!`);
      }

      // 💫 Stunned, or still 🔧 repairing after a 100%-damage wreck: racer
      // is completely frozen either way — no gas ramping, no movement.
      if (now < (p.stunnedUntil || 0) || (p.repairingUntil && now < p.repairingUntil)) return;

      // Speed climbs or falls toward 0/MAX_SPEED_KMH depending on whether
      // the gas control is currently held (see setGasHeld()), at a rate
      // that depends on the CURRENT speed band (see SPEED_BANDS above) --
      // not a flat rate, so accelerating from a stop feels different than
      // accelerating at speed. A ⛽ Max Gas item (see useItem()) already
      // jumped speedKmh to MAX_GAS_ITEM_PEAK_KMH on pickup and decays it
      // back down at a flat rate here, ignoring gasHeld entirely for the
      // whole duration -- landing exactly on MAX_SPEED_KMH the instant it
      // expires (see MAX_GAS_ITEM_PEAK_KMH's own comment for why those
      // numbers line up), so normal gas control picks up right where this
      // leaves off with no sudden drop.
      if (now < (p.maxGasUntil || 0)) {
        p.speedKmh = Math.max(MAX_SPEED_KMH, p.speedKmh - MAX_GAS_DECAY_KMH_PER_SEC * dt);
      } else {
        const rate = speedRateKmhPerSec(p.speedKmh);
        p.speedKmh = clamp(p.speedKmh + rate * dt * (p.gasHeld ? 1 : -1), 0, MAX_SPEED_KMH);
      }
      // PLAYER_SPEED is exactly what speedKmh === MAX_SPEED_KMH already
      // meant, so this is a no-op at top speed and scales down from there.
      const speed = PLAYER_SPEED * (p.speedKmh / MAX_SPEED_KMH);

      // Inertia: moveDir (the heading that actually drives movement below)
      // chases the raw steering input `dir` rather than snapping to it --
      // see turnLerpFactor()'s own comment for why this gets more sluggish
      // the faster a racer is already going.
      const turnLerp = turnLerpFactor(p.speedKmh);
      p.moveDir = {
        x: p.moveDir.x + (p.dir.x - p.moveDir.x) * turnLerp,
        y: p.moveDir.y + (p.dir.y - p.moveDir.y) * turnLerp,
      };
      const dx = p.moveDir.x * speed * dt;
      const dy = p.moveDir.y * speed * dt;

      // Road-edge barrier, done as an actual wall-slide rather than a flat
      // "snap the candidate back to distance corridorHalfWidth from
      // whatever's nearest" — that flat version has a real deadlock: if a
      // racer's input happens to aim (even partly) into the wall, snapping
      // the candidate back by direction-from-nearest-point can land
      // EXACTLY back on the same spot every tick, freezing them there
      // forever (found via an actual stuck bot on Đèo Mã Pí Lèng's
      // summit — where the ascend and descend segments meet at a sharp
      // angle, aiming for the far checkpoint down the descend column
      // pointed almost exactly along the outward normal of the ascend
      // segment's wall the bot was still closest to). Fix: measured
      // relative to the nearest road point to the racer's CURRENT (pre-
      // move) position, decompose this tick's attempted movement into a
      // tangential part (along that wall) and an outward-normal part, and
      // clip ONLY however much of the outward part would push distance-
      // from-road past corridorHalfWidth — never the whole outward
      // component, and never gated on already being at the limit (a
      // single tick can cross from well inside the corridor to past its
      // edge, and that transition tick is exactly when the old code's
      // fixed point formed). The tangential part is always applied in
      // full, so a racer can always keep sliding along whichever segment
      // is nearest — including one that isn't actually the segment
      // leading to their real next checkpoint — until they round the
      // corner and a different, correct segment naturally becomes
      // nearest instead.
      const { point: nearestBefore, dist: distBefore } = closestPointOnLoop(p, track.checkpoints);
      let newX = p.x + dx;
      let newY = p.y + dy;
      if (distBefore > 0) {
        const normalX = (p.x - nearestBefore.x) / distBefore;
        const normalY = (p.y - nearestBefore.y) / distBefore;
        const outward = dx * normalX + dy * normalY;
        const allowedOutward = corridorHalfWidth - distBefore; // how much further outward this tick may still go
        if (outward > allowedOutward) {
          const clippedOutward = Math.max(allowedOutward, 0);
          newX = p.x + (dx - outward * normalX) + clippedOutward * normalX;
          newY = p.y + (dy - outward * normalY) + clippedOutward * normalY;

          // 💥 Barrier hit: damage scales with speed AT IMPACT (see
          // DAMAGE_BANDS) — cooled down so continuing to grind along the
          // same wall for several ticks in a row still counts as one hit.
          // An active 🛡️ shield absorbs it completely (no damage at all).
          if (now - (p.lastBarrierHitAt || 0) >= BARRIER_HIT_COOLDOWN_MS) {
            p.lastBarrierHitAt = now;
            if (now < (p.shieldUntil || 0)) {
              this.pushLog(`🛡️ ${p.name}'s shield absorbed a barrier hit!`);
            } else {
              const damagePercent = damagePercentForSpeed(p.speedKmh);
              p.damage = clamp((p.damage || 0) + damagePercent, 0, 100);
              this.pushLog(`💥 ${p.name} hit the barrier! (+${damagePercent}% damage, now ${Math.round(p.damage)}%)`);
              if (p.damage >= 100 && !p.repairingUntil) {
                p.repairingUntil = now + REPAIR_DURATION_MS;
                this.pushLog(`🔧 ${p.name}'s car is wrecked — repairing for ${REPAIR_DURATION_MS / 1000}s!`);
              }
            }
          }
        }
      }
      newX = clamp(newX, PLAYER_RADIUS, track.mapWidth - PLAYER_RADIUS);
      newY = clamp(newY, PLAYER_RADIUS, track.mapHeight - PLAYER_RADIUS);

      // The clip above uses a straight-line (locally-flat) approximation
      // of the wall at nearestBefore, which is exact for a straight
      // segment but not quite for rounding a curved or angled part of the
      // road — over many ticks that mismatch can accumulate into a slow
      // outward drift even though no single tick "pushed into the wall".
      // Re-checked here against a FRESH nearest point and pulled back by
      // only the excess (never further than that), this is small and
      // bounded precisely because the clip above already removed the bulk
      // of any into-the-wall movement — unlike the flat snap-to-radius
      // this replaced, it can't alone reproduce that fixed-point deadlock.
      const { point: nearestAfter, dist: distAfter } = closestPointOnLoop({ x: newX, y: newY }, track.checkpoints);
      if (distAfter > corridorHalfWidth) {
        const excess = distAfter - corridorHalfWidth;
        newX += ((nearestAfter.x - newX) / distAfter) * excess;
        newY += ((nearestAfter.y - newY) / distAfter) * excess;
      }
      p.x = newX;
      p.y = newY;

      const target = track.checkpoints[nextCheckpointIndex(p.checkpointsPassed, track.numCheckpoints)];
      if (distance(p, target) <= checkpointRadius) {
        p.checkpointsPassed += 1;
        // THIS racer, specifically, is granted one random item — a
        // guaranteed personal reward for reaching the checkpoint, not a
        // pickup another nearby racer could grab instead (see the comment
        // on ITEM_TYPES above). Doesn't touch or block anyone else's own
        // crossing of the same checkpoint, before or after.
        this.grantRandomItem(p);
        if (p.checkpointsPassed % track.numCheckpoints === 0) {
          const lap = p.checkpointsPassed / track.numCheckpoints;
          this.pushLog(`🏎️ ${p.name} completed lap ${lap}/${track.lapsToWin}!`);
        }
        if (p.checkpointsPassed >= track.totalCheckpointsToFinish) {
          p.finishedAt = now;
          this.finishCounter += 1;
          p.finishRank = this.finishCounter;
          const seconds = this.raceStartedAt ? ((now - this.raceStartedAt) / 1000).toFixed(2) : '?';
          this.pushLog(`🏁 ${p.name} finished #${p.finishRank} in ${seconds}s!`);
        }
      }

      // 🕳️ Potholes: a static hazard, not a one-time pickup (see
      // buildPotholes()) — driving over one damages the car (lighter than
      // a barrier hit, see POTHOLE_DAMAGE_BANDS) and knocks
      // POTHOLE_SPEED_MULTIPLIER off current speed, both scaled by how
      // fast the racer was going. Cooled down per-racer so straddling the
      // same one for consecutive ticks only counts once. An active 🛡️
      // shield absorbs it completely (no damage, no speed loss).
      if (now - (p.lastPotholeHitAt || 0) >= POTHOLE_HIT_COOLDOWN_MS) {
        const hitPothole = this.potholes.find((h) => distance(p, h) <= POTHOLE_RADIUS);
        if (hitPothole) {
          p.lastPotholeHitAt = now;
          if (now < (p.shieldUntil || 0)) {
            this.pushLog(`🛡️ ${p.name}'s shield absorbed a pothole!`);
          } else {
            const potholeDamage = potholeDamagePercentForSpeed(p.speedKmh);
            p.damage = clamp((p.damage || 0) + potholeDamage, 0, 100);
            p.speedKmh = clamp(p.speedKmh * POTHOLE_SPEED_MULTIPLIER, 0, MAX_SPEED_KMH);
            this.pushLog(`🕳️ ${p.name} hit a pothole! (+${potholeDamage}% damage, speed cut to ${Math.round(p.speedKmh)}km/h)`);
            if (p.damage >= 100 && !p.repairingUntil) {
              p.repairingUntil = now + REPAIR_DURATION_MS;
              this.pushLog(`🔧 ${p.name}'s car is wrecked — repairing for ${REPAIR_DURATION_MS / 1000}s!`);
            }
          }
        }
      }
    });

    const allDone = this.players.every((p) => !p.connected || p.finishedAt);
    const timedOut = this.raceStartedAt && now - this.raceStartedAt >= MAX_RACE_DURATION_MS;
    if (allDone || timedOut) this.finishRace();
  }

  // Fractional progress (0..1) toward the current track's
  // totalCheckpointsToFinish, purely for ranking unfinished racers and
  // driving the client's live progress bar — includes a smooth fractional
  // term for "how close to the next checkpoint" rather than only jumping
  // in whole-checkpoint steps.
  progressFraction(player) {
    const track = this.track;
    const target = track.checkpoints[nextCheckpointIndex(player.checkpointsPassed, track.numCheckpoints)];
    const dist = distance(player, target);
    const fractional = 1 - clamp(dist / (CHECKPOINT_RADIUS * 4), 0, 1);
    return (player.checkpointsPassed + fractional) / track.totalCheckpointsToFinish;
  }

  finishRace() {
    this.status = 'finished';
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    // Unfinished racers (time ran out) are ranked after every finisher,
    // ordered by however far around the circuit they'd gotten — furthest first.
    const finishers = [...this.players].filter((p) => p.finishedAt).sort((a, b) => a.finishRank - b.finishRank);
    const unfinished = [...this.players].filter((p) => !p.finishedAt).sort((a, b) => this.progressFraction(b) - this.progressFraction(a));
    const ranking = [...finishers, ...unfinished];
    this.winnerId = finishers.length ? finishers[0].id : null;
    const winner = this.winnerId ? this.findPlayer(this.winnerId) : null;
    this.resultText = winner ? `🏆 ${winner.name} wins the race!` : "⏰ Time's up — nobody crossed the finish line!";
    this.finalRanking = ranking.map((p) => p.id);
    this.pushLog(this.resultText);
  }

  startTicking(nsp) {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      try {
        this.tick();
        this.broadcast(nsp);
      } catch (err) {
        console.error(`[racing] tick failed in room ${this.id}:`, err);
      }
      if (this.status !== 'racing' && this.status !== 'countdown' && this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
    }, TICK_MS);
  }

  // No hidden per-player info in this game (unlike EK/Battleship/Go), so
  // unlike nien-server.js's state(playerId)/broadcast() this is the SAME
  // payload for everyone — the client already knows its own id (Festival's
  // player id) and just compares against it directly, no server-provided
  // "yourId" needed.
  state() {
    const now = Date.now();
    const track = this.track;
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      trackKey: this.trackKey,
      trackLabel: track.label,
      trackBlurb: track.blurb,
      mapWidth: track.mapWidth,
      mapHeight: track.mapHeight,
      checkpoints: track.checkpoints,
      landmarks: track.landmarks,
      decorations: track.decorations,
      trackWidth: track.trackWidth,
      bgFrom: track.bgFrom,
      bgTo: track.bgTo,
      lapsToWin: track.lapsToWin,
      numCheckpoints: track.numCheckpoints,
      totalCheckpointsToFinish: track.totalCheckpointsToFinish,
      // Lightweight catalog of every selectable track (for the waiting-room
      // picker) — full checkpoint/landmark/item geometry is only sent for
      // the CURRENTLY selected one, above.
      tracks: Object.fromEntries(TRACK_KEYS.map((key) => {
        const t = TRACKS[key];
        return [key, { key: t.key, label: t.label, blurb: t.blurb, lapsToWin: t.lapsToWin, numCheckpoints: t.numCheckpoints }];
      })),
      characters: CHARACTERS,
      raceStartsAt: this.raceStartsAt,
      raceStartedAt: this.raceStartedAt,
      potholes: this.potholes,
      players: this.players.map((p) => {
        const stunned = now < (p.stunnedUntil || 0);
        const repairing = Boolean(p.repairingUntil && now < p.repairingUntil);
        const maxGasActive = now < (p.maxGasUntil || 0);
        const shieldActive = now < (p.shieldUntil || 0);
        return {
          id: p.id,
          name: p.name,
          connected: p.connected,
          isBot: Boolean(p.isBot),
          character: p.character || null,
          x: p.x || 0,
          y: p.y || 0,
          // The heading that actually drives movement (see tick()'s
          // inertia comment) -- exposed so the client's chase-cam view can
          // orient itself the same way the racer is actually facing/
          // moving, not just their raw steering input.
          moveDir: p.moveDir || { x: 0, y: 0 },
          checkpointsPassed: p.checkpointsPassed || 0,
          lap: Math.min(track.lapsToWin, Math.floor((p.checkpointsPassed || 0) / track.numCheckpoints) + 1),
          gasHeld: Boolean(p.gasHeld),
          // Shown as 0 while stunned/repairing rather than the stale value
          // a racer who isn't actually moving anymore still holds
          // internally (see tick()'s early-out) -- it resumes from that
          // real value, not from 0, the instant a stun wears off (a repair
          // instead explicitly resets it to 0, see tick()'s repair-clear).
          speedKmh: (stunned || repairing) ? 0 : Math.round(p.speedKmh || 0),
          maxGasActive,
          stunned,
          damage: Math.round(p.damage || 0),
          repairing,
          repairSecondsLeft: repairing ? Math.max(0, Math.ceil((p.repairingUntil - now) / 1000)) : 0,
          shieldActive,
          shieldSecondsLeft: shieldActive ? Math.max(0, Math.ceil((p.shieldUntil - now) / 1000)) : 0,
          inventory: p.inventory || { maxGas: 0, stun: 0, shield: 0 },
          progress: this.progressFraction(p),
          finishedAt: p.finishedAt || null,
          finishRank: p.finishRank || null,
        };
      }),
      finalRanking: this.finalRanking || null,
      log: this.log,
      winnerId: this.winnerId,
      resultText: this.resultText,
    };
  }

  // A single emit to the room, not one per player — serializing this
  // (identical, since there's no hidden info here) payload once and
  // letting Socket.IO fan it out is simpler than nien-server.js's
  // broadcast(), which builds a separate payload per player only because
  // it has real hidden info to withhold. Relies on every real player's
  // socket having joined this room's id (see the createRoom/joinRoom
  // handlers below) — bots have no socket and don't need to.
  broadcast(nsp) {
    nsp.to(this.id).emit('racing:state', this.state());
  }
}

function attachRacing(io) {
  const nsp = io.of('/racing');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].map((r) => r.summary());
  }
  function broadcastRoomList() {
    nsp.emit('racing:rooms', roomList());
  }
  function deleteRoomIfEmpty(room) {
    if (room && room.isEmpty()) {
      clearInterval(room.tickTimer);
      clearTimeout(room.countdownTimer);
      rooms.delete(room.id);
    }
  }

  function newPlayer(playerId, name, socketId, isBot) {
    return {
      id: playerId, name, connected: true, socketId, isBot: Boolean(isBot),
      character: null, x: 0, y: 0, dir: { x: 0, y: 0 }, moveDir: { x: 0, y: 0 }, checkpointsPassed: 0,
      speedKmh: 0, gasHeld: false, maxGasUntil: 0, stunnedUntil: 0, shieldUntil: 0,
      damage: 0, repairingUntil: 0, lastBarrierHitAt: 0, lastPotholeHitAt: 0,
      inventory: { maxGas: 0, stun: 0, shield: 0 },
      finishedAt: null, finishRank: null,
    };
  }

  nsp.on('connection', (socket) => {
    socket.emit('racing:rooms', roomList());

    socket.on('racing:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('racing:createRoom', ({ roomName, password, playerId, name, trackKey }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const room = new RacingRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, trackKey);
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push(newPlayer(playerId, clean, socket.id, false));
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      socket.join(room.id);
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('racing:joinRoom', ({ roomId, password, playerId, name }, callback) => {
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
        room.players.push(newPlayer(playerId, clean, socket.id, false));
        room.pushLog(`${clean} joined the room.`);
      }

      socket.roomId = room.id;
      socket.playerId = playerId;
      socket.join(room.id);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    function myRoom() {
      return rooms.get(socket.roomId);
    }

    socket.on('racing:addBots', ({ count }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      // Capped at whatever's left of MAX_PLAYERS (not just the requested
      // count) so a load-test click for e.g. 70 in a near-full room fills
      // the remaining seats instead of failing outright.
      const requested = Math.max(1, Math.min(MAX_PLAYERS, Number(count) || 3));
      const n = Math.min(requested, MAX_PLAYERS - room.players.length);
      if (n <= 0) { if (typeof callback === 'function') callback({ ok: false, error: 'room-full' }); return; }
      for (let i = 0; i < n; i++) {
        room.botCounter += 1;
        // Cycled first name + the ever-increasing counter, so bot names stay
        // visually distinct even well past BOT_NAMES.length (e.g. "Bot An 7").
        const botName = `🤖 Bot ${BOT_NAMES[(room.botCounter - 1) % BOT_NAMES.length]} ${room.botCounter}`;
        const bot = newPlayer(`bot_${room.id}_${room.botCounter}`, botName, null, true);
        bot.character = CHARACTER_KEYS[room.botCounter % CHARACTER_KEYS.length];
        room.players.push(bot);
        room.pushLog(`${botName} joined the room.`);
      }
      if (typeof callback === 'function') callback({ ok: true, added: n });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('racing:selectCharacter', ({ character }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.selectCharacter(player, character);
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('racing:selectTrack', ({ trackKey }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      const result = room.setTrack(trackKey);
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('racing:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length < 1) { if (typeof callback === 'function') callback({ ok: false, error: 'not-enough-players' }); return; }
      room.startRace();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      room.startTicking(nsp);
    });

    socket.on('racing:input', ({ dx, dy }) => {
      const room = myRoom();
      if (!room || room.status !== 'racing') return;
      const player = room.findPlayer(socket.playerId);
      if (!player) return;
      room.setPlayerInput(player, Number(dx) || 0, Number(dy) || 0);
    });

    socket.on('racing:gasInput', ({ held }) => {
      const room = myRoom();
      if (!room || room.status !== 'racing') return;
      const player = room.findPlayer(socket.playerId);
      if (!player) return;
      room.setGasHeld(player, Boolean(held));
    });

    socket.on('racing:useItem', ({ type }, callback) => {
      const room = myRoom();
      if (!room || room.status !== 'racing') { if (typeof callback === 'function') callback({ ok: false, error: 'not-racing' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.useItem(player, type);
      if (typeof callback === 'function') callback(result);
    });

    socket.on('racing:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'finished') { if (typeof callback === 'function') callback({ ok: false, error: 'not-finished' }); return; }
      room.status = 'waiting';
      room.winnerId = null;
      room.resultText = null;
      room.finalRanking = null;
      room.log = [];
      room.pushLog('Ready for another race — click Start when everyone is in.');
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
      socket.leave(room.id);
      deleteRoomIfEmpty(room);
      broadcastRoomList();
      socket.roomId = null;
    }

    socket.on('racing:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
}

module.exports = attachRacing;
// Exposed purely for automated testing of the game-logic pieces without
// needing a live socket server.
module.exports.RacingRoom = RacingRoom;
module.exports.WORLD_SCALE = WORLD_SCALE;
module.exports.buildSwitchbackLoop = buildSwitchbackLoop;
module.exports.buildColumn = buildColumn;
module.exports.columnX = columnX;
module.exports.TRACKS = TRACKS;
module.exports.TRACK_KEYS = TRACK_KEYS;
module.exports.DEFAULT_TRACK_KEY = DEFAULT_TRACK_KEY;
module.exports.PLAYER_SPEED = PLAYER_SPEED;
module.exports.PLAYER_RADIUS = PLAYER_RADIUS;
module.exports.COUNTDOWN_MS = COUNTDOWN_MS;
module.exports.MAX_RACE_DURATION_MS = MAX_RACE_DURATION_MS;
module.exports.CHECKPOINT_RADIUS = CHECKPOINT_RADIUS;
module.exports.CHECKPOINT_EDGE_MARGIN = CHECKPOINT_EDGE_MARGIN;
module.exports.MAX_SPEED_KMH = MAX_SPEED_KMH;
module.exports.SPEED_BANDS = SPEED_BANDS;
module.exports.speedRateKmhPerSec = speedRateKmhPerSec;
module.exports.turnLerpFactor = turnLerpFactor;
module.exports.DAMAGE_BANDS = DAMAGE_BANDS;
module.exports.damagePercentForSpeed = damagePercentForSpeed;
module.exports.BARRIER_HIT_COOLDOWN_MS = BARRIER_HIT_COOLDOWN_MS;
module.exports.REPAIR_DURATION_MS = REPAIR_DURATION_MS;
module.exports.POTHOLE_COUNT = POTHOLE_COUNT;
module.exports.POTHOLE_RADIUS = POTHOLE_RADIUS;
module.exports.POTHOLE_HIT_COOLDOWN_MS = POTHOLE_HIT_COOLDOWN_MS;
module.exports.POTHOLE_SPEED_MULTIPLIER = POTHOLE_SPEED_MULTIPLIER;
module.exports.POTHOLE_DAMAGE_BANDS = POTHOLE_DAMAGE_BANDS;
module.exports.potholeDamagePercentForSpeed = potholeDamagePercentForSpeed;
module.exports.SHIELD_PROTECTION_DURATION_MS = SHIELD_PROTECTION_DURATION_MS;
module.exports.ITEM_TYPES = ITEM_TYPES;
module.exports.ITEM_DEFS = ITEM_DEFS;
module.exports.MAX_GAS_ITEM_DURATION_MS = MAX_GAS_ITEM_DURATION_MS;
module.exports.MAX_GAS_ITEM_PEAK_KMH = MAX_GAS_ITEM_PEAK_KMH;
module.exports.MAX_GAS_DECAY_KMH_PER_SEC = MAX_GAS_DECAY_KMH_PER_SEC;
module.exports.STUN_DURATION_MS = STUN_DURATION_MS;
module.exports.STUN_TOP_N = STUN_TOP_N;
module.exports.CHARACTERS = CHARACTERS;
module.exports.CHARACTER_KEYS = CHARACTER_KEYS;
module.exports.TICK_MS = TICK_MS;
module.exports.MAX_PLAYERS = MAX_PLAYERS;
module.exports.nextCheckpointIndex = nextCheckpointIndex;
module.exports.closestPointOnLoop = closestPointOnLoop;
module.exports.closestPointOnSegment = closestPointOnSegment;
