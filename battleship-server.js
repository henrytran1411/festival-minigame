// Battleship — a sixth backup game alongside UNO, Exploding Kittens, Go,
// Đuổi Niên Thú, and Ô Ăn Quan. Same "casual side activity" contract as
// those: its own Socket.IO namespace, no leaderboard, no admin open/close
// gating (see server.js).
//
// Rules: each player secretly places the same standard 6-ship fleet
// (Carrier 5, Battleship 4, Cruiser 3, Submarine 3, Destroyer 2, King 1 —
// 18 cells total, regardless of board size) on a host-chosen NxN grid,
// then players fire single shots at each other's grid. A HIT keeps the
// turn with the same player (fire again); a MISS passes the turn. Fog of
// war is enforced server-side: a player's own state never includes the
// opponent's unsunk ship positions — only shot results (hit/miss) and,
// once a ship is fully sunk, that one ship's cells.
//
// The King (1 cell) has no defense of its own, but it doesn't go down for
// good on a single hit either: the instant it's hit, if the King's OWNER
// still has an undamaged Cruiser, Submarine, or Destroyer (fully unhit,
// judged independently of each other) somewhere on the board, that ship
// and the King trade places -- see trySwapKingToSafety() /
// relocatePartnerToKingsSpot(). The undamaged partner relocates onto a
// straight-line placement CENTERED on the King's old cell (e.g. a 3-cell
// ship becomes [king-1, king, king+1] along whichever axis has room),
// inheriting the hit that just landed there as its own first hit -- and
// the King itself reappears, alive and unhit, at a random one of the
// partner's own just-vacated cells (the other one or two go back to plain
// empty water). Everything in a Nuclear-Bomb-shaped area around the
// King's old cell that isn't sitting under a ship is healed back to
// unfired water so the partner has room to land. This can repeat any
// number of times over the course of a game -- every single time the King
// is hit, it checks again for a still-undamaged partner. The King only
// sinks for real once no partner is undamaged, or nothing fits anywhere
// (every direction blocked by another ship, the board edge, or an
// already-fired cell).
//
// Special ammunition (inspired by papergames.io's Battleship, with this
// project's own chosen shapes/rates -- see battleship.html's rules
// modal): each player's own board secretly hides a few "supply drop"
// cells (plain water, never on top of a ship -- the count scales with
// board area), each pre-assigned one of the 3 weapon types at seed time.
// If the OPPONENT hits one, they immediately gain a charge of that cell's
// weapon (capped per type at whatever the room's starting loadout is,
// minimum 1 -- finding a duplicate once already at the cap is wasted).
// Two more ways to learn where a hidden drop is, both purely informative
// (the attacker still has to actually hit the cell to claim it):
//   - Sinking a ship reveals one still-hidden drop of a type keyed to
//     that ship's size (Carrier/Battleship -> Cross Shot, Cruiser/
//     Submarine -> Scatter Shot, Destroyer -> Nuclear Bomb) on the
//     opponent's board, to the sinker only.
//   - 3 consecutive misses BY THE SAME PLAYER (streak resets the moment
//     they land a hit) reveals one random still-hidden drop (any type)
//     on the opponent's board, to that player only -- a small "pity"
//     mechanic for a cold streak.
// Before firing, a player holding a charge may spend it instead of firing
// a normal single shot:
//   - Cross shot: the target cell plus every orthogonal neighbor that
//     exists (up to 4 extra, a "+" shape, fewer at edges/corners).
//   - Nuclear bomb: a bigger blast than Cross Shot -- orthogonal out to 2
//     cells in every direction (8 cells) plus the 4 immediate diagonal
//     corners (13 cells total including the target). E.g. firing at C3
//     also hits C1/C2/C4/C5, A3/B3/D3/E3, and B2/B4/D2/D4.
//   - Scatter shot: the target cell plus a random 3-7 OTHER cells chosen
//     from anywhere still unfired on the board.
// A special weapon's hit/miss/turn-continuation rules are identical to a
// normal shot's, just evaluated once per affected cell -- landing at
// least one hit among all of them still earns the bonus turn.
//
// Host-configurable room settings (chosen at oaq:createRoom time, fixed
// for that room's whole lifetime including rematches):
//   - Board size: 10x10 / 15x15 / 20x20. The fleet stays the same 18
//     cells regardless -- a bigger board is proportionally easier to
//     defend, which is the expected/natural consequence of that choice.
//   - Time per turn: a per-shot clock (30/60/90/120s, or unlimited). If a
//     human player doesn't fire before it runs out, the server fires a
//     reasonable shot on their behalf automatically (using the same
//     hunt-capable targeting the bots use) -- the game keeps moving, but
//     they lose the choice of where. This does NOT end the game by
//     itself.
//   - Minutes per player: a total time bank (3/5/8/15/30/60 minutes, or
//     unlimited) that only ticks down during that player's own turn,
//     chess-clock style. If it reaches zero, that player loses
//     immediately (opponent wins by timeout).
//   - Who plays first: random / the host / the host's opponent. Sticks
//     for every game in the room, including rematches.
//   - Map theme: a purely cosmetic label (11 Vietnamese rivers -- see
//     MAP_THEMES below) -- no effect on mechanics. It's only the room's
//     DEFAULT; each player can independently override it client-side to
//     any theme (localStorage, never touches the server) to see the board
//     over a different background image than their opponent does.
//   - Starting ammo: 0-3 charges of each special weapon, granted to BOTH
//     players the moment placement begins (and every rematch) -- on top
//     of whatever they find via supply drops during play.
//   - Include King ship: on by default, but a host can turn it off for a
//     more straightforward game -- with it off, the fleet is the same 5
//     ships (Carrier/Battleship/Cruiser/Submarine/Destroyer, 17 cells
//     total) and the King's swap-to-safety mechanic simply never comes up
//     (nothing named 'King' is ever placed, so trySwapKingToSafety() is
//     never reached). See fleetSpecFor().
// Bots are never subject to the per-turn clock or time bank -- they
// already act on their own short "thinking" delay regardless.

const BOT_NAMES = ['🤖 Bot An', '🤖 Bot Bình', '🤖 Bot Chi'];
const MAX_PLAYERS = 2;
const BOT_THINK_MS_MIN = 900;
const BOT_THINK_MS_MAX = 2200;

const VALID_GRID_SIZES = [10, 15, 20];
const DEFAULT_GRID_SIZE = 10;

const FLEET_SPEC = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
  { name: 'King', size: 1 },
];
// The same fleet with the King left out entirely -- for rooms created with
// includeKing:false. Nothing else needs to know King is gone: the King
// swap-to-safety mechanic (trySwapKingToSafety) only ever fires when a
// ship named 'King' actually sunk, which simply never happens when it was
// never placed.
const NON_KING_FLEET_SPEC = FLEET_SPEC.filter((s) => s.name !== 'King');
function fleetSpecFor(includeKing) {
  return includeKing ? FLEET_SPEC : NON_KING_FLEET_SPEC;
}
const TOTAL_SHIP_CELLS = FLEET_SPEC.reduce((sum, s) => sum + s.size, 0);
// Ships the King can trade places with to dodge death -- see trySwapKingToSafety().
const KING_PROTECTS = ['Cruiser', 'Submarine', 'Destroyer'];

// -- Special ammunition -----------------------------------------------
const WEAPON_TYPES = ['cross', 'nuclear', 'scatter'];
const WEAPON_LABELS = { cross: 'Cross Shot', nuclear: 'Nuclear Bomb', scatter: 'Scatter Shot' };
const MAX_AMMO_PER_TYPE = 1; // floor for the per-type hold cap -- see startingAmmo below
const SCATTER_MIN_EXTRA = 3;
const SCATTER_MAX_EXTRA = 7;
const STARTING_AMMO_MAX = 3; // host can configure 0-3 starting charges of each weapon
// Sinking a ship hints one still-hidden supply drop of this weapon type
// on the opponent's board (to the sinker only) -- keyed by ship SIZE, so
// Cruiser and Submarine (both size 3) share a hint type.
const SHIP_SIZE_TO_HINT_WEAPON = { 5: 'cross', 4: 'cross', 3: 'scatter', 2: 'nuclear' };
const MISS_STREAK_HINT_THRESHOLD = 3;

// -- Room configuration options -----------------------------------------
const TURN_TIME_OPTIONS = [30, 60, 90, 120]; // seconds; not in this list (incl. 0/null) means unlimited
const TIME_BANK_MINUTE_OPTIONS = [3, 5, 8, 15, 30, 60]; // minutes; not in this list means unlimited
const FIRST_PLAYER_OPTIONS = ['random', 'host', 'opponent'];
const MAP_THEMES = {
  bachdang: 'Sông Bạch Đằng',
  benhai: 'Sông Bến Hải',
  songgianh: 'Sông Gianh',
  songhan: 'Sông Hàn',
  songhuong: 'Sông Hương',
  songhong: 'Sông Hồng',
  songlam: 'Sông Lam',
  songlo: 'Sông Lô',
  thubon: 'Sông Thu Bồn',
  songda: 'Sông Đà',
  songday: 'Sông Đáy',
  cuulong: 'Sông Cửu Long',
  saigon: 'Sông Sài Gòn',
  serepok: 'Sông Sêrêpôk',
  vamco: 'Sông Vàm Cỏ',
  dongnai: 'Sông Đồng Nai',
  hoangsa: 'Hoàng Sa',
  truongsa: 'Trường Sa',
};
const DEFAULT_MAP_THEME = 'bachdang';

function freshAmmo() {
  return { cross: 0, nuclear: 0, scatter: 0 };
}

// Supply-drop count scales gently with board area so bigger boards
// aren't proportionally drop-starved: 3 on 10x10, ~7 on 15x15, 12 on
// 20x20.
function supplyDropCountFor(size) {
  return Math.max(3, Math.round(size * size * 0.03));
}

// Seeds hidden pickup cells on plain water (never atop a ship) for one
// player's board, each pre-assigned one of the 3 weapon types (so a
// sink/streak hint can name exactly what a cell holds without having to
// wait for it to actually be found). Rejection sampling, same spirit as
// randomFleet() -- trivially converges given how few cells are needed
// relative to the board area. A cell holds either null (nothing) or a
// weapon-type string.
function seedSupplyDrops(shipGrid, size) {
  const supplyGrid = freshGrid(size);
  const dropCount = supplyDropCountFor(size);
  let placed = 0;
  let attempts = 0;
  while (placed < dropCount && attempts < 2000) {
    attempts += 1;
    const r = Math.floor(Math.random() * size);
    const c = Math.floor(Math.random() * size);
    if (shipGrid[r][c] !== null || supplyGrid[r][c]) continue;
    supplyGrid[r][c] = WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)];
    placed += 1;
  }
  return supplyGrid;
}

// Picks one still-hidden supply-drop cell on `defender`'s board to reveal
// as a hint -- of the given weapon type if one is provided (sink hint),
// or any type if `weapon` is null (miss-streak hint). Skips cells already
// hinted (so repeat sinks of the same-size ship surface a fresh cell
// rather than repeating one). Returns null if nothing qualifies.
function pickHintCell(defender, weapon) {
  const candidates = [];
  for (let r = 0; r < defender.supplyGrid.length; r += 1) {
    for (let c = 0; c < defender.supplyGrid[r].length; c += 1) {
      const w = defender.supplyGrid[r][c];
      if (!w) continue;
      if (weapon && w !== weapon) continue;
      if (defender.hintedCells.some((h) => h.r === r && h.c === c)) continue;
      candidates.push({ r, c, weapon: w });
    }
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

const NEIGHBOR_DELTAS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
// Nuclear Bomb's footprint: orthogonal out to 2 cells in every direction
// (8 cells) plus the 4 immediate diagonal corners (1 cell out) -- e.g.
// firing at C3 also hits C1/C2/C4/C5, A3/B3/D3/E3, and B2/B4/D2/D4. A
// bigger, differently-shaped blast than Cross Shot's plain 5-cell "+".
const NUCLEAR_DELTAS = [
  [-2, 0], [-1, 0], [1, 0], [2, 0],
  [0, -2], [0, -1], [0, 1], [0, 2],
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

// The cell set a given weapon affects when fired at (r, c). `shotsGrid`
// (the defender's incoming-shots record) is only needed by scatter shot,
// to pick its random extra cells from ones that haven't been fired at
// yet -- wasting a random cell on already-revealed water would be a dud
// with no point to it. A plain (no-weapon) shot just hits the one cell.
function weaponCells(weapon, r, c, shotsGrid, size) {
  if (weapon === 'cross' || weapon === 'nuclear') {
    const deltas = weapon === 'nuclear' ? NUCLEAR_DELTAS : NEIGHBOR_DELTAS;
    const cells = [{ r, c }];
    deltas.forEach(([dr, dc]) => {
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds(nr, nc, size)) cells.push({ r: nr, c: nc });
    });
    return cells;
  }
  if (weapon === 'scatter') {
    const extraCount = SCATTER_MIN_EXTRA + Math.floor(Math.random() * (SCATTER_MAX_EXTRA - SCATTER_MIN_EXTRA + 1));
    const candidates = [];
    for (let rr = 0; rr < size; rr += 1) {
      for (let cc = 0; cc < size; cc += 1) {
        if (rr === r && cc === c) continue;
        if (shotsGrid[rr][cc] !== null) continue;
        candidates.push({ r: rr, c: cc });
      }
    }
    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return [{ r, c }, ...candidates.slice(0, Math.min(extraCount, candidates.length))];
  }
  return [{ r, c }];
}

function freshGrid(size, fill) {
  return Array.from({ length: size }, () => new Array(size).fill(fill === undefined ? null : fill));
}

function inBounds(r, c, size) {
  return r >= 0 && r < size && c >= 0 && c < size;
}

// Validates a client-submitted fleet against `fleetSpec` (a room's fleet,
// with or without the King -- see fleetSpecFor()): exactly one ship per
// spec (matched by name+size), every ship's cells form a straight,
// contiguous line of the right length, fully in-bounds for this room's
// `size`, and no ship overlaps another. Returns { grid, ships } on
// success (grid[r][c] is the index into `ships`, or null for water) or
// null if anything is invalid.
function validateFleet(rawShips, size, fleetSpec = FLEET_SPEC) {
  if (!Array.isArray(rawShips) || rawShips.length !== fleetSpec.length) return null;
  const grid = freshGrid(size);
  const usedNames = new Set();
  const ships = [];

  for (let i = 0; i < rawShips.length; i += 1) {
    const raw = rawShips[i];
    if (!raw || typeof raw.name !== 'string') return null;
    const spec = fleetSpec.find((f) => f.name === raw.name);
    if (!spec || usedNames.has(spec.name)) return null;
    usedNames.add(spec.name);

    if (!Array.isArray(raw.cells) || raw.cells.length !== spec.size) return null;
    const cells = raw.cells.map((cell) => ({ r: Number(cell && cell.r), c: Number(cell && cell.c) }));
    if (cells.some(({ r, c }) => !Number.isInteger(r) || !Number.isInteger(c) || !inBounds(r, c, size))) return null;

    const sameRow = cells.every((cell) => cell.r === cells[0].r);
    const sameCol = cells.every((cell) => cell.c === cells[0].c);
    if (!sameRow && !sameCol) return null;
    if (sameRow) {
      const cols = cells.map((cell) => cell.c).sort((a, b) => a - b);
      for (let k = 1; k < cols.length; k += 1) if (cols[k] !== cols[k - 1] + 1) return null;
    } else {
      const rows = cells.map((cell) => cell.r).sort((a, b) => a - b);
      for (let k = 1; k < rows.length; k += 1) if (rows[k] !== rows[k - 1] + 1) return null;
    }

    for (const { r, c } of cells) {
      if (grid[r][c] !== null) return null; // overlaps a previously-placed ship
      grid[r][c] = i;
    }
    ships.push({ name: spec.name, size: spec.size, cells, sunk: false });
  }

  if (usedNames.size !== fleetSpec.length) return null;
  return { grid, ships };
}

// Rejection-sampling random placer -- used for bots (and available to the
// client as the "Randomize" convenience, though the client does its own
// equivalent locally rather than round-tripping through the server for
// it). Only 18 ship cells (17 without the King) on even the smallest
// supported board means this converges in only a few attempts almost
// always; a generous retry cap keeps it provably terminating rather than
// a true infinite loop.
function randomFleet(size, fleetSpec = FLEET_SPEC) {
  const grid = freshGrid(size);
  const ships = [];
  for (let i = 0; i < fleetSpec.length; i += 1) {
    const spec = fleetSpec[i];
    let placed = false;
    for (let attempt = 0; attempt < 1000 && !placed; attempt += 1) {
      const horizontal = Math.random() < 0.5;
      const r = Math.floor(Math.random() * size);
      const c = Math.floor(Math.random() * size);
      const cells = [];
      for (let k = 0; k < spec.size; k += 1) cells.push(horizontal ? { r, c: c + k } : { r: r + k, c });
      if (cells.some(({ r: cr, c: cc }) => !inBounds(cr, cc, size))) continue;
      if (cells.some(({ r: cr, c: cc }) => grid[cr][cc] !== null)) continue;
      cells.forEach(({ r: cr, c: cc }) => { grid[cr][cc] = i; });
      ships.push({ name: spec.name, size: spec.size, cells, sunk: false });
      placed = true;
    }
    if (!placed) return randomFleet(size, fleetSpec); // pathologically unlucky run -- just start over
  }
  return { grid, ships };
}

// Which index within a straight line of `n` cells is closest to centered
// -- for odd n there's exactly one (dead center); for even n there are
// two equally-close candidates (e.g. n=2 -> the king can be either the
// first or the second cell of the pair).
function centerIndices(n) {
  if (n % 2 === 1) return [(n - 1) / 2];
  return [n / 2 - 1, n / 2];
}

// Every index a line of length n could sit the anchor at (0..n-1) -- the
// full, non-centered-only fallback set. See kingReplacementCandidates().
function allLineIndices(n) {
  return Array.from({ length: n }, (_, k) => k);
}

// Every straight-line placement of length `n` that includes (kingR,
// kingC) somewhere in its span, across both axes, restricted to the
// given king-index offsets `kOffsets` (defaults to just the centered
// one(s) -- see centerIndices()). E.g. for n=3 with the default centered
// offset this is exactly the horizontal and vertical "king is the middle
// cell" lines (2 candidates); for n=2 it's the 4 ways a 2-cell ship can
// touch the king's cell while staying as centered as a 2-cell ship can
// be. Pass allLineIndices(n) to widen the search to every off-center
// placement too -- used as a fallback in relocatePartnerToKingsSpot() when
// something else already crowds out every centered option.
function kingReplacementCandidates(kingR, kingC, n, kOffsets = centerIndices(n)) {
  const candidates = [];
  ['h', 'v'].forEach((axis) => {
    kOffsets.forEach((k) => {
      const cells = [];
      for (let i = 0; i < n; i += 1) {
        const offset = i - k;
        cells.push(axis === 'h' ? { r: kingR, c: kingC + offset } : { r: kingR + offset, c: kingC });
      }
      candidates.push(cells);
    });
  });
  return candidates;
}

// A candidate is usable if every cell is in bounds, and every cell OTHER
// than the king's own death cell is free: not occupied by another ship,
// and not already fired at (fire() rejects re-targeting an already-shot
// cell, so landing there would make that cell of the ship permanently
// unfireable). The king's own cell is exempt from the "not already
// fired" check -- it's *always* already fired at (that's how the king
// just died), and that's exactly the hit this mechanic hands off to the
// replacement ship.
function isValidKingReplacement(defender, cells, kingR, kingC, size) {
  return cells.every(({ r, c }) => {
    if (!inBounds(r, c, size)) return false;
    if (r === kingR && c === kingC) return true;
    if (defender.grid[r][c] !== null) return false;
    if (defender.shotsAtMe[r][c] !== null) return false;
    return true;
  });
}

// Relocates `defender`'s undamaged partner ship at `shipIndex` onto a
// straight-line placement centered on the King's cell (kingR, kingC) --
// e.g. a 3-cell ship becomes [king-1, king, king+1] along whichever axis
// has room. The King's cell is deliberately part of the new footprint:
// the hit that just landed there stays recorded in shotsAtMe, so it's
// inherited as the partner's first hit the instant it takes over. Prefers
// a CENTERED placement, but falls back to any off-center placement that
// still includes the anchor cell if no centered one fits (something else
// -- other ships, earlier shots -- crowding out the centered option).
// Returns true on success (ship relocated); false if NOTHING fits
// anywhere (blocked on every side by another ship, the edge of the
// board, or an already-fired cell) -- the King has nowhere to swap to and
// sinks for real.
function relocatePartnerToKingsSpot(defender, shipIndex, kingR, kingC, size) {
  const ship = defender.ships[shipIndex];
  ship.cells.forEach(({ r, c }) => { defender.grid[r][c] = null; });
  let candidates = kingReplacementCandidates(kingR, kingC, ship.size)
    .filter((cells) => isValidKingReplacement(defender, cells, kingR, kingC, size));
  if (!candidates.length) {
    candidates = kingReplacementCandidates(kingR, kingC, ship.size, allLineIndices(ship.size))
      .filter((cells) => isValidKingReplacement(defender, cells, kingR, kingC, size));
  }
  if (!candidates.length) {
    ship.cells.forEach(({ r, c }) => { defender.grid[r][c] = shipIndex; }); // put it back -- can't teleport
    return false;
  }
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  chosen.forEach(({ r, c }) => { defender.grid[r][c] = shipIndex; });
  ship.cells = chosen;
  return true;
}

// Bot (and auto-fire-on-timeout) targeting: prioritizes unfired cells
// orthogonally adjacent to a hit that isn't yet part of a confirmed-sunk
// ship (classic "hunt" mode, using only information a human opponent
// would also have -- the shooter's own shotsGrid plus which of the
// opponent's ships have been revealed as sunk), falling back to any
// unfired cell at random. Not perfect play, just a believable opponent,
// matching this project's other game bots.
function chooseBotShot(shotsGrid, sunkCells, size) {
  const huntCandidates = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (shotsGrid[r][c] !== 'hit' || sunkCells.has(`${r},${c}`)) continue;
      NEIGHBOR_DELTAS.forEach(([dr, dc]) => {
        const nr = r + dr;
        const nc = c + dc;
        if (inBounds(nr, nc, size) && shotsGrid[nr][nc] === null) huntCandidates.push({ r: nr, c: nc });
      });
    }
  }
  if (huntCandidates.length) return huntCandidates[Math.floor(Math.random() * huntCandidates.length)];

  const openCells = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (shotsGrid[r][c] === null) openCells.push({ r, c });
    }
  }
  return openCells.length ? openCells[Math.floor(Math.random() * openCells.length)] : null;
}

// Pure shot resolution -- mutates `shotsGrid` (the defender's record of
// incoming shots) and the hit ship's `sunk` flag. Returns what happened;
// callers apply logging/turn-advancement/game-end around it.
function resolveShot(defenderGrid, defenderShips, shotsGrid, r, c) {
  const shipIndex = defenderGrid[r][c];
  if (shipIndex === null) {
    shotsGrid[r][c] = 'miss';
    return { result: 'miss' };
  }
  shotsGrid[r][c] = 'hit';
  const ship = defenderShips[shipIndex];
  const sunk = ship.cells.every(({ r: sr, c: sc }) => shotsGrid[sr][sc] === 'hit');
  if (sunk) ship.sunk = true;
  return { result: 'hit', ship, shipIndex, sunk };
}

function sanitizeStartingAmmoCount(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(STARTING_AMMO_MAX, n);
}

function sanitizeOptions(raw) {
  const opts = raw || {};
  const gridSize = VALID_GRID_SIZES.includes(Number(opts.gridSize)) ? Number(opts.gridSize) : DEFAULT_GRID_SIZE;
  const timePerTurn = TURN_TIME_OPTIONS.includes(Number(opts.timePerTurn)) ? Number(opts.timePerTurn) : null;
  const timeBankMinutes = TIME_BANK_MINUTE_OPTIONS.includes(Number(opts.timeBankMinutes)) ? Number(opts.timeBankMinutes) : null;
  const firstPlayer = FIRST_PLAYER_OPTIONS.includes(opts.firstPlayer) ? opts.firstPlayer : 'random';
  const mapTheme = MAP_THEMES[opts.mapTheme] ? opts.mapTheme : DEFAULT_MAP_THEME;
  const includeKing = opts.includeKing !== false; // default true -- only an explicit false turns it off
  const rawStartingAmmo = opts.startingAmmo || {};
  const startingAmmo = {
    cross: sanitizeStartingAmmoCount(rawStartingAmmo.cross),
    nuclear: sanitizeStartingAmmoCount(rawStartingAmmo.nuclear),
    scatter: sanitizeStartingAmmoCount(rawStartingAmmo.scatter),
  };
  return {
    gridSize,
    timePerTurn,
    timeBankSeconds: timeBankMinutes ? timeBankMinutes * 60 : null,
    firstPlayer,
    mapTheme,
    includeKing,
    startingAmmo,
  };
}

class BattleshipRoom {
  constructor(id, name, password, options) {
    this.id = id;
    this.name = name;
    this.password = password;
    const { gridSize, timePerTurn, timeBankSeconds, firstPlayer, mapTheme, includeKing, startingAmmo } = sanitizeOptions(options);
    this.gridSize = gridSize;
    this.timePerTurn = timePerTurn; // seconds, or null for unlimited
    this.timeBankSeconds = timeBankSeconds; // seconds, or null for unlimited
    this.firstPlayer = firstPlayer; // 'random' | 'host' | 'opponent'
    this.mapTheme = mapTheme;
    this.includeKing = includeKing; // whether the King ship is part of this room's fleet
    this.fleetSpec = fleetSpecFor(includeKing);
    this.startingAmmo = startingAmmo; // { cross, nuclear, scatter } charges granted at the start of every game
    this.hostPlayerId = null; // set by attachBattleship() right after the creator is pushed into players
    this.status = 'waiting'; // 'waiting' | 'placing' | 'playing' | 'finished'
    this.players = []; // { id, name, connected, socketId, isBot, ships, grid, shotsAtMe, ready, ammo, supplyGrid, foundOnBoard, timeBankMsRemaining }
    this.botCounter = 0;
    this.currentPlayerIndex = 0;
    this.log = [];
    this.winnerId = null;
    this.resultText = null;
    this.botTimer = null;
    this.turnTimer = null; // per-turn clock (auto-fires on expiry)
    this.timeBankTimer = null; // total time-bank clock (ends the game on expiry)
    this.turnStartedAt = null; // Date.now() when the current player's turn/clocks began
    this.moveSeq = 0;
    this.lastShot = null; // { seq, playerId, r, c, weapon, cells, suppliesFound, gameOver, continuesTurn }
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
      gridSize: this.gridSize,
      mapTheme: this.mapTheme,
      mapThemeLabel: MAP_THEMES[this.mapTheme],
      includeKing: this.includeKing,
    };
  }

  currentPlayer() {
    return this.players[this.currentPlayerIndex] || null;
  }

  opponentOf(player) {
    const idx = this.players.indexOf(player);
    return this.players[1 - idx] || null;
  }

  chooseFirstPlayerIndex() {
    if (this.firstPlayer === 'host') {
      const idx = this.players.findIndex((p) => p.id === this.hostPlayerId);
      if (idx !== -1) return idx;
    } else if (this.firstPlayer === 'opponent') {
      const idx = this.players.findIndex((p) => p.id !== this.hostPlayerId);
      if (idx !== -1) return idx;
    }
    return Math.random() < 0.5 ? 0 : 1;
  }

  // Moves the room from the lobby into ship placement: both seats must be
  // filled first (enforced by the socket handler). Bots place instantly;
  // human players place via submitFleet(). If a bot happens to be BOTH
  // seats' occupant... can't happen (MAX_PLAYERS enforces one human seat
  // minimum isn't required, but two bots is legal and just resolves
  // instantly into 'playing').
  beginPlacement() {
    this.status = 'placing';
    this.winnerId = null;
    this.resultText = null;
    this.log = [];
    this.moveSeq = 0;
    this.lastShot = null;
    this.players.forEach((p) => {
      p.ships = null;
      p.grid = null;
      p.shotsAtMe = freshGrid(this.gridSize);
      p.ready = false;
      p.supplyGrid = null;
      p.ammo = { ...this.startingAmmo };
      p.foundOnBoard = []; // supply drops found ON this player's board (by their opponent)
      p.hintedCells = []; // cells hinted to this player's OPPONENT, on this player's board
      p.missStreak = 0; // this player's own consecutive-miss count (resets on any hit)
      p.timeBankMsRemaining = (this.timeBankSeconds && !p.isBot) ? this.timeBankSeconds * 1000 : null;
    });
    this.pushLog(`🚢 Place your fleet! (${this.gridSize}x${this.gridSize} — ${MAP_THEMES[this.mapTheme]})`);
    clearTimeout(this.botTimer);
    clearTimeout(this.turnTimer);
    clearTimeout(this.timeBankTimer);
    this.players.filter((p) => p.isBot).forEach((bot) => this.submitFleet(bot, randomFleet(this.gridSize, this.fleetSpec).ships));
  }

  // Applies one player's fleet placement. Returns { ok, error? }.
  submitFleet(player, rawShips) {
    if (this.status !== 'placing') return { ok: false, error: 'not-placing' };
    if (player.ready) return { ok: false, error: 'already-ready' };
    const validated = validateFleet(rawShips, this.gridSize, this.fleetSpec);
    if (!validated) return { ok: false, error: 'invalid-fleet' };
    player.ships = validated.ships;
    player.grid = validated.grid;
    player.supplyGrid = seedSupplyDrops(validated.grid, this.gridSize);
    player.ready = true;
    this.pushLog(`${player.name} finished placing their fleet.`);

    if (this.players.length === MAX_PLAYERS && this.players.every((p) => p.ready)) {
      this.status = 'playing';
      this.currentPlayerIndex = this.chooseFirstPlayerIndex();
      this.pushLog(`⚔️ Both fleets are set! ${this.currentPlayer().name} fires first.`);
      this.scheduleTurnTimers();
      this.scheduleBotTurn();
    }
    return { ok: true };
  }

  // Resolves one shot cell against `opponent` for `player`: applies the
  // hit/miss, grants ammo + clears any stale hint if it lands on a supply
  // drop, and hints a fresh drop of the mapped weapon type if it sinks a
  // ship. Returns the { r, c, result, sunkShip } entry for shotResults.
  applyShotToCell(player, opponent, tr, tc) {
    const res = resolveShot(opponent.grid, opponent.ships, opponent.shotsAtMe, tr, tc);
    if (opponent.supplyGrid?.[tr][tc]) {
      const granted = opponent.supplyGrid[tr][tc]; // pre-assigned at seed time -- see seedSupplyDrops
      opponent.supplyGrid[tr][tc] = null;
      opponent.hintedCells = opponent.hintedCells.filter((h) => !(h.r === tr && h.c === tc));
      const cap = Math.max(MAX_AMMO_PER_TYPE, this.startingAmmo[granted]);
      const wasted = player.ammo[granted] >= cap;
      player.ammo[granted] = Math.min(cap, player.ammo[granted] + 1);
      res.suppliesFoundEntry = { r: tr, c: tc, weapon: granted, wasted };
      opponent.foundOnBoard.push({ r: tr, c: tc, weapon: granted });
    }
    if (res.sunk) {
      const hintWeapon = SHIP_SIZE_TO_HINT_WEAPON[res.ship.size];
      const hint = hintWeapon ? pickHintCell(opponent, hintWeapon) : null;
      if (hint) {
        opponent.hintedCells.push(hint);
        this.pushLog(`🧭 Sinking the ${res.ship.name} revealed a ${WEAPON_LABELS[hint.weapon]} supply drop on ${opponent.name}'s board!`);
      }
      if (res.ship.name === 'King') this.trySwapKingToSafety(opponent, res.shipIndex, tr, tc);
    }
    return {
      r: tr, c: tc, result: res.result,
      sunkShip: res.sunk ? { name: res.ship.name, cells: res.ship.cells } : null,
      suppliesFoundEntry: res.suppliesFoundEntry || null,
    };
  }

  // Called the instant the King is hit (and thus, per resolveShot, sunk --
  // a 1-cell ship dies on its first hit). If `defender` still has an
  // undamaged Cruiser, Submarine, or Destroyer somewhere (independently
  // judged -- one already hit elsewhere doesn't disqualify the other
  // two), one is picked at random to trade places with the King: it
  // relocates onto a straight-line placement CENTERED on the King's cell
  // (see relocatePartnerToKingsSpot()), inheriting the hit that just
  // landed there as its own first hit -- and the King reappears, alive
  // and marked unsunk again, at a random one of the partner's own
  // just-vacated cells (the rest of that footprint goes back to plain
  // empty water). Everything in a Nuclear-Bomb-shaped area around the
  // King's old cell that isn't sitting under a ship is healed back to
  // unfired water so the partner has room to land. If no partner is
  // undamaged, or nothing fits anywhere, the King simply stays sunk.
  trySwapKingToSafety(defender, kingIndex, kingR, kingC) {
    const candidates = defender.ships
      .map((s, i) => i)
      .filter((i) => KING_PROTECTS.includes(defender.ships[i].name)
        && defender.ships[i].cells.every(({ r, c }) => defender.shotsAtMe[r][c] !== 'hit'));
    if (!candidates.length) {
      this.pushLog(`👑 ${defender.name}'s King had no undamaged ship left to swap with — sunk for good.`);
      return;
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const partner = defender.ships[pick];
    const vacatedCells = partner.cells; // captured BEFORE relocatePartnerToKingsSpot reassigns it
    const relocated = relocatePartnerToKingsSpot(defender, pick, kingR, kingC, this.gridSize);
    if (!relocated) {
      this.pushLog(`👑 ${defender.name}'s King had nowhere to swap to — sunk for good.`);
      return;
    }
    NUCLEAR_DELTAS.forEach(([dr, dc]) => {
      const nr = kingR + dr;
      const nc = kingC + dc;
      if (!inBounds(nr, nc, this.gridSize)) return;
      if (defender.grid[nr][nc] !== null) return; // a ship's here -- leave its shot record alone
      defender.shotsAtMe[nr][nc] = null; // heal -- back to pristine, unfired water
    });
    const newKingCell = vacatedCells[Math.floor(Math.random() * vacatedCells.length)];
    const king = defender.ships[kingIndex];
    king.cells = [newKingCell];
    king.sunk = false;
    defender.grid[newKingCell.r][newKingCell.c] = kingIndex;
    this.pushLog(`👑 ${defender.name}'s King swapped places with the ${partner.name} to escape certain death!`);
  }

  // Tracks `player`'s own consecutive-miss streak (across their own fire()
  // calls only, ignoring the opponent's turns in between); reveals one
  // random still-hidden supply drop on the opponent's board once it hits
  // the threshold, then resets so it can trigger again later.
  registerMissStreak(player, opponent, anyHit) {
    if (anyHit) { player.missStreak = 0; return; }
    player.missStreak += 1;
    if (player.missStreak < MISS_STREAK_HINT_THRESHOLD) return;
    player.missStreak = 0;
    const hint = pickHintCell(opponent, null);
    if (hint) {
      opponent.hintedCells.push(hint);
      this.pushLog(`🧭 ${player.name}'s cold streak revealed a ${WEAPON_LABELS[hint.weapon]} supply drop on ${opponent.name}'s board!`);
    }
  }

  // Applies one shot (or, if `weapon` is given and the player holds a
  // charge of it, one special-weapon volley) from `player` at (r, c) on
  // their opponent's grid. A hit anywhere in the volley keeps the turn
  // with `player`; an all-miss volley passes it to the opponent.
  fire(player, r, c, weapon) {
    if (this.status !== 'playing') return { ok: false, error: 'not-playing' };
    if (this.currentPlayer().id !== player.id) return { ok: false, error: 'not-your-turn' };
    if (!inBounds(r, c, this.gridSize)) return { ok: false, error: 'out-of-bounds' };
    const opponent = this.opponentOf(player);
    if (!opponent) return { ok: false, error: 'no-opponent' };
    if (opponent.shotsAtMe[r][c] !== null) return { ok: false, error: 'already-fired' };
    let usedWeapon = null;
    if (weapon) {
      if (!WEAPON_TYPES.includes(weapon)) return { ok: false, error: 'invalid-weapon' };
      if (!player.ammo[weapon]) return { ok: false, error: 'no-ammo' };
      player.ammo[weapon] -= 1;
      usedWeapon = weapon;
    }

    // Spend this player's clocks BEFORE resolving the shot, since the
    // clocks measure how long they took to decide, not what happened.
    this.chargeElapsedTime(player);
    clearTimeout(this.turnTimer);
    clearTimeout(this.timeBankTimer);

    const targetCells = weaponCells(usedWeapon, r, c, opponent.shotsAtMe, this.gridSize);
    const shotResults = [];
    targetCells.forEach(({ r: tr, c: tc }) => {
      if (opponent.shotsAtMe[tr][tc] !== null) return; // secondary blast cell already fired at -- no-op
      shotResults.push(this.applyShotToCell(player, opponent, tr, tc));
    });
    const suppliesFound = shotResults.map((res) => res.suppliesFoundEntry).filter(Boolean);
    shotResults.forEach((res) => { delete res.suppliesFoundEntry; });

    this.moveSeq += 1;
    const anyHit = shotResults.some((res) => res.result === 'hit');
    this.registerMissStreak(player, opponent, anyHit);
    const gameOver = opponent.ships.every((s) => s.sunk);
    this.lastShot = {
      seq: this.moveSeq,
      playerId: player.id,
      r,
      c,
      weapon: usedWeapon,
      cells: shotResults,
      suppliesFound,
      gameOver,
      continuesTurn: anyHit && !gameOver,
    };

    this.logShot(player, opponent, usedWeapon, shotResults, suppliesFound, anyHit, gameOver);

    if (gameOver) {
      this.finishGame(player, `${player.name} wins — ${opponent.name}'s fleet is sunk!`);
    } else {
      if (!anyHit) this.currentPlayerIndex = this.players.indexOf(opponent);
      this.scheduleTurnTimers();
      this.scheduleBotTurn();
    }
    return { ok: true, result: { cells: shotResults, suppliesFound, weapon: usedWeapon } };
  }

  logShot(player, opponent, weapon, shotResults, suppliesFound, anyHit, gameOver) {
    const weaponNote = weapon ? ` using a ${WEAPON_LABELS[weapon]}` : '';
    if (shotResults.length <= 1) {
      const only = shotResults[0];
      if (!only) {
        this.pushLog(`${player.name} fired${weaponNote} — every affected cell was already shot.`);
      } else if (only.result === 'miss') {
        this.pushLog(`${player.name} fired at (${only.r + 1}, ${only.c + 1})${weaponNote} — miss.`);
      } else if (only.sunkShip) {
        this.pushLog(`💥 ${player.name} fired at (${only.r + 1}, ${only.c + 1})${weaponNote} — hit! Sank ${opponent.name}'s ${only.sunkShip.name}!`);
      } else {
        this.pushLog(`💥 ${player.name} fired at (${only.r + 1}, ${only.c + 1})${weaponNote} — hit!`);
      }
    } else {
      const hitCount = shotResults.filter((res) => res.result === 'hit').length;
      const missCount = shotResults.length - hitCount;
      this.pushLog(`💣 ${player.name} fired${weaponNote} — ${hitCount} hit${hitCount === 1 ? '' : 's'}, ${missCount} miss${missCount === 1 ? '' : 'es'}.`);
      shotResults.filter((res) => res.sunkShip).forEach((res) => this.pushLog(`💥 Sank ${opponent.name}'s ${res.sunkShip.name}!`));
    }
    suppliesFound.forEach((found) => {
      this.pushLog(found.wasted
        ? `🎁 ${player.name} found a supply drop, but already held a ${WEAPON_LABELS[found.weapon]} — wasted.`
        : `🎁 ${player.name} found a supply drop — gained a ${WEAPON_LABELS[found.weapon]}!`);
    });
    if (anyHit && !gameOver) this.pushLog(`${player.name} hit a ship — fires again!`);
  }

  finishGame(winner, resultText) {
    this.status = 'finished';
    this.winnerId = winner.id;
    this.resultText = resultText;
    this.pushLog(`🏁 ${this.resultText}`);
    clearTimeout(this.botTimer);
    clearTimeout(this.turnTimer);
    clearTimeout(this.timeBankTimer);
  }

  newGame() {
    if (this.status !== 'finished') return { ok: false, error: 'not-finished' };
    this.beginPlacement();
    return { ok: true };
  }

  // Deducts however long the current turn has actually taken so far from
  // `player`'s time bank (a no-op if time banks are unlimited or no turn
  // is in progress). Called right before the turn ends, whether that's
  // because the player fired for real or because they were auto-fired
  // for on a per-turn timeout.
  chargeElapsedTime(player) {
    if (player.timeBankMsRemaining === null || this.turnStartedAt === null) return;
    const elapsed = Date.now() - this.turnStartedAt;
    player.timeBankMsRemaining = Math.max(0, player.timeBankMsRemaining - elapsed);
  }

  // Arms the per-turn clock and/or the time-bank clock for whoever's turn
  // it now is, IF they're human (bots run on their own separate
  // scheduleBotTurn() delay and are never subject to either clock) and
  // the room is actually mid-game. Both clocks race independently: the
  // per-turn timer auto-fires a shot (and keeps the game going); the
  // time-bank timer ends the game outright the moment it fires.
  scheduleTurnTimers() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.timeBankTimer);
    this.turnStartedAt = null;
    if (this.status !== 'playing') return;
    const player = this.currentPlayer();
    if (!player || player.isBot) return;
    this.turnStartedAt = Date.now();
    if (this.timePerTurn) {
      this.turnTimer = setTimeout(() => this.handleTurnTimeout(player), this.timePerTurn * 1000);
    }
    if (player.timeBankMsRemaining !== null) {
      this.timeBankTimer = setTimeout(() => this.handleTimeBankExpired(player), player.timeBankMsRemaining);
    }
  }

  // The per-turn clock ran out on `player` -- fire a reasonable shot on
  // their behalf (same hunt-capable targeting the bots use) so the game
  // keeps moving. Does not end the game; a hit still earns the bonus
  // turn exactly as if they'd chosen it themselves.
  handleTurnTimeout(player) {
    if (this.status !== 'playing' || this.currentPlayer() !== player) return;
    const opponent = this.opponentOf(player);
    const sunkCells = new Set();
    opponent.ships.filter((s) => s.sunk).forEach((s) => s.cells.forEach(({ r, c }) => sunkCells.add(`${r},${c}`)));
    const shot = chooseBotShot(opponent.shotsAtMe, sunkCells, this.gridSize);
    if (!shot) return; // shouldn't happen -- gameOver would have caught a fully-shot grid already
    this.pushLog(`⏰ ${player.name} ran out of time for this turn — firing automatically.`);
    this.fire(player, shot.r, shot.c, null);
    if (this.nsp) this.broadcast(this.nsp);
  }

  // `player`'s total time bank hit zero mid-turn -- they lose immediately.
  handleTimeBankExpired(player) {
    if (this.status !== 'playing' || this.currentPlayer() !== player) return;
    player.timeBankMsRemaining = 0;
    const opponent = this.opponentOf(player);
    this.finishGame(opponent, `${opponent.name} wins — ${player.name} ran out of time!`);
    if (this.nsp) this.broadcast(this.nsp);
  }

  // Bots fire after a short human-like delay, same pattern as the other
  // games' bot AI. Uses this.nsp (set once in attachBattleship() right
  // after room creation) so a bot-vs-bot game keeps ticking on its own.
  scheduleBotTurn() {
    clearTimeout(this.botTimer);
    const player = this.currentPlayer();
    if (!player || !player.isBot || this.status !== 'playing') return;
    this.botTimer = setTimeout(() => {
      if (this.status !== 'playing') return;
      const opponent = this.opponentOf(player);
      const sunkCells = new Set();
      opponent.ships.filter((s) => s.sunk).forEach((s) => s.cells.forEach(({ r, c }) => sunkCells.add(`${r},${c}`)));
      const shot = chooseBotShot(opponent.shotsAtMe, sunkCells, this.gridSize);
      if (!shot) return; // shouldn't happen -- gameOver would have caught a fully-shot grid already
      const weapon = WEAPON_TYPES.find((w) => player.ammo[w] > 0) || null; // spend any held charge rather than hoard it
      this.fire(player, shot.r, shot.c, weapon);
      if (this.nsp) this.broadcast(this.nsp);
    }, BOT_THINK_MS_MIN + Math.random() * (BOT_THINK_MS_MAX - BOT_THINK_MS_MIN));
  }

  addBot() {
    const botName = BOT_NAMES[this.botCounter % BOT_NAMES.length];
    this.botCounter += 1;
    this.players.push({
      id: `bot_${this.id}_${this.botCounter}`, name: botName, connected: true, socketId: null, isBot: true,
      ships: null, grid: null, shotsAtMe: freshGrid(this.gridSize), ready: false,
      supplyGrid: null, ammo: freshAmmo(), foundOnBoard: [], hintedCells: [], missStreak: 0, timeBankMsRemaining: null,
    });
    this.pushLog(`${botName} joined the table.`);
  }

  // The LIVE remaining time-bank for `player`, accounting for however
  // much of their current turn (if any) has already elapsed -- purely
  // for display; the authoritative deduction happens in
  // chargeElapsedTime() when their turn actually ends.
  liveTimeBankMs(player) {
    if (player.timeBankMsRemaining === null) return null;
    if (this.currentPlayer() !== player || this.turnStartedAt === null) return player.timeBankMsRemaining;
    const elapsed = Date.now() - this.turnStartedAt;
    return Math.max(0, player.timeBankMsRemaining - elapsed);
  }

  state(forPlayerId) {
    const me = this.findPlayer(forPlayerId);
    const opponent = me ? this.opponentOf(me) : null;
    const finished = this.status === 'finished';
    const isCurrentPlayerTurn = this.status === 'playing' && this.turnStartedAt !== null;
    const turnElapsedMs = isCurrentPlayerTurn ? Date.now() - this.turnStartedAt : 0;
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      gridSize: this.gridSize,
      fleetSpec: this.fleetSpec,
      includeKing: this.includeKing,
      weaponTypes: WEAPON_TYPES,
      weaponLabels: WEAPON_LABELS,
      timePerTurn: this.timePerTurn,
      timeBankSeconds: this.timeBankSeconds,
      firstPlayer: this.firstPlayer,
      mapTheme: this.mapTheme,
      mapThemeLabel: MAP_THEMES[this.mapTheme],
      startingAmmo: this.startingAmmo,
      hostPlayerId: this.hostPlayerId,
      turnTimeRemainingMs: (this.timePerTurn && isCurrentPlayerTurn)
        ? Math.max(0, this.timePerTurn * 1000 - turnElapsedMs) : null,
      currentPlayerId: this.players.length ? this.currentPlayer().id : null,
      log: this.log,
      winnerId: this.winnerId,
      resultText: this.resultText,
      lastShot: this.lastShot,
      moveSeq: this.moveSeq,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isBot: Boolean(p.isBot),
        ready: p.ready,
        shipsRemaining: p.ships ? p.ships.filter((s) => !s.sunk).length : null,
        timeBankMsRemaining: this.liveTimeBankMs(p),
      })),
      yourId: forPlayerId || null,
      you: me && me.ships ? {
        grid: me.grid,
        shots: me.shotsAtMe,
        ships: me.ships.map((s) => ({ name: s.name, size: s.size, sunk: s.sunk })),
        ammo: me.ammo,
        foundOnBoard: me.foundOnBoard, // supply drops the OPPONENT has found on MY board -- public once discovered
        // Wherever the King ship currently sits, as long as it's still alive
        // (it moves every time it dodges death -- see trySwapKingToSafety())
        // -- lets the client badge that one cell so the King's current spot
        // reads as "the King", not just an anonymous plain ship cell.
        kingPosition: (() => {
          const king = me.ships.find((s) => s.name === 'King');
          return king && !king.sunk ? { r: king.cells[0].r, c: king.cells[0].c } : null;
        })(),
      } : null,
      opponent: opponent && opponent.ships ? {
        shots: opponent.shotsAtMe, // the shots recorded on the opponent's board ARE my shots against them, 1v1
        revealedShips: (finished ? opponent.ships : opponent.ships.filter((s) => s.sunk))
          .map((s) => ({ name: s.name, cells: s.cells, sunk: s.sunk })),
        foundOnBoard: opponent.foundOnBoard, // supply drops I have found on THEIR board
        hintedCells: opponent.hintedCells, // still-hidden drops hinted to ME on THEIR board (sink/streak rewards)
      } : null,
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('battleship:state', this.state(p.id));
    });
  }
}

function attachBattleship(io) {
  const nsp = io.of('/battleship');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].filter((r) => !r.isEmpty()).map((r) => r.summary());
  }

  function broadcastRoomList() {
    nsp.emit('battleship:rooms', roomList());
  }

  nsp.on('connection', (socket) => {
    function myRoom() {
      return rooms.get(socket.roomId);
    }

    socket.on('battleship:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('battleship:createRoom', ({
      roomName, password, playerId, name, gridSize, timePerTurn, timeBankMinutes, firstPlayer, mapTheme, includeKing, startingAmmo,
    }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const room = new BattleshipRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, {
        gridSize, timePerTurn, timeBankMinutes, firstPlayer, mapTheme, includeKing, startingAmmo,
      });
      room.nsp = nsp;
      room.hostPlayerId = playerId;
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({
        id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false,
        ships: null, grid: null, shotsAtMe: freshGrid(room.gridSize), ready: false,
        supplyGrid: null, ammo: freshAmmo(), foundOnBoard: [], hintedCells: [], missStreak: 0, timeBankMsRemaining: null,
      });
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('battleship:joinRoom', ({ roomId, password, playerId, name }, callback) => {
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
        room.players.push({
          id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false,
          ships: null, grid: null, shotsAtMe: freshGrid(room.gridSize), ready: false,
          supplyGrid: null, ammo: freshAmmo(), foundOnBoard: [], hintedCells: [], missStreak: 0, timeBankMsRemaining: null,
        });
        room.pushLog(`${clean} joined the room.`);
      }

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('battleship:addBot', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length >= MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'table-full' }); return; }
      room.addBot();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('battleship:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length < MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'not-enough-players' }); return; }
      room.beginPlacement();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('battleship:submitFleet', ({ ships }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.submitFleet(player, ships);
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('battleship:fire', ({ r, c, weapon }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.fire(player, Number(r), Number(c), weapon || null);
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('battleship:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const result = room.newGame();
      if (typeof callback === 'function') callback(result);
      if (result.ok) room.broadcast(nsp);
    });

    socket.on('battleship:leave', () => {
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

module.exports = attachBattleship;
module.exports.BattleshipRoom = BattleshipRoom;
module.exports.validateFleet = validateFleet;
module.exports.randomFleet = randomFleet;
module.exports.resolveShot = resolveShot;
module.exports.chooseBotShot = chooseBotShot;
module.exports.freshGrid = freshGrid;
module.exports.FLEET_SPEC = FLEET_SPEC;
module.exports.NON_KING_FLEET_SPEC = NON_KING_FLEET_SPEC;
module.exports.fleetSpecFor = fleetSpecFor;
module.exports.TOTAL_SHIP_CELLS = TOTAL_SHIP_CELLS;
module.exports.MAX_PLAYERS = MAX_PLAYERS;
module.exports.WEAPON_TYPES = WEAPON_TYPES;
module.exports.WEAPON_LABELS = WEAPON_LABELS;
module.exports.MAX_AMMO_PER_TYPE = MAX_AMMO_PER_TYPE;
module.exports.SCATTER_MIN_EXTRA = SCATTER_MIN_EXTRA;
module.exports.SCATTER_MAX_EXTRA = SCATTER_MAX_EXTRA;
module.exports.seedSupplyDrops = seedSupplyDrops;
module.exports.supplyDropCountFor = supplyDropCountFor;
module.exports.weaponCells = weaponCells;
module.exports.freshAmmo = freshAmmo;
module.exports.VALID_GRID_SIZES = VALID_GRID_SIZES;
module.exports.DEFAULT_GRID_SIZE = DEFAULT_GRID_SIZE;
module.exports.TURN_TIME_OPTIONS = TURN_TIME_OPTIONS;
module.exports.TIME_BANK_MINUTE_OPTIONS = TIME_BANK_MINUTE_OPTIONS;
module.exports.FIRST_PLAYER_OPTIONS = FIRST_PLAYER_OPTIONS;
module.exports.MAP_THEMES = MAP_THEMES;
module.exports.DEFAULT_MAP_THEME = DEFAULT_MAP_THEME;
module.exports.sanitizeOptions = sanitizeOptions;
module.exports.STARTING_AMMO_MAX = STARTING_AMMO_MAX;
module.exports.SHIP_SIZE_TO_HINT_WEAPON = SHIP_SIZE_TO_HINT_WEAPON;
module.exports.MISS_STREAK_HINT_THRESHOLD = MISS_STREAK_HINT_THRESHOLD;
module.exports.pickHintCell = pickHintCell;
module.exports.relocatePartnerToKingsSpot = relocatePartnerToKingsSpot;
module.exports.kingReplacementCandidates = kingReplacementCandidates;
module.exports.centerIndices = centerIndices;
module.exports.allLineIndices = allLineIndices;
module.exports.KING_PROTECTS = KING_PROTECTS;
