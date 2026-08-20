const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/go');
  const LAST_ROOM_KEY = 'go_last_room_id';
  const BLACK = 1;
  const WHITE = 2;

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
  const createRoomErrorEl = document.getElementById('create-room-error');

  const passwordModal = document.getElementById('password-modal');
  const passwordModalTitle = document.getElementById('password-modal-title');
  const joinPasswordInput = document.getElementById('join-password-input');
  const passwordErrorEl = document.getElementById('password-error');
  const passwordSubmitBtn = document.getElementById('password-submit-btn');
  const passwordCancelBtn = document.getElementById('password-cancel-btn');

  const waitingRoomTitleEl = document.getElementById('waiting-room-title');
  const waitingBoardSizeEl = document.getElementById('waiting-board-size');
  const playerListEl = document.getElementById('player-list');
  const startBtn = document.getElementById('start-btn');
  const addBotBtn = document.getElementById('add-bot-btn');
  const waitingLogEl = document.getElementById('waiting-log');
  const leaveWaitingBtn = document.getElementById('leave-waiting-btn');

  const seatsRowEl = document.getElementById('seats-row');
  const turnBannerEl = document.getElementById('turn-banner');
  const boardWrapEl = document.getElementById('board-wrap');
  const passBtn = document.getElementById('pass-btn');
  const resignBtn = document.getElementById('resign-btn');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');

  const winnerTextEl = document.getElementById('winner-text');
  const scoreTableEl = document.getElementById('score-table');
  const newGameBtn = document.getElementById('new-game-btn');

  const rulesModal = document.getElementById('rules-modal');

  let joined = false;
  let latestRooms = [];
  let latestState = null;
  let pendingJoinRoomId = null;

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
      meta.className = 'room-meta' + (room.status === 'playing' ? ' playing' : '');
      meta.textContent = `${statusLabel(room.status)} · ${room.boardSize}x${room.boardSize} · ${room.playerCount}/2 players`;
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
    waitingBoardSizeEl.textContent = `Board: ${state.boardSize}x${state.boardSize}`;
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
    [BLACK, WHITE].forEach((color) => {
      const p = state.players.find((pl) => pl.color === color);
      const el = document.createElement('div');
      el.className = 'go-seat'
        + (p && state.status === 'playing' && p.color === state.currentColor ? ' turn' : '')
        + (p && !p.connected ? ' offline' : '');
      const name = document.createElement('div');
      name.className = 'name';
      const dot = document.createElement('span');
      dot.className = 'stone-dot ' + (color === BLACK ? 'black' : 'white');
      name.appendChild(dot);
      name.appendChild(document.createTextNode(
        p ? p.name + (p.id === state.yourId ? ' (You)' : '') + (p.isBot ? ' 🤖' : '') : 'Waiting for opponent...'
      ));
      const caps = document.createElement('div');
      caps.className = 'captures';
      caps.textContent = `Captures: ${(state.captures && state.captures[color]) || 0}`;
      el.append(name, caps);
      seatsRowEl.appendChild(el);
    });
  }

  function renderTurnBanner(state) {
    if (state.status !== 'playing') { turnBannerEl.textContent = ''; turnBannerEl.className = 'go-turn-banner'; return; }
    const mine = state.yourColor === state.currentColor;
    const colorLabel = state.currentColor === BLACK ? 'Black' : 'White';
    turnBannerEl.textContent = mine ? `Your turn (${colorLabel})` : `Waiting for ${colorLabel}...`;
    turnBannerEl.className = 'go-turn-banner' + (mine ? ' mine' : '');
    if (state.passCount === 1) {
      const note = document.createElement('span');
      note.className = 'pass-warning';
      note.textContent = ' (1 pass in a row — another pass ends the game)';
      turnBannerEl.appendChild(note);
    }
  }

  function starPoints(n) {
    if (n === 9) return [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]];
    if (n === 13) return [[3, 3], [3, 9], [9, 3], [9, 9], [3, 6], [9, 6], [6, 3], [6, 9], [6, 6]];
    if (n === 19) return [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]];
    return [];
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }

  function buildBoardSvg(state) {
    const n = state.boardSize;
    const VIEW = 520;
    const PAD = 28;
    const cell = (VIEW - PAD * 2) / (n - 1);
    const myTurn = state.status === 'playing' && state.yourColor === state.currentColor;

    const svg = svgEl('svg', { viewBox: `0 0 ${VIEW} ${VIEW}`, width: VIEW, height: VIEW });

    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: VIEW, height: VIEW, rx: 8, fill: '#c8944f' }));

    for (let i = 0; i < n; i++) {
      const pos = PAD + i * cell;
      svg.appendChild(svgEl('line', { x1: PAD, y1: pos, x2: VIEW - PAD, y2: pos, stroke: '#3a2a14', 'stroke-width': 1.2 }));
      svg.appendChild(svgEl('line', { x1: pos, y1: PAD, x2: pos, y2: VIEW - PAD, stroke: '#3a2a14', 'stroke-width': 1.2 }));
    }

    starPoints(n).forEach(([r, c]) => {
      svg.appendChild(svgEl('circle', {
        cx: PAD + c * cell, cy: PAD + r * cell, r: Math.max(2, cell * 0.08), fill: '#3a2a14',
      }));
    });

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const idx = r * n + c;
        const cx = PAD + c * cell;
        const cy = PAD + r * cell;
        const g = svgEl('g', { class: 'go-point' });
        g.appendChild(svgEl('circle', { cx, cy, r: cell * 0.48, fill: 'transparent' }));

        const stoneColor = state.board[idx];
        if (stoneColor) {
          g.appendChild(svgEl('circle', {
            cx, cy, r: cell * 0.46,
            fill: stoneColor === BLACK ? '#161616' : '#f4f4f0',
            stroke: stoneColor === BLACK ? '#000' : '#999',
            'stroke-width': 1,
          }));
        } else {
          if (idx === state.koPoint) {
            g.appendChild(svgEl('circle', {
              cx, cy, r: cell * 0.15, fill: 'none', stroke: '#e6194b', 'stroke-width': 1.5,
            }));
          }
          if (myTurn) {
            g.appendChild(svgEl('circle', {
              cx, cy, r: cell * 0.46,
              class: 'hover-preview',
              fill: state.currentColor === BLACK ? '#161616' : '#f4f4f0',
              opacity: 0,
            }));
            g.style.cursor = 'pointer';
            g.addEventListener('click', () => {
              if (idx === state.koPoint) {
                alert("Ko rule — you can't immediately recapture there. Play elsewhere first.");
                return;
              }
              socket.emit('go:place', { index: idx }, (res) => {
                if (!res || !res.ok) {
                  const messages = {
                    occupied: 'That point is occupied.',
                    ko: "Ko rule — you can't immediately recapture there.",
                    suicide: 'That move would be suicide (no liberties) — not allowed.',
                    'not-your-turn': "It's not your turn.",
                  };
                  alert(messages[res && res.error] || 'Illegal move.');
                }
              });
            });
          }
        }
        svg.appendChild(g);
      }
    }

    return svg;
  }

  function renderGame(state) {
    renderSeats(state);
    renderTurnBanner(state);
    boardWrapEl.innerHTML = '';
    boardWrapEl.appendChild(buildBoardSvg(state));
    passBtn.disabled = !(state.status === 'playing' && state.yourColor === state.currentColor);
    resignBtn.disabled = state.status !== 'playing';
    renderLog(gameLogEl, state.log);
  }

  function renderFinished(state) {
    winnerTextEl.textContent = state.resultText || 'Game over.';
    scoreTableEl.innerHTML = '';
    if (state.scoreSummary) {
      const s = state.scoreSummary;
      const rows = [
        ['', 'Black', 'White'],
        ['Stones', s.stoneCount[BLACK], s.stoneCount[WHITE]],
        ['Territory', s.territory[BLACK], s.territory[WHITE]],
        ['Komi', '—', s.komi],
        ['Total', s.blackScore.toFixed(1), s.whiteScore.toFixed(1)],
      ];
      rows.forEach((row, i) => {
        const tr = document.createElement('tr');
        row.forEach((cellText) => {
          const cellEl = document.createElement(i === 0 ? 'th' : 'td');
          cellEl.textContent = cellText;
          tr.appendChild(cellEl);
        });
        scoreTableEl.appendChild(tr);
      });
    }
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
    localStorage.removeItem(LAST_ROOM_KEY);
    createRoomScreen.classList.add('hidden');
    socket.emit('go:listRooms', {}, (res) => {
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
    socket.emit('go:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
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
    createRoomErrorEl.style.display = 'none';
    showScreen('create');
  });
  cancelCreateBtn.addEventListener('click', () => showScreen('lobby'));

  createRoomBtn.addEventListener('click', () => {
    const roomName = roomNameInput.value.trim();
    const password = roomPasswordInput.value;
    const boardSizeInput = document.querySelector('input[name="board-size"]:checked');
    const boardSize = boardSizeInput ? Number(boardSizeInput.value) : 9;
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
    socket.emit('go:createRoom', { roomName, password, playerId: me.id, name: me.name, boardSize }, (res) => {
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
    socket.emit('go:addBot', {}, (res) => {
      if (!res || !res.ok) alert('Could not add a bot: ' + ((res && res.error) || 'unknown error'));
    });
  });

  startBtn.addEventListener('click', () => socket.emit('go:start'));
  passBtn.addEventListener('click', () => {
    if (confirm('Pass your turn? If your opponent also passes next, the game ends and the board is scored.')) {
      socket.emit('go:pass');
    }
  });
  resignBtn.addEventListener('click', () => {
    if (confirm('Resign this game? Your opponent will be declared the winner.')) {
      socket.emit('go:resign');
    }
  });
  newGameBtn.addEventListener('click', () => socket.emit('go:newGame'));
  leaveWaitingBtn.addEventListener('click', () => { socket.emit('go:leave'); backToLobby(); });
  leaveBtn.addEventListener('click', () => { socket.emit('go:leave'); backToLobby(); });

  socket.on('go:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('go:state', (state) => {
    latestState = state;
    if (state.players.some((p) => p.id === state.yourId)) joined = true;
    render();
  });

  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('go:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('go:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
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

  showScreen('lobby');
}
