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
  const advanceCardCheckboxes = Array.from(document.querySelectorAll('.advance-card-checkbox'));
  const targetScoreInput = document.getElementById('target-score-input');
  const targetScoreSetBtn = document.getElementById('target-score-set-btn');

  const othersRowEl = document.getElementById('others-row');
  const deckEl = document.getElementById('deck-el');
  const unoTableEl = document.querySelector('.uno-table');
  const deckCountEl = document.getElementById('deck-count');
  const discardEl = document.getElementById('discard-el');
  const colorLabelEl = document.getElementById('color-label');
  const directionEl = document.getElementById('direction-el');
  const turnBannerEl = document.getElementById('turn-banner');
  const unoCountdownBannerEl = document.getElementById('uno-countdown-banner');
  const switchToastEl = document.getElementById('switch-toast');
  const handRowEl = document.getElementById('hand-row');
  const drawBtn = document.getElementById('draw-btn');
  const passBtn = document.getElementById('pass-btn');
  const unoBtn = document.getElementById('uno-btn');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');

  const winnerTextEl = document.getElementById('winner-text');
  const matchScoresEl = document.getElementById('match-scores');
  const newGameBtn = document.getElementById('new-game-btn');

  const colorModal = document.getElementById('color-modal');
  const colorModalCancelBtn = document.getElementById('color-modal-cancel-btn');
  const rulesModal = document.getElementById('rules-modal');
  const catalogModal = document.getElementById('catalog-modal');
  const catalogContentEl = document.getElementById('catalog-content');

  const targetPickerModal = document.getElementById('target-picker-modal');
  const targetPickerTitleEl = document.getElementById('target-picker-title');
  const targetPickerListEl = document.getElementById('target-picker-list');
  const targetPickerConfirmBtn = document.getElementById('target-picker-confirm-btn');
  const targetPickerCancelBtn = document.getElementById('target-picker-cancel-btn');

  const dumpPickerModal = document.getElementById('dump-picker-modal');
  const dumpColorLabelEl = document.getElementById('dump-color-label');
  const dumpPickerListEl = document.getElementById('dump-picker-list');
  const dumpConfirmBtn = document.getElementById('dump-confirm-btn');
  const dumpSkipBtn = document.getElementById('dump-skip-btn');

  const lockModal = document.getElementById('lock-modal');
  const lockModalTitleEl = document.getElementById('lock-modal-title');
  const lockDiceDisplayEl = document.getElementById('lock-dice-display');
  const lockWheelSvg = document.getElementById('lock-wheel-svg');
  const lockWheelCaptionEl = document.getElementById('lock-wheel-caption');
  const lockResultListEl = document.getElementById('lock-result-list');

  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    rulesModal.classList.remove('hidden');
  });
  rulesModal.querySelector('.modal-close').addEventListener('click', () => rulesModal.classList.add('hidden'));
  Festival.wireRulesLangToggle(rulesModal);

  document.getElementById('catalog-link').addEventListener('click', (e) => {
    e.preventDefault();
    buildCatalog();
    catalogModal.classList.remove('hidden');
  });
  catalogModal.querySelector('.modal-close').addEventListener('click', () => catalogModal.classList.add('hidden'));

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
    minus2: 'Trừ liền hai lá!',
    switchPos: 'Đổi chỗ bất ngờ!',
    actionWild: 'Lặp lại chiêu cũ!',
    lock: 'Khóa lượt luôn!',
    switchWild: 'Đổi chỗ theo ý mình!',
    plusWild: 'Cộng dồn cho cả làng!',
  };
  const UNO_CALLOUT_TEXT = 'UNO!';
  // Some advance-card audio files were recorded under a different filename
  // than the card's internal value — map value -> actual file slug; any
  // value not listed here just uses itself (e.g. minus2.mp3, lock.mp3).
  const CALLOUT_AUDIO_FILE = {
    switchPos: 'switchposition',
    actionWild: 'actionwild',
    switchWild: 'switchpositionwild',
    plusWild: 'pluswild',
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

  // Prefer a real recorded clip per card type (sounds/callouts/UNO/<value>.mp3)
  // over the synthesized voice above; falls back to speakCallout() if that
  // file hasn't been recorded/added yet, or fails to load/play.
  const calloutAudioCache = {};
  function getCalloutAudio(value) {
    const slug = CALLOUT_AUDIO_FILE[value] || value;
    if (!calloutAudioCache[slug]) {
      const audio = new Audio(`sounds/callouts/UNO/${slug}.mp3`);
      audio.preload = 'auto';
      calloutAudioCache[slug] = audio;
    }
    return calloutAudioCache[slug];
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
  // The id of the last card we already played a callout for. Deliberately
  // separate from lastDiscardCardId: a minus2 bonus dump pushes its extra
  // cards on top of the minus2 itself, so discardTop ends up being one of
  // THOSE afterward — tracking state.lastPlayedCard instead means the callout
  // still fires for the minus2 (or any advance card) even when it's not the
  // card the player currently sees on top of the pile.
  let lastPlayedCardId = null;
  // Player ids whose calledUno flag was already true as of the last render —
  // diffed against the incoming state to detect the exact moment someone
  // (human via the UNO button, or a bot auto-calling) newly calls UNO, so
  // everyone at the table hears the callout, not just whoever clicked it.
  let calledUnoIds = new Set();
  // While a Lock wheel animation is playing: blocks all player actions, and
  // (via renderTable above) hides each affected player's lockedTurns count
  // until their specific wheel round has actually landed.
  let lockAnimationActive = false;
  let lockRevealOverrides = null;
  let lastUnoPenaltyCounter = null;
  let unoTickInterval = null;

  const ACTION_SYMBOL = { skip: '⊘', reverse: '⇄', draw2: '+2', minus2: '-2', switchPos: '🔀' };
  // These 4 wild variants now have their own dedicated card artwork
  // (uploaded), so they skip the generic pie-background + badge treatment
  // still used as a fallback (see buildCardEl) — only Wild Draw Four keeps
  // the old mini-swatches + "+4" badge look, since it never got custom art.
  const WILD_CARD_ART = new Set(['actionWild', 'lock', 'switchWild', 'plusWild']);
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  // Colors with real festival artwork (a blank card template) instead of the
  // plain gradient — the art fills the whole face, so we skip the plain
  // center oval and only stamp the corner numbers over it.
  const CUSTOM_ART_COLORS = new Set(['red', 'yellow', 'green', 'blue']);

  let latestState = null;
  let latestRooms = [];
  let joined = false;
  let pendingWildCardId = null;
  let pendingWildCardValue = null;
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
      } else if (WILD_CARD_ART.has(card.value)) {
        // Dedicated artwork already shows the effect — no badge needed.
        el.classList.add('wild-' + card.value);
      } else {
        el.classList.add('wild-plain');
      }
      return el;
    }

    el.classList.add(card.color);
    if (card.value === 'draw2') el.classList.add('draw2');
    const hasDedicatedColorArt = card.value === 'minus2' || card.value === 'switchPos';
    if (hasDedicatedColorArt) {
      // The -2/Switch Position artwork already shows the effect per color —
      // no corner symbols needed on top.
      el.classList.add(card.value);
      return el;
    }
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

  // Reference data for the "📖 Cards" catalog — grouped by rule/behavior
  // rather than one entry per physical card, since the point is explaining
  // what each TYPE does, not enumerating all 108+ individual cards. The
  // colored entries that got dedicated per-color artwork (-2, Switch
  // Position) show all 4 so their distinct art is visible; plain number/
  // action cards just show one representative color.
  const CATALOG_SECTIONS = [
    {
      title: 'Standard Deck (108 cards)',
      entries: [
        {
          cards: [
            { color: 'red', value: '5' }, { color: 'yellow', value: '5' },
            { color: 'green', value: '5' }, { color: 'blue', value: '5' },
          ],
          label: 'Number (0-9)',
          description: 'Match by color or number. One 0 and two of each 1-9, per color. No special effect.',
        },
        { cards: [{ color: 'red', value: 'skip' }], label: 'Skip', description: "Next player's turn is skipped entirely." },
        { cards: [{ color: 'red', value: 'reverse' }], label: 'Reverse', description: 'Reverses turn direction. Acts like Skip with only 2 players.' },
        { cards: [{ color: 'red', value: 'draw2' }], label: 'Draw Two', description: 'Next player draws 2 cards and their turn is skipped.' },
        { cards: [{ color: 'wild', value: 'wild' }], label: 'Wild', description: 'Play anytime. Choose the new color. No other effect.' },
        { cards: [{ color: 'wild', value: 'wild4' }], label: 'Wild Draw Four', description: 'Play anytime. Choose the new color; next player draws 4 and is skipped.' },
      ],
    },
    {
      title: 'Advance Cards (optional house rules)',
      entries: [
        {
          cards: [
            { color: 'red', value: 'minus2' }, { color: 'yellow', value: 'minus2' },
            { color: 'green', value: 'minus2' }, { color: 'blue', value: 'minus2' },
          ],
          label: '-2 (Minus Two)',
          description: 'Plays like a normal card of its color. If you have 5+ cards (including this one), you may also discard up to 2 more cards of the same color in the same turn.',
        },
        {
          cards: [
            { color: 'red', value: 'switchPos' }, { color: 'yellow', value: 'switchPos' },
            { color: 'green', value: 'switchPos' }, { color: 'blue', value: 'switchPos' },
          ],
          label: 'Switch Position',
          description: 'No choice involved — 2 random players at the table (possibly including you) permanently swap seats/turn order.',
        },
        {
          cards: [{ color: 'wild', value: 'actionWild' }],
          label: 'Action Wild',
          description: 'Choose a color. Repeats whichever of Skip / Reverse / Draw Two was most recently played by anyone this game (no effect if none has been played yet).',
        },
        {
          cards: [{ color: 'wild', value: 'lock' }],
          label: 'Lock',
          description: "Choose a color. Rolls a die (1-3, weighted toward 1) and randomly skips that many other players' next turn — players holding fewer cards are more likely to be picked.",
        },
        {
          cards: [{ color: 'wild', value: 'switchWild' }],
          label: 'Switch Position Wild',
          description: 'Choose a color, then pick any 2 players at the table (yourself included) — they permanently swap seats/turn order.',
        },
        {
          cards: [{ color: 'wild', value: 'plusWild' }],
          label: 'Plus Wild',
          description: 'Choose a color. Every other player immediately draws cards — more if they hold fewer cards (up to 3 for someone at UNO, down to 1 for a big hand). No one is skipped.',
        },
      ],
    },
  ];

  function buildCatalog() {
    catalogContentEl.innerHTML = '';
    CATALOG_SECTIONS.forEach((section) => {
      const heading = document.createElement('div');
      heading.className = 'catalog-section-title';
      heading.textContent = section.title;
      catalogContentEl.appendChild(heading);

      section.entries.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'catalog-entry';

        const cardsRow = document.createElement('div');
        cardsRow.className = 'catalog-cards-row';
        entry.cards.forEach((c) => {
          cardsRow.appendChild(buildCardEl({ id: 'catalog', ...c }, { small: true }));
        });

        const text = document.createElement('div');
        text.className = 'catalog-text';
        const label = document.createElement('div');
        label.className = 'catalog-label';
        label.textContent = entry.label;
        const desc = document.createElement('div');
        desc.className = 'catalog-desc';
        desc.textContent = entry.description;
        text.append(label, desc);

        row.append(cardsRow, text);
        catalogContentEl.appendChild(row);
      });
    });
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
    const selectedAdvanceCards = new Set(state.advanceCardTypes || []);
    advanceCardCheckboxes.forEach((cb) => { cb.checked = selectedAdvanceCards.has(cb.value); });
    // Don't clobber the input while someone's actively editing it — the
    // waiting room re-renders on every player join/leave/checkbox change.
    if (document.activeElement !== targetScoreInput) {
      targetScoreInput.value = state.targetScore || '';
    }
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
      seatEl.dataset.playerId = p.id;
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

      // The server applies Lock's effect immediately (so the broadcast
      // already carries the final lockedTurns), but the wheel animation is
      // still "deciding" as far as the player watching is concerned — so
      // while that reveal is in progress, show each affected player's count
      // as it was BEFORE this activation's still-pending picks, not the
      // final value, and bump it up round by round as the wheel lands.
      const displayedLockedTurns = lockRevealOverrides && lockRevealOverrides.has(p.id)
        ? lockRevealOverrides.get(p.id)
        : (p.lockedTurns || 0);
      if (displayedLockedTurns > 0) {
        const lockBadge = document.createElement('div');
        lockBadge.className = 'next-badge';
        lockBadge.style.color = '#ff5c5c';
        lockBadge.textContent = `🔒 Locked x${displayedLockedTurns}`;
        seatEl.appendChild(lockBadge);
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
          catchBtn.disabled = lockAnimationActive;
          catchBtn.addEventListener('click', () => {
            if (!lockAnimationActive) socket.emit('uno:catch', { targetId: p.id });
          });
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
    }
    lastDiscardCardId = newTopId;

    const newPlayedId = state.lastPlayedCard ? state.lastPlayedCard.id : null;
    if (lastPlayedCardId !== null && newPlayedId !== null && newPlayedId !== lastPlayedCardId) {
      const calloutValue = state.lastPlayedCard.value;
      const calloutText = CARD_CALLOUTS[calloutValue];
      if (calloutText) playCallout(calloutValue, calloutText);
    }
    lastPlayedCardId = newPlayedId;

    if (lastUnoPenaltyCounter !== null && state.unoPenaltyCounter !== lastUnoPenaltyCounter) {
      playPenaltySound();
    }
    lastUnoPenaltyCounter = state.unoPenaltyCounter;

    const nowCalledUnoIds = new Set(state.players.filter((p) => p.calledUno).map((p) => p.id));
    const someoneJustCalledUno = [...nowCalledUnoIds].some((id) => !calledUnoIds.has(id));
    if (someoneJustCalledUno) playCallout('uno', UNO_CALLOUT_TEXT);
    calledUnoIds = nowCalledUnoIds;

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
    // House rule: drawing is only allowed when NOTHING in hand is playable,
    // and if what you draw turns out to be playable, you must play it — no
    // drawing to dodge a card you'd rather not play, and no holding a drawn
    // card you could've played. The server enforces both; this just mirrors
    // them so the buttons/hint don't invite a rejected action.
    const hasPlayableCard = state.yourHand.some((c) => canPlayLocally(c, state.discardTop, state.currentColor));
    const drawnCard = state.turnHasDrawn ? state.yourHand[state.yourHand.length - 1] : null;
    const mustPlayDrawnCard = Boolean(drawnCard && canPlayLocally(drawnCard, state.discardTop, state.currentColor));
    let turnBannerText = isMyTurn ? 'Your turn!' : other ? `${other.name}'s turn` : '';
    if (isMyTurn && !state.turnHasDrawn && hasPlayableCard) turnBannerText += ' — you have a playable card, play it!';
    else if (isMyTurn && mustPlayDrawnCard) turnBannerText += ' — that drawn card is playable, you must play it!';
    turnBannerEl.textContent = turnBannerText;
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
      const playable = !lockAnimationActive && isMyTurn && canPlayLocally(card, state.discardTop, state.currentColor);
      el.classList.toggle('playable', playable);
      el.addEventListener('click', () => attemptPlay(card, isMyTurn));

      slot.appendChild(el);
      handRowEl.appendChild(slot);
    });

    drawBtn.disabled = lockAnimationActive || !isMyTurn || state.turnHasDrawn || hasPlayableCard;
    passBtn.disabled = lockAnimationActive || !isMyTurn || !state.turnHasDrawn || mustPlayDrawnCard;
    const self = myPlayer(state);
    unoBtn.disabled = lockAnimationActive || state.yourHand.length !== 1 || Boolean(self?.calledUno);

    renderLog(gameLogEl, state.log);
  }

  function renderFinished(state) {
    const winner = state.players.find((p) => p.id === state.winnerId);
    const matchWinner = state.players.find((p) => p.id === state.matchWinnerId);
    const points = state.lastHandPoints;
    const earnedNote = points && points.winnerId === state.winnerId ? ` (+${points.points} points)` : '';

    if (matchWinner) {
      winnerTextEl.textContent = `👑 ${matchWinner.name} WINS THE MATCH with ${matchWinner.score} points!`;
    } else if (winner) {
      winnerTextEl.textContent = `🏆 ${winner.name} wins the hand${earnedNote}!`;
    } else {
      winnerTextEl.textContent = 'Game over.';
    }

    const ranked = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0));
    const target = state.targetScore || 500;
    matchScoresEl.innerHTML = matchWinner
      ? `<div style="text-align:center; color:var(--muted); font-size:12px; margin-bottom:6px;">Final match scores (target was ${target}):</div>`
      : `<div style="text-align:center; color:var(--muted); font-size:12px; margin-bottom:6px;">Match scores so far (first to ${target} wins):</div>`;
    ranked.forEach((p) => {
      const row = document.createElement('div');
      row.textContent = `${p.name}: ${p.score || 0}${p.id === state.matchWinnerId ? ' 👑' : ''}`;
      matchScoresEl.appendChild(row);
    });

    // "Next Match" continues the SAME match (scores carry over) as long as
    // no one has reached the target yet; once someone has, the server resets
    // scores to 0 on the next uno:newGame, so this becomes a fresh "Play
    // Again" instead.
    newGameBtn.textContent = matchWinner ? '▶ Play Again' : '▶ Next Match';

    const readyIds = state.nextMatchReadyIds || [];
    const connectedCount = state.players.filter((p) => p.connected).length;
    const iAmReady = readyIds.includes(state.yourId);
    newGameBtn.disabled = !matchWinner && iAmReady;
    if (!matchWinner) {
      const readyNote = document.createElement('div');
      readyNote.style.cssText = 'text-align:center; color:var(--muted); font-size:12px; margin-top:8px;';
      readyNote.textContent = iAmReady
        ? `⏳ Waiting for other players (${readyIds.length}/${connectedCount} ready)...`
        : `Click "Next Match" when you're ready (${readyIds.length}/${connectedCount} ready so far).`;
      matchScoresEl.appendChild(readyNote);
    }
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

  function submitPlay(cardId, chosenColor, extra = {}) {
    socket.emit('uno:play', { cardId, chosenColor, ...extra }, (res) => {
      if (!res || !res.ok) flashInvalid();
    });
  }

  // --- Target picker (Switch Position: pick 1 other player; Switch
  // Position Wild: pick 2 players, self allowed) — a simple multi-select
  // list capped at exactly `count` choices before Confirm enables. ---
  let targetPickerSelection = [];
  let targetPickerCount = 1;
  let targetPickerOnConfirm = null;

  function renderTargetPickerList(excludeSelf) {
    targetPickerListEl.innerHTML = '';
    const candidates = latestState.players.filter((p) => !excludeSelf || p.id !== latestState.yourId);
    candidates.forEach((p) => {
      const btn = document.createElement('button');
      const selected = targetPickerSelection.includes(p.id);
      btn.className = 'secondary uno-target-btn' + (selected ? ' selected' : '');
      btn.textContent = p.name + (p.id === latestState.yourId ? ' (You)' : '') + (selected ? ' ✓' : '');
      btn.addEventListener('click', () => {
        if (targetPickerSelection.includes(p.id)) {
          targetPickerSelection = targetPickerSelection.filter((id) => id !== p.id);
        } else if (targetPickerSelection.length < targetPickerCount) {
          targetPickerSelection.push(p.id);
        }
        renderTargetPickerList(excludeSelf);
      });
      targetPickerListEl.appendChild(btn);
    });
    targetPickerConfirmBtn.disabled = targetPickerSelection.length !== targetPickerCount;
  }

  function openTargetPicker(count, onConfirm, { excludeSelf = true } = {}) {
    targetPickerSelection = [];
    targetPickerCount = count;
    targetPickerOnConfirm = onConfirm;
    targetPickerTitleEl.textContent = count === 1 ? 'Choose a player to switch seats with' : 'Choose 2 players to switch seats';
    renderTargetPickerList(excludeSelf);
    targetPickerModal.classList.remove('hidden');
  }

  function closeTargetPicker() {
    targetPickerModal.classList.add('hidden');
    targetPickerOnConfirm = null;
  }

  targetPickerConfirmBtn.addEventListener('click', () => {
    if (targetPickerSelection.length !== targetPickerCount) return;
    const cb = targetPickerOnConfirm;
    const selection = [...targetPickerSelection];
    closeTargetPicker();
    if (cb) cb(selection);
  });
  targetPickerCancelBtn.addEventListener('click', closeTargetPicker);

  // --- Minus Two bonus dump: only offered when the player held 5+ cards
  // (including the -2 itself) before playing — matches the server's own
  // "more than 4 cards" gate, so this is purely a UI convenience, not the
  // actual enforcement (the server re-validates independently). ---
  let dumpPickerCard = null;
  let dumpPickerSelection = [];

  function renderDumpPickerList() {
    dumpPickerListEl.innerHTML = '';
    const candidates = latestState.yourHand.filter((c) => c.id !== dumpPickerCard.id && c.color === dumpPickerCard.color);
    if (!candidates.length) {
      const msg = document.createElement('p');
      msg.style.cssText = 'color:var(--muted); font-size:13px;';
      msg.textContent = `No other ${dumpPickerCard.color} cards in hand.`;
      dumpPickerListEl.appendChild(msg);
      return;
    }
    candidates.forEach((c) => {
      const el = buildCardEl(c, { small: true });
      el.classList.add('playable');
      if (dumpPickerSelection.includes(c.id)) el.style.boxShadow = '0 0 0 3px var(--good)';
      el.addEventListener('click', () => {
        if (dumpPickerSelection.includes(c.id)) {
          dumpPickerSelection = dumpPickerSelection.filter((id) => id !== c.id);
        } else if (dumpPickerSelection.length < 2) {
          dumpPickerSelection.push(c.id);
        }
        renderDumpPickerList();
      });
      dumpPickerListEl.appendChild(el);
    });
  }

  function openDumpPicker(card) {
    dumpPickerCard = card;
    dumpPickerSelection = [];
    dumpColorLabelEl.textContent = card.color;
    renderDumpPickerList();
    dumpPickerModal.classList.remove('hidden');
  }

  function closeDumpPicker() {
    dumpPickerModal.classList.add('hidden');
    dumpPickerCard = null;
    dumpPickerSelection = [];
  }

  dumpConfirmBtn.addEventListener('click', () => {
    const card = dumpPickerCard;
    const extraCardIds = [...dumpPickerSelection];
    closeDumpPicker();
    submitPlay(card.id, null, extraCardIds.length ? { extraCardIds } : {});
  });
  dumpSkipBtn.addEventListener('click', () => {
    const card = dumpPickerCard;
    closeDumpPicker();
    submitPlay(card.id, null);
  });

  // --- Lock card: dice + weighted "wheel" reveal, driven by the round-by-
  // round breakdown the server sends so the animation always lands on the
  // actual server-decided outcome rather than faking its own randomness. ---
  // Cycles el's text through `values` (formatted by formatFn) for roughly
  // `totalMs`, slowing down as it goes so it reads like a wheel/die
  // decelerating into its landing spot, rather than a flat-speed flicker.
  async function spinFor(el, values, totalMs, formatFn) {
    let elapsed = 0;
    let delay = 80;
    let i = 0;
    while (elapsed < totalMs) {
      el.textContent = formatFn(values[i % values.length]);
      i += 1;
      await sleep(delay);
      elapsed += delay;
      delay = Math.min(delay + 15, 400);
    }
  }

  // --- Prize-wheel visual for Lock's player pick: real pie slices (one per
  // candidate) drawn as SVG, spun via a CSS transform transition, landing on
  // whichever slice matches the server's actual pick under the fixed
  // pointer (right / 0°/East side) — the visual always agrees with the
  // real outcome, it's just decorating it. ---
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const WHEEL_SEGMENT_COLORS = ['#ea5a5f', '#f4cf5c', '#3fd08c', '#5c8ff0'];

  function buildWheelSvg(names) {
    lockWheelSvg.innerHTML = '';
    lockWheelSvg.style.transition = 'none';
    lockWheelSvg.style.transform = 'rotate(0deg)';
    const n = names.length;
    const r = 95;
    const segAngle = 360 / n;
    const fontSize = n > 8 ? 8 : n > 5 ? 10 : 13;
    for (let i = 0; i < n; i++) {
      const startRad = (i * segAngle * Math.PI) / 180;
      const endRad = ((i + 1) * segAngle * Math.PI) / 180;
      const x1 = r * Math.cos(startRad);
      const y1 = r * Math.sin(startRad);
      const x2 = r * Math.cos(endRad);
      const y2 = r * Math.sin(endRad);
      const largeArc = segAngle > 180 ? 1 : 0;

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M 0 0 L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`);
      path.setAttribute('fill', WHEEL_SEGMENT_COLORS[i % WHEEL_SEGMENT_COLORS.length]);
      path.setAttribute('stroke', 'white');
      path.setAttribute('stroke-width', '1.5');
      lockWheelSvg.appendChild(path);

      const midDeg = (i + 0.5) * segAngle;
      const midRad = (midDeg * Math.PI) / 180;
      const labelR = r * 0.62;
      const lx = labelR * Math.cos(midRad);
      const ly = labelR * Math.sin(midRad);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', String(lx));
      text.setAttribute('y', String(ly));
      text.setAttribute('fill', 'white');
      text.setAttribute('font-size', String(fontSize));
      text.setAttribute('font-weight', '800');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('transform', `rotate(${midDeg}, ${lx}, ${ly})`);
      text.textContent = names[i].length > 10 ? names[i].slice(0, 9) + '…' : names[i];
      lockWheelSvg.appendChild(text);
    }
  }

  // Rotates the wheel so pickedIndex's slice ends up under the fixed
  // pointer (East / 0°), after a few extra full spins for showmanship.
  function spinWheelTo(segmentCount, pickedIndex, durationMs) {
    return new Promise((resolve) => {
      const segAngle = 360 / segmentCount;
      const targetCenterDeg = (pickedIndex + 0.5) * segAngle;
      const baseRotation = (360 - (targetCenterDeg % 360)) % 360;
      const extraSpins = 5;
      const finalRotation = baseRotation + extraSpins * 360;
      requestAnimationFrame(() => {
        lockWheelSvg.style.transition = `transform ${durationMs}ms cubic-bezier(0.12, 0.66, 0.18, 1)`;
        requestAnimationFrame(() => {
          lockWheelSvg.style.transform = `rotate(${finalRotation}deg)`;
        });
      });
      setTimeout(resolve, durationMs + 100);
    });
  }

  // Turns a round's candidate list into wheel SLOTS, repeating each
  // candidate `weight` times (UNO status = 3 slots, 2-5 cards = 2 slots, 6+
  // cards = 1 slot — the exact same weight the server used to actually pick
  // the winner) so the wheel's slice sizes visually match the real odds
  // instead of giving everyone one equal-sized slice regardless of weight.
  function expandCandidatesToSlots(candidates) {
    const slots = [];
    candidates.forEach((c) => {
      const weight = Math.max(1, c.weight || 1);
      for (let i = 0; i < weight; i++) slots.push(c);
    });
    return slots;
  }

  async function showLockAnimation(payload) {
    lockAnimationActive = true;
    drawBtn.disabled = true;
    passBtn.disabled = true;
    unoBtn.disabled = true;

    lockModalTitleEl.textContent = `🔒 ${payload.playerName} played Lock!`;
    lockDiceDisplayEl.textContent = '🎲 …';
    lockWheelSvg.innerHTML = '';
    lockWheelCaptionEl.textContent = '';
    lockResultListEl.textContent = '';
    lockModal.classList.remove('hidden');

    // Hide each affected player's badge at their PRE-pick count (sent by the
    // server, not inferred from live state — see applyLockCard's comment:
    // the room keeps running underneath this animation, so by the time we
    // read latestState a lock may already have been consumed by a real
    // turn-skip, and "current minus 1" would then be wrong) until their
    // round actually lands, instead of spoiling every result up front.
    lockRevealOverrides = new Map();
    payload.rounds.forEach((round) => {
      lockRevealOverrides.set(round.pickedId, round.baselineLockedTurns);
    });
    if (latestState) renderGame(latestState);

    // Dice: ~5s of suspenseful rolling before landing on the real result.
    await spinFor(lockDiceDisplayEl, [1, 2, 3], 5000, (n) => `🎲 ${n}`);
    lockDiceDisplayEl.textContent = `🎲 Rolled a ${payload.diceResult}!`;
    await sleep(500);

    // Wheel: one ~5s spin per locked player (so a dice roll of 2 means two
    // back-to-back 5s spins), showing that round's actual candidate pool —
    // weighted into repeated slots — as real pie slices, landing on the
    // real pick under the pointer.
    const lockedNames = [];
    for (const round of payload.rounds) {
      const slots = expandCandidatesToSlots(round.candidates);
      const matchingSlotIndices = slots.reduce((acc, c, idx) => {
        if (c.id === round.pickedId) acc.push(idx);
        return acc;
      }, []);
      const pickedSlotIndex = matchingSlotIndices.length
        ? matchingSlotIndices[Math.floor(Math.random() * matchingSlotIndices.length)]
        : 0;
      const picked = round.candidates.find((c) => c.id === round.pickedId);
      const pickedName = picked ? picked.name : '?';

      buildWheelSvg(slots.map((c) => c.name));
      lockWheelCaptionEl.textContent = '';
      await spinWheelTo(slots.length, pickedSlotIndex, 4800);
      lockWheelCaptionEl.textContent = `🔒 ${pickedName}`;
      lockedNames.push(pickedName);

      // Reveal this round's pick now that the wheel has actually landed —
      // force-show the confirmed +1 rather than falling back to live state,
      // which may already have moved past it (their turn came up and the
      // lock was auto-consumed) before the player ever got to see this.
      lockRevealOverrides.set(round.pickedId, round.baselineLockedTurns + 1);
      if (latestState) renderGame(latestState);
      await sleep(600);
    }
    lockResultListEl.textContent = lockedNames.length ? `Locked: ${lockedNames.join(', ')}` : 'No one else at the table to lock.';

    // Hold the confirmed reveal on screen for a beat so it actually reads,
    // then close automatically — no manual "Close" button, every player at
    // the table sees the same effect and is unblocked at the same moment.
    await sleep(1000);
    lockModal.classList.add('hidden');
    lockRevealOverrides = null;
    lockAnimationActive = false;
    if (latestState) render();
  }

  socket.on('uno:lockEvent', (payload) => { showLockAnimation(payload); });

  // Switch Position / Switch Position Wild: by the time this event arrives,
  // uno:state already reflects the swapped seating order, so the two seat
  // elements are already sitting at their correct final spots. To actually
  // SHOW the swap (rather than a silent instant jump), snap them back to
  // each other's spot with no transition, then animate them sliding into
  // the position they're really at now.
  function showSwitchAnimation(payload) {
    const seatA = othersRowEl.querySelector(`[data-player-id="${CSS.escape(payload.idA)}"]`);
    const seatB = othersRowEl.querySelector(`[data-player-id="${CSS.escape(payload.idB)}"]`);
    if (seatA && seatB) {
      const toA = { left: seatA.style.left, top: seatA.style.top };
      const toB = { left: seatB.style.left, top: seatB.style.top };

      seatA.style.transition = 'none';
      seatB.style.transition = 'none';
      seatA.style.left = toB.left;
      seatA.style.top = toB.top;
      seatB.style.left = toA.left;
      seatB.style.top = toA.top;
      seatA.classList.add('swapping');
      seatB.classList.add('swapping');

      // Force a reflow so the instant jump above actually paints before the
      // transitioned move back below starts, or the browser may collapse
      // both into a single no-op frame.
      void seatA.offsetWidth;

      requestAnimationFrame(() => {
        seatA.style.transition = '';
        seatB.style.transition = '';
        seatA.style.left = toA.left;
        seatA.style.top = toA.top;
        seatB.style.left = toB.left;
        seatB.style.top = toB.top;
      });

      setTimeout(() => {
        seatA.classList.remove('swapping');
        seatB.classList.remove('swapping');
      }, 1200);
    }

    switchToastEl.textContent = `🔀 ${payload.nameA} and ${payload.nameB} swapped seats!`;
    switchToastEl.classList.remove('hidden');
    clearTimeout(showSwitchAnimation.hideTimer);
    showSwitchAnimation.hideTimer = setTimeout(() => switchToastEl.classList.add('hidden'), 2200);
  }

  socket.on('uno:switchEvent', (payload) => { showSwitchAnimation(payload); });

  // Plus Wild: animates one card-back "flyer" per card the player actually
  // receives — a player getting 2 cards sees 2 separate flights land on
  // their seat, not one combined effect, matching the real per-card amount.
  function flyCardToSeat(playerId) {
    const seatEl = othersRowEl.querySelector(`[data-player-id="${CSS.escape(playerId)}"]`);
    if (!seatEl || !deckEl || !unoTableEl) return;
    const tableRect = unoTableEl.getBoundingClientRect();
    const fromRect = deckEl.getBoundingClientRect();
    const toRect = seatEl.getBoundingClientRect();
    const fromX = fromRect.left + fromRect.width / 2 - tableRect.left;
    const fromY = fromRect.top + fromRect.height / 2 - tableRect.top;
    const toX = toRect.left + toRect.width / 2 - tableRect.left;
    const toY = toRect.top + toRect.height / 2 - tableRect.top;

    const flyer = document.createElement('div');
    flyer.className = 'uno-card back small';
    flyer.style.position = 'absolute';
    flyer.style.left = fromX + 'px';
    flyer.style.top = fromY + 'px';
    flyer.style.transform = 'translate(-50%, -50%)';
    flyer.style.transition = 'left 0.5s ease, top 0.5s ease, opacity 0.2s ease 0.35s';
    flyer.style.zIndex = '45';
    flyer.style.pointerEvents = 'none';
    unoTableEl.appendChild(flyer);

    requestAnimationFrame(() => {
      flyer.style.left = toX + 'px';
      flyer.style.top = toY + 'px';
    });
    setTimeout(() => { flyer.style.opacity = '0'; }, 350);
    setTimeout(() => { flyer.remove(); }, 600);
  }

  function showPlusWildAnimation(payload) {
    switchToastEl.textContent = `💥 ${payload.playerName} played Plus Wild!`;
    switchToastEl.classList.remove('hidden');
    clearTimeout(showPlusWildAnimation.hideTimer);
    showPlusWildAnimation.hideTimer = setTimeout(() => switchToastEl.classList.add('hidden'), 2200);

    (payload.affected || []).forEach((a) => {
      for (let i = 0; i < a.amount; i++) {
        setTimeout(() => flyCardToSeat(a.id), i * 350);
      }
    });
  }

  socket.on('uno:plusWildEvent', (payload) => { showPlusWildAnimation(payload); });

  function attemptPlay(card, isMyTurn) {
    if (lockAnimationActive) return;
    if (!isMyTurn) return;
    if (!canPlayLocally(card, latestState.discardTop, latestState.currentColor)) {
      flashInvalid();
      return;
    }
    if (card.value === 'minus2') {
      if (latestState.yourHand.length >= 5) openDumpPicker(card);
      else submitPlay(card.id, null);
      return;
    }
    if (card.color === 'wild') {
      pendingWildCardId = card.id;
      pendingWildCardValue = card.value;
      colorModal.classList.remove('hidden');
      return;
    }
    submitPlay(card.id, null);
  }

  colorModal.querySelectorAll('.uno-color-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      colorModal.classList.add('hidden');
      const cardId = pendingWildCardId;
      const cardValue = pendingWildCardValue;
      pendingWildCardId = null;
      pendingWildCardValue = null;
      if (!cardId) return;
      if (cardValue === 'switchWild') {
        openTargetPicker(2, (ids) => submitPlay(cardId, color, { targetPlayerIds: ids }), { excludeSelf: false });
      } else {
        submitPlay(cardId, color);
      }
    });
  });

  colorModalCancelBtn.addEventListener('click', () => {
    colorModal.classList.add('hidden');
    pendingWildCardId = null;
    pendingWildCardValue = null;
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
    lastPlayedCardId = null;
    lastUnoPenaltyCounter = null;
    calledUnoIds = new Set();
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

  advanceCardCheckboxes.forEach((cb) => {
    cb.addEventListener('change', () => {
      const selected = advanceCardCheckboxes.filter((c) => c.checked).map((c) => c.value);
      socket.emit('uno:setAdvanceCards', { selected }, (res) => {
        if (!res || !res.ok) cb.checked = !cb.checked; // revert just this one on rejection
      });
    });
  });

  targetScoreSetBtn.addEventListener('click', () => {
    const targetScore = Number(targetScoreInput.value);
    socket.emit('uno:setTargetScore', { targetScore }, (res) => {
      if (!res || !res.ok) alert('Could not set target score: ' + ((res && res.error) || 'unknown error'));
    });
  });

  startBtn.addEventListener('click', () => socket.emit('uno:start'));
  drawBtn.addEventListener('click', () => socket.emit('uno:draw'));
  passBtn.addEventListener('click', () => socket.emit('uno:pass'));
  unoBtn.addEventListener('click', () => socket.emit('uno:callUno'));
  newGameBtn.addEventListener('click', () => {
    if (latestState && latestState.matchWinnerId) {
      socket.emit('uno:newGame'); // match concluded -- fresh match, back to the waiting room
    } else {
      socket.emit('uno:readyNextMatch'); // match ongoing -- ready-check, no waiting room
    }
  });
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
