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
  const unoCountdownBannerEl = document.getElementById('uno-countdown-banner');
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

  // --- Sound: looping background music while a game is in progress, plus a
  // synthesized "card flick" effect whenever a card hits the discard pile
  // (ours or anyone else's — driven by discardTop actually changing). ---
  const MUSIC_MUTED_KEY = 'uno_music_muted';
  const bgmAudio = document.getElementById('bgm-audio');
  const muteBtn = document.getElementById('mute-btn');
  const BGM_NORMAL_VOLUME = 0.35;
  const BGM_DUCK_VOLUME = 0.08;
  bgmAudio.volume = BGM_NORMAL_VOLUME;
  let musicMuted = localStorage.getItem(MUSIC_MUTED_KEY) === '1';

  // Ducking so a card callout voice is easy to hear over the music. Tracked
  // with a token so two callouts firing close together (fast bot turns)
  // can't have the first one's cleanup restore full volume while the
  // second is still talking.
  let duckToken = 0;
  function duckBgm() {
    duckToken += 1;
    bgmAudio.volume = BGM_DUCK_VOLUME;
    return duckToken;
  }
  function restoreBgmVolume(token) {
    if (token === duckToken) bgmAudio.volume = BGM_NORMAL_VOLUME;
  }

  function updateMuteBtn() {
    muteBtn.textContent = musicMuted ? '🔇' : '🔊';
  }
  function syncBgm(status) {
    if (musicMuted || status !== 'playing') {
      bgmAudio.pause();
    } else if (bgmAudio.paused) {
      bgmAudio.play().catch(() => {}); // blocked until a user gesture — fine, next click retries via render()
    }
  }
  muteBtn.addEventListener('click', () => {
    musicMuted = !musicMuted;
    localStorage.setItem(MUSIC_MUTED_KEY, musicMuted ? '1' : '0');
    updateMuteBtn();
    syncBgm(latestState ? latestState.status : null);
  });
  updateMuteBtn();

  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // Playful Vietnamese callouts per action card — spoken via the browser's
  // built-in Web Speech API rather than shipped audio files. Quality depends
  // on whatever Vietnamese voice (if any) the OS/browser provides.
  const CARD_CALLOUTS = {
    wild: 'Xí xóa nha!',
    wild4: 'U là trời!',
    skip: 'Dỗi!',
    reverse: 'Không chịu đâu!',
    draw2: 'Ahihi đồ ngốc!',
  };
  function speakCallout(text) {
    if (musicMuted) return;
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel(); // don't queue up if cards fly fast
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'vi-VN';
      utter.rate = 1.05;
      utter.pitch = 1.15;
      const token = duckBgm();
      utter.onend = () => restoreBgmVolume(token);
      utter.onerror = () => restoreBgmVolume(token);
      setTimeout(() => restoreBgmVolume(token), 4000); // safety net if onend never fires
      window.speechSynthesis.speak(utter);
    } catch (err) {
      // Speech synthesis unsupported/blocked — nice-to-have, skip silently.
    }
  }

  // Prefer a real recorded clip per card type (sounds/callouts/<value>.mp3)
  // over the synthesized voice above; falls back to speakCallout() if that
  // file hasn't been recorded/added yet, or fails to load/play.
  const calloutAudioCache = {};
  function getCalloutAudio(value) {
    if (!calloutAudioCache[value]) {
      const audio = new Audio(`sounds/callouts/${value}.mp3`);
      audio.preload = 'auto';
      calloutAudioCache[value] = audio;
    }
    return calloutAudioCache[value];
  }
  function playCallout(value, text) {
    if (musicMuted) return;
    const audio = getCalloutAudio(value);
    audio.currentTime = 0;
    const token = duckBgm();
    const restore = () => restoreBgmVolume(token);
    audio.onended = restore;
    audio.onerror = restore;
    setTimeout(restore, 4000); // safety net if neither event fires
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        restore();
        speakCallout(text);
      });
    }
  }
  // No sound asset needed — a low pitch-dropping "thump" plus a short noise
  // "tick" reads as a satisfying card-slap without shipping an audio file.
  function playCardDropSound() {
    if (musicMuted) return;
    try {
      const ctx = getAudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(55, now + 0.09);
      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.25, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
      osc.connect(oscGain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.12);

      const bufferSize = Math.floor(ctx.sampleRate * 0.03);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'highpass';
      noiseFilter.frequency.value = 2000;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.2, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
      noise.start(now);
    } catch (err) {
      // Web Audio unsupported/blocked — the sound is a nice-to-have, skip silently.
    }
  }

  // A two-note descending "womp womp" buzzer for the auto UNO-penalty —
  // distinct from the card-drop thump and the voice callouts.
  function playPenaltySound() {
    if (musicMuted) return;
    try {
      const ctx = getAudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      [0, 0.18].forEach((offset, i) => {
        const startFreq = i === 0 ? 220 : 180;
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(startFreq, now + offset);
        osc.frequency.exponentialRampToValueAtTime(startFreq * 0.5, now + offset + 0.22);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, now + offset);
        gain.gain.linearRampToValueAtTime(0.22, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.24);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.25);
      });
    } catch (err) {
      // Web Audio unsupported/blocked — nice-to-have, skip silently.
    }
  }

  let lastDiscardCardId = null;
  let lastUnoPenaltyCounter = null;
  let unoTickInterval = null;

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

  // The server only pushes state on actual game events, but a countdown
  // needs to visibly tick between them — so re-render on a short interval
  // for exactly as long as there's an active UNO window, and stop otherwise.
  function updateUnoTicking(shouldTick) {
    if (shouldTick && !unoTickInterval) {
      unoTickInterval = setInterval(() => {
        if (latestState) renderGame(latestState);
      }, 200);
    } else if (!shouldTick && unoTickInterval) {
      clearInterval(unoTickInterval);
      unoTickInterval = null;
    }
  }

  // Whoever the direction arrow will land on after the current player's
  // turn — computed the same way the server's advance(1) would move the
  // turn pointer, just read-only here purely for display.
  function computeNextPlayerId(state) {
    const n = state.players.length;
    if (!n) return null;
    const currentIndex = state.players.findIndex((p) => p.id === state.currentPlayerId);
    if (currentIndex === -1) return null;
    const nextIndex = (((currentIndex + state.direction) % n) + n) % n;
    return state.players[nextIndex].id;
  }

  // Seats everyone — you included — around an oval table, in FIXED seating
  // order (the same order the server deals turns in), with you always at
  // the bottom. The direction arrow in the center plus each seat's
  // turn/next highlighting together show which way play is moving and who
  // goes after the current player, without needing the seats themselves to
  // physically rotate when a Reverse flips the direction.
  function renderTable(state, unoWindows) {
    othersRowEl.innerHTML = '';
    const n = state.players.length;
    if (!n) return;
    const nextPlayerId = computeNextPlayerId(state);
    const youIndex = state.players.findIndex((p) => p.id === state.yourId);
    const startIndex = youIndex === -1 ? 0 : youIndex;

    for (let seat = 0; seat < n; seat++) {
      const p = state.players[(startIndex + seat) % n];
      const isYou = p.id === state.yourId;

      // seat 0 (you) sits at the bottom (90°); the rest fill in evenly
      // around the oval in fixed seating order.
      const angleDeg = 90 + seat * (360 / n);
      const angleRad = (angleDeg * Math.PI) / 180;
      const x = 50 + 42 * Math.cos(angleRad);
      const y = 50 + 38 * Math.sin(angleRad);

      const seatEl = document.createElement('div');
      seatEl.className = 'uno-seat'
        + (isYou ? ' you' : '')
        + (p.id === state.currentPlayerId ? ' turn' : '')
        + (p.id === nextPlayerId ? ' next' : '')
        + (p.connected ? '' : ' offline');
      seatEl.style.left = x + '%';
      seatEl.style.top = y + '%';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name + (isYou ? ' (You)' : '');
      const count = document.createElement('div');
      count.className = 'count';
      const cardCount = isYou ? state.yourHand.length : p.cardCount;
      count.textContent = `${cardCount} card${cardCount === 1 ? '' : 's'}`;
      seatEl.append(name, count);

      if (p.id === nextPlayerId) {
        const nextBadge = document.createElement('div');
        nextBadge.className = 'next-badge';
        nextBadge.textContent = '▶ Next';
        seatEl.appendChild(nextBadge);
      }

      if (!isYou && p.cardCount === 1) {
        if (p.calledUno) {
          const flag = document.createElement('div');
          flag.className = 'uno-flag';
          flag.textContent = 'UNO!';
          seatEl.appendChild(flag);
        } else {
          const catchBtn = document.createElement('button');
          catchBtn.className = 'secondary catch-btn';
          catchBtn.textContent = 'Catch!';
          catchBtn.addEventListener('click', () => socket.emit('uno:catch', { targetId: p.id }));
          seatEl.appendChild(catchBtn);

          const theirWindow = unoWindows.find((w) => w.playerId === p.id);
          if (theirWindow) {
            const countdown = document.createElement('div');
            countdown.className = 'uno-countdown-mini';
            const remaining = Math.max(0, theirWindow.deadline - Date.now());
            countdown.textContent = `⏰ ${(remaining / 1000).toFixed(1)}s`;
            seatEl.appendChild(countdown);
          }
        }
      }

      othersRowEl.appendChild(seatEl);
    }
  }

  function renderGame(state) {
    const newTopId = state.discardTop ? state.discardTop.id : null;
    if (lastDiscardCardId !== null && newTopId !== lastDiscardCardId) {
      playCardDropSound();
      const calloutValue = state.discardTop && state.discardTop.value;
      const calloutText = CARD_CALLOUTS[calloutValue];
      if (calloutText) playCallout(calloutValue, calloutText);
    }
    lastDiscardCardId = newTopId;

    if (lastUnoPenaltyCounter !== null && state.unoPenaltyCounter !== lastUnoPenaltyCounter) {
      playPenaltySound();
    }
    lastUnoPenaltyCounter = state.unoPenaltyCounter;

    const unoWindows = state.unoWindows || [];
    updateUnoTicking(state.status === 'playing' && unoWindows.length > 0);

    renderTable(state, unoWindows);

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

    const myWindow = unoWindows.find((w) => w.playerId === state.yourId);
    if (myWindow) {
      const remaining = Math.max(0, myWindow.deadline - Date.now());
      unoCountdownBannerEl.textContent = `⏰ Call UNO! ${(remaining / 1000).toFixed(1)}s left`;
      unoCountdownBannerEl.classList.remove('hidden');
    } else {
      unoCountdownBannerEl.classList.add('hidden');
    }

    handRowEl.innerHTML = '';
    const mid = (state.yourHand.length - 1) / 2;
    state.yourHand.forEach((card, index) => {
      const slot = document.createElement('div');
      slot.className = 'hand-slot';
      // Fan the hand like real held cards: a slight rotation per position,
      // capped so a big hand doesn't tip over sideways, plus a small outward
      // drop so the fan reads as an arc rather than a flat rotated stack.
      const tilt = Math.max(-16, Math.min(16, (index - mid) * 4));
      const drop = Math.abs(index - mid) * 3;
      slot.style.transform = `rotate(${tilt}deg) translateY(${drop}px)`;

      const el = buildCardEl(card);
      const playable = isMyTurn && canPlayLocally(card, state.discardTop, state.currentColor);
      el.classList.toggle('playable', playable);
      el.addEventListener('click', () => attemptPlay(card, isMyTurn));

      slot.appendChild(el);
      handRowEl.appendChild(slot);
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
      syncBgm(null);
      showScreen(createRoomScreen.classList.contains('hidden') ? 'lobby' : 'create');
      renderLobby();
      return;
    }
    if (!latestState) return;
    syncBgm(latestState.status);
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
    lastDiscardCardId = null;
    lastUnoPenaltyCounter = null;
    updateUnoTicking(false);
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
