const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/ek');
  const LAST_ROOM_KEY = 'ek_last_room_id';

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

  const seatsRowEl = document.getElementById('seats-row');
  const deckCountEl = document.getElementById('deck-count');
  const discardEl = document.getElementById('discard-el');
  const discardCountEl = document.getElementById('discard-count');
  const viewDiscardLink = document.getElementById('view-discard-link');
  const turnBannerEl = document.getElementById('turn-banner');
  const pendingBannerEl = document.getElementById('pending-banner');
  const handRowEl = document.getElementById('hand-row');
  const drawBtn = document.getElementById('draw-btn');
  const playSelectedBtn = document.getElementById('play-selected-btn');
  const clearSelectionBtn = document.getElementById('clear-selection-btn');
  const nopeBtn = document.getElementById('nope-btn');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');

  const winnerTextEl = document.getElementById('winner-text');
  const newGameBtn = document.getElementById('new-game-btn');

  const targetPickerModal = document.getElementById('target-picker-modal');
  const targetPickerTitleEl = document.getElementById('target-picker-title');
  const targetPickerListEl = document.getElementById('target-picker-list');
  const requestedTypeRow = document.getElementById('requested-type-row');
  const requestedTypeSelect = document.getElementById('requested-type-select');
  const targetPickerConfirmBtn = document.getElementById('target-picker-confirm-btn');
  const targetPickerCancelBtn = document.getElementById('target-picker-cancel-btn');

  const discardPickerModal = document.getElementById('discard-picker-modal');
  const discardPickerListEl = document.getElementById('discard-picker-list');
  const discardPickerCancelBtn = document.getElementById('discard-picker-cancel-btn');

  const viewDiscardModal = document.getElementById('view-discard-modal');
  const viewDiscardListEl = document.getElementById('view-discard-list');
  const viewDiscardCloseBtn = document.getElementById('view-discard-close-btn');

  const reinsertModal = document.getElementById('reinsert-modal');
  const reinsertOptionsEl = document.getElementById('reinsert-options');

  const favorGiveModal = document.getElementById('favor-give-modal');
  const favorGiveTitleEl = document.getElementById('favor-give-title');
  const favorGiveListEl = document.getElementById('favor-give-list');

  const seeFutureModal = document.getElementById('see-future-modal');
  const seeFutureListEl = document.getElementById('see-future-list');
  const seeFutureCloseBtn = document.getElementById('see-future-close-btn');

  const rulesModal = document.getElementById('rules-modal');

  // Mirrors ek-server.js's CARD_INFO / CAT_KEYS — kept in sync by hand since
  // client and server don't share a module (same approach as uno.js).
  const CARD_INFO = {
    defuse: { label: 'Defuse', emoji: '🛡️' },
    explodingKitten: { label: 'Exploding Kitten', emoji: '💣' },
    attack: { label: 'Attack', emoji: '⚔️' },
    skip: { label: 'Skip', emoji: '⏭️' },
    favor: { label: 'Favor', emoji: '🤝' },
    shuffle: { label: 'Shuffle', emoji: '🔀' },
    seeFuture: { label: 'See the Future', emoji: '🔮' },
    nope: { label: 'Nope', emoji: '🙅' },
    tacocat: { label: 'Tacocat', emoji: '🌮' },
    cattermelon: { label: 'Cattermelon', emoji: '🍉' },
    beardcat: { label: 'Beard Cat', emoji: '🧔' },
    potatocat: { label: 'Hairy Potato Cat', emoji: '🥔' },
    rainbowcat: { label: 'Rainbow-Ralphing Cat', emoji: '🌈' },
  };
  const CAT_KEYS = ['tacocat', 'cattermelon', 'beardcat', 'potatocat', 'rainbowcat'];

  let latestState = null;
  let latestRooms = [];
  let joined = false;
  let pendingJoinRoomId = null;
  let selectedCardIds = [];
  let pendingPlayContext = null; // { cardIds, needsRequestedType }
  let selectedTargetId = null;
  let tickInterval = null;

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

  function buildCardEl(card, { small = false } = {}) {
    const el = document.createElement('div');
    el.className = 'ek-card' + (small ? ' small' : '');
    el.dataset.type = card.type;
    const info = CARD_INFO[card.type] || { emoji: '❓', label: card.type };
    const emoji = document.createElement('span');
    emoji.className = 'emoji';
    emoji.textContent = info.emoji;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = info.label;
    el.append(emoji, label);
    return el;
  }

  function statusLabel(status) {
    if (status === 'waiting') return 'Waiting for players';
    if (status === 'playing') return 'In progress';
    return 'Finished';
  }

  function renderLog(el, log) {
    el.innerHTML = log.map((line) => `<div>${line}</div>`).join('');
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

  function myPlayer(state) {
    return state.players.find((p) => p.id === state.yourId);
  }

  function renderSeats(state) {
    seatsRowEl.innerHTML = '';
    state.players.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'ek-seat'
        + (p.id === state.currentPlayerId ? ' turn' : '')
        + (!p.alive ? ' dead' : '')
        + (!p.connected ? ' offline' : '');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name + (p.id === state.yourId ? ' (You)' : '');
      const count = document.createElement('div');
      count.className = 'count';
      count.textContent = `${p.cardCount} card${p.cardCount === 1 ? '' : 's'}`;
      el.append(name, count);
      if (!p.alive) {
        const tag = document.createElement('div');
        tag.className = 'dead-tag';
        tag.textContent = '💥 OUT';
        el.appendChild(tag);
      }
      seatsRowEl.appendChild(el);
    });
  }

  function renderPiles(state) {
    deckCountEl.textContent = state.deckCount;
    discardCountEl.textContent = (state.discard || []).length;
    discardEl.innerHTML = '';
    if (state.discardTop) discardEl.appendChild(buildCardEl(state.discardTop));
  }

  function selectionShape(state) {
    const cards = selectedCardIds.map((id) => state.yourHand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== selectedCardIds.length || !cards.length) return null;
    if (cards.length === 1) {
      return ['attack', 'skip', 'favor', 'shuffle', 'seeFuture'].includes(cards[0].type) ? { kind: 'single', type: cards[0].type } : null;
    }
    if (cards.length === 2 || cards.length === 3) {
      if (!CAT_KEYS.includes(cards[0].type) || !cards.every((c) => c.type === cards[0].type)) return null;
      return { kind: cards.length === 2 ? 'pair' : 'triple', type: cards[0].type };
    }
    if (cards.length === 5) {
      const types = new Set(cards.map((c) => c.type));
      if (types.size !== 5 || ![...types].every((t) => CAT_KEYS.includes(t))) return null;
      return { kind: 'five' };
    }
    return null;
  }

  function renderHand(state) {
    handRowEl.innerHTML = '';
    const isMyTurn = state.currentPlayerId === state.yourId;
    const blocked = Boolean(state.pendingAction || state.pendingFavor || state.pendingReinsert);
    state.yourHand.forEach((card) => {
      const el = buildCardEl(card);
      const clickable = isMyTurn && !blocked;
      el.classList.toggle('playable', clickable);
      el.classList.toggle('selected', selectedCardIds.includes(card.id));
      if (clickable) {
        el.addEventListener('click', () => {
          if (selectedCardIds.includes(card.id)) {
            selectedCardIds = selectedCardIds.filter((id) => id !== card.id);
          } else if (selectedCardIds.length < 5) {
            selectedCardIds.push(card.id);
          }
          render();
        });
      }
      handRowEl.appendChild(el);
    });

    const shape = selectionShape(state);
    playSelectedBtn.disabled = !isMyTurn || blocked || !shape;
    drawBtn.disabled = !isMyTurn || blocked;
  }

  function renderPendingBanner(state) {
    let text = '';
    if (state.pendingAction) {
      const actor = state.players.find((p) => p.id === state.pendingAction.actorId);
      const remaining = Math.max(0, state.pendingAction.deadline - Date.now());
      text = `⏳ ${actor ? actor.name : 'Someone'} played a card — Nope it? ${(remaining / 1000).toFixed(1)}s left`;
    } else if (state.pendingFavor) {
      const from = state.players.find((p) => p.id === state.pendingFavor.fromId);
      const to = state.players.find((p) => p.id === state.pendingFavor.toId);
      text = `🤝 Waiting for ${to ? to.name : '?'} to hand a card to ${from ? from.name : '?'}...`;
    } else if (state.pendingReinsert) {
      const p = state.players.find((pl) => pl.id === state.pendingReinsert.playerId);
      text = `💣 ${p ? p.name : 'Someone'} is slipping the kitten back into the deck...`;
    }
    pendingBannerEl.classList.toggle('hidden', !text);
    pendingBannerEl.textContent = text;

    const canNope = Boolean(state.pendingAction) && state.pendingAction.actorId !== state.yourId
      && state.yourHand.some((c) => c.type === 'nope');
    nopeBtn.style.display = canNope ? '' : 'none';

    updateTicking(Boolean(state.pendingAction));
  }

  function updateTicking(shouldTick) {
    if (shouldTick && !tickInterval) {
      tickInterval = setInterval(() => { if (latestState) renderGame(latestState); }, 200);
    } else if (!shouldTick && tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function renderReinsertModal(state) {
    const shouldShow = Boolean(state.pendingReinsert && state.pendingReinsert.playerId === state.yourId);
    reinsertModal.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;
    const n = state.deckCount;
    reinsertOptionsEl.innerHTML = '';
    const options = [
      { label: 'Top (next draw)', pos: 0 },
      { label: 'Near Top', pos: Math.round(n * 0.25) },
      { label: 'Middle', pos: Math.round(n * 0.5) },
      { label: 'Near Bottom', pos: Math.round(n * 0.75) },
      { label: 'Bottom', pos: n },
      { label: '🎲 Random', pos: Math.floor(Math.random() * (n + 1)) },
    ];
    options.forEach((o) => {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = o.label;
      btn.addEventListener('click', () => {
        socket.emit('ek:reinsertKitten', { position: o.pos }, (res) => {
          if (!res || !res.ok) alert('Could not reinsert: ' + ((res && res.error) || 'unknown error'));
        });
      });
      reinsertOptionsEl.appendChild(btn);
    });
  }

  function renderFavorGiveModal(state) {
    const shouldShow = Boolean(state.pendingFavor && state.pendingFavor.toId === state.yourId);
    favorGiveModal.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;
    const from = state.players.find((p) => p.id === state.pendingFavor.fromId);
    favorGiveTitleEl.textContent = `Favor: give a card to ${from ? from.name : '?'}`;
    favorGiveListEl.innerHTML = '';
    state.yourHand.forEach((card) => {
      const el = buildCardEl(card);
      el.classList.add('playable');
      el.addEventListener('click', () => {
        socket.emit('ek:giveFavorCard', { cardId: card.id }, (res) => {
          if (!res || !res.ok) alert('Could not give that card: ' + ((res && res.error) || 'unknown error'));
        });
      });
      favorGiveListEl.appendChild(el);
    });
  }

  function renderGame(state) {
    renderSeats(state);
    renderPiles(state);

    const isMyTurn = state.currentPlayerId === state.yourId;
    const other = state.players.find((p) => p.id === state.currentPlayerId);
    turnBannerEl.textContent = isMyTurn
      ? `Your turn!${state.turnsOwed > 1 ? ` (${state.turnsOwed} turns owed)` : ''}`
      : (other ? `${other.name}'s turn` : '');
    turnBannerEl.classList.toggle('mine', isMyTurn);

    renderPendingBanner(state);
    renderHand(state);
    renderReinsertModal(state);
    renderFavorGiveModal(state);
    renderLog(gameLogEl, state.log);
  }

  function renderFinished(state) {
    const winner = state.players.find((p) => p.id === state.winnerId);
    winnerTextEl.textContent = winner ? `🏆 ${winner.name} wins!` : 'Everyone exploded — no winner.';
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

  // --- Playing a card: routes to a target/discard picker as needed, then
  // submits. Cat combo "kind" (pair/triple/five) is inferred from how many
  // cards are selected (see selectionShape). ---
  function submitPlayCard(cardIds, extra) {
    socket.emit('ek:playCard', { cardIds, ...extra }, (res) => {
      if (!res || !res.ok) alert('Could not play that: ' + ((res && res.error) || 'unknown error'));
    });
    selectedCardIds = [];
    render();
  }

  function renderTargetPickerList() {
    targetPickerListEl.innerHTML = '';
    latestState.players.filter((p) => p.id !== latestState.yourId && p.alive).forEach((p) => {
      const btn = document.createElement('button');
      btn.className = 'ek-target-btn' + (p.id === selectedTargetId ? ' selected' : '');
      btn.textContent = `${p.name} (${p.cardCount} cards)`;
      btn.addEventListener('click', () => {
        selectedTargetId = p.id;
        renderTargetPickerList();
        targetPickerConfirmBtn.disabled = false;
      });
      targetPickerListEl.appendChild(btn);
    });
  }

  function populateRequestedTypeSelect() {
    requestedTypeSelect.innerHTML = '';
    Object.entries(CARD_INFO).forEach(([type, info]) => {
      if (type === 'defuse' || type === 'explodingKitten') return;
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = `${info.emoji} ${info.label}`;
      requestedTypeSelect.appendChild(opt);
    });
  }

  function openTargetPicker(cardIds, needsRequestedType) {
    pendingPlayContext = { cardIds, needsRequestedType };
    selectedTargetId = null;
    targetPickerTitleEl.textContent = needsRequestedType ? 'Choose a player to demand a card from' : 'Choose a player';
    requestedTypeRow.classList.toggle('hidden', !needsRequestedType);
    if (needsRequestedType) populateRequestedTypeSelect();
    targetPickerConfirmBtn.disabled = true;
    renderTargetPickerList();
    targetPickerModal.classList.remove('hidden');
  }
  function closeTargetPicker() {
    targetPickerModal.classList.add('hidden');
    pendingPlayContext = null;
    selectedTargetId = null;
  }
  targetPickerConfirmBtn.addEventListener('click', () => {
    if (!selectedTargetId || !pendingPlayContext) return;
    const extra = { targetId: selectedTargetId };
    if (pendingPlayContext.needsRequestedType) extra.requestedType = requestedTypeSelect.value;
    const cardIds = pendingPlayContext.cardIds;
    closeTargetPicker();
    submitPlayCard(cardIds, extra);
  });
  targetPickerCancelBtn.addEventListener('click', closeTargetPicker);

  function openDiscardPicker(cardIds) {
    pendingPlayContext = { cardIds };
    discardPickerListEl.innerHTML = '';
    (latestState.discard || []).forEach((c) => {
      const el = buildCardEl(c, { small: true });
      el.classList.add('playable');
      el.addEventListener('click', () => {
        const ids = pendingPlayContext.cardIds;
        discardPickerModal.classList.add('hidden');
        pendingPlayContext = null;
        submitPlayCard(ids, { discardCardId: c.id });
      });
      discardPickerListEl.appendChild(el);
    });
    discardPickerModal.classList.remove('hidden');
  }
  discardPickerCancelBtn.addEventListener('click', () => {
    discardPickerModal.classList.add('hidden');
    pendingPlayContext = null;
  });

  playSelectedBtn.addEventListener('click', () => {
    const shape = selectionShape(latestState);
    if (!shape) return;
    const cardIds = [...selectedCardIds];
    if (shape.kind === 'single') {
      if (shape.type === 'favor') { openTargetPicker(cardIds, false); return; }
      submitPlayCard(cardIds, {});
    } else if (shape.kind === 'pair') {
      openTargetPicker(cardIds, false);
    } else if (shape.kind === 'triple') {
      openTargetPicker(cardIds, true);
    } else if (shape.kind === 'five') {
      openDiscardPicker(cardIds);
    }
  });
  clearSelectionBtn.addEventListener('click', () => { selectedCardIds = []; render(); });
  drawBtn.addEventListener('click', () => {
    socket.emit('ek:draw', {}, (res) => {
      if (!res || !res.ok) alert('Could not draw: ' + ((res && res.error) || 'unknown error'));
    });
  });
  nopeBtn.addEventListener('click', () => {
    socket.emit('ek:nope', {}, (res) => {
      if (!res || !res.ok) alert('Could not Nope: ' + ((res && res.error) || 'unknown error'));
    });
  });

  viewDiscardLink.addEventListener('click', (e) => {
    e.preventDefault();
    viewDiscardListEl.innerHTML = '';
    [...(latestState.discard || [])].reverse().forEach((c) => viewDiscardListEl.appendChild(buildCardEl(c, { small: true })));
    viewDiscardModal.classList.remove('hidden');
  });
  viewDiscardCloseBtn.addEventListener('click', () => viewDiscardModal.classList.add('hidden'));

  socket.on('ek:seeFutureResult', ({ top3 }) => {
    seeFutureListEl.innerHTML = '';
    top3.forEach((c) => seeFutureListEl.appendChild(buildCardEl(c, { small: true })));
    seeFutureModal.classList.remove('hidden');
  });
  seeFutureCloseBtn.addEventListener('click', () => seeFutureModal.classList.add('hidden'));

  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    rulesModal.classList.remove('hidden');
  });
  rulesModal.querySelector('.modal-close').addEventListener('click', () => rulesModal.classList.add('hidden'));

  function enterRoom(roomId) {
    joined = true;
    localStorage.setItem(LAST_ROOM_KEY, roomId);
    render();
  }

  function backToLobby() {
    joined = false;
    latestState = null;
    selectedCardIds = [];
    updateTicking(false);
    localStorage.removeItem(LAST_ROOM_KEY);
    createRoomScreen.classList.add('hidden');
    socket.emit('ek:listRooms', {}, (res) => {
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
    socket.emit('ek:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
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
    socket.emit('ek:createRoom', { roomName, password, playerId: me.id, name: me.name }, (res) => {
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
    socket.emit('ek:addBots', { count: 3 }, (res) => {
      if (!res || !res.ok) alert('Could not add bots: ' + ((res && res.error) || 'unknown error'));
    });
  });

  startBtn.addEventListener('click', () => socket.emit('ek:start'));
  newGameBtn.addEventListener('click', () => socket.emit('ek:newGame'));
  leaveWaitingBtn.addEventListener('click', () => { socket.emit('ek:leave'); backToLobby(); });
  leaveBtn.addEventListener('click', () => { socket.emit('ek:leave'); backToLobby(); });

  socket.on('ek:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('ek:state', (state) => {
    latestState = state;
    if (state.players.some((p) => p.id === state.yourId)) joined = true;
    render();
  });

  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('ek:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('ek:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (res && res.ok) enterRoom(lastRoomId);
        else backToLobby();
      });
    } else {
      backToLobby();
    }
  });

  showScreen('lobby');
}
