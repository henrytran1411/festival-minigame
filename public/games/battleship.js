const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/battleship');
  const LAST_ROOM_KEY = 'battleship_last_room_id';
  // Set to whatever the room's state says (10/15/20) as soon as we know it
  // -- defaults to the standard size only for the brief window before any
  // state has arrived (lobby screen, which never needs a grid at all).
  let GRID_SIZE = 10;
  const FLEET_SPEC = [
    { name: 'Carrier', size: 5 },
    { name: 'Battleship', size: 4 },
    { name: 'Cruiser', size: 3 },
    { name: 'Submarine', size: 3 },
    { name: 'Destroyer', size: 2 },
    { name: 'King', size: 1 },
  ];
  // Cell pixel size shrinks as the board grows so a 20x20 arena still fits
  // on screen without horizontal scrolling.
  const CELL_SIZE_FOR = { 10: 26, 15: 19, 20: 15 };
  // Semi-transparent so the theme's background photo (set on .bs-boards,
  // see THEME_IMAGES below) shows through behind the grid instead of being
  // fully hidden by a flat water color.
  const THEME_COLORS = {
    bachdang: { water: 'rgba(43, 42, 20, 0.6)', deep: 'rgba(33, 31, 13, 0.72)' },
    benhai: { water: 'rgba(15, 45, 50, 0.6)', deep: 'rgba(10, 34, 38, 0.72)' },
    songgianh: { water: 'rgba(18, 40, 55, 0.6)', deep: 'rgba(12, 30, 42, 0.72)' },
    songhan: { water: 'rgba(10, 40, 58, 0.6)', deep: 'rgba(7, 30, 44, 0.72)' },
    songhuong: { water: 'rgba(16, 48, 46, 0.6)', deep: 'rgba(11, 36, 35, 0.72)' },
    songhong: { water: 'rgba(51, 28, 20, 0.6)', deep: 'rgba(38, 20, 14, 0.72)' },
    songlam: { water: 'rgba(20, 46, 32, 0.6)', deep: 'rgba(14, 34, 24, 0.72)' },
    songlo: { water: 'rgba(14, 44, 50, 0.6)', deep: 'rgba(9, 33, 38, 0.72)' },
    thubon: { water: 'rgba(38, 40, 18, 0.6)', deep: 'rgba(28, 30, 13, 0.72)' },
    songda: { water: 'rgba(12, 26, 40, 0.6)', deep: 'rgba(8, 19, 30, 0.72)' },
    songday: { water: 'rgba(14, 42, 48, 0.6)', deep: 'rgba(9, 31, 36, 0.72)' },
    cuulong: { water: 'rgba(45, 38, 22, 0.6)', deep: 'rgba(34, 28, 15, 0.72)' },
    saigon: { water: 'rgba(20, 34, 44, 0.6)', deep: 'rgba(14, 25, 33, 0.72)' },
    serepok: { water: 'rgba(24, 42, 28, 0.6)', deep: 'rgba(17, 31, 20, 0.72)' },
    vamco: { water: 'rgba(30, 40, 26, 0.6)', deep: 'rgba(22, 30, 18, 0.72)' },
    dongnai: { water: 'rgba(16, 36, 42, 0.6)', deep: 'rgba(11, 27, 31, 0.72)' },
    hoangsa: { water: 'rgba(8, 34, 52, 0.6)', deep: 'rgba(5, 25, 40, 0.72)' },
    truongsa: { water: 'rgba(6, 40, 50, 0.6)', deep: 'rgba(4, 30, 38, 0.72)' },
  };
  // Filenames have spaces and Vietnamese diacritics -- percent-encoded so
  // they resolve correctly from a CSS url(...). Paths are relative to this
  // page (public/games/).
  const THEME_IMAGES = {
    bachdang: 'theme/battleship/S%C3%B4ng%20B%E1%BA%A1ch%20%C4%90%E1%BA%B1ng.png',
    benhai: 'theme/battleship/S%C3%B4ng%20B%E1%BA%BFn%20H%E1%BA%A3i.png',
    songgianh: 'theme/battleship/S%C3%B4ng%20Gianh.png',
    songhan: 'theme/battleship/S%C3%B4ng%20H%C3%A0n.png',
    songhuong: 'theme/battleship/S%C3%B4ng%20H%C6%B0%C6%A1ng.png',
    songhong: 'theme/battleship/S%C3%B4ng%20H%E1%BB%93ng.png',
    songlam: 'theme/battleship/S%C3%B4ng%20Lam.png',
    songlo: 'theme/battleship/S%C3%B4ng%20L%C3%B4.png',
    thubon: 'theme/battleship/S%C3%B4ng%20Thu%20B%E1%BB%93n.png',
    songda: 'theme/battleship/S%C3%B4ng%20%C4%90%C3%A0.png',
    songday: 'theme/battleship/S%C3%B4ng%20%C4%90%C3%A1y.png',
    cuulong: 'theme/battleship/S%C3%B4ng%20C%E1%BB%ADu%20Long.png',
    saigon: 'theme/battleship/S%C3%B4ng%20S%C3%A0i%20G%C3%B2n.jpg',
    serepok: 'theme/battleship/S%C3%B4ng%20S%C3%AAr%C3%AAp%C3%B4k.png',
    vamco: 'theme/battleship/S%C3%B4ng%20V%C3%A0m%20C%E1%BB%8F.png',
    dongnai: 'theme/battleship/S%C3%B4ng%20%C4%90%E1%BB%93ng%20Nai.png',
    hoangsa: 'theme/battleship/Ho%C3%A0ng%20Sa.png',
    truongsa: 'theme/battleship/Tr%C6%B0%E1%BB%9Dng%20sa.png',
  };
  const DEFAULT_THEME = 'bachdang';
  // The room's mapTheme is only a shared DEFAULT -- each player can pick
  // their own map independently, purely as a local rendering preference
  // (no gameplay effect, so it never needs to touch the server). Stored
  // per-browser; empty/absent means "follow the room's default".
  const MY_THEME_KEY = 'battleship_my_theme';
  function myThemeOverride() { return localStorage.getItem(MY_THEME_KEY) || ''; }
  const bsWrapEl = document.querySelector('.bs-wrap');
  const myThemeSelect = document.getElementById('my-theme-select');
  function applyBoardStyling(state) {
    GRID_SIZE = state.gridSize || GRID_SIZE;
    const cellSize = CELL_SIZE_FOR[GRID_SIZE] || 26;
    const themeKey = myThemeOverride() || state.mapTheme || DEFAULT_THEME;
    const theme = THEME_COLORS[themeKey] || THEME_COLORS[DEFAULT_THEME];
    const imageUrl = THEME_IMAGES[themeKey] || THEME_IMAGES[DEFAULT_THEME];
    bsWrapEl.style.setProperty('--bs-cell-size', `${cellSize}px`);
    bsWrapEl.style.setProperty('--bs-label-size', `${Math.max(14, cellSize - 6)}px`);
    bsWrapEl.style.setProperty('--bs-cols', String(GRID_SIZE));
    bsWrapEl.style.setProperty('--bs-water', theme.water);
    bsWrapEl.style.setProperty('--bs-water-deep', theme.deep);
    bsWrapEl.style.setProperty('--bs-theme-image', `url("${imageUrl}")`);
    myThemeSelect.value = myThemeOverride();
  }
  myThemeSelect.value = myThemeOverride();
  myThemeSelect.addEventListener('change', () => {
    if (myThemeSelect.value) localStorage.setItem(MY_THEME_KEY, myThemeSelect.value);
    else localStorage.removeItem(MY_THEME_KEY);
    if (latestState) applyBoardStyling(latestState);
  });
  function formatClock(ms) {
    if (ms === null || ms === undefined) return '';
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const mm = Math.floor(totalSeconds / 60);
    const ss = totalSeconds % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  const lobbyScreen = document.getElementById('lobby-screen');
  const createRoomScreen = document.getElementById('create-room-screen');
  const waitingScreen = document.getElementById('waiting-screen');
  const placementScreen = document.getElementById('placement-screen');
  const gameScreen = document.getElementById('game-screen');
  const finishedScreen = document.getElementById('finished-screen');

  const roomListEl = document.getElementById('room-list');
  const noRoomsMsgEl = document.getElementById('no-rooms-msg');
  const showCreateBtn = document.getElementById('show-create-btn');
  const cancelCreateBtn = document.getElementById('cancel-create-btn');
  const createRoomBtn = document.getElementById('create-room-btn');
  const roomNameInput = document.getElementById('room-name-input');
  const roomPasswordInput = document.getElementById('room-password-input');
  const gridSizeSelect = document.getElementById('grid-size-select');
  const mapThemeSelect = document.getElementById('map-theme-select');
  const timePerTurnSelect = document.getElementById('time-per-turn-select');
  const timeBankSelect = document.getElementById('time-bank-select');
  const firstPlayerSelect = document.getElementById('first-player-select');
  const startCrossSelect = document.getElementById('start-cross-select');
  const startNuclearSelect = document.getElementById('start-nuclear-select');
  const startScatterSelect = document.getElementById('start-scatter-select');
  const createRoomErrorEl = document.getElementById('create-room-error');

  const passwordModal = document.getElementById('password-modal');
  const passwordModalTitle = document.getElementById('password-modal-title');
  const joinPasswordInput = document.getElementById('join-password-input');
  const passwordErrorEl = document.getElementById('password-error');
  const passwordSubmitBtn = document.getElementById('password-submit-btn');
  const passwordCancelBtn = document.getElementById('password-cancel-btn');

  const waitingRoomTitleEl = document.getElementById('waiting-room-title');
  const waitingConfigEl = document.getElementById('waiting-config');
  const playerListEl = document.getElementById('player-list');
  const startBtn = document.getElementById('start-btn');
  const addBotBtn = document.getElementById('add-bot-btn');
  const waitingLogEl = document.getElementById('waiting-log');
  const leaveWaitingBtn = document.getElementById('leave-waiting-btn');

  const shipListEl = document.getElementById('ship-list');
  const placementGridEl = document.getElementById('placement-grid');
  const rotateBtn = document.getElementById('rotate-btn');
  const randomizeBtn = document.getElementById('randomize-btn');
  const resetPlacementBtn = document.getElementById('reset-placement-btn');
  const confirmFleetBtn = document.getElementById('confirm-fleet-btn');
  const placementStatusEl = document.getElementById('placement-status');
  const leavePlacementBtn = document.getElementById('leave-placement-btn');

  const fleetStatusEl = document.getElementById('fleet-status');
  const turnBannerEl = document.getElementById('turn-banner');
  const turnClockEl = document.getElementById('turn-clock');
  const weaponPickerEl = document.getElementById('weapon-picker');

  // --- Clocks (time-per-turn + per-player time bank) ----------------------
  // The server is authoritative on when a clock actually expires -- this is
  // purely a locally-ticking display, resynced from the numbers in every
  // state broadcast so it can't drift far even if a broadcast is delayed.
  let clockSnapshot = null;
  function captureClockSnapshot(state) {
    clockSnapshot = {
      capturedAt: Date.now(),
      status: state.status,
      currentPlayerId: state.currentPlayerId,
      turnTimeRemainingMs: state.turnTimeRemainingMs,
      players: state.players.map((p) => ({ id: p.id, timeBankMsRemaining: p.timeBankMsRemaining })),
    };
  }
  function tickClocks() {
    if (!clockSnapshot || clockSnapshot.status !== 'playing') { turnClockEl.textContent = ''; return; }
    const elapsed = Date.now() - clockSnapshot.capturedAt;
    if (clockSnapshot.turnTimeRemainingMs !== null) {
      const remaining = Math.max(0, clockSnapshot.turnTimeRemainingMs - elapsed);
      turnClockEl.textContent = `⏱ ${formatClock(remaining)} left this turn`;
      turnClockEl.classList.toggle('low', remaining <= 10000);
    } else {
      turnClockEl.textContent = '';
    }
    clockSnapshot.players.forEach((p) => {
      const el = fleetStatusEl.querySelector(`[data-timebank-for="${p.id}"]`);
      if (!el) return;
      if (p.timeBankMsRemaining === null) { el.textContent = ''; return; }
      const isCurrent = p.id === clockSnapshot.currentPlayerId;
      const remaining = isCurrent ? Math.max(0, p.timeBankMsRemaining - elapsed) : p.timeBankMsRemaining;
      el.textContent = `⏳ ${formatClock(remaining)}`;
      el.classList.toggle('low', remaining <= 30000);
    });
  }
  setInterval(tickClocks, 1000);
  const enemyGridEl = document.getElementById('enemy-grid');
  const ownGridEl = document.getElementById('own-grid');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');

  const winnerTextEl = document.getElementById('winner-text');
  const finishedEnemyTitleEl = document.getElementById('finished-enemy-title');
  const finishedEnemyGridEl = document.getElementById('finished-enemy-grid');
  const finishedOwnGridEl = document.getElementById('finished-own-grid');
  const newGameBtn = document.getElementById('new-game-btn');

  const rulesModal = document.getElementById('rules-modal');

  let joined = false;
  let latestRooms = [];
  let latestState = null;
  let pendingJoinRoomId = null;

  // --- Placement (client-local until submitted) ---------------------------
  let placedShips = new Array(FLEET_SPEC.length).fill(null); // { cells: [{r,c},...] } | null
  let selectedShipIndex = 0;
  let orientation = 'horizontal';
  let hoverPreview = null; // { cells, valid }

  // --- Shot flash (brief highlight on the cell that was just fired at) ----
  let flashTargets = []; // [{ board: 'enemy'|'own', r, c }, ...] -- every cell the last shot/weapon affected
  let lastAnimatedShotSeq = null;
  let flashTimer = null;

  // --- Special ammo (client-side selection only; server is authoritative) -
  let selectedWeapon = null; // null | 'cross' | 'nuclear' | 'scatter'
  const WEAPON_ICONS = { cross: '➕', nuclear: '☢️', scatter: '💫' };

  function cellKey(r, c) { return `${r},${c}`; }

  // Classifies a ship cell so CSS can taper the two true ends of the hull
  // into a boat-like point (see .ship-h/.ship-v/.ship-start/.ship-end in
  // battleship.html) instead of every cell just being an identical square.
  // `sameShipAt(r, c)` should report whether the given cell belongs to the
  // same ship as the one being classified.
  function shipCellPosition(sameShipAt, r, c) {
    const up = sameShipAt(r - 1, c);
    const down = sameShipAt(r + 1, c);
    if (up || down) return { orientation: 'v', isStart: !up, isEnd: !down };
    const left = sameShipAt(r, c - 1);
    const right = sameShipAt(r, c + 1);
    return { orientation: 'h', isStart: !left, isEnd: !right };
  }

  function candidateCells(r, c, size, orient) {
    const cells = [];
    for (let k = 0; k < size; k += 1) cells.push(orient === 'horizontal' ? { r, c: c + k } : { r: r + k, c });
    return cells;
  }

  function cellsInBounds(cells) {
    return cells.every(({ r, c }) => r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE);
  }

  function occupiedCellSet(excludeIndex) {
    const occupied = new Set();
    placedShips.forEach((ship, i) => {
      if (!ship || i === excludeIndex) return;
      ship.cells.forEach(({ r, c }) => occupied.add(cellKey(r, c)));
    });
    return occupied;
  }

  function cellsValid(cells, excludeIndex) {
    if (!cellsInBounds(cells)) return false;
    const occupied = occupiedCellSet(excludeIndex);
    return !cells.some(({ r, c }) => occupied.has(cellKey(r, c)));
  }

  function updateSelectedShip() {
    const firstUnplaced = FLEET_SPEC.findIndex((_, i) => !placedShips[i]);
    selectedShipIndex = firstUnplaced;
  }

  function resetPlacementState() {
    placedShips = new Array(FLEET_SPEC.length).fill(null);
    orientation = 'horizontal';
    hoverPreview = null;
    updateSelectedShip();
    rotateBtn.textContent = '🔄 Rotate: Horizontal';
  }

  // --- Generic 11x11-cell grid builder (1 label row/col + 10x10 cells) ----
  function makeLabelCell(text) {
    const el = document.createElement('div');
    el.className = 'bs-cell label';
    el.textContent = text;
    return el;
  }
  function buildGrid(containerEl, cellRenderer) {
    containerEl.innerHTML = '';
    containerEl.appendChild(makeLabelCell(''));
    for (let c = 0; c < GRID_SIZE; c += 1) containerEl.appendChild(makeLabelCell(String.fromCharCode(65 + c)));
    for (let r = 0; r < GRID_SIZE; r += 1) {
      containerEl.appendChild(makeLabelCell(String(r + 1)));
      for (let c = 0; c < GRID_SIZE; c += 1) containerEl.appendChild(cellRenderer(r, c));
    }
  }

  function shipCellSets(revealedShips) {
    const shipCells = new Set();
    const sunkCells = new Set();
    (revealedShips || []).forEach((ship) => {
      ship.cells.forEach(({ r, c }) => {
        shipCells.add(cellKey(r, c));
        if (ship.sunk) sunkCells.add(cellKey(r, c));
      });
    });
    return { shipCells, sunkCells };
  }

  function revealedCellClass(hasShip, shotResult, isSunk) {
    if (hasShip) return shotResult === 'hit' ? (isSunk ? 'sunk' : 'hit') : 'ship';
    return shotResult === 'miss' ? 'miss' : 'water';
  }
  function fogCellClass(shotResult, isSunk) {
    if (shotResult === 'hit') return isSunk ? 'sunk' : 'hit';
    return shotResult === 'miss' ? 'miss' : 'water';
  }

  function isFlashed(board, r, c) {
    return flashTargets.some((f) => f.board === board && f.r === r && f.c === c);
  }
  function foundCellSet(foundOnBoard) {
    return new Set((foundOnBoard || []).map((f) => cellKey(f.r, f.c)));
  }

  // Renders a fully-owned board (your own fleet, or -- at game end -- the
  // opponent's fully revealed fleet): ship outlines are always visible,
  // shots overlay hit/sunk/miss on top. `foundOnBoard` marks cells where a
  // hidden supply drop was discovered (own board: found by the opponent).
  function renderRevealedGrid(targetEl, grid, ships, shotsGrid, flashBoardKey, foundOnBoard) {
    const found = foundCellSet(foundOnBoard);
    buildGrid(targetEl, (r, c) => {
      const el = document.createElement('div');
      const shipIndex = grid[r][c];
      const hasShip = shipIndex !== null && shipIndex !== undefined;
      const shot = shotsGrid[r][c];
      const isSunk = hasShip && ships[shipIndex] && ships[shipIndex].sunk;
      let cls = revealedCellClass(hasShip, shot, isSunk);
      if (hasShip) {
        const sameShipAt = (rr, cc) => rr >= 0 && rr < GRID_SIZE && cc >= 0 && cc < GRID_SIZE && grid[rr][cc] === shipIndex;
        const pos = shipCellPosition(sameShipAt, r, c);
        cls += ` ship-${pos.orientation}`;
        if (pos.isStart) cls += ' ship-start';
        if (pos.isEnd) cls += ' ship-end';
      }
      if (found.has(cellKey(r, c))) cls += ' supply-found';
      el.className = `bs-cell ${cls}`;
      if (flashBoardKey && isFlashed(flashBoardKey, r, c)) el.classList.add('just-fired');
      return el;
    });
  }

  // Renders a fog-of-war board (the enemy's grid, from your point of view):
  // only hit/miss/sunk markers, plus click-to-fire when it's your turn.
  // `foundOnBoard` marks cells where YOU discovered a supply drop.
  // `hintedCells` marks cells you've been hinted about (sinking a ship, or
  // a 3-miss cold streak) but haven't fired at yet -- still just water
  // until you actually click it.
  function renderFogGrid(targetEl, shotsGrid, revealedShips, canFire, onCellClick, foundOnBoard, hintedCells) {
    const { sunkCells } = shipCellSets(revealedShips);
    const found = foundCellSet(foundOnBoard);
    const hintByCell = new Map((hintedCells || []).map((h) => [cellKey(h.r, h.c), h.weapon]));
    buildGrid(targetEl, (r, c) => {
      const el = document.createElement('div');
      const shot = shotsGrid[r][c];
      const baseCls = fogCellClass(shot, sunkCells.has(cellKey(r, c)));
      const clickable = baseCls === 'water' && canFire;
      let cls = found.has(cellKey(r, c)) ? `${baseCls} supply-found` : baseCls;
      const hintWeapon = hintByCell.get(cellKey(r, c));
      if (hintWeapon) {
        cls += ' hinted';
        el.dataset.hintIcon = WEAPON_ICONS[hintWeapon] || '🎁';
      }
      el.className = `bs-cell ${cls}${clickable ? ' fireable' : ''}`;
      if (isFlashed('enemy', r, c)) el.classList.add('just-fired');
      if (clickable) el.addEventListener('click', () => onCellClick(r, c));
      return el;
    });
  }

  function gridFromRevealedShips(revealedShips) {
    const grid = Array.from({ length: GRID_SIZE }, () => new Array(GRID_SIZE).fill(null));
    const ships = [];
    (revealedShips || []).forEach((ship, i) => {
      ship.cells.forEach(({ r, c }) => { grid[r][c] = i; });
      ships.push({ sunk: ship.sunk });
    });
    return { grid, ships };
  }

  function showScreen(name) {
    lobbyScreen.classList.add('hidden');
    createRoomScreen.classList.add('hidden');
    waitingScreen.classList.add('hidden');
    placementScreen.classList.add('hidden');
    gameScreen.classList.add('hidden');
    finishedScreen.classList.add('hidden');
    if (name === 'lobby') lobbyScreen.classList.remove('hidden');
    else if (name === 'create') createRoomScreen.classList.remove('hidden');
    else if (name === 'waiting') waitingScreen.classList.remove('hidden');
    else if (name === 'placing') placementScreen.classList.remove('hidden');
    else if (name === 'playing') gameScreen.classList.remove('hidden');
    else if (name === 'finished') finishedScreen.classList.remove('hidden');
  }

  function statusLabel(status) {
    if (status === 'waiting') return 'Waiting for players';
    if (status === 'placing') return 'Placing fleets';
    if (status === 'playing') return 'In progress';
    return 'Finished';
  }

  function renderLog(el, log) {
    el.innerHTML = '';
    (log || []).forEach((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      el.appendChild(div);
    });
    el.scrollTop = el.scrollHeight;
  }

  function renderLobby() {
    roomListEl.innerHTML = '';
    noRoomsMsgEl.style.display = latestRooms.length ? 'none' : 'block';
    latestRooms.forEach((room) => {
      const li = document.createElement('li');
      li.className = 'room-row';
      const info = document.createElement('div');
      info.className = 'room-info';
      const name = document.createElement('div');
      name.className = 'room-name';
      name.textContent = room.name;
      const meta = document.createElement('div');
      meta.className = 'room-meta' + (room.status === 'waiting' ? '' : ' playing');
      meta.textContent = `${statusLabel(room.status)} · ${room.playerCount}/2 players · ${room.gridSize}x${room.gridSize} · ${room.mapThemeLabel}`;
      info.append(name, meta);
      const joinBtn = document.createElement('button');
      joinBtn.className = 'secondary';
      joinBtn.textContent = 'Join';
      joinBtn.addEventListener('click', () => openPasswordModal(room.id, room.name));
      li.append(info, joinBtn);
      roomListEl.appendChild(li);
    });
  }

  function renderWaiting(state) {
    waitingRoomTitleEl.textContent = state.roomName || 'Waiting Room';
    const firstPlayerLabel = { random: 'Random', host: 'Host', opponent: 'Opponent' }[state.firstPlayer] || 'Random';
    const ammo = state.startingAmmo || {};
    const startingAmmoParts = (state.weaponTypes || [])
      .filter((w) => ammo[w] > 0)
      .map((w) => `${ammo[w]}x ${WEAPON_ICONS[w] || ''} ${state.weaponLabels?.[w] || w}`);
    waitingConfigEl.textContent = [
      `${state.gridSize}x${state.gridSize} — default map: ${state.mapThemeLabel} (pick your own map top-right)`,
      state.timePerTurn ? `${state.timePerTurn}s per turn` : 'Unlimited time per turn',
      state.timeBankSeconds ? `${Math.round(state.timeBankSeconds / 60)}m per player` : 'Unlimited time per player',
      `${firstPlayerLabel} goes first`,
      startingAmmoParts.length ? `Start with: ${startingAmmoParts.join(', ')}` : 'No starting ammo (find it in-game)',
    ].join(' · ');
    playerListEl.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p.name + (p.id === state.yourId ? ' (you)' : '') + (p.isBot ? ' 🤖' : '');
      playerListEl.appendChild(li);
    });
    if (state.players.length < 2) {
      const li = document.createElement('li');
      li.style.color = 'var(--muted)';
      li.textContent = 'Waiting for an opponent to join, or add a bot...';
      playerListEl.appendChild(li);
    }
    startBtn.disabled = state.players.length < 2;
    addBotBtn.disabled = state.players.length >= 2;
    renderLog(waitingLogEl, state.log);
  }

  function renderShipList() {
    shipListEl.innerHTML = '';
    FLEET_SPEC.forEach((spec, i) => {
      const li = document.createElement('li');
      li.className = (placedShips[i] ? 'placed' : '') + (i === selectedShipIndex ? ' selected' : '');
      const label = document.createElement('span');
      label.textContent = spec.name;
      const dots = document.createElement('span');
      dots.className = 'dots';
      for (let k = 0; k < spec.size; k += 1) dots.appendChild(document.createElement('span'));
      li.append(label, dots);
      if (!placedShips[i]) {
        li.style.cursor = 'pointer';
        li.addEventListener('click', () => { selectedShipIndex = i; renderPlacement(); });
      }
      shipListEl.appendChild(li);
    });
  }

  function onPlacementCellClick(r, c) {
    const shipHere = placedShips.findIndex((s) => s && s.cells.some((cell) => cell.r === r && cell.c === c));
    if (shipHere !== -1) {
      placedShips[shipHere] = null;
      selectedShipIndex = shipHere;
      hoverPreview = null;
      renderPlacement();
      return;
    }
    if (selectedShipIndex === -1 || selectedShipIndex === null) return;
    const spec = FLEET_SPEC[selectedShipIndex];
    const cells = candidateCells(r, c, spec.size, orientation);
    if (!cellsValid(cells, selectedShipIndex)) return;
    placedShips[selectedShipIndex] = { cells };
    updateSelectedShip();
    hoverPreview = null;
    renderPlacement();
  }

  // Applies the current hoverPreview by toggling classes on the EXISTING
  // grid cells, rather than re-rendering the whole grid. Rebuilding the
  // grid on hover (as this used to) replaces the DOM node the cursor is
  // sitting on, which makes the browser fire a fresh mouseenter on the
  // new node even though the cursor hasn't moved -- an infinite reentrant
  // hover-render loop that starved out clicks entirely (manual placement
  // looked completely broken, even though the underlying click logic was
  // fine -- Randomize worked because it never touches hover at all).
  function applyHoverPreviewClasses() {
    placementGridEl.querySelectorAll('.bs-cell[data-r]').forEach((el) => {
      el.classList.remove('placing-preview-ok', 'placing-preview-bad');
      if (!hoverPreview) return;
      const r = Number(el.dataset.r);
      const c = Number(el.dataset.c);
      if (hoverPreview.cells.some((cell) => cell.r === r && cell.c === c)) {
        el.classList.add(hoverPreview.valid ? 'placing-preview-ok' : 'placing-preview-bad');
      }
    });
  }

  function onPlacementCellHover(r, c) {
    if (selectedShipIndex === -1 || selectedShipIndex === null) { hoverPreview = null; applyHoverPreviewClasses(); return; }
    const shipHere = placedShips.some((s) => s && s.cells.some((cell) => cell.r === r && cell.c === c));
    if (shipHere) { hoverPreview = null; applyHoverPreviewClasses(); return; }
    const spec = FLEET_SPEC[selectedShipIndex];
    const cells = candidateCells(r, c, spec.size, orientation);
    hoverPreview = { cells, valid: cellsValid(cells, selectedShipIndex) };
    applyHoverPreviewClasses();
  }

  function renderPlacementGrid() {
    buildGrid(placementGridEl, (r, c) => {
      const el = document.createElement('div');
      el.dataset.r = String(r);
      el.dataset.c = String(c);
      const shipIndex = placedShips.findIndex((s) => s && s.cells.some((cell) => cell.r === r && cell.c === c));
      const shipHere = shipIndex !== -1;
      let cls = shipHere ? 'ship' : 'water';
      if (shipHere) {
        const sameShipAt = (rr, cc) => placedShips[shipIndex].cells.some((cell) => cell.r === rr && cell.c === cc);
        const pos = shipCellPosition(sameShipAt, r, c);
        cls += ` ship-${pos.orientation}`;
        if (pos.isStart) cls += ' ship-start';
        if (pos.isEnd) cls += ' ship-end';
      }
      if (hoverPreview && hoverPreview.cells.some((cell) => cell.r === r && cell.c === c)) {
        cls += hoverPreview.valid ? ' placing-preview-ok' : ' placing-preview-bad';
      }
      el.className = `bs-cell ${cls}`;
      el.addEventListener('click', () => onPlacementCellClick(r, c));
      el.addEventListener('mouseenter', () => onPlacementCellHover(r, c));
      el.addEventListener('mouseleave', () => { hoverPreview = null; applyHoverPreviewClasses(); });
      return el;
    });
  }

  function renderPlacement() {
    if (!latestState) return;
    const me2 = latestState.players.find((p) => p.id === latestState.yourId);
    const allPlaced = placedShips.every(Boolean);
    confirmFleetBtn.disabled = !allPlaced || Boolean(me2 && me2.ready);
    const iAmReady = Boolean(me2 && me2.ready);
    renderShipList();
    renderPlacementGrid();
    rotateBtn.disabled = iAmReady;
    randomizeBtn.disabled = iAmReady;
    resetPlacementBtn.disabled = iAmReady;
    placementStatusEl.style.display = iAmReady ? 'block' : 'none';
  }

  function renderFleetStatus(state) {
    fleetStatusEl.innerHTML = '';
    state.players.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'bs-fleet-seat'
        + (state.status === 'playing' && p.id === state.currentPlayerId ? ' turn' : '')
        + (!p.connected ? ' offline' : '');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name + (p.id === state.yourId ? ' (You)' : '') + (p.isBot ? ' 🤖' : '');
      const ships = document.createElement('div');
      ships.className = 'ships-left';
      ships.textContent = p.shipsRemaining !== null ? `${p.shipsRemaining}/${FLEET_SPEC.length} ships` : '';
      el.append(name, ships);
      if (p.timeBankMsRemaining !== null) {
        const clock = document.createElement('div');
        clock.className = 'bs-clock';
        clock.dataset.timebankFor = p.id;
        clock.textContent = `⏳ ${formatClock(p.timeBankMsRemaining)}`;
        el.appendChild(clock);
      }
      fleetStatusEl.appendChild(el);
    });
  }

  function renderTurnBanner(state) {
    if (state.status !== 'playing') { turnBannerEl.textContent = ''; turnBannerEl.className = 'bs-turn-banner'; return; }
    const mine = state.yourId === state.currentPlayerId;
    const currentPlayer = state.players.find((p) => p.id === state.currentPlayerId);
    const thinking = !mine && currentPlayer && currentPlayer.isBot;
    turnBannerEl.innerHTML = '';
    if (mine) {
      turnBannerEl.textContent = 'Your turn — fire at the enemy waters!';
    } else if (thinking) {
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `🤔 ${currentPlayer.name} is thinking`;
      const dots = document.createElement('span');
      dots.className = 'bs-thinking-dots';
      dots.textContent = '...';
      turnBannerEl.append(nameSpan, dots);
    } else {
      turnBannerEl.textContent = `Waiting for ${currentPlayer ? currentPlayer.name : 'opponent'}...`;
    }
    turnBannerEl.className = 'bs-turn-banner' + (mine ? ' mine' : '') + (thinking ? ' thinking' : '');
  }

  function onEnemyCellClick(r, c) {
    const weapon = selectedWeapon;
    selectedWeapon = null; // spend it immediately -- the real count comes back from the server either way
    socket.emit('battleship:fire', { r, c, weapon }, (res) => {
      if (!res || !res.ok) alert('Could not fire there: ' + ((res && res.error) || 'unknown error'));
    });
  }

  // A row of buttons, one per weapon type, showing how many charges you
  // hold and letting you arm one before clicking a target cell. Armed
  // weapon is spent by whichever cell you click next (or stays armed
  // until you click a different weapon or fire, whichever comes first).
  function renderWeaponPicker(state) {
    weaponPickerEl.innerHTML = '';
    const ammo = (state.you && state.you.ammo) || {};
    const canFire = state.status === 'playing' && state.yourId === state.currentPlayerId;
    if (selectedWeapon && !ammo[selectedWeapon]) selectedWeapon = null; // stale selection -- charge is gone
    (state.weaponTypes || []).forEach((weapon) => {
      const count = ammo[weapon] || 0;
      const btn = document.createElement('button');
      btn.className = 'secondary bs-weapon-btn' + (selectedWeapon === weapon ? ' armed' : '');
      btn.textContent = `${WEAPON_ICONS[weapon] || ''} ${(state.weaponLabels && state.weaponLabels[weapon]) || weapon} (${count})`;
      btn.disabled = !canFire || count < 1;
      btn.addEventListener('click', () => {
        selectedWeapon = selectedWeapon === weapon ? null : weapon;
        renderWeaponPicker(state);
      });
      weaponPickerEl.appendChild(btn);
    });
  }

  function renderGame(state) {
    captureClockSnapshot(state);
    renderFleetStatus(state);
    renderTurnBanner(state);
    tickClocks(); // paint immediately rather than waiting up to 1s for the next interval tick
    renderWeaponPicker(state);
    const canFire = state.status === 'playing' && state.yourId === state.currentPlayerId;
    renderFogGrid(enemyGridEl, state.opponent.shots, state.opponent.revealedShips, canFire, onEnemyCellClick, state.opponent.foundOnBoard, state.opponent.hintedCells);
    renderRevealedGrid(ownGridEl, state.you.grid, state.you.ships, state.you.shots, 'own', state.you.foundOnBoard);
    renderLog(gameLogEl, state.log);
  }

  function renderFinished(state) {
    winnerTextEl.textContent = state.resultText || 'Game over.';
    const won = state.winnerId === state.yourId;
    finishedEnemyTitleEl.textContent = won ? 'Enemy Fleet (sunk!)' : 'Enemy Fleet (revealed)';
    const { grid, ships } = gridFromRevealedShips(state.opponent.revealedShips);
    renderRevealedGrid(finishedEnemyGridEl, grid, ships, state.opponent.shots, null, state.opponent.foundOnBoard);
    renderRevealedGrid(finishedOwnGridEl, state.you.grid, state.you.ships, state.you.shots, null, state.you.foundOnBoard);
  }

  function render() {
    if (!joined) {
      renderLobby();
      showScreen('lobby');
      return;
    }
    if (!latestState) return;
    if (latestState.status === 'waiting') {
      renderWaiting(latestState);
      showScreen('waiting');
    } else if (latestState.status === 'placing') {
      renderPlacement();
      showScreen('placing');
    } else if (latestState.status === 'playing') {
      renderGame(latestState);
      showScreen('playing');
    } else if (latestState.status === 'finished') {
      renderGame(latestState); // keep the board consistent underneath
      renderFinished(latestState);
      showScreen('finished');
    }
  }

  function enterRoom(roomId) {
    joined = true;
    localStorage.setItem(LAST_ROOM_KEY, roomId);
    render();
  }

  function backToLobby() {
    joined = false;
    latestState = null;
    resetPlacementState();
    lastAnimatedShotSeq = null;
    flashTargets = [];
    selectedWeapon = null;
    clearTimeout(flashTimer);
    localStorage.removeItem(LAST_ROOM_KEY);
    createRoomScreen.classList.add('hidden');
    socket.emit('battleship:listRooms', {}, (res) => {
      if (res && res.ok) latestRooms = res.rooms;
      render();
    });
  }

  function openPasswordModal(roomId, roomName) {
    pendingJoinRoomId = roomId;
    passwordModalTitle.textContent = `Enter Password for "${roomName}"`;
    joinPasswordInput.value = '';
    passwordErrorEl.style.display = 'none';
    passwordModal.classList.remove('hidden');
    joinPasswordInput.focus();
  }
  function closePasswordModal() {
    pendingJoinRoomId = null;
    passwordModal.classList.add('hidden');
  }
  function attemptJoinRoom(roomId, password) {
    socket.emit('battleship:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
      if (res && res.ok) {
        closePasswordModal();
        enterRoom(roomId);
      } else if (res && res.error === 'wrong-password') {
        passwordErrorEl.textContent = 'Wrong password — try again.';
        passwordErrorEl.style.display = 'block';
      } else {
        closePasswordModal();
        const messages = {
          'no-such-room': 'That room no longer exists.',
          'game-in-progress': 'That room already started a game.',
          'room-full': 'That room already has 2 players.',
        };
        alert(messages[res && res.error] || 'Could not join that room.');
        backToLobby();
      }
    });
  }
  passwordSubmitBtn.addEventListener('click', () => {
    if (pendingJoinRoomId) attemptJoinRoom(pendingJoinRoomId, joinPasswordInput.value);
  });
  joinPasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') passwordSubmitBtn.click(); });
  passwordCancelBtn.addEventListener('click', closePasswordModal);

  showCreateBtn.addEventListener('click', () => {
    roomNameInput.value = '';
    roomPasswordInput.value = '';
    gridSizeSelect.value = '10';
    mapThemeSelect.value = 'bachdang';
    timePerTurnSelect.value = '0';
    timeBankSelect.value = '0';
    firstPlayerSelect.value = 'random';
    startCrossSelect.value = '0';
    startNuclearSelect.value = '0';
    startScatterSelect.value = '0';
    createRoomErrorEl.style.display = 'none';
    showScreen('create');
  });
  cancelCreateBtn.addEventListener('click', () => showScreen('lobby'));

  createRoomBtn.addEventListener('click', () => {
    const roomName = roomNameInput.value.trim();
    const password = roomPasswordInput.value;
    if (!roomName) {
      createRoomErrorEl.textContent = 'Please enter a room name.';
      createRoomErrorEl.style.display = 'block';
      return;
    }
    if (!password) {
      createRoomErrorEl.textContent = 'Please set a password for the room.';
      createRoomErrorEl.style.display = 'block';
      return;
    }
    socket.emit('battleship:createRoom', {
      roomName,
      password,
      playerId: me.id,
      name: me.name,
      gridSize: Number(gridSizeSelect.value),
      mapTheme: mapThemeSelect.value,
      timePerTurn: Number(timePerTurnSelect.value) || 0,
      timeBankMinutes: Number(timeBankSelect.value) || 0,
      firstPlayer: firstPlayerSelect.value,
      startingAmmo: {
        cross: Number(startCrossSelect.value) || 0,
        nuclear: Number(startNuclearSelect.value) || 0,
        scatter: Number(startScatterSelect.value) || 0,
      },
    }, (res) => {
      if (res && res.ok) {
        enterRoom(res.roomId);
      } else {
        const messages = {
          'name-taken': 'A room with that name already exists — pick another name.',
          'invalid-name': 'Please enter a room name.',
          'invalid-password': 'Please set a password for the room.',
        };
        createRoomErrorEl.textContent = messages[res && res.error] || 'Could not create the room.';
        createRoomErrorEl.style.display = 'block';
      }
    });
  });

  addBotBtn.addEventListener('click', () => {
    socket.emit('battleship:addBot', {}, (res) => {
      if (!res || !res.ok) alert('Could not add a bot: ' + ((res && res.error) || 'unknown error'));
    });
  });

  startBtn.addEventListener('click', () => socket.emit('battleship:start'));
  leaveWaitingBtn.addEventListener('click', () => { socket.emit('battleship:leave'); backToLobby(); });
  leaveBtn.addEventListener('click', () => { socket.emit('battleship:leave'); backToLobby(); });
  leavePlacementBtn.addEventListener('click', () => { socket.emit('battleship:leave'); backToLobby(); });
  newGameBtn.addEventListener('click', () => socket.emit('battleship:newGame'));

  rotateBtn.addEventListener('click', () => {
    orientation = orientation === 'horizontal' ? 'vertical' : 'horizontal';
    rotateBtn.textContent = `🔄 Rotate: ${orientation === 'horizontal' ? 'Horizontal' : 'Vertical'}`;
    hoverPreview = null;
    renderPlacement();
  });

  function attemptRandomPlacement() {
    const newPlaced = new Array(FLEET_SPEC.length).fill(null);
    for (let i = 0; i < FLEET_SPEC.length; i += 1) {
      const spec = FLEET_SPEC[i];
      let placed = false;
      for (let attempt = 0; attempt < 500 && !placed; attempt += 1) {
        const horiz = Math.random() < 0.5;
        const r = Math.floor(Math.random() * GRID_SIZE);
        const c = Math.floor(Math.random() * GRID_SIZE);
        const cells = candidateCells(r, c, spec.size, horiz ? 'horizontal' : 'vertical');
        if (!cellsInBounds(cells)) continue;
        const occupied = new Set();
        newPlaced.forEach((s) => { if (s) s.cells.forEach((cell) => occupied.add(cellKey(cell.r, cell.c))); });
        if (cells.some((cell) => occupied.has(cellKey(cell.r, cell.c)))) continue;
        newPlaced[i] = { cells };
        placed = true;
      }
      if (!placed) return null;
    }
    return newPlaced;
  }
  randomizeBtn.addEventListener('click', () => {
    let result = null;
    for (let tries = 0; tries < 30 && !result; tries += 1) result = attemptRandomPlacement();
    if (result) {
      placedShips = result;
      updateSelectedShip();
      hoverPreview = null;
      renderPlacement();
    }
  });
  resetPlacementBtn.addEventListener('click', () => {
    placedShips = new Array(FLEET_SPEC.length).fill(null);
    updateSelectedShip();
    hoverPreview = null;
    renderPlacement();
  });
  confirmFleetBtn.addEventListener('click', () => {
    if (!placedShips.every(Boolean)) return;
    const ships = FLEET_SPEC.map((spec, i) => ({ name: spec.name, cells: placedShips[i].cells }));
    socket.emit('battleship:submitFleet', { ships }, (res) => {
      if (!res || !res.ok) alert('Could not submit fleet: ' + ((res && res.error) || 'unknown error'));
    });
  });

  socket.on('battleship:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('battleship:state', (state) => {
    if (state.players.some((p) => p.id === state.yourId)) joined = true;
    applyBoardStyling(state);

    const enteringPlacement = state.status === 'placing' && (!latestState || latestState.status !== 'placing');
    if (enteringPlacement) resetPlacementState();

    if (state.lastShot && state.lastShot.seq !== lastAnimatedShotSeq) {
      lastAnimatedShotSeq = state.lastShot.seq;
      const board = state.lastShot.playerId === state.yourId ? 'enemy' : 'own';
      const cells = (state.lastShot.cells && state.lastShot.cells.length) ? state.lastShot.cells : [{ r: state.lastShot.r, c: state.lastShot.c }];
      flashTargets = cells.map(({ r, c }) => ({ board, r, c }));
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashTargets = []; render(); }, 550);
    }

    latestState = state;
    render();
  });

  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('battleship:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('battleship:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (res && res.ok) enterRoom(lastRoomId);
        else backToLobby();
      });
    } else {
      backToLobby();
    }
  });

  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    rulesModal.classList.remove('hidden');
  });
  rulesModal.querySelector('.modal-close').addEventListener('click', () => rulesModal.classList.add('hidden'));

  updateSelectedShip();
  showScreen('lobby');
}
