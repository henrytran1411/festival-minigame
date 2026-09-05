const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/chess');
  const LAST_ROOM_KEY = 'chess_last_room_id';
  const ROWS = 8;
  const COLS = 8;
  const COLOR_NAME = { w: 'White', b: 'Black' };
  const PIECE_GLYPH = {
    w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' },
    b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' },
  };
  const PROMO_CHOICES = ['Q', 'R', 'B', 'N'];

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
  const resignBtn = document.getElementById('resign-btn');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');

  const winnerTextEl = document.getElementById('winner-text');
  const newGameBtn = document.getElementById('new-game-btn');

  const promoModal = document.getElementById('promo-modal');
  const promoOptionsEl = document.getElementById('promo-options');
  const rulesModal = document.getElementById('rules-modal');

  let joined = false;
  let latestRooms = [];
  let latestState = null;
  let pendingJoinRoomId = null;
  let selectedIdx = null;
  let cellEls = [];
  let pendingPromotion = null; // { from, to }

  // -- Clock: locally-ticking display, resynced from the server on every
  // broadcast (same pattern as this project's other games). -------------
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
      `${firstPlayerLabel} plays White (moves first)`,
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
      el.className = 'cx-seat'
        + (state.status === 'playing' && p.color === state.currentColor ? ' turn' : '')
        + (state.status === 'playing' && p.color === state.checkColor ? ' check' : '')
        + (!p.connected ? ' offline' : '');
      const dot = document.createElement('span');
      dot.className = 'color-dot ' + (p.color === 'w' ? 'white' : 'black');
      const name = document.createElement('div');
      name.className = 'name';
      name.append(dot, document.createTextNode(p.name + (p.id === state.yourId ? ' (you)' : '') + (p.isBot ? ' 🤖' : '')));
      const captured = document.createElement('div');
      captured.className = 'captured';
      const capturedFromThem = (p.color && state.captured[p.color]) || [];
      captured.textContent = capturedFromThem.map((t) => PIECE_GLYPH[otherColorOf(p.color)][t]).join(' ');
      el.append(name, captured);
      seatsRowEl.appendChild(el);
    });
  }
  function otherColorOf(color) { return color === 'w' ? 'b' : 'w'; }

  function renderTurnBanner(state) {
    if (state.status !== 'playing') { turnBannerEl.textContent = ''; turnBannerEl.className = 'cx-turn-banner'; return; }
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
      dots.className = 'cx-thinking-dots';
      dots.textContent = '...';
      turnBannerEl.append(nameSpan, dots);
    } else {
      turnBannerEl.textContent = `Waiting for ${currentPlayer ? currentPlayer.name : COLOR_NAME[state.currentColor]}${inCheck ? ' (in check!)' : ''}...`;
    }
    turnBannerEl.className = 'cx-turn-banner' + (mine ? ' mine' : '') + (thinking ? ' thinking' : '') + (inCheck ? ' check' : '');
  }

  // -- Board (built once; only classes/content are updated per render) -----
  function buildBoardDom() {
    boardEl.innerHTML = '';
    cellEls = [];
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const el = document.createElement('div');
        el.className = `cx-cell ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;
        const idx = idxOf(row, col);
        el.addEventListener('click', () => onCellClick(idx));
        boardEl.appendChild(el);
        cellEls.push(el);
      }
    }
  }
  buildBoardDom();

  function isPromotionMove(from, to) {
    const board = latestState.board;
    const piece = board[from];
    return piece && piece.type === 'P' && (rowOf(to) === 0 || rowOf(to) === 7);
  }

  function sendMove(from, to, promotion) {
    socket.emit('chess:move', { from, to, promotion }, (res) => {
      if (!res || !res.ok) alert('Could not move: ' + ((res && res.error) || 'unknown error'));
    });
  }

  function openPromoModal(from, to) {
    pendingPromotion = { from, to };
    promoOptionsEl.innerHTML = '';
    const color = latestState.board[from].color;
    PROMO_CHOICES.forEach((type) => {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = PIECE_GLYPH[color][type];
      btn.addEventListener('click', () => {
        promoModal.classList.add('hidden');
        if (pendingPromotion) sendMove(pendingPromotion.from, pendingPromotion.to, type);
        pendingPromotion = null;
      });
      promoOptionsEl.appendChild(btn);
    });
    promoModal.classList.remove('hidden');
  }

  function onCellClick(idx) {
    if (!latestState || latestState.status !== 'playing') return;
    if (latestState.yourColor !== latestState.currentColor) return;
    const board = latestState.board;
    const piece = board[idx];

    if (selectedIdx !== null) {
      const legal = latestState.legalMoves[selectedIdx] || [];
      if (legal.includes(idx)) {
        const from = selectedIdx;
        selectedIdx = null;
        renderBoard(latestState);
        if (isPromotionMove(from, idx)) openPromoModal(from, idx);
        else sendMove(from, idx);
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

  function renderBoard(state) {
    const board = state.board || new Array(ROWS * COLS).fill(null);
    const canAct = state.status === 'playing' && state.yourColor === state.currentColor;
    const legal = (canAct && selectedIdx !== null && state.legalMoves[selectedIdx]) || [];
    const legalSet = new Set(legal);
    const justMoved = new Set();
    if (state.lastMove) { justMoved.add(state.lastMove.from); justMoved.add(state.lastMove.to); }
    let checkKingIdx = -1;
    if (state.checkColor) checkKingIdx = board.findIndex((p) => p && p.color === state.checkColor && p.type === 'K');

    for (let idx = 0; idx < ROWS * COLS; idx += 1) {
      const el = cellEls[idx];
      el.classList.remove('selected', 'legal-dest', 'has-piece', 'just-moved', 'clickable', 'king-in-check');
      el.innerHTML = '';
      const piece = board[idx];
      if (piece) {
        const pieceEl = document.createElement('div');
        pieceEl.className = `cx-piece ${piece.color === 'w' ? 'white' : 'black'}`;
        pieceEl.textContent = PIECE_GLYPH[piece.color][piece.type];
        el.appendChild(pieceEl);
      }
      if (idx === selectedIdx) el.classList.add('selected');
      if (legalSet.has(idx)) { el.classList.add('legal-dest'); if (piece) el.classList.add('has-piece'); }
      if (justMoved.has(idx)) el.classList.add('just-moved');
      if (idx === checkKingIdx) el.classList.add('king-in-check');
      if (canAct && piece && piece.color === state.yourColor) el.classList.add('clickable');
      else if (canAct && selectedIdx !== null && legalSet.has(idx)) el.classList.add('clickable');
    }
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
    socket.emit('chess:listRooms', {}, (res) => {
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
    socket.emit('chess:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
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
    socket.emit('chess:createRoom', {
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
    socket.emit('chess:addBot', {}, (res) => {
      if (!res || !res.ok) alert('Could not add a bot: ' + ((res && res.error) || 'unknown error'));
    });
  });

  startBtn.addEventListener('click', () => socket.emit('chess:start'));
  leaveWaitingBtn.addEventListener('click', () => { socket.emit('chess:leave'); backToLobby(); });
  leaveBtn.addEventListener('click', () => { socket.emit('chess:leave'); backToLobby(); });
  resignBtn.addEventListener('click', () => {
    if (confirm('Resign this game?')) socket.emit('chess:resign', {}, () => {});
  });
  newGameBtn.addEventListener('click', () => socket.emit('chess:newGame'));

  socket.on('chess:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('chess:state', (state) => {
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
      socket.emit('chess:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('chess:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
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
