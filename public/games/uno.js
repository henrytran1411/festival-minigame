const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/uno');
  const LAST_ROOM_KEY = 'uno_last_room_id';

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
  const playerListEl = document.getElementById('player-list');
  const startBtn = document.getElementById('start-btn');
  const addBotsBtn = document.getElementById('add-bots-btn');
  const waitingLogEl = document.getElementById('waiting-log');
  const leaveWaitingBtn = document.getElementById('leave-waiting-btn');

  const othersRowEl = document.getElementById('others-row');
  const deckCountEl = document.getElementById('deck-count');
  const discardEl = document.getElementById('discard-el');
  const colorLabelEl = document.getElementById('color-label');
  const directionEl = document.getElementById('direction-el');
  const turnBannerEl = document.getElementById('turn-banner');
  const handRowEl = document.getElementById('hand-row');
  const drawBtn = document.getElementById('draw-btn');
  const passBtn = document.getElementById('pass-btn');
  const unoBtn = document.getElementById('uno-btn');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');

  const winnerTextEl = document.getElementById('winner-text');
  const newGameBtn = document.getElementById('new-game-btn');

  const colorModal = document.getElementById('color-modal');
  const rulesModal = document.getElementById('rules-modal');

  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    rulesModal.classList.remove('hidden');
  });
  rulesModal.querySelector('.modal-close').addEventListener('click', () => rulesModal.classList.add('hidden'));

  const ACTION_SYMBOL = { skip: '⊘', reverse: '⇄', draw2: '+2' };
  // Colors with real festival artwork (a blank card template) instead of the
  // plain gradient — the art fills the whole face, so we skip the plain
  // center oval and only stamp the corner numbers over it.
  const CUSTOM_ART_COLORS = new Set(['red', 'yellow', 'green', 'blue']);

  let latestState = null;
  let latestRooms = [];
  let joined = false;
  let pendingWildCardId = null;
  let pendingJoinRoomId = null;

  // Screens: 'lobby' | 'create' | 'waiting' | 'playing' | 'finished'
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

  function cardSymbol(card) {
    return ACTION_SYMBOL[card.value] || card.value;
  }

  // Builds a card face that reads like a real UNO card: a white center oval
  // with the colored symbol, plus small corner symbols so cards are still
  // legible when fanned out edge-to-edge in a hand. Wilds get the classic
  // 4-color pie background instead (Wild Draw Four adds a "+4" badge).
  function buildCardEl(card, { small = false } = {}) {
    const el = document.createElement('div');
    el.className = 'uno-card' + (small ? ' small' : '');

    if (card.color === 'wild') {
      el.classList.add('wild-face');
      if (card.value === 'wild4') {
        ['red', 'yellow', 'green', 'blue'].forEach((c) => {
          const mini = document.createElement('div');
          mini.className = 'mini-swatch ' + c;
          el.appendChild(mini);
        });
        const badge = document.createElement('span');
        badge.className = 'wild-badge';
        badge.textContent = '+4';
        el.appendChild(badge);
      } else {
        el.classList.add('wild-plain');
      }
      return el;
    }

    el.classList.add(card.color);
    if (card.value === 'draw2') el.classList.add('draw2');
    const symbol = cardSymbol(card);

    const tl = document.createElement('span');
    tl.className = 'corner tl';
    tl.textContent = symbol;

    const br = document.createElement('span');
    br.className = 'corner br';
    br.textContent = symbol;

    if (CUSTOM_ART_COLORS.has(card.color)) {
      el.append(tl, br);
      return el;
    }

    const oval = document.createElement('div');
    oval.className = 'uno-oval';
    const big = document.createElement('span');
    big.className = 'big-symbol';
    big.textContent = symbol;
    oval.appendChild(big);

    el.append(tl, oval, br);
    return el;
  }

  function canPlayLocally(card, topCard, currentColor) {
    if (!topCard) return true;
    if (card.color === 'wild') return true;
    if (card.color === currentColor) return true;
    if (card.value === topCard.value) return true;
    return false;
  }

  function myPlayer(state) {
    return state.players.find((p) => p.id === state.yourId);
  }

  function renderLog(el, log) {
    el.innerHTML = log.map((line) => `<div>${line}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  function statusLabel(status) {
    if (status === 'waiting') return 'Waiting for players';
    if (status === 'playing') return 'In progress';
    return 'Finished';
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
      meta.textContent = `${statusLabel(room.status)} · ${room.playerCount} player${room.playerCount === 1 ? '' : 's'}`;
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
    playerListEl.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p.name + (p.id === state.yourId ? ' (you)' : '');
      playerListEl.appendChild(li);
    });
    startBtn.disabled = state.players.length < 2;
    renderLog(waitingLogEl, state.log);
  }

  function renderGame(state) {
    othersRowEl.innerHTML = '';
    state.players
      .filter((p) => p.id !== state.yourId)
      .forEach((p) => {
        const tile = document.createElement('div');
        tile.className = 'uno-player-tile' + (p.id === state.currentPlayerId ? ' turn' : '') + (p.connected ? '' : ' offline');

        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = p.name;
        const count = document.createElement('div');
        count.className = 'count';
        count.textContent = `${p.cardCount} card${p.cardCount === 1 ? '' : 's'}`;
        tile.append(name, count);

        if (p.cardCount === 1) {
          if (p.calledUno) {
            const flag = document.createElement('div');
            flag.className = 'uno-flag';
            flag.textContent = 'UNO!';
            tile.appendChild(flag);
          } else {
            const catchBtn = document.createElement('button');
            catchBtn.className = 'secondary catch-btn';
            catchBtn.textContent = 'Catch!';
            catchBtn.addEventListener('click', () => socket.emit('uno:catch', { targetId: p.id }));
            tile.appendChild(catchBtn);
          }
        }
        othersRowEl.appendChild(tile);
      });

    deckCountEl.textContent = state.deckCount;
    discardEl.innerHTML = '';
    if (state.discardTop) discardEl.appendChild(buildCardEl(state.discardTop));
    colorLabelEl.textContent = state.currentColor
      ? state.currentColor[0].toUpperCase() + state.currentColor.slice(1)
      : '—';
    directionEl.textContent = state.direction === 1 ? '↻' : '↺';

    const isMyTurn = state.currentPlayerId === state.yourId;
    const other = state.players.find((p) => p.id === state.currentPlayerId);
    turnBannerEl.textContent = isMyTurn ? 'Your turn!' : other ? `${other.name}'s turn` : '';
    turnBannerEl.classList.toggle('mine', isMyTurn);

    handRowEl.innerHTML = '';
    state.yourHand.forEach((card) => {
      const el = buildCardEl(card);
      const playable = isMyTurn && canPlayLocally(card, state.discardTop, state.currentColor);
      el.classList.toggle('playable', playable);
      el.addEventListener('click', () => attemptPlay(card, isMyTurn));
      handRowEl.appendChild(el);
    });

    drawBtn.disabled = !isMyTurn || state.turnHasDrawn;
    passBtn.disabled = !isMyTurn || !state.turnHasDrawn;
    const self = myPlayer(state);
    unoBtn.disabled = state.yourHand.length !== 1 || Boolean(self?.calledUno);

    renderLog(gameLogEl, state.log);
  }

  function renderFinished(state) {
    const winner = state.players.find((p) => p.id === state.winnerId);
    winnerTextEl.textContent = winner ? `🏆 ${winner.name} wins!` : 'Game over.';
  }

  function render() {
    if (!joined) {
      showScreen(createRoomScreen.classList.contains('hidden') ? 'lobby' : 'create');
      renderLobby();
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
      renderFinished(latestState);
      showScreen('finished');
    }
  }

  function flashInvalid() {
    handRowEl.classList.remove('shake');
    handRowEl.offsetWidth;
    handRowEl.classList.add('shake');
  }

  function submitPlay(cardId, chosenColor) {
    socket.emit('uno:play', { cardId, chosenColor }, (res) => {
      if (!res || !res.ok) flashInvalid();
    });
  }

  function attemptPlay(card, isMyTurn) {
    if (!isMyTurn) return;
    if (!canPlayLocally(card, latestState.discardTop, latestState.currentColor)) {
      flashInvalid();
      return;
    }
    if (card.color === 'wild') {
      pendingWildCardId = card.id;
      colorModal.classList.remove('hidden');
      return;
    }
    submitPlay(card.id, null);
  }

  colorModal.querySelectorAll('.uno-color-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      colorModal.classList.add('hidden');
      if (pendingWildCardId) submitPlay(pendingWildCardId, color);
      pendingWildCardId = null;
    });
  });

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
    socket.emit('uno:listRooms', {}, (res) => {
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
    socket.emit('uno:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
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
          'room-full': 'That room is full.',
        };
        alert(messages[res && res.error] || 'Could not join that room.');
        backToLobby();
      }
    });
  }

  passwordSubmitBtn.addEventListener('click', () => {
    if (pendingJoinRoomId) attemptJoinRoom(pendingJoinRoomId, joinPasswordInput.value);
  });
  joinPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') passwordSubmitBtn.click();
  });
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
    socket.emit('uno:createRoom', { roomName, password, playerId: me.id, name: me.name }, (res) => {
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

  addBotsBtn.addEventListener('click', () => {
    socket.emit('uno:addBots', { count: 3 }, (res) => {
      if (!res || !res.ok) alert('Could not add bots: ' + ((res && res.error) || 'unknown error'));
    });
  });

  startBtn.addEventListener('click', () => socket.emit('uno:start'));
  drawBtn.addEventListener('click', () => socket.emit('uno:draw'));
  passBtn.addEventListener('click', () => socket.emit('uno:pass'));
  unoBtn.addEventListener('click', () => socket.emit('uno:callUno'));
  newGameBtn.addEventListener('click', () => socket.emit('uno:newGame'));
  leaveWaitingBtn.addEventListener('click', () => {
    socket.emit('uno:leave');
    backToLobby();
  });
  leaveBtn.addEventListener('click', () => {
    socket.emit('uno:leave');
    backToLobby();
  });

  socket.on('uno:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('uno:state', (state) => {
    latestState = state;
    if (state.players.some((p) => p.id === state.yourId)) joined = true;
    render();
  });

  // Fires on the initial connection AND every automatic reconnect after a
  // dropped connection. Re-send our stable playerId so the server can
  // reclaim our seat in whichever room we were last in — no password
  // needed, since already-seated reconnects are trusted.
  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('uno:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      // Silent rejoin attempt after a full page reload — succeeds only if
      // we're already a known seat in that room (password not required).
      socket.emit('uno:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (res && res.ok) enterRoom(lastRoomId);
        else backToLobby();
      });
    } else {
      backToLobby();
    }
  });

  showScreen('lobby');
}
