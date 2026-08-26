// Battleship — a sixth backup game alongside UNO, Exploding Kittens, Go,
// Đuổi Niên Thú, and Ô Ăn Quan. Same "casual side activity" contract as
// those: its own Socket.IO namespace, no leaderboard, no admin open/close
// gating (see server.js).
//
// Rules: each player secretly places the same standard 5-ship fleet
// (Carrier 5, Battleship 4, Cruiser 3, Submarine 3, Destroyer 2 — 17
// cells total, regardless of board size) on a host-chosen NxN grid, then
// players fire single shots at each other's grid. A HIT keeps the turn
// with the same player (fire again); a MISS passes the turn. Fog of war
// is enforced server-side: a player's own state never includes the
// opponent's unsunk ship positions — only shot results (hit/miss) and,
// once a ship is fully sunk, that one ship's cells.
//
// Special ammunition (inspired by papergames.io's Battleship, with this
// project's own chosen shapes/rates -- see battleship.html's rules
// modal): each player's own board secretly hides a few "supply drop"
// cells (plain water, never on top of a ship -- the count scales with
// board area). If the OPPONENT hits one, they immediately gain one
// charge of a randomly-chosen special weapon (capped at 1 charge held
// per type at a time -- finding a duplicate while already holding one is
// wasted). Before firing, a player holding a charge may spend it instead
// of firing a normal single shot:
//   - Cross shot: the target cell plus every orthogonal neighbor that
//     exists (up to 4 extra, a "+" shape, fewer at edges/corners).
//   - Nuclear bomb: the target cell plus its 4 orthogonal neighbors (the
//     same footprint as a cross shot, per this project's own weapon
//     design -- the two are currently equal in blast radius; only their
//     rarity/name differ. Widen this shape here if that's ever revisited).
//   - Scatter shot: the target cell plus a random 3-7 OTHER cells chosen
//     from anywhere still unfired on the board.
// A special weapon's hit/miss/turn-continuation rules are identical to a
// normal shot's, just evaluated once per affected cell -- landing at
// least one hit among all of them still earns the bonus turn.
//
// Host-configurable room settings (chosen at oaq:createRoom time, fixed
// for that room's whole lifetime including rematches):
//   - Board size: 10x10 / 15x15 / 20x20. The fleet stays the same 17
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
];
const TOTAL_SHIP_CELLS = FLEET_SPEC.reduce((sum, s) => sum + s.size, 0);

// -- Special ammunition -----------------------------------------------
const WEAPON_TYPES = ['cross', 'nuclear', 'scatter'];
const WEAPON_LABELS = { cross: 'Cross Shot', nuclear: 'Nuclear Bomb', scatter: 'Scatter Shot' };
const MAX_AMMO_PER_TYPE = 1; // charges of the same weapon a player can hold at once
const SCATTER_MIN_EXTRA = 3;
const SCATTER_MAX_EXTRA = 7;

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
// player's board. Rejection sampling, same spirit as randomFleet() --
// trivially converges given how few cells are needed relative to the
// board area.
function seedSupplyDrops(shipGrid, size) {
  const supplyGrid = freshGrid(size, false);
  const dropCount = supplyDropCountFor(size);
  let placed = 0;
  let attempts = 0;
  while (placed < dropCount && attempts < 2000) {
    attempts += 1;
    const r = Math.floor(Math.random() * size);
    const c = Math.floor(Math.random() * size);
    if (shipGrid[r][c] !== null || supplyGrid[r][c]) continue;
    supplyGrid[r][c] = true;
    placed += 1;
  }
  return supplyGrid;
}

const NEIGHBOR_DELTAS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// The cell set a given weapon affects when fired at (r, c). `shotsGrid`
// (the defender's incoming-shots record) is only needed by scatter shot,
// to pick its random extra cells from ones that haven't been fired at
// yet -- wasting a random cell on already-revealed water would be a dud
// with no point to it. A plain (no-weapon) shot just hits the one cell.
function weaponCells(weapon, r, c, shotsGrid, size) {
  if (weapon === 'cross' || weapon === 'nuclear') {
    const cells = [{ r, c }];
    NEIGHBOR_DELTAS.forEach(([dr, dc]) => {
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

// Validates a client-submitted fleet against FLEET_SPEC: exactly one ship
// per spec (matched by name+size), every ship's cells form a straight,
// contiguous line of the right length, fully in-bounds for this room's
// `size`, and no ship overlaps another. Returns { grid, ships } on
// success (grid[r][c] is the index into `ships`, or null for water) or
// null if anything is invalid.
function validateFleet(rawShips, size) {
  if (!Array.isArray(rawShips) || rawShips.length !== FLEET_SPEC.length) return null;
  const grid = freshGrid(size);
  const usedNames = new Set();
  const ships = [];

  for (let i = 0; i < rawShips.length; i += 1) {
    const raw = rawShips[i];
    if (!raw || typeof raw.name !== 'string') return null;
    const spec = FLEET_SPEC.find((f) => f.name === raw.name);
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

  if (usedNames.size !== FLEET_SPEC.length) return null;
  return { grid, ships };
}

// Rejection-sampling random placer -- used for bots (and available to the
// client as the "Randomize" convenience, though the client does its own
// equivalent locally rather than round-tripping through the server for
// it). Only 17 ship cells on even the smallest supported board means
// this converges in only a few attempts almost always; a generous retry
// cap keeps it provably terminating rather than a true infinite loop.
function randomFleet(size) {
  const grid = freshGrid(size);
  const ships = [];
  for (let i = 0; i < FLEET_SPEC.length; i += 1) {
    const spec = FLEET_SPEC[i];
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
    if (!placed) return randomFleet(size); // pathologically unlucky run -- just start over
  }
  return { grid, ships };
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
  return { result: 'hit', ship, sunk };
}

function sanitizeOptions(raw) {
  const opts = raw || {};
  const gridSize = VALID_GRID_SIZES.includes(Number(opts.gridSize)) ? Number(opts.gridSize) : DEFAULT_GRID_SIZE;
  const timePerTurn = TURN_TIME_OPTIONS.includes(Number(opts.timePerTurn)) ? Number(opts.timePerTurn) : null;
  const timeBankMinutes = TIME_BANK_MINUTE_OPTIONS.includes(Number(opts.timeBankMinutes)) ? Number(opts.timeBankMinutes) : null;
  const firstPlayer = FIRST_PLAYER_OPTIONS.includes(opts.firstPlayer) ? opts.firstPlayer : 'random';
  const mapTheme = MAP_THEMES[opts.mapTheme] ? opts.mapTheme : DEFAULT_MAP_THEME;
  return {
    gridSize,
    timePerTurn,
    timeBankSeconds: timeBankMinutes ? timeBankMinutes * 60 : null,
    firstPlayer,
    mapTheme,
  };
}

class BattleshipRoom {
  constructor(id, name, password, options) {
    this.id = id;
    this.name = name;
    this.password = password;
    const { gridSize, timePerTurn, timeBankSeconds, firstPlayer, mapTheme } = sanitizeOptions(options);
    this.gridSize = gridSize;
    this.timePerTurn = timePerTurn; // seconds, or null for unlimited
    this.timeBankSeconds = timeBankSeconds; // seconds, or null for unlimited
    this.firstPlayer = firstPlayer; // 'random' | 'host' | 'opponent'
    this.mapTheme = mapTheme;
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
      p.ammo = freshAmmo();
      p.foundOnBoard = []; // supply drops found ON this player's board (by their opponent)
      p.timeBankMsRemaining = (this.timeBankSeconds && !p.isBot) ? this.timeBankSeconds * 1000 : null;
    });
    this.pushLog(`🚢 Place your fleet! (${this.gridSize}x${this.gridSize} — ${MAP_THEMES[this.mapTheme]})`);
    clearTimeout(this.botTimer);
    clearTimeout(this.turnTimer);
    clearTimeout(this.timeBankTimer);
    this.players.filter((p) => p.isBot).forEach((bot) => this.submitFleet(bot, randomFleet(this.gridSize).ships));
  }

  // Applies one player's fleet placement. Returns { ok, error? }.
  submitFleet(player, rawShips) {
    if (this.status !== 'placing') return { ok: false, error: 'not-placing' };
    if (player.ready) return { ok: false, error: 'already-ready' };
    const validated = validateFleet(rawShips, this.gridSize);
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
    const suppliesFound = [];
    targetCells.forEach(({ r: tr, c: tc }) => {
      if (opponent.shotsAtMe[tr][tc] !== null) return; // secondary blast cell already fired at -- no-op
      const res = resolveShot(opponent.grid, opponent.ships, opponent.shotsAtMe, tr, tc);
      shotResults.push({
        r: tr, c: tc, result: res.result,
        sunkShip: res.sunk ? { name: res.ship.name, cells: res.ship.cells } : null,
      });
      if (opponent.supplyGrid && opponent.supplyGrid[tr][tc]) {
        opponent.supplyGrid[tr][tc] = false;
        const granted = WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)];
        const wasted = player.ammo[granted] >= MAX_AMMO_PER_TYPE;
        player.ammo[granted] = Math.min(MAX_AMMO_PER_TYPE, player.ammo[granted] + 1);
        suppliesFound.push({ r: tr, c: tc, weapon: granted, wasted });
        opponent.foundOnBoard.push({ r: tr, c: tc, weapon: granted });
      }
    });

    this.moveSeq += 1;
    const anyHit = shotResults.some((res) => res.result === 'hit');
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
      supplyGrid: null, ammo: freshAmmo(), foundOnBoard: [], timeBankMsRemaining: null,
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
      fleetSpec: FLEET_SPEC,
      weaponTypes: WEAPON_TYPES,
      weaponLabels: WEAPON_LABELS,
      timePerTurn: this.timePerTurn,
      timeBankSeconds: this.timeBankSeconds,
      firstPlayer: this.firstPlayer,
      mapTheme: this.mapTheme,
      mapThemeLabel: MAP_THEMES[this.mapTheme],
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
      } : null,
      opponent: opponent && opponent.ships ? {
        shots: opponent.shotsAtMe, // the shots recorded on the opponent's board ARE my shots against them, 1v1
        revealedShips: (finished ? opponent.ships : opponent.ships.filter((s) => s.sunk))
          .map((s) => ({ name: s.name, cells: s.cells, sunk: s.sunk })),
        foundOnBoard: opponent.foundOnBoard, // supply drops I have found on THEIR board
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
      roomName, password, playerId, name, gridSize, timePerTurn, timeBankMinutes, firstPlayer, mapTheme,
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
        gridSize, timePerTurn, timeBankMinutes, firstPlayer, mapTheme,
      });
      room.nsp = nsp;
      room.hostPlayerId = playerId;
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({
        id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false,
        ships: null, grid: null, shotsAtMe: freshGrid(room.gridSize), ready: false,
        supplyGrid: null, ammo: freshAmmo(), foundOnBoard: [], timeBankMsRemaining: null,
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
          supplyGrid: null, ammo: freshAmmo(), foundOnBoard: [], timeBankMsRemaining: null,
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
