const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/nien');
  const LAST_ROOM_KEY = 'nien_last_room_id';
  const EXPLOSION_DURATION_MS = 450;
  const PICKUP_HOLD_MS = 500; // must match nien-server.js's own PICKUP_HOLD_MS -- only used here to size the progress ring below

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
  const shopListEl = document.getElementById('shop-list');
  const characterListEl = document.getElementById('character-list');
  const shopRemainingEl = document.getElementById('shop-remaining');
  const shopTotalEl = document.getElementById('shop-total');

  const hudRowEl = document.getElementById('hud-row');
  const fearValueEl = document.getElementById('fear-value');
  const fearBarEl = document.getElementById('fear-bar');
  const lootRemainingEl = document.getElementById('loot-remaining');
  const roundDamageListEl = document.getElementById('round-damage-list');
  const turnBannerEl = document.getElementById('turn-banner');
  const throwTypePickerEl = document.getElementById('throw-type-picker');
  const canvas = document.getElementById('arena-canvas');
  const ctx = canvas.getContext('2d');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');
  const mobileJoystickEl = document.getElementById('mobile-joystick');
  const joystickThumbEl = document.getElementById('joystick-thumb');
  const fireCircleEls = document.querySelectorAll('#mobile-fire-circles .fire-circle');

  // Arena backdrop -- drawn scaled to cover the canvas each frame once
  // loaded; a flat fill (see drawArena) covers the gap before then so
  // there's never a blank frame.
  const arenaBg = new Image();
  arenaBg.src = '../assets/nien-bg.png';

  // Character portraits -- one Image per character, created once and
  // reused (mirrors the card-art caching pattern in ek.js/uno.js).
  const characterImageCache = {};
  function getCharacterImage(def) {
    if (!def || !def.image) return null;
    if (!characterImageCache[def.key]) {
      const img = new Image();
      img.src = characterImageUrl(def);
      characterImageCache[def.key] = img;
    }
    return characterImageCache[def.key];
  }

  // Loot art -- cached per TYPE (not per item instance), since many
  // dropped items share the same picture (e.g. every "Nến" on the
  // ground). characterImageUrl() works here too -- it just reads
  // `.image` off whatever object it's given.
  const lootImageCache = {};
  function getLootImage(item) {
    if (!item || !item.image) return null;
    if (!lootImageCache[item.type]) {
      const img = new Image();
      img.src = characterImageUrl(item);
      lootImageCache[item.type] = img;
    }
    return lootImageCache[item.type];
  }

  // Draws an image centered on (cx, cy), scaled so its LONGER side is
  // maxDim, preserving the source's aspect ratio -- forcing a fixed
  // square (the original approach here) badly squishes anything that
  // isn't already square, which is exactly what made the wide "Trung/
  // Thu/Vui/Vẻ" text-logo art unreadable once it replaced the plain
  // canvas-drawn text.
  function clampNum(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function drawImageFit(img, cx, cy, maxDim) {
    const ratio = img.naturalWidth / img.naturalHeight;
    const w = ratio >= 1 ? maxDim : maxDim * ratio;
    const h = ratio >= 1 ? maxDim / ratio : maxDim;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  }

  const winnerTextEl = document.getElementById('winner-text');
  const scoreListEl = document.getElementById('score-list');
  const newGameBtn = document.getElementById('new-game-btn');

  const rulesModal = document.getElementById('rules-modal');

  let joined = false;
  let latestRooms = [];
  let latestState = null;
  let pendingJoinRoomId = null;
  let explosions = [];
  let selfPuffs = [];
  let lastSentDir = { x: 0, y: 0 };
  let selectedType = null; // client-side only -- toggled by the type icons, confirmed by clicking the arena
  const pressedKeys = new Set();

  // Touch-primary devices get a whole different control scheme (drag
  // joystick + fire circles, see below) AND a camera that follows the
  // player instead of shrinking the whole map to fit -- computed once,
  // since a device's pointer type doesn't change mid-session.
  const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
  // Fixed on-screen pixel size of the arena viewport on touch devices --
  // deliberately smaller than the map itself (which ranges 520-1400px
  // square depending on player count) so tokens stay a sane tap/visual
  // size instead of shrinking to a few pixels on an 8-player map. Ignored
  // entirely on desktop, which still shows the whole map like before.
  const MOBILE_VIEWPORT_SIZE = 380;
  // How far (in map px) a full-length fire-circle drag throws -- filled
  // in from the server's own FIRECRACKER_RANGE once state arrives (see
  // renderGame); 190 is just a same-ballpark fallback before the first
  // state tick.
  let firecrackerRange = 190;

  // Zone lighting: a zone lights up the instant a firecracker burns out in
  // it (the lighting/rooted phase finishing, whether or not it's actually
  // thrown afterward) and stays lit for ZONE_LIGHT_MS after that moment;
  // with nothing new burning out there, it fades back to shadow. Tracked
  // per zone key -> the timestamp it should stop being lit.
  const ZONE_LIGHT_MS = 5000;
  let zoneLitUntil = {};
  // Per-player burning flag from the PREVIOUS frame, needed to detect the
  // burning -> not-burning transition (the "burned out" moment) rather
  // than just observing an ongoing state.
  let prevPlayerBurning = {};

  function totalLoadoutCost(loadout, catalog) {
    // loadout[key] is a raw firecracker count; cost is per PACK
    // (purchaseUnit firecrackers, e.g. 1,000 Pháo tép per pack), so divide
    // back down to packs before pricing -- mirrors the server's own math.
    return Object.keys(catalog).reduce((sum, key) => {
      const def = catalog[key];
      const unit = def.purchaseUnit || 1;
      return sum + (((loadout && loadout[key]) || 0) / unit) * def.cost;
    }, 0);
  }

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
      const charDef = (state.characters && p.character && state.characters[p.character]) || null;
      const charTag = charDef ? ` ${charDef.emoji} ${charDef.label}` : '';
      li.textContent = p.name + (p.id === state.yourId ? ' (you)' : '') + (p.isBot ? ' 🤖' : '') + charTag;
      playerListEl.appendChild(li);
    });
    startBtn.disabled = state.players.length < 1;
    addBotsBtn.disabled = state.players.length >= 8;
    renderCharacterPicker(state);
    renderShop(state);
    renderLog(waitingLogEl, state.log);
  }

  function selectCharacter(character) {
    socket.emit('nien:selectCharacter', { character }, (res) => {
      if (!res || !res.ok) {
        // Nothing to roll back client-side -- picking is cosmetic and
        // there's no local optimistic state to undo.
      }
    });
  }

  // Portrait paths (public/games/nienmonster/characters/*.png) have spaces
  // and Vietnamese diacritics in them -- encodeURI so they resolve as a
  // single path segment instead of breaking on the raw spaces.
  function characterImageUrl(def) {
    return def && def.image ? encodeURI(def.image) : null;
  }

  function renderCharacterPicker(state) {
    if (!state.characters) return;
    const myPlayer = state.players.find((p) => p.id === state.yourId);
    const myCharacter = myPlayer && myPlayer.character;
    characterListEl.innerHTML = '';
    Object.values(state.characters).forEach((def) => {
      const btn = document.createElement('button');
      btn.className = 'character-btn' + (myCharacter === def.key ? ' selected' : '');
      btn.type = 'button';
      const portrait = document.createElement('img');
      portrait.className = 'portrait';
      portrait.src = characterImageUrl(def);
      portrait.alt = def.label;
      // Falls back to the emoji token if the portrait ever fails to load.
      portrait.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = 'emoji';
        fallback.textContent = def.emoji;
        portrait.replaceWith(fallback);
      }, { once: true });
      const label = document.createElement('span');
      label.textContent = def.label;
      btn.append(portrait, label);
      btn.addEventListener('click', () => selectCharacter(def.key));
      characterListEl.appendChild(btn);
    });
  }

  function buyFirecracker(type, delta) {
    socket.emit('nien:buyFirecracker', { type, delta }, (res) => {
      if (!res || !res.ok) {
        // Buttons are already disabled for the common cases (0 owned, budget
        // maxed) -- this only guards a rare race between two rapid clicks.
      }
    });
  }

  function renderShop(state) {
    const myPlayer = state.players.find((p) => p.id === state.yourId);
    const loadout = (myPlayer && myPlayer.loadout) || { small: 0, medium: 0, large: 0 };
    const spent = totalLoadoutCost(loadout, state.firecrackerTypes);
    const remaining = state.loadoutBudget - spent;
    shopRemainingEl.textContent = remaining;
    shopTotalEl.textContent = state.loadoutBudget;
    shopListEl.innerHTML = '';
    Object.values(state.firecrackerTypes).forEach((def) => {
      const row = document.createElement('div');
      row.className = 'shop-row';

      const icon = document.createElement('div');
      icon.className = 'icon';
      icon.textContent = def.emoji;

      const info = document.createElement('div');
      info.className = 'info';
      const label = document.createElement('div');
      label.className = 'label';
      const unit = def.purchaseUnit || 1;
      label.textContent = unit > 1
        ? `${def.label} — ${def.cost} pts / pack of ${unit.toLocaleString()}`
        : `${def.label} — ${def.cost} pts`;
      const stats = document.createElement('div');
      stats.className = 'stats';
      stats.textContent = `Radius ${def.radius} · Fear +${def.fear}`;
      info.append(label, stats);

      const counter = document.createElement('div');
      counter.className = 'counter';
      const owned = loadout[def.key] || 0;
      const minusBtn = document.createElement('button');
      minusBtn.className = 'secondary';
      minusBtn.textContent = '−';
      minusBtn.disabled = owned <= 0;
      minusBtn.addEventListener('click', () => buyFirecracker(def.key, -1));
      const count = document.createElement('div');
      count.className = 'count';
      count.textContent = owned.toLocaleString();
      const plusBtn = document.createElement('button');
      plusBtn.textContent = '+';
      plusBtn.disabled = remaining < def.cost;
      plusBtn.addEventListener('click', () => buyFirecracker(def.key, 1));
      counter.append(minusBtn, count, plusBtn);

      row.append(icon, info, counter);
      shopListEl.appendChild(row);
    });
  }

  function renderHud(state) {
    hudRowEl.innerHTML = '';
    [...state.players].sort((a, b) => b.score - a.score).forEach((p) => {
      const chip = document.createElement('div');
      chip.className = 'nien-hud-chip' + (p.id === state.yourId ? ' you' : '');
      const value = document.createElement('div');
      value.className = 'value';
      value.textContent = p.score;
      chip.appendChild(document.createTextNode(p.name + (p.id === state.yourId ? ' (You)' : '') + (p.connected ? '' : ' 💤')));
      chip.appendChild(value);
      hudRowEl.appendChild(chip);
    });
  }

  // Live "who's topping this 10% round" standings, from state.players[].
  // roundDamage (raw HP dealt since the last decile payout -- resets to 0
  // for everyone the instant a 10% milestone pays out and crosses). The
  // top 3 shown here are exactly who'll each get a reserved gift tile the
  // moment this round's milestone is crossed (see the server's
  // dropReservedZoneTiles()) -- highlighted the same way renderHud
  // highlights "you", so it reads as "you're currently in line for a
  // tile" at a glance.
  function renderRoundDamage(state) {
    roundDamageListEl.innerHTML = '';
    const ranked = [...state.players]
      .filter((p) => p.connected)
      .sort((a, b) => (b.roundDamage || 0) - (a.roundDamage || 0));
    ranked.forEach((p, idx) => {
      const chip = document.createElement('div');
      const isTopRank = idx < 3 && (p.roundDamage || 0) > 0;
      chip.className = 'nien-hud-chip' + (p.id === state.yourId ? ' you' : '') + (isTopRank ? ' top-rank' : '');
      const value = document.createElement('div');
      value.className = 'value';
      value.textContent = Math.round(p.roundDamage || 0).toLocaleString();
      chip.appendChild(document.createTextNode(p.name + (p.id === state.yourId ? ' (You)' : '')));
      chip.appendChild(value);
      roundDamageListEl.appendChild(chip);
    });
  }

  // Read in quadrant order (top-left, top-right, bottom-left,
  // bottom-right) these spell out "Trung Thu Vui Vẻ" (Happy Mid-Autumn
  // Festival) -- matches the server's own ZONE_LABELS (nien-server.js).
  const ZONE_LABELS = {
    topLeft: 'Trung', topRight: 'Thu', bottomLeft: 'Vui', bottomRight: 'Vẻ',
  };
  const ZONE_KEYS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

  // Rect (in canvas pixel space) for one of the 4 quadrants -- mirrors
  // nien-server.js's zoneOrigin()/randomPositionInZone() math.
  function zoneRect(zone, width, height) {
    const halfW = width / 2;
    const halfH = height / 2;
    return {
      x: (zone === 'topRight' || zone === 'bottomRight') ? halfW : 0,
      y: (zone === 'bottomLeft' || zone === 'bottomRight') ? halfH : 0,
      w: halfW,
      h: halfH,
    };
  }

  // Which quadrant a point falls in -- used to find which zone a currently
  // burning firecracker is standing in.
  function zoneAt(x, y, width, height) {
    const right = x >= width / 2;
    const bottom = y >= height / 2;
    if (!right && !bottom) return 'topLeft';
    if (right && !bottom) return 'topRight';
    if (!right && bottom) return 'bottomLeft';
    return 'bottomRight';
  }

  function renderTurnBanner(state) {
    if (state.status !== 'playing') { turnBannerEl.textContent = ''; return; }
    if (!state.monster) {
      turnBannerEl.textContent = '👻 The Niên Thú fled! It will return in about a minute...';
      return;
    }
    if (!state.monster.visible) {
      const zoneLabel = ZONE_LABELS[state.monster.zone] || state.monster.zone;
      turnBannerEl.textContent = `❓ The Niên Thú is hiding somewhere in the ${zoneLabel} zone — throw firecrackers to find it!`;
      return;
    }
    turnBannerEl.textContent = '👹 The Niên Thú is REVEALED — scare it before it hides again!';
  }

  function renderFinished(state) {
    winnerTextEl.textContent = state.resultText || 'Game over.';
    scoreListEl.innerHTML = '';
    [...state.players].sort((a, b) => b.score - a.score).forEach((p, i) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${i === 0 ? '🏆 ' : ''}${p.name}${p.id === state.yourId ? ' (You)' : ''}`;
      const score = document.createElement('span');
      score.textContent = `${p.score} pts`;
      li.append(label, score);
      scoreListEl.appendChild(li);
    });
  }

  function drawArena(state) {
    if (!state || state.status !== 'playing') return;
    const mapW = state.mapWidth;
    const mapH = state.mapHeight;
    // On touch devices the canvas is a fixed-size VIEWPORT, not the whole
    // map -- everything below this point is drawn in MAP coordinates and
    // panned into view via ctx.translate(-camX, -camY), so the drawing
    // code for zones/grid/players/loot/etc. never needs to know which
    // mode it's in. Desktop keeps viewport === map (camX/camY always 0),
    // i.e. the exact behavior this had before camera-follow existed.
    const viewW = IS_TOUCH ? Math.min(MOBILE_VIEWPORT_SIZE, mapW) : mapW;
    const viewH = IS_TOUCH ? Math.min(MOBILE_VIEWPORT_SIZE, mapH) : mapH;
    if (canvas.width !== viewW || canvas.height !== viewH) {
      canvas.width = viewW;
      canvas.height = viewH;
    }
    const now = Date.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Flat fallback fill first (covers the gap before the image loads),
    // then the real backdrop scaled to cover the whole arena on top.
    // Drawn BEFORE the camera translate below, in untransformed canvas
    // space, so it always covers exactly the visible viewport regardless
    // of where the camera currently is.
    ctx.fillStyle = '#25361f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const myPlayer = state.players.find((p) => p.id === state.yourId);
    const camX = IS_TOUCH ? clampNum((myPlayer ? myPlayer.x : mapW / 2) - viewW / 2, 0, Math.max(0, mapW - viewW)) : 0;
    const camY = IS_TOUCH ? clampNum((myPlayer ? myPlayer.y : mapH / 2) - viewH / 2, 0, Math.max(0, mapH - viewH)) : 0;
    ctx.save();
    ctx.translate(-camX, -camY);

    if (arenaBg.complete && arenaBg.naturalWidth) {
      ctx.drawImage(arenaBg, 0, 0, mapW, mapH);
    }

    // A shadow over the backdrop for contrast against the loot/monster/
    // player art on top. A zone lights up the instant a firecracker
    // BURNS OUT in it (the burning -> armed/rooted phase finishing --
    // detected by edge, not by the ongoing p.burning state) and fades
    // back to shadow ZONE_LIGHT_MS later if nothing else burns out there
    // in the meantime.
    (state.players || []).forEach((p) => {
      const wasBurning = Boolean(prevPlayerBurning[p.id]);
      const isBurningNow = Boolean(p.connected && p.burning);
      if (wasBurning && !isBurningNow) {
        zoneLitUntil[zoneAt(p.x, p.y, mapW, mapH)] = now + ZONE_LIGHT_MS;
      }
      prevPlayerBurning[p.id] = isBurningNow;
    });
    const litZones = new Set(ZONE_KEYS.filter((zone) => (zoneLitUntil[zone] || 0) > now));
    ZONE_KEYS.forEach((zone) => {
      const r = zoneRect(zone, mapW, mapH);
      ctx.fillStyle = litZones.has(zone) ? 'rgba(255, 209, 102, 0.10)' : 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    });

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    const gridStep = 60;
    for (let x = gridStep; x < mapW; x += gridStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, mapH); ctx.stroke();
    }
    for (let y = gridStep; y < mapH; y += gridStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(mapW, y); ctx.stroke();
    }

    // A persistent dashed cross dividing the arena into the 4 zones
    // (Trung / Thu / Vui / Vẻ — named and drawn directly into the
    // background art now, so no text label is drawn here) — purely a
    // visual aid so the "hiding in the X zone" hint text maps onto an
    // actual part of the screen.
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.25)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(mapW / 2, 0);
    ctx.lineTo(mapW / 2, mapH);
    ctx.moveTo(0, mapH / 2);
    ctx.lineTo(mapW, mapH / 2);
    ctx.stroke();
    ctx.restore();

    (state.loot || []).forEach((item) => {
      const lootImg = getLootImage(item);
      if (lootImg && lootImg.complete && lootImg.naturalWidth) {
        drawImageFit(lootImg, item.x, item.y, 40);
      } else {
        ctx.font = '26px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(item.emoji, item.x, item.y);
      }
    });

    // Only draw the monster when it's actually visible -- while hidden the
    // server never sends x/y at all, so there's nothing to draw anyway.
    if (state.monster && state.monster.visible && state.monster.x !== null) {
      const m = state.monster;
      ctx.font = '40px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('👹', m.x, m.y);
      const barW = 50;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(m.x - barW / 2, m.y - 38, barW, 6);
      ctx.fillStyle = '#ff5c5c';
      // m.fear is raw HP dropped now, not a percentage -- scale against maxHp.
      ctx.fillRect(m.x - barW / 2, m.y - 38, barW * (m.fear / m.maxHp), 6);
      if (m.roaring) {
        ctx.font = 'bold 13px sans-serif';
        ctx.fillStyle = '#ffce54';
        ctx.fillText('🦁 Sư Tử Hống!', m.x, m.y - 50);
      }
    }

    (state.players || []).forEach((p) => {
      if (!p.connected) return;
      const mine = p.id === state.yourId;
      const stunned = Boolean(p.stunnedUntil && now < p.stunnedUntil);
      const charDef = (state.characters && p.character && state.characters[p.character]) || null;

      // Colored ring behind the character token -- still the "is this me /
      // is this player stunned" indicator the plain dot used to be.
      ctx.beginPath();
      ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = stunned ? '#666' : (mine ? '#5b8cff' : '#e0a94b');
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.stroke();

      // Character token: the same portrait stands in for move/burn/throw/
      // stun alike (see CHARACTERS in nien-server.js) until each
      // character's own animations/effects for those 4 states are built.
      // Falls back to the emoji if the image hasn't loaded yet (or failed).
      const charImg = getCharacterImage(charDef);
      if (charImg && charImg.complete && charImg.naturalWidth) {
        drawImageFit(charImg, p.x, p.y, 36);
      } else {
        ctx.font = '26px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(charDef ? charDef.emoji : '🧑', p.x, p.y);
      }

      // Picking up an item: a filling gold ring showing progress toward
      // the ~0.5s stationary hold required to actually collect it (see
      // PICKUP_HOLD_MS in nien-server.js). Moving away cancels the hold
      // server-side, which simply stops sending pickupHoldUntil.
      if (p.pickupHoldUntil) {
        const remaining = p.pickupHoldUntil - now;
        const progress = Math.min(1, Math.max(0, 1 - remaining / PICKUP_HOLD_MS));
        ctx.beginPath();
        ctx.arc(p.x, p.y, 22, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      ctx.font = '11px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(p.name.slice(0, 10), p.x, p.y - 26);
      // Visible to everyone, not just the player themselves, so opponents
      // can see the tension (or the mistake) building.
      if (p.burning) {
        ctx.font = '18px sans-serif';
        ctx.fillText('🔥', p.x, p.y - 42);
      } else if (p.armed) {
        ctx.font = '18px sans-serif';
        ctx.fillText('🎇', p.x, p.y - 42);
      } else if (stunned) {
        ctx.font = '18px sans-serif';
        ctx.fillText('💫', p.x, p.y - 42);
      }
    });

    selfPuffs = selfPuffs.filter((sp) => now - sp.startTime < EXPLOSION_DURATION_MS);
    selfPuffs.forEach((sp) => {
      const age = (now - sp.startTime) / EXPLOSION_DURATION_MS;
      ctx.font = '26px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 1 - age;
      ctx.fillText('💥', sp.x, sp.y - 20);
      ctx.globalAlpha = 1;
    });

    explosions = explosions.filter((ex) => now - ex.startTime < EXPLOSION_DURATION_MS);
    explosions.forEach((ex) => {
      const age = (now - ex.startTime) / EXPLOSION_DURATION_MS;
      const r = ex.radius * (0.3 + age * 0.9);
      ctx.beginPath();
      ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ex.hitMonster ? `rgba(255, 209, 102, ${0.5 * (1 - age)})` : `rgba(255, 92, 92, ${0.4 * (1 - age)})`;
      ctx.fill();
      ctx.font = '20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('💥', ex.x, ex.y);
    });

    // Live aim preview while press-dragging a fire circle (touch only --
    // see the fire-circle wiring below): a dashed line from the player out
    // to the computed target, plus a faint circle showing that
    // firecracker's actual blast radius there, so aiming is WYSIWYG
    // instead of a blind guess.
    if (aimDrag && myPlayer) {
      const target = aimDragTarget(aimDrag, myPlayer);
      const def = state.firecrackerTypes && state.firecrackerTypes[aimDrag.type];
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(myPlayer.x, myPlayer.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
      if (def) {
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(target.x, target.y, def.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 209, 102, 0.15)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 209, 102, 0.6)';
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore(); // matches the camera ctx.save()/translate() above
  }

  function startBurn(type) {
    // Deliberately NOT resetting selectedType on success -- it stays the
    // type just thrown, so the picker/circles default back to the SAME
    // type next turn instead of snapping back to the cheapest one every
    // single time (see throwPickerSignature's fallback below for what
    // happens once this type actually runs out).
    socket.emit('nien:startBurn', { type }, (res) => {
      if ((!res || !res.ok) && (!res || (res.error !== 'cooldown' && res.error !== 'busy' && res.error !== 'stunned'))) {
        console.warn('Could not start lighting a firecracker:', res?.error);
      }
    });
  }

  // The cheapest type (by point cost) that the player still has ammo for
  // — used only as a last-resort default (game start, or every tier at or
  // below the last-used one has run out too).
  function cheapestAvailableType(state, inventory) {
    return Object.keys(state.firecrackerTypes)
      .filter((k) => (inventory[k] || 0) > 0)
      .sort((a, b) => state.firecrackerTypes[a].cost - state.firecrackerTypes[b].cost)[0] || null;
  }

  // Once `fromType` (the last type actually thrown) runs dry, step DOWN
  // to the next cheaper tier still in stock (e.g. Pháo Cối -> Pháo Chuột
  // -> Pháo Tép) rather than jumping straight to whatever's globally
  // cheapest -- keeps the player's general "I'm using the big one" intent
  // instead of silently downgrading further than necessary. Falls back to
  // cheapestAvailableType() only if fromType and everything cheaper than
  // it are ALSO empty (the remaining stock, if any, is pricier than fromType).
  function nextLowerAvailableType(state, inventory, fromType) {
    const tiersByCostDesc = Object.keys(state.firecrackerTypes)
      .sort((a, b) => state.firecrackerTypes[b].cost - state.firecrackerTypes[a].cost);
    const startIdx = Math.max(0, tiersByCostDesc.indexOf(fromType));
    for (let i = startIdx; i < tiersByCostDesc.length; i += 1) {
      if ((inventory[tiersByCostDesc[i]] || 0) > 0) return tiersByCostDesc[i];
    }
    return cheapestAvailableType(state, inventory);
  }

  function throwPickerSignature(state, myPlayer, now) {
    // Rounded to the same 0.1s the countdown text displays, so idle ticks
    // (the vast majority — 12.5 state updates/sec, but nothing actually
    // changes most of the time) produce an IDENTICAL signature and skip
    // the rebuild entirely.
    if (myPlayer.burning) return `burning:${myPlayer.burning.type}:${Math.ceil(Math.max(0, myPlayer.burning.burnEndsAt - now) / 100)}`;
    if (myPlayer.armed) return `armed:${myPlayer.armed.type}:${Math.ceil(Math.max(0, myPlayer.armed.readyUntil - now) / 100)}`;
    if (myPlayer.stunnedUntil && now < myPlayer.stunnedUntil) return `stunned:${Math.ceil(Math.max(0, myPlayer.stunnedUntil - now) / 100)}`;
    if (myPlayer.nextBurnAt && now < myPlayer.nextBurnAt) return `cooldown:${Math.ceil(Math.max(0, myPlayer.nextBurnAt - now) / 100)}`;
    const inv = myPlayer.inventory || {};
    if (!selectedType) {
      selectedType = cheapestAvailableType(state, inv); // nothing picked/thrown yet this game
    } else if (!inv[selectedType]) {
      selectedType = nextLowerAvailableType(state, inv, selectedType); // last-used type just ran out
    }
    const invSig = Object.keys(state.firecrackerTypes).map((k) => `${k}=${inv[k] || 0}`).join(',');
    return `idle:${selectedType}:${invSig}`;
  }

  // Rebuilding this on every ~80ms 'nien:state' tick (even though nothing
  // visible usually changed) would destroy and recreate the type buttons
  // out from under an in-progress mouse click — mousedown lands on one
  // button element, the tick replaces it before mouseup, and the click
  // never registers on anything. Skipping the rebuild whenever the
  // signature is unchanged keeps the buttons as stable DOM nodes while
  // idle, which is exactly when they need to be clickable.
  let lastThrowPickerSignature = null;
  function renderThrowTypePicker(state) {
    const myPlayer = state.players.find((p) => p.id === state.yourId);
    if (!myPlayer) { throwTypePickerEl.innerHTML = ''; lastThrowPickerSignature = null; return; }
    const now = Date.now();
    const signature = throwPickerSignature(state, myPlayer, now);
    if (signature === lastThrowPickerSignature) return;
    lastThrowPickerSignature = signature;

    throwTypePickerEl.innerHTML = '';

    if (myPlayer.burning) {
      const def = state.firecrackerTypes[myPlayer.burning.type];
      const remaining = Math.max(0, (myPlayer.burning.burnEndsAt - now) / 1000).toFixed(1);
      const status = document.createElement('div');
      status.className = 'burn-status';
      status.textContent = `🔥 Lighting ${def.emoji} ${def.label}... ${remaining}s (you can't move!)`;
      throwTypePickerEl.appendChild(status);
      return;
    }

    if (myPlayer.armed) {
      const def = state.firecrackerTypes[myPlayer.armed.type];
      const remaining = Math.max(0, (myPlayer.armed.readyUntil - now) / 1000).toFixed(1);
      const status = document.createElement('div');
      status.className = 'burn-status';
      status.textContent = `🎇 ${def.emoji} ${def.label} is lit — click the arena to THROW IT! ${remaining}s left or it goes off in your hands!`;
      throwTypePickerEl.appendChild(status);
      return;
    }

    if (myPlayer.stunnedUntil && now < myPlayer.stunnedUntil) {
      const remaining = Math.max(0, (myPlayer.stunnedUntil - now) / 1000).toFixed(1);
      const status = document.createElement('div');
      status.className = 'burn-status';
      status.textContent = `💫 Stunned! You held it too long. ${remaining}s until you can move again.`;
      throwTypePickerEl.appendChild(status);
      selectedType = null;
      return;
    }

    const onCooldown = Boolean(myPlayer.nextBurnAt && now < myPlayer.nextBurnAt);
    if (onCooldown) {
      const remaining = Math.max(0, (myPlayer.nextBurnAt - now) / 1000).toFixed(1);
      const status = document.createElement('div');
      status.className = 'burn-status';
      status.textContent = `⏳ You can light another firecracker in ${remaining}s`;
      throwTypePickerEl.appendChild(status);
      // NOT resetting selectedType here -- every successful throw goes
      // through this same cooldown window, so clearing it here would undo
      // the "keep using the same type next turn" behavior from
      // startBurn()/throwPickerSignature() the instant the throw lands.
      return;
    }

    const inventory = myPlayer.inventory || {};
    // selectedType is already defaulted/validated by throwPickerSignature() above.
    Object.keys(state.firecrackerTypes).forEach((key) => {
      const def = state.firecrackerTypes[key];
      const count = inventory[key] || 0;
      const disabled = count <= 0;
      const btn = document.createElement('button');
      btn.className = 'throw-type-btn' + (key === selectedType ? ' selected' : '') + (disabled ? ' out-of-ammo' : '');
      btn.disabled = disabled;
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = def.emoji;
      btn.appendChild(icon);
      btn.appendChild(document.createTextNode(`${def.label} x${count}`));
      btn.addEventListener('click', () => {
        if (disabled) return;
        selectedType = selectedType === key ? null : key; // toggle select/unselect
        renderThrowTypePicker(state);
      });
      throwTypePickerEl.appendChild(btn);
    });

    if (selectedType) {
      const def = state.firecrackerTypes[selectedType];
      const hint = document.createElement('div');
      hint.className = 'burn-status';
      hint.textContent = `${def.emoji} ${def.label} selected — click the arena to light it!`;
      throwTypePickerEl.appendChild(hint);
    }
  }

  // Touch equivalent of renderThrowTypePicker() above, but updates the 3
  // STATIC #mobile-fire-circles buttons in place rather than recreating
  // DOM nodes each tick -- an in-progress press-and-drag (see the
  // fire-circle pointerdown/move/up wiring) must keep the exact same
  // element across ticks or the drag breaks mid-gesture.
  function renderFireCircles(state) {
    const myPlayer = state.players.find((p) => p.id === state.yourId);
    if (!myPlayer) return;
    const now = Date.now();
    const inventory = myPlayer.inventory || {};
    const stunned = Boolean(myPlayer.stunnedUntil && now < myPlayer.stunnedUntil);
    const onCooldown = Boolean(myPlayer.nextBurnAt && now < myPlayer.nextBurnAt);
    fireCircleEls.forEach((btn) => {
      const type = btn.dataset.type;
      const def = state.firecrackerTypes[type];
      const count = inventory[type] || 0;
      const isBurningThis = Boolean(myPlayer.burning && myPlayer.burning.type === type);
      const isArmedThis = Boolean(myPlayer.armed && myPlayer.armed.type === type);
      const busyWithOther = Boolean((myPlayer.burning && !isBurningThis) || (myPlayer.armed && !isArmedThis));
      const disabled = !isBurningThis && !isArmedThis && (count <= 0 || stunned || onCooldown || busyWithOther);
      btn.classList.toggle('disabled', disabled);
      btn.classList.toggle('burning', isBurningThis);
      btn.classList.toggle('armed', isArmedThis);
      const ammoEl = btn.querySelector('.ammo');
      if (isBurningThis) {
        const remaining = Math.max(0, (myPlayer.burning.burnEndsAt - now) / 1000).toFixed(1);
        ammoEl.textContent = `🔥${remaining}s`;
      } else if (isArmedThis) {
        const remaining = Math.max(0, (myPlayer.armed.readyUntil - now) / 1000).toFixed(1);
        ammoEl.textContent = `🎯${remaining}s`;
      } else {
        ammoEl.textContent = `x${count}`;
      }
      btn.title = `${def.label} — ${def.cost} pts`;
    });
  }

  function renderGame(state) {
    if (state.firecrackerRange) firecrackerRange = state.firecrackerRange;
    renderHud(state);
    renderRoundDamage(state);
    // state.monster.fear is now raw HP dropped (NOT a percentage) -- derive
    // the percent for display/bar-width from hp/maxHp instead of using it
    // directly.
    const maxHp = (state.monster && state.monster.maxHp) || 100000;
    const hp = state.monster ? state.monster.hp : maxHp;
    const pctDropped = ((maxHp - hp) / maxHp) * 100;
    fearValueEl.textContent = `${pctDropped.toFixed(1)}% (${hp.toLocaleString()} / ${maxHp.toLocaleString()} HP)`;
    fearBarEl.style.width = `${pctDropped}%`;
    lootRemainingEl.textContent = state.lootDropped;
    renderTurnBanner(state);
    renderThrowTypePicker(state);
    if (IS_TOUCH) renderFireCircles(state);
    renderLog(gameLogEl, state.log);
  }

  function render() {
    if (!joined) {
      syncBgm(null);
      renderLobby();
      showScreen('lobby');
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

  function animationLoop() {
    if (latestState && latestState.status === 'playing') drawArena(latestState);
    if (latestState && latestState.status === 'playing') renderTurnBanner(latestState); // keep the final-call countdown ticking between server updates
    requestAnimationFrame(animationLoop);
  }
  requestAnimationFrame(animationLoop);

  function enterRoom(roomId) {
    joined = true;
    localStorage.setItem(LAST_ROOM_KEY, roomId);
    render();
  }

  function backToLobby() {
    joined = false;
    latestState = null;
    explosions = [];
    selfPuffs = [];
    selectedType = null;
    zoneLitUntil = {};
    prevPlayerBurning = {};
    localStorage.removeItem(LAST_ROOM_KEY);
    createRoomScreen.classList.add('hidden');
    socket.emit('nien:listRooms', {}, (res) => {
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
    socket.emit('nien:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
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
          'game-in-progress': 'That room already started a chase.',
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
    const budgetInput = document.querySelector('input[name="loadout-budget"]:checked');
    const loadoutBudget = budgetInput ? Number(budgetInput.value) : 100;
    socket.emit('nien:createRoom', { roomName, password, playerId: me.id, name: me.name, loadoutBudget }, (res) => {
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
    socket.emit('nien:addBots', { count: 3 }, (res) => {
      if (!res || !res.ok) alert('Could not add bots: ' + ((res && res.error) || 'unknown error'));
    });
  });
  startBtn.addEventListener('click', () => socket.emit('nien:start'));
  newGameBtn.addEventListener('click', () => socket.emit('nien:newGame'));
  leaveWaitingBtn.addEventListener('click', () => { socket.emit('nien:leave'); backToLobby(); });
  leaveBtn.addEventListener('click', () => { socket.emit('nien:leave'); backToLobby(); });

  // --- Movement input: WASD / Arrow Keys (desktop) ---------------------
  const MOVE_KEYS = {
    w: { x: 0, y: -1 }, ArrowUp: { x: 0, y: -1 },
    s: { x: 0, y: 1 }, ArrowDown: { x: 0, y: 1 },
    a: { x: -1, y: 0 }, ArrowLeft: { x: -1, y: 0 },
    d: { x: 1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  };
  function currentDir() {
    let x = 0;
    let y = 0;
    pressedKeys.forEach((k) => {
      const v = MOVE_KEYS[k];
      if (v) { x += v.x; y += v.y; }
    });
    return { x, y };
  }
  function sendDirIfChanged() {
    const dir = currentDir();
    if (dir.x !== lastSentDir.x || dir.y !== lastSentDir.y) {
      lastSentDir = dir;
      socket.emit('nien:input', { dx: dir.x, dy: dir.y });
    }
  }
  function myPlayerIsRooted() {
    const mp = latestState && latestState.players.find((p) => p.id === latestState.yourId);
    if (!mp) return false;
    return Boolean(mp.burning) || Boolean(mp.stunnedUntil && Date.now() < mp.stunnedUntil);
  }
  window.addEventListener('keydown', (e) => {
    if (!MOVE_KEYS[e.key] || !latestState || latestState.status !== 'playing') return;
    if (myPlayerIsRooted()) return; // rooted while lighting a firecracker, or stunned after fizzling one
    pressedKeys.add(e.key);
    sendDirIfChanged();
  });
  window.addEventListener('keyup', (e) => {
    if (!MOVE_KEYS[e.key]) return;
    pressedKeys.delete(e.key);
    sendDirIfChanged();
  });
  window.addEventListener('blur', () => {
    pressedKeys.clear();
    sendDirIfChanged();
  });

  // --- Movement input: drag joystick, for touch devices with no --------
  // keyboard (see #mobile-joystick in nien.html -- shown only under
  // `@media (pointer: coarse)`, i.e. touch-primary devices). A floating
  // analog stick, not discrete directions: the sent vector's magnitude
  // scales with how far the thumb is dragged from center (capped at 1),
  // and setPlayerInput() server-side trusts a sub-1 magnitude as-is
  // instead of renormalizing it to full speed -- so this is genuinely
  // variable-speed, unlike the keyboard's always-full-speed unit vectors.
  const JOYSTICK_RADIUS_PX = 46; // matches #mobile-joystick's own CSS radius
  let joystickPointerId = null;
  let lastJoystickDir = { x: 0, y: 0 };
  function sendJoystickDir(x, y) {
    if (x === lastJoystickDir.x && y === lastJoystickDir.y) return;
    lastJoystickDir = { x, y };
    socket.emit('nien:input', { dx: x, dy: y });
  }
  function updateJoystick(e) {
    const rect = mobileJoystickEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, JOYSTICK_RADIUS_PX);
    if (dist > 0) { dx = (dx / dist) * clamped; dy = (dy / dist) * clamped; }
    joystickThumbEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    if (!latestState || latestState.status !== 'playing' || myPlayerIsRooted()) { sendJoystickDir(0, 0); return; }
    sendJoystickDir(dx / JOYSTICK_RADIUS_PX, dy / JOYSTICK_RADIUS_PX);
  }
  function resetJoystick() {
    joystickThumbEl.style.transform = 'translate(-50%, -50%)';
    sendJoystickDir(0, 0);
  }
  mobileJoystickEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    joystickPointerId = e.pointerId;
    mobileJoystickEl.setPointerCapture(e.pointerId);
    updateJoystick(e);
  });
  mobileJoystickEl.addEventListener('pointermove', (e) => {
    if (joystickPointerId !== e.pointerId) return;
    e.preventDefault();
    updateJoystick(e);
  });
  function endJoystickDrag(e) {
    if (joystickPointerId !== e.pointerId) return;
    joystickPointerId = null;
    resetJoystick();
  }
  mobileJoystickEl.addEventListener('pointerup', endJoystickDrag);
  mobileJoystickEl.addEventListener('pointercancel', endJoystickDrag);

  // --- Firing input, touch devices: press-and-HOLD a fire circle to -----
  // light it, then (without necessarily lifting your finger) drag to aim
  // and release to throw once it's armed (see #mobile-fire-circles in
  // nien.html). Tracking starts on the VERY FIRST pointerdown -- even
  // while still idle/burning, before there's anything to aim yet -- so a
  // single continuous press-hold-drag-release gesture works naturally;
  // only actually acting on the drag is deferred until release. A second,
  // separate press-drag-release after letting go mid-burn also still
  // works (aimDrag just restarts from that fresh touch). `aimDrag` (read
  // by drawArena's aim-preview and by renderFireCircles' visual state) is
  // non-null only while a finger is down on this circle.
  let aimDrag = null; // { type, pointerId, anchorX, anchorY, dx, dy } -- dx/dy are raw SCREEN pixels from the initial touch point
  const AIM_DRAG_RADIUS_PX = 90; // drag this many screen px for a full-range throw
  // Screen-space drag direction maps 1:1 onto map-space throw direction --
  // camera-follow only PANS (never rotates/flips), so "drag right" always
  // means "throw right" regardless of where the camera currently sits.
  function aimDragTarget(drag, myPlayer) {
    const dist = Math.hypot(drag.dx, drag.dy);
    const dirX = dist > 0 ? drag.dx / dist : 0;
    const dirY = dist > 0 ? drag.dy / dist : 0;
    const frac = Math.min(1, dist / AIM_DRAG_RADIUS_PX);
    return { x: myPlayer.x + dirX * firecrackerRange * frac, y: myPlayer.y + dirY * firecrackerRange * frac };
  }
  fireCircleEls.forEach((btn) => {
    const type = btn.dataset.type;
    btn.addEventListener('pointerdown', (e) => {
      if (!latestState || latestState.status !== 'playing') return;
      const mp = latestState.players.find((p) => p.id === latestState.yourId);
      if (!mp) return;
      e.preventDefault();
      const alreadyArmedThis = Boolean(mp.armed && mp.armed.type === type);
      if (!alreadyArmedThis) {
        if (mp.burning || mp.armed) return; // busy with a different type
        if (mp.stunnedUntil && Date.now() < mp.stunnedUntil) return;
        if (mp.nextBurnAt && Date.now() < mp.nextBurnAt) return;
        if (!(mp.inventory && mp.inventory[type])) return; // out of ammo
        startBurn(type);
      }
      // Start tracking THIS touch as a potential aim drag regardless of
      // whether it's armed yet -- see the comment above.
      aimDrag = { type, pointerId: e.pointerId, anchorX: e.clientX, anchorY: e.clientY, dx: 0, dy: 0 };
      btn.setPointerCapture(e.pointerId);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!aimDrag || aimDrag.pointerId !== e.pointerId || aimDrag.type !== type) return;
      e.preventDefault();
      // Absolute offset from the finger's FIRST touch point (not the
      // circle's center) -- a "floating" drag origin, more forgiving than
      // requiring the drag to start from an exact fixed point.
      aimDrag.dx = e.clientX - aimDrag.anchorX;
      aimDrag.dy = e.clientY - aimDrag.anchorY;
    });
    function endAim(e) {
      if (!aimDrag || aimDrag.pointerId !== e.pointerId || aimDrag.type !== type) return;
      const mp = latestState && latestState.players.find((p) => p.id === latestState.yourId);
      const drag = aimDrag;
      aimDrag = null;
      // Not armed yet (still burning -- released too early) or already
      // self-detonated: nothing to throw. The burn itself can't be
      // cancelled either way -- it just keeps cooking server-side, and a
      // fresh press once it shows armed will start a new aim drag.
      if (!mp || !mp.armed || mp.armed.type !== drag.type) return;
      const target = aimDragTarget(drag, mp);
      socket.emit('nien:release', { x: target.x, y: target.y }, (res) => {
        if (!res || !res.ok) {
          if (res && res.error === 'not-armed') return;
          console.warn('Could not release firecracker:', res && res.error);
        }
      });
    }
    btn.addEventListener('pointerup', endAim);
    btn.addEventListener('pointercancel', endAim);
  });

  // --- Click the arena to RELEASE an already-armed firecracker ---------
  // (desktop only -- touch devices use the fire-circle drag above.)
  canvas.addEventListener('click', (e) => {
    if (IS_TOUCH) return;
    if (!latestState || latestState.status !== 'playing') return;
    const mp = latestState.players.find((p) => p.id === latestState.yourId);
    if (!mp) return;

    if (mp.armed) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      socket.emit('nien:release', { x, y }, (res) => {
        if (!res || !res.ok) {
          if (res && res.error === 'not-armed') return; // it must have just self-detonated; UI already reflects the stun
          console.warn('Could not release firecracker:', res && res.error);
        }
      });
      return;
    }

    // Not armed/burning/stunned/on-cooldown, and a type is selected --
    // clicking the arena confirms lighting it (same "click the arena to
    // act" pattern as releasing an armed one).
    if (selectedType && !mp.burning && !(mp.stunnedUntil && Date.now() < mp.stunnedUntil) && !(mp.nextBurnAt && Date.now() < mp.nextBurnAt)) {
      startBurn(selectedType);
    }
  });

  socket.on('nien:selfdetonate', (ev) => {
    selfPuffs.push({ ...ev, startTime: Date.now() });
    playExplosionSound(ev.type);
  });

  socket.on('nien:boom', (explosion) => {
    explosions.push({ ...explosion, startTime: Date.now() });
    playExplosionSound(explosion.type);
  });

  socket.on('nien:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('nien:state', (state) => {
    latestState = state;
    if (state.players.some((p) => p.id === state.yourId)) joined = true;
    render();
  });

  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('nien:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('nien:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
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

  // --- Sound: looping background music while a chase is in progress. -----
  const MUSIC_MUTED_KEY = 'nien_music_muted';
  const bgmAudio = document.getElementById('bgm-audio');
  const muteBtn = document.getElementById('mute-btn');
  bgmAudio.volume = 0.35;
  let musicMuted = localStorage.getItem(MUSIC_MUTED_KEY) === '1';

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

  // --- Sound: real recorded clip per firecracker type (small/medium/large), ---
  // triggered off the same 'nien:boom' event that already drives the visual
  // blast (see explosions.push(...) below). Filenames have spaces and
  // Vietnamese diacritics -- percent-encoded so they resolve correctly.
  // A fresh Audio() per play (rather than one shared/reused element) so
  // rapid-fire explosions overlap instead of cutting each other off.
  const EXPLOSION_SOUND_FILES = {
    small: 'nienmonster/sounds/Ph%C3%A1o%20t%C3%A9p.mp3', // Pháo tép
    medium: 'nienmonster/sounds/Ph%C3%A1o%20chu%E1%BB%99t.mp3', // Pháo chuột
    large: 'nienmonster/sounds/Ph%C3%A1o%20c%E1%BB%91i.mp3', // Pháo cối
  };
  function playExplosionSound(type) {
    if (musicMuted) return;
    const src = EXPLOSION_SOUND_FILES[type];
    if (!src) return;
    const audio = new Audio(src);
    audio.volume = 0.7;
    audio.play().catch(() => {}); // blocked until a user gesture -- fine, the next explosion retries
  }

  showScreen('lobby');
}
