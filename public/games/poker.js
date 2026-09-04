const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/poker');
  const LAST_ROOM_KEY = 'poker_last_room_id';
  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

  function rankLabel(rank) { return RANK_LABEL[rank] || String(rank); }
  function isRed(suit) { return suit === 'H' || suit === 'D'; }

  function cardEl(card, { small = false, highlight = false } = {}) {
    const el = document.createElement('div');
    el.className = `pk-card${small ? ' small' : ''}${isRed(card.suit) ? ' red' : ''}${highlight ? ' win' : ''}`;
    const rank = document.createElement('div');
    rank.textContent = rankLabel(card.rank);
    const suit = document.createElement('div');
    suit.className = 'suit';
    suit.textContent = SUIT_SYMBOL[card.suit];
    el.append(rank, suit);
    return el;
  }

  function cardBackEl(small = false) {
    const el = document.createElement('div');
    el.className = `pk-card back${small ? ' small' : ''}`;
    return el;
  }

  function fillCards(container, cards, { small = false, highlightSet = null } = {}) {
    container.innerHTML = '';
    (cards || []).forEach((c) => {
      const win = highlightSet && highlightSet.has(`${c.rank}${c.suit}`);
      container.appendChild(cardEl(c, { small, highlight: win }));
    });
  }

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
  const maxSeatsSelect = document.getElementById('max-seats-select');
  const startingChipsSelect = document.getElementById('starting-chips-select');
  const smallBlindSelect = document.getElementById('small-blind-select');
  const blindIncreaseSelect = document.getElementById('blind-increase-select');
  const timePerTurnSelect = document.getElementById('time-per-turn-select');
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

  const turnBannerEl = document.getElementById('turn-banner');
  const turnClockEl = document.getElementById('turn-clock');
  const handResultEl = document.getElementById('hand-result');
  const seatsEl = document.getElementById('seats');
  const boardCardsEl = document.getElementById('board-cards');
  const potDisplayEl = document.getElementById('pot-display');
  const youPanelEl = document.getElementById('you-panel');
  const actionBarEl = document.getElementById('action-bar');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');

  const winnerTextEl = document.getElementById('winner-text');
  const finalStandingsEl = document.getElementById('final-standings');
  const newGameBtn = document.getElementById('new-game-btn');

  const rulesModal = document.getElementById('rules-modal');

  let joined = false;
  let latestRooms = [];
  let latestState = null;
  let pendingJoinRoomId = null;

  // Clocks are purely a locally-ticking display, resynced from the server's
  // numbers on every broadcast (same pattern as Battleship's turn clock).
  let clockSnapshot = null;
  function captureClockSnapshot(state) {
    clockSnapshot = {
      capturedAt: Date.now(),
      status: state.status,
      turnTimeRemainingMs: state.turnTimeRemainingMs,
    };
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
      meta.textContent = `${statusLabel(room.status)} · ${room.playerCount}/${room.maxSeats} players · blinds ${room.smallBlind}/${room.bigBlind}`;
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
    const increaseLabel = state.blindIncreaseHands ? `blinds double every ${state.blindIncreaseHands} hands` : 'blinds fixed';
    waitingConfigEl.textContent = [
      `${state.players.length}/${state.maxSeats} seats`,
      `${state.startingChips} starting chips`,
      `blinds ${state.smallBlind}/${state.bigBlind} (${increaseLabel})`,
      state.timePerTurn ? `${state.timePerTurn}s per turn` : 'Unlimited time per turn',
    ].join(' · ');
    playerListEl.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = p.name + (p.id === state.yourId ? ' (you)' : '') + (p.isBot ? ' 🤖' : '');
      const chips = document.createElement('span');
      chips.style.color = 'var(--gold)';
      chips.textContent = `${p.chips}`;
      li.append(label, chips);
      playerListEl.appendChild(li);
    });
    if (state.players.length < 2) {
      const li = document.createElement('li');
      li.style.color = 'var(--muted)';
      li.textContent = 'Waiting for more players, or add a bot...';
      playerListEl.appendChild(li);
    }
    startBtn.disabled = state.players.length < 2;
    addBotBtn.disabled = state.players.length >= state.maxSeats;
    renderLog(waitingLogEl, state.log);
  }

  function renderTurnBanner(state) {
    if (state.status !== 'playing') { turnBannerEl.textContent = ''; turnBannerEl.className = 'pk-turn-banner'; return; }
    if (state.phase === 'between' && state.lastHandResult) {
      turnBannerEl.textContent = state.lastHandResult.type === 'uncontested' ? 'Hand over — dealing again soon...' : 'Showdown! Dealing again soon...';
      turnBannerEl.className = 'pk-turn-banner';
      return;
    }
    const mine = state.yourId === state.currentPlayerId;
    const currentPlayer = state.players.find((p) => p.id === state.currentPlayerId);
    const thinking = !mine && currentPlayer && currentPlayer.isBot;
    turnBannerEl.innerHTML = '';
    if (mine) {
      turnBannerEl.textContent = 'Your turn!';
    } else if (thinking) {
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `🤔 ${currentPlayer.name} is thinking`;
      const dots = document.createElement('span');
      dots.className = 'pk-thinking-dots';
      dots.textContent = '...';
      turnBannerEl.append(nameSpan, dots);
    } else {
      turnBannerEl.textContent = `Waiting for ${currentPlayer ? currentPlayer.name : 'the table'}...`;
    }
    turnBannerEl.className = 'pk-turn-banner' + (mine ? ' mine' : '') + (thinking ? ' thinking' : '');
  }

  function winningCardKeySet(bestCards) {
    return new Set((bestCards || []).map((c) => `${c.rank}${c.suit}`));
  }

  function renderHandResult(state) {
    if (state.phase !== 'between' || !state.lastHandResult) { handResultEl.classList.add('hidden'); return; }
    const result = state.lastHandResult;
    handResultEl.classList.remove('hidden');
    handResultEl.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = result.type === 'uncontested' ? 'Everyone else folded' : 'Showdown!';
    handResultEl.appendChild(title);

    if (result.type === 'showdown') {
      const bestKeySets = {};
      result.revealed.forEach((r) => { bestKeySets[r.id] = winningCardKeySet(r.bestCards); });
      result.revealed.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'reveal-row';
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = `${r.name} — ${r.handName}`;
        const cards = document.createElement('div');
        cards.className = 'cards';
        fillCards(cards, r.holeCards, { small: true, highlightSet: bestKeySets[r.id] });
        row.append(label, cards);
        handResultEl.appendChild(row);
      });
    }
    result.pots.forEach((pot) => {
      const line = document.createElement('div');
      line.style.textAlign = 'center';
      line.style.marginTop = '4px';
      line.style.color = 'var(--good)';
      line.textContent = `Pot ${pot.amount}: ` + pot.winners.map((w) => `${w.name} +${w.amount}`).join(', ');
      handResultEl.appendChild(line);
    });
  }

  // Seats everyone -- you included -- around an oval table, in fixed
  // seating order (the server's player join order), with you always at
  // the bottom -- same approach as UNO's renderTable(): a stable seating
  // order means seats never have to physically shuffle around when the
  // dealer button or turn moves, only the highlighting does.
  function renderSeats(state) {
    seatsEl.innerHTML = '';
    const n = state.players.length;
    if (!n) return;
    const youIndex = state.players.findIndex((p) => p.id === state.yourId);
    const startIndex = youIndex === -1 ? 0 : youIndex;

    for (let seat = 0; seat < n; seat += 1) {
      const p = state.players[(startIndex + seat) % n];
      const isYou = p.id === state.yourId;

      // seat 0 (you) sits at the bottom (90°); the rest fill in evenly
      // around the oval in fixed seating order.
      const angleDeg = 90 + seat * (360 / n);
      const angleRad = (angleDeg * Math.PI) / 180;
      const x = 50 + 42 * Math.cos(angleRad);
      const y = 50 + 38 * Math.sin(angleRad);

      const el = document.createElement('div');
      el.className = 'pk-seat'
        + (isYou ? ' you' : '')
        + (state.status === 'playing' && p.id === state.currentPlayerId ? ' turn' : '')
        + (p.folded ? ' folded' : '')
        + (!p.connected ? ' offline' : '')
        + (p.eliminated ? ' eliminated' : '');
      el.style.left = x + '%';
      el.style.top = y + '%';

      if (p.isDealer) {
        const badge = document.createElement('span');
        badge.className = 'dealer-badge';
        badge.textContent = 'D';
        el.appendChild(badge);
      } else if (p.allIn) {
        const badge = document.createElement('span');
        badge.className = 'allin-badge';
        badge.textContent = 'ALL-IN';
        el.appendChild(badge);
      } else if (p.folded && p.inHand) {
        const badge = document.createElement('span');
        badge.className = 'fold-badge';
        badge.textContent = 'FOLD';
        el.appendChild(badge);
      }

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name + (isYou ? ' (you)' : '') + (p.isBot ? ' 🤖' : '');
      const chips = document.createElement('div');
      chips.className = 'chips';
      chips.textContent = p.eliminated ? 'out' : `🪙 ${p.chips}`;
      el.append(name, chips);

      if (p.currentStreetBet > 0 && state.status === 'playing' && state.phase !== 'between') {
        const bet = document.createElement('div');
        bet.className = 'bet';
        bet.textContent = `bet ${p.currentStreetBet}`;
        el.appendChild(bet);
      }

      if (!isYou && p.inHand) {
        const holeRow = document.createElement('div');
        holeRow.className = 'hole-cards';
        if (p.revealedHoleCards) fillCards(holeRow, p.revealedHoleCards, { small: true });
        else if (!p.folded) { holeRow.appendChild(cardBackEl(true)); holeRow.appendChild(cardBackEl(true)); }
        el.appendChild(holeRow);
      }

      seatsEl.appendChild(el);
    }
  }

  // Your own hole cards, shown big below the table -- your name/chips
  // already appear on your seat at the table, same split UNO uses between
  // its table seats (name + card count) and its separate hand row (the
  // actual cards).
  function renderYouPanel(state) {
    youPanelEl.innerHTML = '';
    const holeRow = document.createElement('div');
    holeRow.className = 'hole-cards';
    if (state.you && state.you.holeCards) fillCards(holeRow, state.you.holeCards);
    else { holeRow.appendChild(cardBackEl()); holeRow.appendChild(cardBackEl()); }
    youPanelEl.appendChild(holeRow);
  }

  function renderBoardAndPot(state) {
    fillCards(boardCardsEl, state.community, { small: true });
    for (let i = state.community.length; i < 5; i += 1) boardCardsEl.appendChild(cardBackEl(true));
    potDisplayEl.textContent = `Pot: 🪙 ${state.pot}`;
  }

  function sendAction(action, amount) {
    socket.emit('poker:action', { action, amount }, (res) => {
      if (!res || !res.ok) alert('Could not act: ' + ((res && res.error) || 'unknown error'));
    });
  }

  function renderActionBar(state) {
    actionBarEl.innerHTML = '';
    const info = state.actionInfo;
    if (!info) return;

    const buttonsRow = document.createElement('div');
    buttonsRow.className = 'pk-action-buttons';

    if (info.toCall > 0) {
      const foldBtn = document.createElement('button');
      foldBtn.className = 'danger';
      foldBtn.textContent = 'Fold';
      foldBtn.addEventListener('click', () => sendAction('fold'));
      buttonsRow.appendChild(foldBtn);
    }

    const callBtn = document.createElement('button');
    callBtn.className = 'secondary';
    callBtn.textContent = info.toCall > 0 ? `Call ${info.toCall}` : 'Check';
    callBtn.addEventListener('click', () => sendAction(info.toCall > 0 ? 'call' : 'check'));
    buttonsRow.appendChild(callBtn);

    actionBarEl.appendChild(buttonsRow);

    const canRaise = info.maxRaiseTo > info.highestBet;
    if (canRaise) {
      const minTo = Math.min(info.minRaiseTo, info.maxRaiseTo);
      const maxTo = info.maxRaiseTo;

      const raiseRow = document.createElement('div');
      raiseRow.className = 'pk-raise-row';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(minTo);
      slider.max = String(maxTo);
      slider.step = '1';
      slider.value = String(minTo);
      const numberInput = document.createElement('input');
      numberInput.type = 'number';
      numberInput.min = String(minTo);
      numberInput.max = String(maxTo);
      numberInput.value = String(minTo);
      slider.addEventListener('input', () => { numberInput.value = slider.value; });
      numberInput.addEventListener('input', () => {
        const clamped = Math.max(minTo, Math.min(maxTo, Number(numberInput.value) || minTo));
        slider.value = String(clamped);
      });
      raiseRow.append(slider, numberInput);
      actionBarEl.appendChild(raiseRow);

      const quickRow = document.createElement('div');
      quickRow.className = 'pk-quick-bets';
      const meState = state.players.find((p) => p.id === state.yourId);
      const potAfterCall = state.pot + info.toCall;
      const baseTotal = meState.currentStreetBet + info.toCall;
      const quickTargets = [
        { label: '½ Pot', total: baseTotal + Math.round(potAfterCall * 0.5) },
        { label: 'Pot', total: baseTotal + potAfterCall },
        { label: 'All-in', total: maxTo },
      ];
      quickTargets.forEach(({ label, total }) => {
        const btn = document.createElement('button');
        btn.className = 'secondary';
        btn.textContent = label;
        btn.addEventListener('click', () => {
          const clamped = Math.max(minTo, Math.min(maxTo, total));
          slider.value = String(clamped);
          numberInput.value = String(clamped);
        });
        quickRow.appendChild(btn);
      });
      actionBarEl.appendChild(quickRow);

      const raiseBtn = document.createElement('button');
      raiseBtn.textContent = info.highestBet > 0 ? 'Raise' : 'Bet';
      raiseBtn.addEventListener('click', () => sendAction('raise', Number(numberInput.value) || minTo));
      actionBarEl.appendChild(raiseBtn);
    }
  }

  function renderGame(state) {
    captureClockSnapshot(state);
    renderTurnBanner(state);
    tickClock();
    renderHandResult(state);
    renderSeats(state);
    renderBoardAndPot(state);
    renderYouPanel(state);
    renderActionBar(state);
    renderLog(gameLogEl, state.log);
  }

  function renderFinished(state) {
    winnerTextEl.textContent = state.resultText || 'Game over.';
    finalStandingsEl.innerHTML = '';
    state.players.slice().sort((a, b) => b.chips - a.chips).forEach((p) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = p.name + (p.id === state.yourId ? ' (you)' : '') + (p.isBot ? ' 🤖' : '');
      const chips = document.createElement('span');
      chips.style.color = 'var(--gold)';
      chips.textContent = `${p.chips}`;
      li.append(label, chips);
      finalStandingsEl.appendChild(li);
    });
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
    socket.emit('poker:listRooms', {}, (res) => {
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
    socket.emit('poker:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
      if (res && res.ok) {
        closePasswordModal();
        enterRoom(roomId);
      } else if (res && res.error === 'wrong-password') {
        passwordErrorEl.textContent = 'Wrong password — try again.';
        passwordErrorEl.style.display = 'block';
      } else {
        closePasswordModal();
        const messages = {
          'no-such-room': 'That table no longer exists.',
          'game-in-progress': 'That table already started a game.',
          'room-full': 'That table is already full.',
        };
        alert(messages[res && res.error] || 'Could not join that table.');
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
    maxSeatsSelect.value = '6';
    startingChipsSelect.value = '1000';
    smallBlindSelect.value = '10';
    blindIncreaseSelect.value = '0';
    timePerTurnSelect.value = '0';
    createRoomErrorEl.style.display = 'none';
    showScreen('create');
  });
  cancelCreateBtn.addEventListener('click', () => showScreen('lobby'));

  createRoomBtn.addEventListener('click', () => {
    const roomName = roomNameInput.value.trim();
    const password = roomPasswordInput.value;
    if (!roomName) {
      createRoomErrorEl.textContent = 'Please enter a table name.';
      createRoomErrorEl.style.display = 'block';
      return;
    }
    if (!password) {
      createRoomErrorEl.textContent = 'Please set a password for the table.';
      createRoomErrorEl.style.display = 'block';
      return;
    }
    socket.emit('poker:createRoom', {
      roomName,
      password,
      playerId: me.id,
      name: me.name,
      maxSeats: Number(maxSeatsSelect.value),
      startingChips: Number(startingChipsSelect.value),
      smallBlind: Number(smallBlindSelect.value),
      blindIncreaseHands: Number(blindIncreaseSelect.value),
      timePerTurn: Number(timePerTurnSelect.value),
    }, (res) => {
      if (res && res.ok) {
        enterRoom(res.roomId);
      } else {
        const messages = {
          'name-taken': 'A table with that name already exists — pick another name.',
          'invalid-name': 'Please enter a table name.',
          'invalid-password': 'Please set a password for the table.',
        };
        createRoomErrorEl.textContent = messages[res && res.error] || 'Could not create the table.';
        createRoomErrorEl.style.display = 'block';
      }
    });
  });

  addBotBtn.addEventListener('click', () => {
    socket.emit('poker:addBot', {}, (res) => {
      if (!res || !res.ok) alert('Could not add a bot: ' + ((res && res.error) || 'unknown error'));
    });
  });

  startBtn.addEventListener('click', () => socket.emit('poker:start'));
  leaveWaitingBtn.addEventListener('click', () => { socket.emit('poker:leave'); backToLobby(); });
  leaveBtn.addEventListener('click', () => { socket.emit('poker:leave'); backToLobby(); });
  newGameBtn.addEventListener('click', () => socket.emit('poker:newGame'));

  socket.on('poker:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('poker:state', (state) => {
    if (state.players.some((p) => p.id === state.yourId)) joined = true;
    latestState = state;
    render();
  });

  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('poker:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('poker:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
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
