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
  const lazycatBtn = document.getElementById('lazycat-btn');
  const countercuteBtn = document.getElementById('countercute-btn');
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

  const mimicPickerModal = document.getElementById('mimic-picker-modal');
  const mimicPickerCancelBtn = document.getElementById('mimic-picker-cancel-btn');

  const favorGiveModal = document.getElementById('favor-give-modal');
  const favorGiveTitleEl = document.getElementById('favor-give-title');
  const favorGiveListEl = document.getElementById('favor-give-list');

  const seeFutureModal = document.getElementById('see-future-modal');
  const seeFutureListEl = document.getElementById('see-future-list');
  const seeFutureCloseBtn = document.getElementById('see-future-close-btn');

  const rulesModal = document.getElementById('rules-modal');
  const catalogModal = document.getElementById('catalog-modal');
  const catalogContentEl = document.getElementById('catalog-content');

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
    lazycat: { label: 'Lazy Cat', emoji: '😴' },
    cutecat: { label: 'Cute Cat', emoji: '🥹' },
    dimwittedcat: { label: 'Dim-witted Cat', emoji: '🙀' },
    breadcat: { label: 'Bread Cat', emoji: '🍞' },
    derpcat: { label: 'Derp Cat', emoji: '😝' },
    sushicat: { label: 'Sushi Cat', emoji: '🍣' },
    tacocat: { label: 'Tacocat', emoji: '🌮' },
    cattermelon: { label: 'Cattermelon', emoji: '🍉' },
    beardcat: { label: 'Beard Cat', emoji: '🧔' },
    potatocat: { label: 'Hairy Potato Cat', emoji: '🥔' },
    rainbowcat: { label: 'Rainbow-Ralphing Cat', emoji: '🌈' },
  };
  // Genuine "cat" cards only — Lazy Cat and Cute Cat are full action cards
  // (reactive halving / wild action mimic) and no longer combo-eligible, so
  // they're NOT here (matches ek-server.js's CAT_KEYS, which doubles as the
  // combo-eligible set now that they've moved out).
  const CAT_KEYS = [
    'breadcat', 'derpcat', 'sushicat',
    'tacocat', 'cattermelon', 'beardcat', 'potatocat', 'rainbowcat',
  ];
  // Mirrors ek-server.js's Rainbow Cat wildcard rule: it can stand in for
  // whatever type a Pair/Triple needs, or fill a missing distinct type for
  // a Five Different. Kept in sync with the server, which is the real
  // authority — this just drives the "Play Selected" button locally.
  function catsMatchForCombo(cards) {
    if (!cards.every((c) => CAT_KEYS.includes(c.type))) return false;
    const nonWild = cards.filter((c) => c.type !== 'rainbowcat');
    if (!nonWild.length) return true;
    return nonWild.every((c) => c.type === nonWild[0].type);
  }
  function catsFormFiveDifferentForCombo(cards) {
    if (cards.length !== 5 || !cards.every((c) => CAT_KEYS.includes(c.type))) return false;
    const nonWild = cards.filter((c) => c.type !== 'rainbowcat');
    return new Set(nonWild.map((c) => c.type)).size === nonWild.length;
  }

  // Types with real uploaded card art (see the matching background-image
  // rules in ek.html) — every type has art, including seeFuture.
  const CARD_ART_TYPES = new Set([
    'defuse', 'explodingKitten', 'attack', 'skip', 'favor', 'shuffle', 'nope', 'seeFuture',
    'lazycat', 'cutecat', 'dimwittedcat',
    ...CAT_KEYS,
  ]);

  // Base (2-4 player) counts — see ek-server.js's ACTION_COUNTS / BASE_DEFUSE_TOTAL
  // / CAT_COPIES_PER_TYPE. Defuse/Exploding Kitten counts scale with table
  // size (Defuse: max(6, players+1); Kittens: players-1), so those two
  // entries describe the RULE rather than a fixed number.
  const CATALOG_SECTIONS = [
    {
      title: 'The Core Two',
      entries: [
        {
          cards: [{ type: 'defuse' }],
          label: 'Defuse (6, or players+1 at big tables)',
          description: 'Play the instant you draw an Exploding Kitten to survive — then secretly slip the kitten back into the deck at any position you choose.',
        },
        {
          cards: [{ type: 'explodingKitten' }],
          label: 'Exploding Kitten (players − 1)',
          description: "Draw one with no Defuse in hand and you're out of the game immediately. Never dealt into a starting hand — only ever drawn from the deck.",
        },
      ],
    },
    {
      title: 'Action Cards (32 total)',
      entries: [
        {
          cards: [{ type: 'attack' }],
          label: 'Attack (4)',
          description: 'Ends your turn without drawing — the next player must take 2 turns in a row. Stacks by +2 if they Attack right back instead of taking their turns.',
        },
        {
          cards: [{ type: 'skip' }],
          label: 'Skip (4)',
          description: 'Ends your turn immediately without drawing a card.',
        },
        {
          cards: [{ type: 'favor' }],
          label: 'Favor (4)',
          description: "Pick a player — they must hand you a card of their own choosing. Play pauses until they respond (or a short timer picks one for them).",
        },
        {
          cards: [{ type: 'shuffle' }],
          label: 'Shuffle (4)',
          description: 'Shuffles the entire draw pile. Does not end your turn — you can still act more, or must still draw.',
        },
        {
          cards: [{ type: 'seeFuture' }],
          label: 'See the Future (5)',
          description: 'Privately peek at the top 3 cards of the draw pile, in order. Does not end your turn.',
        },
        {
          cards: [{ type: 'nope' }],
          label: 'Nope (5)',
          description: 'Cancel the last action card played by anyone, even out of turn — but here, a Nope cannot itself be Noped.',
        },
        {
          cards: [{ type: 'lazycat' }],
          label: 'Lazy Cat (4)',
          description: "Reactive — play it against another player's pending Attack or See the Future to HALVE its effect (rounded down) instead of cancelling it. Stacks if played more than once.",
        },
        {
          cards: [{ type: 'cutecat' }],
          label: 'Cute Cat (2)',
          description: "The all-encompassing power of cuteness: play it as ANY action card of your choice (Attack, Skip, Favor, Shuffle, or See the Future), or use it in place of a real Defuse card. A regular Nope can't stop it — only another Cute Cat can.",
        },
      ],
    },
    {
      title: 'Cat Cards & Combos (8 types × 4 = 32 total)',
      entries: [
        {
          cards: CAT_KEYS.map((type) => ({ type })),
          label: 'The 8 Combo-Eligible Cat Types',
          description: 'No effect alone — any 2, 3, or 5 matching/distinct cats combine into a Cat Combo (see below). Lazy Cat and Cute Cat are NOT part of this — they have their own powers above.',
        },
        {
          cards: [{ type: 'rainbowcat' }],
          label: 'Rainbow-Ralphing Cat: Wildcard',
          description: 'Counts as ANY of the other 7 types when forming a Cat Combo — pairs/triples with mismatched cats as long as only Rainbow Cats are the odd ones out, and fills in a missing distinct type for a Five Different.',
        },
        {
          cards: [{ type: CAT_KEYS[0] }, { type: CAT_KEYS[0] }],
          label: 'Cat Combo: Pair',
          description: 'Play 2 matching cat cards, choose a player, and steal a random card from their hand.',
        },
        {
          cards: [{ type: CAT_KEYS[0] }, { type: CAT_KEYS[0] }, { type: CAT_KEYS[0] }],
          label: 'Cat Combo: Triple',
          description: "Play 3 matching cat cards, choose a player, and name a specific card — they must hand it over if they have it (nothing happens if they don't).",
        },
        {
          cards: CAT_KEYS.slice(0, 5).map((type) => ({ type })),
          label: 'Cat Combo: Five Different',
          description: 'Play 5 mutually different eligible cat types at once (any 5 of the 8) to take any one card you want from the (always-visible) discard pile.',
        },
      ],
    },
    {
      title: 'Trap Cards (4 total)',
      entries: [
        {
          cards: [{ type: 'dimwittedcat' }],
          label: 'Dim-witted Cat (4)',
          description: "You can never play this yourself — it just sits in your hand, and you can't hand it away with Favor either. If someone steals it with a Cat Pair or demands it with a Cat Triple, they're immediately forced to draw a card as punishment (which can even explode them!). The card stays with its new owner, ready to bite whoever takes it next.",
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

  let latestState = null;
  let latestRooms = [];
  let joined = false;
  let pendingJoinRoomId = null;
  let selectedCardIds = [];
  let pendingPlayContext = null; // { cardIds, needsRequestedType }
  let selectedTargetId = null;
  let tickInterval = null;

  // --- Sound: looping background music while a game is in progress, ducked
  // under whichever card sound effect is currently playing (mirrors UNO's
  // bgm-audio/mute-btn pattern). ---
  const MUSIC_MUTED_KEY = 'ek_music_muted';
  const bgmAudio = document.getElementById('bgm-audio');
  const muteBtn = document.getElementById('mute-btn');
  const BGM_NORMAL_VOLUME = 0.35;
  const BGM_DUCK_VOLUME = 0.08;
  bgmAudio.volume = BGM_NORMAL_VOLUME;
  let musicMuted = localStorage.getItem(MUSIC_MUTED_KEY) === '1';

  // Ducking so a card sound is easy to hear over the music. Tracked with a
  // token so two sounds firing close together can't have the first one's
  // cleanup restore full volume while the second is still playing.
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

  // Card-type -> recorded clip (sounds/callouts/explodingKitten/<slug>.mp3).
  const CARD_SOUND_FILE = {
    attack: 'attack',
    skip: 'skip',
    favor: 'favor',
    shuffle: 'shuffle',
    seeFuture: 'seethefuture',
    lazycat: 'lazy',
    cutecat: 'cute',
    explodingKitten: 'explodingcard',
    dimwittedcat: 'dimwitted',
    nope: 'nope',
  };
  const cardSoundCache = {};
  function playCardSound(type) {
    if (musicMuted) return;
    const slug = CARD_SOUND_FILE[type];
    if (!slug) return;
    if (!cardSoundCache[slug]) {
      const audio = new Audio(`sounds/callouts/explodingKitten/${slug}.mp3`);
      audio.preload = 'auto';
      cardSoundCache[slug] = audio;
    }
    const audio = cardSoundCache[slug];
    audio.currentTime = 0;
    const token = duckBgm();
    const restore = () => restoreBgmVolume(token);
    audio.onended = restore;
    audio.onerror = restore;
    setTimeout(restore, 4000); // safety net if neither event fires
    audio.play().catch(restore); // blocked until a user gesture, or file missing -- best-effort, no fallback needed
  }
  // Tracks what we've already reacted to, so repeated 'ek:state' broadcasts
  // (the same pending Nope window, the same resolved action) don't replay
  // a sound on every tick — only genuinely NEW events should sound.
  let lastCutecatPendingDeadline = null;
  let lastSoundEventSeq = null;

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
    el.className = 'ek-card' + (small ? ' small' : '') + (CARD_ART_TYPES.has(card.type) ? ' has-art' : '');
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

  // Seats sit around an oval, same layout mechanism as UNO's table: you're
  // always placed at the bottom (90°) with everyone else filled in evenly
  // around the rest of the circle in fixed seating order, positioned via
  // absolute left/top % (see .ek-seat in ek.html) rather than plain flex.
  function renderSeats(state) {
    seatsRowEl.innerHTML = '';
    const n = state.players.length;
    if (!n) return;
    const youIndex = state.players.findIndex((p) => p.id === state.yourId);
    const startIndex = youIndex === -1 ? 0 : youIndex;

    for (let seat = 0; seat < n; seat++) {
      const p = state.players[(startIndex + seat) % n];
      const isYou = p.id === state.yourId;

      const angleDeg = 90 + seat * (360 / n);
      const angleRad = (angleDeg * Math.PI) / 180;
      const x = 50 + 42 * Math.cos(angleRad);
      const y = 50 + 38 * Math.sin(angleRad);

      const el = document.createElement('div');
      el.className = 'ek-seat'
        + (isYou ? ' you' : '')
        + (p.id === state.currentPlayerId ? ' turn' : '')
        + (!p.alive ? ' dead' : '')
        + (!p.connected ? ' offline' : '');
      el.dataset.playerId = p.id;
      el.style.left = x + '%';
      el.style.top = y + '%';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name + (isYou ? ' (You)' : '');
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
    }
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
      if (cards[0].type === 'cutecat') return { kind: 'cutecat' };
      return ['attack', 'skip', 'favor', 'shuffle', 'seeFuture'].includes(cards[0].type) ? { kind: 'single', type: cards[0].type } : null;
    }
    if (cards.length === 2 || cards.length === 3) {
      if (!catsMatchForCombo(cards)) return null;
      const repType = (cards.find((c) => c.type !== 'rainbowcat') || cards[0]).type;
      return { kind: cards.length === 2 ? 'pair' : 'triple', type: repType };
    }
    if (cards.length === 5) {
      if (!catsFormFiveDifferentForCombo(cards)) return null;
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
    const pa = state.pendingAction;
    if (pa) {
      const actor = state.players.find((p) => p.id === pa.actorId);
      const remaining = Math.max(0, pa.deadline - Date.now());
      const secs = (remaining / 1000).toFixed(1);
      if (pa.type === 'cutecat') {
        const mimicInfo = CARD_INFO[pa.mimicType] || { label: pa.mimicType };
        text = `😻 ${actor ? actor.name : 'Someone'} played Cute Cat as ${mimicInfo.label} — only another Cute Cat can stop it! ${secs}s left`;
      } else {
        const halveNote = pa.halvings ? ` (halved x${pa.halvings} by Lazy Cat)` : '';
        text = `⏳ ${actor ? actor.name : 'Someone'} played a card${halveNote} — react? ${secs}s left`;
      }
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

    const isActor = Boolean(pa) && pa.actorId === state.yourId;
    const canNope = Boolean(pa) && pa.type !== 'cutecat' && !isActor && state.yourHand.some((c) => c.type === 'nope');
    nopeBtn.style.display = canNope ? '' : 'none';

    const canHalve = Boolean(pa) && ['attack', 'seeFuture'].includes(pa.type) && !isActor
      && state.yourHand.some((c) => c.type === 'lazycat');
    lazycatBtn.style.display = canHalve ? '' : 'none';

    const canCounterCute = Boolean(pa) && pa.type === 'cutecat' && !isActor
      && state.yourHand.some((c) => c.type === 'cutecat');
    countercuteBtn.style.display = canCounterCute ? '' : 'none';

    updateTicking(Boolean(pa));
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
      // Dim-witted Cat is a Trap Card: it can only ever be stolen (Cat
      // Pair/Triple), never voluntarily handed over via Favor.
      if (card.type === 'dimwittedcat') {
        el.classList.add('disabled');
        el.title = "Dim-witted Cat can't be given away — it can only be stolen with a Cat Pair or Triple.";
      } else {
        el.classList.add('playable');
        el.addEventListener('click', () => {
          socket.emit('ek:giveFavorCard', { cardId: card.id }, (res) => {
            if (!res || !res.ok) alert('Could not give that card: ' + ((res && res.error) || 'unknown error'));
          });
        });
      }
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

  function openTargetPicker(cardIds, needsRequestedType, mimicType) {
    pendingPlayContext = { cardIds, needsRequestedType, mimicType };
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
    if (pendingPlayContext.mimicType) extra.mimicType = pendingPlayContext.mimicType;
    const cardIds = pendingPlayContext.cardIds;
    closeTargetPicker();
    submitPlayCard(cardIds, extra);
  });
  targetPickerCancelBtn.addEventListener('click', closeTargetPicker);

  // Cute Cat: "the all-encompassing power of cuteness" -- played as any
  // action card of the player's choosing. Favor needs a target afterward
  // (reuses the same target picker, carrying mimicType through); everything
  // else submits immediately.
  function openMimicPicker(cardIds) {
    pendingPlayContext = { cardIds };
    mimicPickerModal.classList.remove('hidden');
  }
  mimicPickerModal.querySelectorAll('[data-mimic]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mimicType = btn.dataset.mimic;
      const cardIds = pendingPlayContext ? pendingPlayContext.cardIds : [];
      mimicPickerModal.classList.add('hidden');
      pendingPlayContext = null;
      if (mimicType === 'favor') {
        openTargetPicker(cardIds, false, 'favor');
      } else {
        submitPlayCard(cardIds, { mimicType });
      }
    });
  });
  mimicPickerCancelBtn.addEventListener('click', () => {
    mimicPickerModal.classList.add('hidden');
    pendingPlayContext = null;
  });

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
    } else if (shape.kind === 'cutecat') {
      openMimicPicker(cardIds);
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
  lazycatBtn.addEventListener('click', () => {
    socket.emit('ek:playLazyCat', {}, (res) => {
      if (!res || !res.ok) alert('Could not play Lazy Cat: ' + ((res && res.error) || 'unknown error'));
    });
  });
  countercuteBtn.addEventListener('click', () => {
    socket.emit('ek:counterCuteCat', {}, (res) => {
      if (!res || !res.ok) alert('Could not counter with Cute Cat: ' + ((res && res.error) || 'unknown error'));
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
  Festival.wireRulesLangToggle(rulesModal);

  document.getElementById('catalog-link').addEventListener('click', (e) => {
    e.preventDefault();
    buildCatalog();
    catalogModal.classList.remove('hidden');
  });
  catalogModal.querySelector('.modal-close').addEventListener('click', () => catalogModal.classList.add('hidden'));

  function enterRoom(roomId) {
    joined = true;
    localStorage.setItem(LAST_ROOM_KEY, roomId);
    render();
  }

  function backToLobby() {
    joined = false;
    latestState = null;
    selectedCardIds = [];
    lastCutecatPendingDeadline = null;
    lastSoundEventSeq = null;
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
    // Cute Cat gets its own sound the instant it's played (before any Nope
    // window even opens) -- separate from whichever card it ends up
    // mimicking, which sounds only once that actually resolves, below.
    const pa = state.pendingAction;
    const cutecatDeadline = pa && pa.type === 'cutecat' ? pa.deadline : null;
    if (cutecatDeadline !== null && cutecatDeadline !== lastCutecatPendingDeadline) {
      playCardSound('cutecat');
    }
    lastCutecatPendingDeadline = cutecatDeadline;

    // Whatever just actually resolved: a plain action card's own sound, or
    // (for Cute Cat) the sound of whichever card it mimicked. Also covers
    // drawing an Exploding Kitten and the Dim-witted Cat trap springing,
    // which emit the same event from elsewhere on the server.
    const se = state.lastSoundEvent;
    if (se && se.seq !== lastSoundEventSeq) {
      const soundType = se.type === 'cutecat' ? se.mimicType : se.type;
      if (soundType) playCardSound(soundType);
    }
    lastSoundEventSeq = se ? se.seq : lastSoundEventSeq;

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
