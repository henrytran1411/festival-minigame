const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/xq');
  const LAST_ROOM_KEY = 'xq_last_room_id';
  const ROWS = 10;
  const COLS = 9;
  const PIECE_LABEL_VI = { G: 'Tướng', A: 'Sĩ', E: 'Tượng', H: 'Mã', R: 'Xe', C: 'Pháo', S: 'Tốt' };
  const COLOR_NAME = { r: 'Red', b: 'Black' };

  function idxOf(row, col) { return row * COLS + col; }
  function rowOf(idx) { return Math.floor(idx / COLS); }
  function colOf(idx) { return idx % COLS; }

  function formatClock(ms) {
    if (ms === null || ms === undefined) return '';
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    return `${totalSeconds}s`;
  }

  // -- Screens ---------------------------------------------------------------
  const lobbyScreen = document.getElementById('lobby-screen');
  const createRoomScreen = document.getElementById('create-room-screen');
  const waitingScreen = document.getElementById('waiting-screen');
  const gameScreen = document.getElementById('game-screen');
  const finishedScreen = document.getElementById('finished-screen');

  const roomListEl = document.getElementById('room-list');
  const noRoomsMsgEl = document.getElementById('no-rooms-msg');
  const showCreateBtn = document.getElementById('show-create-btn');
  const cancelCreateBtn = document.getElementById('cancel-create-btn');
  const createRoomBtn = document.getElementById('create-room-btn');
  const roomNameInput = document.getElementById('room-name-input');
  const roomPasswordInput = document.getElementById('room-password-input');
  const timePerTurnSelect = document.getElementById('time-per-turn-select');
  const firstPlayerSelect = document.getElementById('first-player-select');
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

  const seatsRowEl = document.getElementById('seats-row');
  const turnBannerEl = document.getElementById('turn-banner');
  const turnClockEl = document.getElementById('turn-clock');
  const boardEl = document.getElementById('board');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');

  const winnerTextEl = document.getElementById('winner-text');
  const newGameBtn = document.getElementById('new-game-btn');

  const rulesModal = document.getElementById('rules-modal');

  let joined = false;
  let latestRooms = [];
  let latestState = null;
  let pendingJoinRoomId = null;
  let selectedIdx = null;

  // -- Clock: purely a locally-ticking display, resynced from the server's
  // numbers on every broadcast (same pattern as Battleship/Poker). --------
  let clockSnapshot = null;
  function captureClockSnapshot(state) {
    clockSnapshot = { capturedAt: Date.now(), status: state.status, turnTimeRemainingMs: state.turnTimeRemainingMs };
  }
  function tickClock() {
    if (!clockSnapshot || clockSnapshot.status !== 'playing' || clockSnapshot.turnTimeRemainingMs === null) {
      turnClockEl.textContent = '';
      turnClockEl.classList.remove('low');
      return;
    }
    const elapsed = Date.now() - clockSnapshot.capturedAt;
    const remaining = Math.max(0, clockSnapshot.turnTimeRemainingMs - elapsed);
    turnClockEl.textContent = `⏱ ${formatClock(remaining)} left`;
    turnClockEl.classList.toggle('low', remaining <= 8000);
  }
  setInterval(tickClock, 500);

  function showScreen(name) {
    lobbyScreen.classList.add('hidden');
    createRoomScreen.classList.add('hidden');
    waitingScreen.classList.add('hidden');
    gameScreen.classList.add('hidden');
    finishedScreen.classList.add('hidden');
    if (name === 'lobby') lobbyScreen.classList.remove('hidden');
    else if (name === 'create') createRoomScreen.classList.remove('hidden');
    else if (name === 'waiting') waitingScreen.classList.remove('hidden');
    else if (name === 'playing') gameScreen.classList.remove('hidden');
    else if (name === 'finished') finishedScreen.classList.remove('hidden');
  }

  function statusLabel(status) {
    if (status === 'waiting') return 'Waiting for players';
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
      meta.textContent = `${statusLabel(room.status)} · ${room.playerCount}/2 players`;
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
    waitingConfigEl.textContent = [
      state.timePerTurn ? `${state.timePerTurn}s per turn` : 'Unlimited time per turn',
      `${firstPlayerLabel} plays Red (moves first)`,
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

  function renderSeats(state) {
    seatsRowEl.innerHTML = '';
    state.players.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'xq-seat'
        + (state.status === 'playing' && p.color === state.currentColor ? ' turn' : '')
        + (state.status === 'playing' && p.color === state.checkColor ? ' check' : '')
        + (!p.connected ? ' offline' : '');
      const dot = document.createElement('span');
      dot.className = 'color-dot ' + (p.color === 'r' ? 'red' : 'black');
      const name = document.createElement('div');
      name.className = 'name';
      name.append(dot, document.createTextNode(p.name + (p.id === state.yourId ? ' (you)' : '') + (p.isBot ? ' 🤖' : '')));
      const captured = document.createElement('div');
      captured.className = 'captured';
      const capturedFromThem = (p.color && state.captured[p.color]) || [];
      captured.textContent = capturedFromThem.length
        ? `Lost: ${capturedFromThem.map((t) => PIECE_LABEL_VI[t]).join(', ')}`
        : '';
      el.append(name, captured);
      seatsRowEl.appendChild(el);
    });
  }

  function renderTurnBanner(state) {
    if (state.status !== 'playing') { turnBannerEl.textContent = ''; turnBannerEl.className = 'xq-turn-banner'; return; }
    const mine = state.yourColor === state.currentColor;
    const currentPlayer = state.players.find((p) => p.color === state.currentColor);
    const thinking = !mine && currentPlayer && currentPlayer.isBot;
    const inCheck = state.checkColor === state.currentColor;
    turnBannerEl.innerHTML = '';
    if (mine) {
      turnBannerEl.textContent = `Your turn (${COLOR_NAME[state.currentColor]})${inCheck ? ' — you are in check!' : ''}!`;
    } else if (thinking) {
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `🤔 ${currentPlayer.name} is thinking`;
      const dots = document.createElement('span');
      dots.className = 'xq-thinking-dots';
      dots.textContent = '...';
      turnBannerEl.append(nameSpan, dots);
    } else {
      turnBannerEl.textContent = `Waiting for ${currentPlayer ? currentPlayer.name : COLOR_NAME[state.currentColor]}${inCheck ? ' (in check!)' : ''}...`;
    }
    turnBannerEl.className = 'xq-turn-banner' + (mine ? ' mine' : '') + (thinking ? ' thinking' : '') + (inCheck ? ' check' : '');
  }

  // -- Board ------------------------------------------------------------
  // A real wooden Xiangqi board: pieces sit ON the grid intersections,
  // not inside cells. Rebuilt as one SVG per render (same technique as
  // Go's board -- see go.js's buildBoardSvg), since re-attaching fresh
  // click handlers alongside the selection/legal-move highlights in a
  // single pass is simpler than maintaining a separate persistent DOM.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }

  const BOARD_PAD = 30;
  const BOARD_CELL = 46;
  const RIVER_GAP = BOARD_CELL * 0.55;
  const VIEW_W = BOARD_PAD * 2 + BOARD_CELL * (COLS - 1);
  const VIEW_H = BOARD_PAD * 2 + BOARD_CELL * (ROWS - 1) + RIVER_GAP;
  function xForCol(col) { return BOARD_PAD + col * BOARD_CELL; }
  function yForRow(row) { return BOARD_PAD + row * BOARD_CELL + (row >= 5 ? RIVER_GAP : 0); }

  // Traditional position markers -- the 2 Cannon points and 5 Soldier
  // points per side -- drawn as small corner brackets, same convention
  // as printed/carved wooden boards.
  const POSITION_MARKERS = [
    [2, 1], [2, 7], [7, 1], [7, 7],
    [3, 0], [3, 2], [3, 4], [3, 6], [3, 8],
    [6, 0], [6, 2], [6, 4], [6, 6], [6, 8],
  ];
  function drawCornerMarker(svg, cx, cy) {
    const gap = 6;
    const len = 7;
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([dx, dy]) => {
      svg.appendChild(svgEl('polyline', {
        points: `${cx + dx * (gap + len)},${cy + dy * gap} ${cx + dx * gap},${cy + dy * gap} ${cx + dx * gap},${cy + dy * (gap + len)}`,
        fill: 'none', stroke: '#8a6d3b', 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }));
    });
  }

  // A hidden piece is selected and moved exactly like a revealed one --
  // there's no separate "flip" action. Moving a still-hidden piece (per
  // the position-based legalMoves the server already computed for it --
  // see xq-server.js's effectiveType()) is simultaneously its first move
  // AND the thing that flips it face-up.
  function onCellClick(idx) {
    if (!latestState || latestState.status !== 'playing') return;
    if (latestState.yourColor !== latestState.currentColor) return;
    const board = latestState.board;
    const piece = board[idx];

    if (selectedIdx !== null) {
      const legal = latestState.legalMoves[selectedIdx] || [];
      if (legal.includes(idx)) {
        socket.emit('xq:move', { from: selectedIdx, to: idx }, (res) => {
          if (!res || !res.ok) alert('Could not move: ' + ((res && res.error) || 'unknown error'));
        });
        selectedIdx = null;
        renderBoard(latestState);
        return;
      }
    }

    if (piece && piece.color === latestState.yourColor) {
      selectedIdx = (selectedIdx === idx) ? null : idx;
      renderBoard(latestState);
      return;
    }

    selectedIdx = null;
    renderBoard(latestState);
  }

  function buildBoardSvg(state) {
    const board = state.board || new Array(ROWS * COLS).fill(null);
    const canAct = state.status === 'playing' && state.yourColor === state.currentColor;
    const legal = (canAct && selectedIdx !== null && state.legalMoves[selectedIdx]) || [];
    const legalSet = new Set(legal);
    const justMoved = new Set();
    if (state.lastAction) { justMoved.add(state.lastAction.from); justMoved.add(state.lastAction.to); }
    let checkKingIdx = -1;
    if (state.checkColor) checkKingIdx = board.findIndex((p) => p && p.color === state.checkColor && p.type === 'G');

    const svg = svgEl('svg', { viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, width: VIEW_W, height: VIEW_H });
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: VIEW_W, height: VIEW_H, rx: 6, fill: '#ecd9ae' }));

    for (let row = 0; row < ROWS; row += 1) {
      const y = yForRow(row);
      svg.appendChild(svgEl('line', { x1: xForCol(0), y1: y, x2: xForCol(COLS - 1), y2: y, stroke: '#8a6d3b', 'stroke-width': 1.2 }));
    }
    // Vertical lines stop at the river (never cross it), same as a real board.
    for (let col = 0; col < COLS; col += 1) {
      const x = xForCol(col);
      svg.appendChild(svgEl('line', { x1: x, y1: yForRow(0), x2: x, y2: yForRow(4), stroke: '#8a6d3b', 'stroke-width': 1.2 }));
      svg.appendChild(svgEl('line', { x1: x, y1: yForRow(5), x2: x, y2: yForRow(9), stroke: '#8a6d3b', 'stroke-width': 1.2 }));
    }
    // Full corner-to-corner palace diagonals (both palaces).
    [[0, 2], [7, 9]].forEach(([topRow, bottomRow]) => {
      svg.appendChild(svgEl('line', { x1: xForCol(3), y1: yForRow(topRow), x2: xForCol(5), y2: yForRow(bottomRow), stroke: '#8a6d3b', 'stroke-width': 1.2 }));
      svg.appendChild(svgEl('line', { x1: xForCol(5), y1: yForRow(topRow), x2: xForCol(3), y2: yForRow(bottomRow), stroke: '#8a6d3b', 'stroke-width': 1.2 }));
    });
    POSITION_MARKERS.forEach(([r, c]) => drawCornerMarker(svg, xForCol(c), yForRow(r)));
    const riverText = svgEl('text', {
      x: VIEW_W / 2, y: (yForRow(4) + yForRow(5)) / 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': 13, 'font-weight': 700, fill: '#8a6d3b', 'letter-spacing': 4,
    });
    riverText.textContent = 'SÔNG · SÔNG · SÔNG';
    svg.appendChild(riverText);

    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const idx = idxOf(row, col);
        const cx = xForCol(col);
        const cy = yForRow(row);
        const piece = board[idx];
        const g = svgEl('g', { class: 'xq-point' });
        g.appendChild(svgEl('circle', { cx, cy, r: BOARD_CELL * 0.46, fill: 'transparent' })); // click hit-area

        if (idx === checkKingIdx) svg.appendChild(svgEl('circle', { cx, cy, r: BOARD_CELL * 0.42, fill: '#e6194b', opacity: 0.6 }));
        if (justMoved.has(idx)) svg.appendChild(svgEl('circle', { cx, cy, r: BOARD_CELL * 0.44, fill: 'none', stroke: '#ffd166', 'stroke-width': 2.5 }));

        if (piece) {
          const faceDown = !piece.type;
          const fillColor = faceDown ? (piece.color === 'r' ? '#c0392b' : '#2a2a2a') : '#f4e9d8';
          const strokeColor = piece.color === 'r' ? '#b3122b' : '#1a1a1a';
          g.appendChild(svgEl('circle', { cx, cy, r: BOARD_CELL * 0.4, fill: fillColor, stroke: strokeColor, 'stroke-width': 2 }));
          const label = svgEl('text', {
            x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central',
            'font-size': faceDown ? 15 : 12, 'font-weight': 800, fill: faceDown ? 'rgba(255,255,255,0.55)' : strokeColor,
          });
          label.textContent = faceDown ? '?' : PIECE_LABEL_VI[piece.type];
          g.appendChild(label);
        }
        if (idx === selectedIdx) g.appendChild(svgEl('circle', { cx, cy, r: BOARD_CELL * 0.44, fill: 'none', stroke: '#ffd166', 'stroke-width': 3 }));
        if (legalSet.has(idx)) {
          if (piece) g.appendChild(svgEl('circle', { cx, cy, r: BOARD_CELL * 0.44, fill: 'none', stroke: '#e6194b', 'stroke-width': 3 }));
          else g.appendChild(svgEl('circle', { cx, cy, r: BOARD_CELL * 0.16, fill: 'rgba(58, 196, 125, 0.85)' }));
        }
        if (canAct) {
          g.classList.add('clickable');
          g.addEventListener('click', () => onCellClick(idx));
        }
        svg.appendChild(g);
      }
    }
    return svg;
  }

  function renderBoard(state) {
    boardEl.innerHTML = '';
    boardEl.appendChild(buildBoardSvg(state));
  }

  function renderGame(state) {
    captureClockSnapshot(state);
    renderSeats(state);
    renderTurnBanner(state);
    tickClock();
    renderBoard(state);
    renderLog(gameLogEl, state.log);
  }

  function renderFinished(state) {
    winnerTextEl.textContent = state.resultText || 'Game over.';
    renderBoard(state);
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
    } else if (latestState.status === 'playing') {
      renderGame(latestState);
      showScreen('playing');
    } else if (latestState.status === 'finished') {
      renderGame(latestState);
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
    selectedIdx = null;
    localStorage.removeItem(LAST_ROOM_KEY);
    createRoomScreen.classList.add('hidden');
    socket.emit('xq:listRooms', {}, (res) => {
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
    socket.emit('xq:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
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
    timePerTurnSelect.value = '0';
    firstPlayerSelect.value = 'random';
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
    socket.emit('xq:createRoom', {
      roomName,
      password,
      playerId: me.id,
      name: me.name,
      timePerTurn: Number(timePerTurnSelect.value) || 0,
      firstPlayer: firstPlayerSelect.value,
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
    socket.emit('xq:addBot', {}, (res) => {
      if (!res || !res.ok) alert('Could not add a bot: ' + ((res && res.error) || 'unknown error'));
    });
  });

  startBtn.addEventListener('click', () => socket.emit('xq:start'));
  leaveWaitingBtn.addEventListener('click', () => { socket.emit('xq:leave'); backToLobby(); });
  leaveBtn.addEventListener('click', () => { socket.emit('xq:leave'); backToLobby(); });
  newGameBtn.addEventListener('click', () => socket.emit('xq:newGame'));

  socket.on('xq:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('xq:state', (state) => {
    if (state.players.some((p) => p.id === state.yourId)) joined = true;
    if (!latestState || latestState.status !== 'playing' || state.status !== 'playing' || state.currentColor !== latestState.currentColor) {
      selectedIdx = null;
    }
    latestState = state;
    render();
  });

  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('xq:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('xq:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
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
  Festival.wireRulesLangToggle(rulesModal);

  showScreen('lobby');
}
