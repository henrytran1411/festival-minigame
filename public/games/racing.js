const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/racing');
  const LAST_ROOM_KEY = 'racing_last_room_id';
  const MAX_PLAYERS = 10; // must match racing-server.js's own MAX_PLAYERS -- only used here to disable "Add Bots" once full

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
  const addManyBotsBtn = document.getElementById('add-many-bots-btn');
  const waitingLogEl = document.getElementById('waiting-log');
  const leaveWaitingBtn = document.getElementById('leave-waiting-btn');
  const characterListEl = document.getElementById('character-list');

  const canvas = document.getElementById('track-canvas');
  const ctx = canvas.getContext('2d');
  const countdownEl = document.getElementById('countdown-el');
  const leaveBtn = document.getElementById('leave-btn');
  const gameLogEl = document.getElementById('game-log');
  const hintToggleBtn = document.getElementById('hint-toggle-btn');
  const logToggleBtn = document.getElementById('log-toggle-btn');
  const hintTextEl = document.getElementById('racing-hint-text');
  const mobileJoystickEl = document.getElementById('mobile-joystick');
  const joystickThumbEl = document.getElementById('joystick-thumb');

  const gasGaugeFillEl = document.getElementById('gas-gauge-fill');
  const speedValueEl = document.getElementById('speed-value');
  const gasBtn = document.getElementById('gas-btn');
  const damageGaugeFillEl = document.getElementById('damage-gauge-fill');
  const damageValueEl = document.getElementById('damage-value');
  const repairBannerEl = document.getElementById('repair-banner');
  const repairSecondsEl = document.getElementById('repair-seconds');
  const itemButtons = {
    maxGas: document.getElementById('use-maxGas-btn'),
    stun: document.getElementById('use-stun-btn'),
    shield: document.getElementById('use-shield-btn'),
  };

  const winnerTextEl = document.getElementById('winner-text');
  const scoreListEl = document.getElementById('score-list');
  const newGameBtn = document.getElementById('new-game-btn');

  const rulesModal = document.getElementById('rules-modal');

  let joined = false;
  let latestRooms = [];
  let latestState = null;

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
    if (status === 'countdown' || status === 'racing') return 'In progress';
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
      meta.className = 'room-meta' + (room.status !== 'waiting' ? ' playing' : '');
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

  function selectCharacter(character) {
    socket.emit('racing:selectCharacter', { character }, () => {
      // Cosmetic and no local optimistic state to roll back on failure.
    });
  }

  function selectTrack(trackKey) {
    socket.emit('racing:selectTrack', { trackKey }, (res) => {
      if (!res || !res.ok) alert('Could not switch pass: ' + ((res && res.error) || 'unknown error'));
    });
  }

  // Preview of the currently-selected track's actual layout -- reuses the
  // same checkpoint/decoration/landmark/road data the in-race views draw
  // from (state's own checkpoints/decorations/landmarks/bgFrom/bgTo/
  // trackWidth already describe whichever track is CURRENTLY selected, see
  // racing-server.js's state()), just scaled down to fit a small standalone
  // canvas since there's no player position to frame here like the minimap
  // has. Redrawn every time the waiting room re-renders, so switching the
  // track (an immediate server broadcast) updates it right away.
  const trackPreviewCanvas = document.getElementById('track-preview-canvas');
  const tpctx = trackPreviewCanvas.getContext('2d');
  const TRACK_PREVIEW_WIDTH = 260;
  function renderTrackPreview(state) {
    if (!state.checkpoints || !state.checkpoints.length) return;
    const w = TRACK_PREVIEW_WIDTH;
    const h = Math.round(w * (state.mapHeight / state.mapWidth));
    trackPreviewCanvas.width = w;
    trackPreviewCanvas.height = h;
    const sx = w / state.mapWidth;
    const sy = h / state.mapHeight;

    const bg = tpctx.createLinearGradient(0, 0, w, 0);
    bg.addColorStop(0, state.bgFrom || '#16321f');
    bg.addColorStop(1, state.bgTo || '#0d2b3d');
    tpctx.fillStyle = bg;
    tpctx.fillRect(0, 0, w, h);

    tpctx.font = '10px sans-serif';
    tpctx.textAlign = 'center';
    tpctx.textBaseline = 'middle';
    (state.decorations || []).forEach((d) => tpctx.fillText(d.emoji, d.x * sx, d.y * sy));

    tpctx.lineJoin = 'round';
    tpctx.lineCap = 'round';
    tpctx.strokeStyle = '#ffd166';
    tpctx.lineWidth = 5;
    tpctx.beginPath();
    state.checkpoints.forEach((pt, i) => {
      const x = pt.x * sx;
      const y = pt.y * sy;
      if (i === 0) tpctx.moveTo(x, y); else tpctx.lineTo(x, y);
    });
    tpctx.closePath();
    tpctx.stroke();
    tpctx.strokeStyle = '#3a4152';
    tpctx.lineWidth = 3;
    tpctx.stroke();

    tpctx.fillStyle = '#ffd166';
    const start = state.checkpoints[0];
    tpctx.beginPath();
    tpctx.arc(start.x * sx, start.y * sy, 4, 0, Math.PI * 2);
    tpctx.fill();
    tpctx.fillText('🏁', start.x * sx, start.y * sy - 10);

    tpctx.font = '9px sans-serif';
    tpctx.fillStyle = '#eef1f6';
    (state.landmarks || []).forEach((l) => tpctx.fillText(l.icon, l.x * sx, l.y * sy));
  }

  const trackListEl = document.getElementById('track-list');
  function renderTrackPicker(state) {
    if (!state.tracks) return;
    trackListEl.innerHTML = '';
    Object.values(state.tracks).forEach((t) => {
      const btn = document.createElement('button');
      btn.className = 'track-btn' + (state.trackKey === t.key ? ' selected' : '');
      btn.type = 'button';
      const label = document.createElement('div');
      label.className = 'track-label';
      label.textContent = t.label;
      const blurb = document.createElement('div');
      blurb.className = 'track-blurb';
      blurb.textContent = t.blurb;
      const meta = document.createElement('div');
      meta.className = 'track-meta';
      meta.textContent = `${t.lapsToWin} lap${t.lapsToWin === 1 ? '' : 's'} · ${t.numCheckpoints} checkpoints`;
      btn.append(label, blurb, meta);
      btn.addEventListener('click', () => selectTrack(t.key));
      trackListEl.appendChild(btn);
    });
  }

  function renderCharacterPicker(state) {
    if (!state.characters) return;
    const myPlayer = state.players.find((p) => p.id === me.id);
    const myCharacter = myPlayer && myPlayer.character;
    characterListEl.innerHTML = '';
    Object.values(state.characters).forEach((def) => {
      const btn = document.createElement('button');
      btn.className = 'character-btn' + (myCharacter === def.key ? ' selected' : '');
      btn.type = 'button';
      if (def.image) {
        const portrait = document.createElement('img');
        portrait.className = 'portrait';
        portrait.src = encodeURI(def.image);
        portrait.alt = def.label;
        portrait.addEventListener('error', () => {
          const fallback = document.createElement('span');
          fallback.className = 'emoji';
          fallback.textContent = def.emoji;
          portrait.replaceWith(fallback);
        }, { once: true });
        btn.appendChild(portrait);
      } else {
        const emoji = document.createElement('span');
        emoji.className = 'emoji';
        emoji.textContent = def.emoji;
        btn.appendChild(emoji);
      }
      const label = document.createElement('span');
      label.textContent = def.label;
      btn.appendChild(label);
      btn.addEventListener('click', () => selectCharacter(def.key));
      characterListEl.appendChild(btn);
    });
  }

  function renderWaiting(state) {
    waitingRoomTitleEl.textContent = state.roomName || 'Waiting Room';
    playerListEl.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      const charDef = (state.characters && p.character && state.characters[p.character]) || null;
      const charTag = charDef ? ` ${charDef.emoji} ${charDef.label}` : '';
      li.textContent = p.name + (p.id === me.id ? ' (you)' : '') + (p.isBot ? ' 🤖' : '') + charTag;
      playerListEl.appendChild(li);
    });
    startBtn.disabled = state.players.length < 1;
    addBotsBtn.disabled = state.players.length >= MAX_PLAYERS;
    addManyBotsBtn.disabled = state.players.length >= MAX_PLAYERS;
    renderTrackPicker(state);
    renderTrackPreview(state);
    renderCharacterPicker(state);
    renderLog(waitingLogEl, state.log);
  }

  // --- Track rendering ----------------------------------------------------
  // The whole world is authored at WORLD_SCALE x its "natural" size (see
  // racing-server.js's own WORLD_SCALE) — every coordinate coming from the
  // server (checkpoints, landmarks, items, player x/y, trackWidth) is
  // already that big. Every literal "visual size" constant drawn here
  // (line widths, font sizes, marker radii) is multiplied by the same
  // factor so proportions relative to the road match exactly what they'd
  // be unscaled — only the camera below actually changes what fraction of
  // that bigger world is visible at once.
  const WORLD_SCALE = 8;

  // The map is now far too large to show all at once, so the canvas is a
  // fixed-size window (not sized to the map) that follows the local
  // player: drawTrack() re-centers on my own x/y every frame via a canvas
  // transform, and everything below still just draws at its raw world
  // coordinates — the transform handles turning that into "where on
  // screen". VIEWPORT_ROAD_WIDTHS is how many road-widths across the
  // window shows at once (bigger = more context/more zoomed out); tying it
  // to the current track's own trackWidth keeps the on-screen road width
  // (and therefore every proportionally-sized element) similar across all
  // 6 tracks despite their different trackWidth values.
  // The canvas's CSS (see #track-canvas/#track-wrap in racing.html) is the
  // single source of truth for its on-screen SIZE now -- #track-wrap is a
  // fixed 600x900 (2:3, matching the tracks' own portrait shape -- every
  // track's mapHeight is bigger than its mapWidth, see racing-server.js's
  // TRACKS) with 10px padding, so #track-canvas fills its 580x880 content
  // area exactly. These two just mirror whatever size the browser actually
  // rendered that box at (see syncCanvasResolution()) rather than
  // dictating it, so the backing store stays crisp (no upscaling blur, no
  // wasted oversampling). Defaults here (580x880, matching that CSS box)
  // only matter before the very first layout pass.
  let canvasPixelWidth = 580;
  let canvasPixelHeight = 880;
  // Eagerly matches the canvas's actual backing store (its width/height
  // ATTRIBUTES) to the fallback above right away, since renderGame() (see
  // render()) draws the very first countdown/racing frame BEFORE the
  // canvas's screen is un-hidden — at that instant getBoundingClientRect()
  // below still reads 0x0 and bails out, so without this the attributes
  // would be left at the browser's own default (300x150) while the
  // drawing math already assumes canvasPixelWidth/Height, badly
  // mismatched. Just keeps the two in sync at every point in time; the
  // real post-layout measurement corrects it to the CSS box's true size
  // the moment that screen actually becomes visible.
  canvas.width = canvasPixelWidth;
  canvas.height = canvasPixelHeight;
  // Reads the canvas element's actual rendered CSS box (post-layout) and
  // resizes its backing store (the width/height ATTRIBUTES, a completely
  // separate thing from its CSS box) to match 1:1 in device pixels, so
  // it's sharp on high-DPI screens without over- or under-sampling.
  // Skips a zero-size measurement (the canvas is briefly display:none
  // while its screen is hidden — see render()) rather than collapsing to
  // a 1x1 buffer for that one frame; the next real measurement corrects it.
  function syncCanvasResolution() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (w === canvasPixelWidth && h === canvasPixelHeight) return;
    canvasPixelWidth = w;
    canvasPixelHeight = h;
    canvas.width = w;
    canvas.height = h;
  }
  // A per-viewer preference (see the zoom buttons below), not a fixed
  // constant -- persisted in localStorage so it's remembered across
  // reloads/races on this browser, same as LAST_ROOM_KEY above. Defaults
  // to 8 (much wider than the old fixed value of 3) so more of the road
  // around the player is visible at once out of the box.
  const ZOOM_STORAGE_KEY = 'racing_viewport_road_widths';
  const ZOOM_OPTIONS = [3, 4, 5, 6, 8];
  let VIEWPORT_ROAD_WIDTHS = (() => {
    const saved = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
    return ZOOM_OPTIONS.includes(saved) ? saved : 8;
  })();
  // How much forward/backward visibility to guarantee, as a multiple of
  // the horizontal viewport width above -- kept as an EXPLICIT world-unit
  // target rather than just "whatever falls out of the canvas's pixel
  // width:height ratio" (that was the old behavior, and it quietly broke
  // when #track-wrap's CSS box got shorter: less canvas height left less
  // room to see an upcoming hairpin coming, so racers started slamming
  // into the barrier far more since they had far less warning). These
  // tracks are switchback climbs where seeing far AHEAD matters much more
  // than side-to-side margin, so this is intentionally generous (1.5x,
  // matching what the old 2:3-shaped canvas gave "for free" before);
  // drawTrack() below picks whichever zoom level satisfies BOTH this and
  // the horizontal target, so a short/wide canvas box can never silently
  // shrink how far ahead a racer can see.
  const VIEWPORT_HEIGHT_TO_WIDTH_RATIO = 1.5;
  // The viewport actually shown, in world units -- computed fresh in
  // drawTrack() every frame, then reused by drawMinimap() (which runs
  // right after it in renderGame()) so the little rectangle it draws
  // always matches the real camera exactly rather than recomputing its
  // own (and risking drifting out of sync with it).
  let lastViewportWidth = 0;
  let lastViewportHeight = 0;
  const zoomButtons = document.querySelectorAll('.zoom-btn');
  function renderZoomButtons() {
    zoomButtons.forEach((btn) => {
      btn.classList.toggle('selected', Number(btn.dataset.zoom) === VIEWPORT_ROAD_WIDTHS);
    });
  }
  zoomButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      VIEWPORT_ROAD_WIDTHS = Number(btn.dataset.zoom);
      localStorage.setItem(ZOOM_STORAGE_KEY, String(VIEWPORT_ROAD_WIDTHS));
      renderZoomButtons();
      // drawTrack()/drawMinimap() just read the variable above each time
      // they run, so a race in progress picks up the new zoom on its very
      // next state broadcast (~100ms) with no extra redraw call needed.
    });
  });
  renderZoomButtons();

  // Above this many racers, per-racer name labels on the canvas just
  // clutter it -- the live Standings list is the real way to read
  // placement at that scale (see renderStandings() below).
  const NAME_LABEL_THRESHOLD = 15;

  // Preloaded character portraits (each CHARACTERS entry's own `image`
  // path, see racing-server.js) -- the racer-drawing loop below draws the
  // actual uploaded artwork once it's loaded, falling back to the plain
  // `emoji` glyph (same fallback the waiting-room character picker's own
  // <img onerror> uses) until then or if it fails to load. Cached by
  // character key so each portrait file is only ever requested once no
  // matter how many racers (or state broadcasts) use it.
  const characterImageCache = {};
  function getCharacterImage(charDef) {
    if (!charDef || !charDef.image) return null;
    let entry = characterImageCache[charDef.key];
    if (!entry) {
      const img = new Image();
      entry = { img, loaded: false, failed: false };
      img.addEventListener('load', () => { entry.loaded = true; });
      img.addEventListener('error', () => { entry.failed = true; });
      img.src = encodeURI(charDef.image);
      characterImageCache[charDef.key] = entry;
    }
    return entry;
  }

  // A checkered start/finish band across the road at checkpoint 0, in place
  // of a plain dashed line — oriented along the road's local direction
  // there (perpendicular to travel) so it reads correctly regardless of
  // which way the road runs at that point.
  function drawFinishLine(state) {
    const pts = state.checkpoints;
    const c0 = pts[0];
    const prev = pts[pts.length - 1];
    const next = pts[1];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const dirX = dx / len;
    const dirY = dy / len;
    const perpX = -dirY;
    const perpY = dirX;
    const half = state.trackWidth / 2;
    const thickness = 16 * WORLD_SCALE;
    const cells = 8;
    for (let i = 0; i < cells; i++) {
      const s0 = -half + (2 * half * i) / cells;
      const s1 = -half + (2 * half * (i + 1)) / cells;
      ctx.fillStyle = i % 2 === 0 ? '#14161c' : '#eef1f6';
      ctx.beginPath();
      ctx.moveTo(c0.x + perpX * s0 - dirX * thickness / 2, c0.y + perpY * s0 - dirY * thickness / 2);
      ctx.lineTo(c0.x + perpX * s1 - dirX * thickness / 2, c0.y + perpY * s1 - dirY * thickness / 2);
      ctx.lineTo(c0.x + perpX * s1 + dirX * thickness / 2, c0.y + perpY * s1 + dirY * thickness / 2);
      ctx.lineTo(c0.x + perpX * s0 + dirX * thickness / 2, c0.y + perpY * s0 + dirY * thickness / 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Checkpoint markers — every checkpoint gets a numbered badge, so the
  // whole required sequence is visible on the map at a glance. MY OWN next
  // required checkpoint (computed the same way the server does, from my
  // own checkpointsPassed) is drawn larger with a glow, since that's the
  // one thing actually worth knowing mid-race: "where do I go next".
  function nextCheckpointIndexClient(checkpointsPassed, numCheckpoints) {
    return (checkpointsPassed + 1) % numCheckpoints;
  }

  function drawCheckpointMarkers(state) {
    const pts = state.checkpoints;
    const n = pts.length;
    const myPlayer = state.players.find((p) => p.id === me.id);
    const myNextIndex = (myPlayer && !myPlayer.finishedAt) ? nextCheckpointIndexClient(myPlayer.checkpointsPassed, n) : null;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    pts.forEach((pt, i) => {
      const isNext = i === myNextIndex;
      const radius = (isNext ? 20 : 13) * WORLD_SCALE;

      if (isNext) {
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255, 209, 102, 0.35)';
        ctx.arc(pt.x, pt.y, radius + 9 * WORLD_SCALE, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.fillStyle = isNext ? '#ffd166' : 'rgba(255,255,255,0.82)';
      ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2 * WORLD_SCALE;
      ctx.strokeStyle = 'rgba(20,22,28,0.6)';
      ctx.stroke();

      ctx.fillStyle = '#14161c';
      ctx.font = (isNext ? `bold ${15 * WORLD_SCALE}px` : `${11 * WORLD_SCALE}px`) + ' sans-serif';
      ctx.fillText(i === 0 ? '🏁' : String(i), pt.x, pt.y);
    });
  }

  function drawTrack(state) {
    syncCanvasResolution();

    // Camera: centered on my own position (falling back to the start/
    // finish line before I have one — e.g. the instant the countdown
    // begins). The viewport's WORLD-unit size is a multiple of the current
    // track's own trackWidth, so the road reads at a similar on-screen
    // width across all 6 tracks despite their different trackWidth values;
    // converting that to a zoom (screen px per world unit) and baking it
    // into the transform means every draw call below still just uses raw
    // world coordinates, completely unaware a camera exists.
    const myPlayer = state.players.find((p) => p.id === me.id);
    const camX = myPlayer ? myPlayer.x : state.checkpoints[0].x;
    const camY = myPlayer ? myPlayer.y : state.checkpoints[0].y;
    // Whichever axis needs MORE zoom-out to hit its own target wins, so
    // #track-wrap's exact CSS shape can only ever show MORE than these
    // targets (bonus context on the other axis), never less (see
    // VIEWPORT_HEIGHT_TO_WIDTH_RATIO's own comment above for why that
    // matters -- it's what silently broke forward visibility last time).
    const targetViewportWidth = state.trackWidth * VIEWPORT_ROAD_WIDTHS;
    const targetViewportHeight = targetViewportWidth * VIEWPORT_HEIGHT_TO_WIDTH_RATIO;
    const zoom = Math.min(canvasPixelWidth / targetViewportWidth, canvasPixelHeight / targetViewportHeight);
    lastViewportWidth = canvasPixelWidth / zoom;
    lastViewportHeight = canvasPixelHeight / zoom;

    ctx.save();
    ctx.setTransform(zoom, 0, 0, zoom, canvasPixelWidth / 2 - camX * zoom, canvasPixelHeight / 2 - camY * zoom);

    // Each track supplies its own left-to-right gradient (see TRACKS in
    // racing-server.js) — a loose color nod to that pass's real landscape
    // (e.g. mountain-green to sea-blue for Hải Vân, foggy blue-grey for the
    // high-altitude Ô Quy Hồ), not a literal map. Positioned in WORLD
    // coordinates (0..mapWidth) rather than canvas pixels, so it stays tied
    // to where you physically are on the pass as the camera pans, not to
    // the screen.
    const bg = ctx.createLinearGradient(0, 0, state.mapWidth, 0);
    bg.addColorStop(0, state.bgFrom || '#16321f');
    bg.addColorStop(1, state.bgTo || '#0d2b3d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, state.mapWidth, state.mapHeight);

    // Background scenery (trees/rocks/clouds, themed per track) — drawn
    // before the road so it always reads as sitting behind it.
    ctx.font = `${24 * WORLD_SCALE}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    (state.decorations || []).forEach((d) => ctx.fillText(d.emoji, d.x, d.y));

    const pts = state.checkpoints;
    const pathIt = () => {
      ctx.beginPath();
      pts.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
      ctx.closePath();
    };

    // Road-edge barrier + road surface: a "stroke twice at different
    // widths" outline trick — a wider stroke in the barrier color drawn
    // first, then the actual road width drawn on top in the road color,
    // leaving a uniform colored rim visible along both edges. This lets
    // the canvas API work out the join geometry for the WHOLE closed path
    // in one pass (round joins/caps, same as the road stroke itself),
    // instead of manually offsetting each segment — which produced ugly
    // overlaps and gaps right at the sharp hairpin joints this game uses.
    // The rim is the visual counterpart of the server's actual road-edge
    // collision (see closestPointOnLoop()/tick() in racing-server.js).
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const barrierRimWidth = 9 * WORLD_SCALE;
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = state.trackWidth + barrierRimWidth * 2;
    pathIt();
    ctx.stroke();

    ctx.strokeStyle = '#3a4152';
    ctx.lineWidth = state.trackWidth;
    pathIt();
    ctx.stroke();

    // Center dashed line.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 3 * WORLD_SCALE;
    ctx.setLineDash([14 * WORLD_SCALE, 14 * WORLD_SCALE]);
    pathIt();
    ctx.stroke();
    ctx.setLineDash([]);

    drawFinishLine(state);
    drawCheckpointMarkers(state);

    // Landmark labels (Đà Nẵng, Hải Vân Quan, Lăng Cô) — flavor only, no
    // gameplay effect.
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${16 * WORLD_SCALE}px sans-serif`;
    ctx.fillStyle = '#eef1f6';
    (state.landmarks || []).forEach((l) => ctx.fillText(`${l.icon} ${l.label}`, l.x, l.y));

    // 🕳️ Potholes -- static road hazards (see racing-server.js's
    // buildPotholes()), never removed, unlike items. Drawn right on the
    // road surface, same layer as the checkpoint markers below.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${20 * WORLD_SCALE}px sans-serif`;
    (state.potholes || []).forEach((h) => ctx.fillText('🕳️', h.x, h.y));

    // Items are granted straight into a racer's own inventory the instant
    // they cross a checkpoint (see racing-server.js's grantRandomItem()) --
    // there's no separate pickup object on the map to draw here. Restore
    // center/middle alignment (the landmark labels above just left it at
    // start/alphabetic) for the racer emoji drawn next.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Racers.
    const showNames = state.players.length <= NAME_LABEL_THRESHOLD;
    state.players.forEach((p) => {
      const charDef = (state.characters && p.character && state.characters[p.character]) || null;
      const emoji = charDef ? charDef.emoji : '🏃';
      const isMe = p.id === me.id;

      // Shrunk from 28/22 -- smaller than a plain zoom-out alone would give,
      // so racers take up noticeably less of the wider view above and more
      // of the actual road stays visible around them.
      if (p.maxGasActive) {
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255, 209, 102, 0.35)';
        ctx.arc(p.x, p.y, 16 * WORLD_SCALE, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p.shieldActive) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(91, 140, 255, 0.85)';
        ctx.lineWidth = 2.5 * WORLD_SCALE;
        ctx.arc(p.x, p.y, 15 * WORLD_SCALE, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (p.stunned) {
        ctx.beginPath();
        ctx.fillStyle = 'rgba(120, 120, 130, 0.45)';
        ctx.arc(p.x, p.y, 16 * WORLD_SCALE, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p.repairing) {
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255, 159, 90, 0.45)';
        ctx.arc(p.x, p.y, 16 * WORLD_SCALE, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.damage > 0) {
        // Partial arc (not a full ring) showing damage as a fraction of
        // the circle, same idea as a health/fuel gauge -- green at low
        // damage fading to red as it climbs toward the 100% wreck point.
        ctx.beginPath();
        ctx.strokeStyle = `hsl(${Math.round(120 - (p.damage / 100) * 120)}, 80%, 55%)`;
        ctx.lineWidth = 2 * WORLD_SCALE;
        ctx.arc(p.x, p.y, 14 * WORLD_SCALE, -Math.PI / 2, -Math.PI / 2 + (p.damage / 100) * Math.PI * 2);
        ctx.stroke();
      }

      const markerSize = (isMe ? 20 : 16) * WORLD_SCALE;
      const imgEntry = getCharacterImage(charDef);
      if (imgEntry && imgEntry.loaded && !imgEntry.failed) {
        // "Contain" fit within a markerSize x markerSize box, same idea as
        // the character picker's own `object-fit: contain` -- these
        // portraits are taller than they are wide, so drawing at a fixed
        // square would squash them.
        const scale = Math.min(markerSize / imgEntry.img.naturalWidth, markerSize / imgEntry.img.naturalHeight);
        const w = imgEntry.img.naturalWidth * scale;
        const h = imgEntry.img.naturalHeight * scale;
        ctx.drawImage(imgEntry.img, p.x - w / 2, p.y - h / 2, w, h);
      } else {
        ctx.font = `${markerSize}px sans-serif`;
        ctx.fillText(emoji, p.x, p.y);
      }
      if (p.stunned) {
        ctx.font = `${12 * WORLD_SCALE}px sans-serif`;
        ctx.fillText('💫', p.x + 12 * WORLD_SCALE, p.y - 12 * WORLD_SCALE);
      }
      if (p.repairing) {
        ctx.font = `${12 * WORLD_SCALE}px sans-serif`;
        ctx.fillText('🔧', p.x + 12 * WORLD_SCALE, p.y - 12 * WORLD_SCALE);
      }

      if (showNames || isMe) {
        ctx.font = `${9 * WORLD_SCALE}px sans-serif`;
        ctx.fillStyle = isMe ? '#ffd166' : '#eef1f6';
        ctx.fillText(p.name, p.x, p.y - 15 * WORLD_SCALE);
      }
    });

    ctx.restore();
  }

  // --- Minimap --------------------------------------------------------
  // The camera above only shows a small local window, so this is the only
  // place a player can see the WHOLE track, where they sit on it, and
  // which way the route goes next — a small fixed-size overview canvas
  // (see #minimap-canvas in racing.html), scaled independently of the main
  // view. Highlights my own position and next checkpoint, plus a rectangle
  // showing exactly what the main camera currently frames.
  const minimapCanvas = document.getElementById('minimap-canvas');
  const mctx = minimapCanvas.getContext('2d');
  const MINIMAP_WIDTH = 130;

  function drawMinimap(state) {
    const w = MINIMAP_WIDTH;
    const h = Math.round(w * (state.mapHeight / state.mapWidth));
    minimapCanvas.width = w;
    minimapCanvas.height = h;
    const sx = w / state.mapWidth;
    const sy = h / state.mapHeight;

    mctx.fillStyle = 'rgba(10, 12, 18, 0.85)';
    mctx.fillRect(0, 0, w, h);

    // Road outline (thin — this is an overview, not a playable view).
    mctx.strokeStyle = 'rgba(255,255,255,0.55)';
    mctx.lineWidth = 2;
    mctx.beginPath();
    state.checkpoints.forEach((pt, i) => {
      const x = pt.x * sx;
      const y = pt.y * sy;
      if (i === 0) mctx.moveTo(x, y); else mctx.lineTo(x, y);
    });
    mctx.closePath();
    mctx.stroke();

    const myPlayer = state.players.find((p) => p.id === me.id);

    // My own next checkpoint, highlighted the same gold as on the main view.
    if (myPlayer && !myPlayer.finishedAt) {
      const target = state.checkpoints[nextCheckpointIndexClient(myPlayer.checkpointsPassed, state.numCheckpoints)];
      mctx.beginPath();
      mctx.fillStyle = '#ffd166';
      mctx.arc(target.x * sx, target.y * sy, 4, 0, Math.PI * 2);
      mctx.fill();
    }

    // The main camera's current viewport, so "where am I looking" maps
    // onto "where am I on the whole track". Reuses the exact width/height
    // drawTrack() just computed (see lastViewportWidth/Height's own
    // comment) rather than re-deriving it here, so this can never drift
    // out of sync with what the main view is actually showing.
    if (myPlayer) {
      mctx.strokeStyle = 'rgba(255,255,255,0.55)';
      mctx.lineWidth = 1;
      mctx.strokeRect(
        (myPlayer.x - lastViewportWidth / 2) * sx,
        (myPlayer.y - lastViewportHeight / 2) * sy,
        lastViewportWidth * sx,
        lastViewportHeight * sy,
      );
    }

    // Every racer as a small dot — me distinct and bigger.
    state.players.forEach((p) => {
      const isMe = p.id === me.id;
      mctx.beginPath();
      mctx.fillStyle = isMe ? '#5b8cff' : 'rgba(255,255,255,0.75)';
      mctx.arc(p.x * sx, p.y * sy, isMe ? 3.5 : 2, 0, Math.PI * 2);
      mctx.fill();
    });
  }

  // Live-ranked standings -- deliberately just rank + name now (see
  // #standings-mini in racing.html): the point of a race screen is the
  // road, not a scoreboard, so this sits tucked under the zoom control
  // rather than as its own full card. Rebuilding these rows on every
  // single state broadcast (10/sec) is needless DOM churn, so this
  // throttles to 4/sec; pass force=true to bypass that for a state
  // transition the player should see immediately (e.g. the moment the
  // countdown starts).
  const standingsMiniEl = document.getElementById('standings-mini');
  let lastStandingsRenderAt = 0;
  function renderStandings(state, force) {
    const now = Date.now();
    if (!force && now - lastStandingsRenderAt < 250) return;
    lastStandingsRenderAt = now;

    const ranked = [...state.players].sort((a, b) => {
      if (a.finishedAt && b.finishedAt) return a.finishRank - b.finishRank;
      if (a.finishedAt) return -1;
      if (b.finishedAt) return 1;
      return (b.progress || 0) - (a.progress || 0);
    });

    standingsMiniEl.innerHTML = '';
    ranked.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'standings-mini-row' + (p.id === me.id ? ' me' : '');

      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = `${idx + 1}.`;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name + (p.id === me.id ? ' (You)' : '');

      row.append(rank, name);
      standingsMiniEl.appendChild(row);
    });
  }

  function renderCountdown(state) {
    if (state.status === 'countdown' && state.raceStartsAt) {
      const remaining = state.raceStartsAt - Date.now();
      countdownEl.textContent = remaining > 0 ? String(Math.ceil(remaining / 1000)) : 'GO!';
      countdownEl.classList.remove('hidden');
    } else {
      countdownEl.classList.add('hidden');
    }
  }

  const trackBannerEl = document.getElementById('track-banner');
  const checkpointHintEl = document.getElementById('checkpoint-hint');
  function renderCheckpointHint(state) {
    const myPlayer = state.players.find((p) => p.id === me.id);
    if (!myPlayer) { checkpointHintEl.textContent = ''; return; }
    if (myPlayer.finishedAt) { checkpointHintEl.textContent = `🏆 You finished #${myPlayer.finishRank}!`; return; }
    const nextIndex = nextCheckpointIndexClient(myPlayer.checkpointsPassed, state.numCheckpoints);
    const target = nextIndex === 0
      ? `back to the 🏁 finish line to complete lap ${myPlayer.lap}/${state.lapsToWin}`
      : `checkpoint #${nextIndex} (highlighted gold on the map)`;
    checkpointHintEl.textContent = `🚩 Head to ${target} · Lap ${myPlayer.lap}/${state.lapsToWin}`;
  }

  // Gas gauge + the 3 item-use buttons -- driven entirely by MY OWN player
  // entry in the latest state broadcast (gas/inventory), not local
  // optimistic state, so it always reflects what the server actually thinks
  // I'm holding.
  // Must match racing-server.js's own MAX_SPEED_KMH -- only used here to
  // turn the server-computed speedKmh into the gauge's fill percentage.
  const MAX_SPEED_KMH = 400;
  function renderControls(state) {
    const myPlayer = state.players.find((p) => p.id === me.id);
    const speedKmh = myPlayer ? myPlayer.speedKmh : 0;
    gasGaugeFillEl.style.width = `${Math.round(Math.max(0, Math.min(1, speedKmh / MAX_SPEED_KMH)) * 100)}%`;
    speedValueEl.textContent = `${speedKmh} km/h`;

    const damage = myPlayer ? myPlayer.damage : 0;
    damageGaugeFillEl.style.width = `${Math.round(Math.max(0, Math.min(100, damage)))}%`;
    damageValueEl.textContent = `${damage}%`;

    const repairing = Boolean(myPlayer && myPlayer.repairing);
    repairBannerEl.classList.toggle('hidden', !repairing);
    if (repairing) repairSecondsEl.textContent = String(myPlayer.repairSecondsLeft);

    const inventory = (myPlayer && myPlayer.inventory) || { maxGas: 0, stun: 0, shield: 0 };
    Object.keys(itemButtons).forEach((type) => {
      const btn = itemButtons[type];
      const count = inventory[type] || 0;
      btn.querySelector('.item-count').textContent = String(count);
      btn.disabled = count <= 0 || !myPlayer || Boolean(myPlayer.finishedAt) || repairing;
    });

    // While a 🛡️ shield is active, show the countdown in place of the
    // held count -- the shield button is otherwise the only place a
    // player can see this text-wise (the canvas ring around their own
    // racer is easy to miss while looking at this corner HUD instead).
    const shieldActive = Boolean(myPlayer && myPlayer.shieldActive);
    itemButtons.shield.classList.toggle('active', shieldActive);
    if (shieldActive) itemButtons.shield.querySelector('.item-count').textContent = `${myPlayer.shieldSecondsLeft}s`;
  }

  function renderGame(state) {
    trackBannerEl.textContent = `🏔️ ${state.trackLabel}`;
    drawTrack(state);
    drawMinimap(state);
    renderCountdown(state);
    renderCheckpointHint(state);
    renderStandings(state, state.status === 'countdown');
    renderControls(state);
    renderLog(gameLogEl, state.log);
  }

  function renderFinished(state) {
    winnerTextEl.textContent = `${state.trackLabel ? `🏔️ ${state.trackLabel}\n` : ''}${state.resultText || 'Race over.'}`;
    scoreListEl.innerHTML = '';
    const order = state.finalRanking && state.finalRanking.length
      ? state.finalRanking.map((id) => state.players.find((p) => p.id === id)).filter(Boolean)
      : state.players;
    order.forEach((p, i) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${i === 0 && p.finishedAt ? '🏆 ' : ''}${p.name}${p.id === me.id ? ' (You)' : ''}`;
      const detail = document.createElement('span');
      if (p.finishedAt) {
        const seconds = state.raceStartedAt ? ((p.finishedAt - state.raceStartedAt) / 1000).toFixed(2) : '?';
        detail.textContent = `#${p.finishRank} · ${seconds}s`;
      } else {
        detail.className = 'dnf';
        detail.textContent = `DNF · Lap ${p.lap}/${state.lapsToWin}`;
      }
      li.append(label, detail);
      scoreListEl.appendChild(li);
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
    } else if (latestState.status === 'countdown' || latestState.status === 'racing') {
      renderGame(latestState);
      showScreen('playing');
    } else if (latestState.status === 'finished') {
      renderFinished(latestState);
      showScreen('finished');
    }
  }

  // Redraw the countdown at a steady local rate too, so the "3-2-1" ticks
  // down smoothly between server broadcasts instead of jumping only once
  // every TICK_MS.
  setInterval(() => {
    if (joined && latestState && (latestState.status === 'countdown' || latestState.status === 'racing')) {
      renderCountdown(latestState);
    }
  }, 100);

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
    socket.emit('racing:listRooms', {}, (res) => {
      if (res && res.ok) latestRooms = res.rooms;
      render();
    });
  }

  let pendingJoinRoomId = null;
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
    socket.emit('racing:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
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
          'game-in-progress': 'That room already started a race.',
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
    socket.emit('racing:createRoom', { roomName, password, playerId: me.id, name: me.name }, (res) => {
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
    socket.emit('racing:addBots', { count: 3 }, (res) => {
      if (!res || !res.ok) alert('Could not add bots: ' + ((res && res.error) || 'unknown error'));
    });
  });
  addManyBotsBtn.addEventListener('click', () => {
    // Requests more than MAX_PLAYERS could ever hold -- the server clamps
    // to whatever's actually left, so this is really "fill the room".
    socket.emit('racing:addBots', { count: MAX_PLAYERS }, (res) => {
      if (!res || !res.ok) alert('Could not add bots: ' + ((res && res.error) || 'unknown error'));
    });
  });
  startBtn.addEventListener('click', () => socket.emit('racing:start'));
  newGameBtn.addEventListener('click', () => socket.emit('racing:newGame'));
  leaveWaitingBtn.addEventListener('click', () => { socket.emit('racing:leave'); backToLobby(); });
  leaveBtn.addEventListener('click', () => { socket.emit('racing:leave'); backToLobby(); });

  // Hint/Log start collapsed (see the "hidden" class on their own elements
  // in racing.html) so the default in-race view is just the road -- click
  // either button to expand it on demand.
  hintToggleBtn.addEventListener('click', () => {
    const nowHidden = hintTextEl.classList.toggle('hidden');
    hintToggleBtn.classList.toggle('active', !nowHidden);
  });
  logToggleBtn.addEventListener('click', () => {
    const nowHidden = gameLogEl.classList.toggle('hidden');
    logToggleBtn.classList.toggle('active', !nowHidden);
  });

  function myPlayerFinished() {
    const mp = latestState && latestState.players.find((p) => p.id === me.id);
    return Boolean(mp && mp.finishedAt);
  }

  // --- Steering input: WASD / Arrow Keys (desktop) ------------------------
  const MOVE_KEYS = {
    w: { x: 0, y: -1 }, ArrowUp: { x: 0, y: -1 },
    s: { x: 0, y: 1 }, ArrowDown: { x: 0, y: 1 },
    a: { x: -1, y: 0 }, ArrowLeft: { x: -1, y: 0 },
    d: { x: 1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  };
  const pressedKeys = new Set();
  let lastSentDir = { x: 0, y: 0 };
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
      socket.emit('racing:input', { dx: dir.x, dy: dir.y });
    }
  }
  window.addEventListener('keydown', (e) => {
    if (!MOVE_KEYS[e.key] || !latestState || latestState.status !== 'racing') return;
    if (myPlayerFinished()) return;
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

  // --- Steering input: drag joystick, for touch devices with no ----------
  // keyboard (see #mobile-joystick in racing.html -- shown only under
  // `@media (pointer: coarse)`, i.e. touch-primary devices). A floating
  // analog stick, not discrete directions: the sent vector's magnitude
  // scales with how far the thumb is dragged from center (capped at 1),
  // and setPlayerInput() server-side trusts a sub-1 magnitude as-is instead
  // of renormalizing it to full speed -- so this is genuinely variable-speed,
  // unlike the keyboard's always-full-speed unit vectors. Mirrors
  // nien.js's own joystick implementation.
  const JOYSTICK_RADIUS_PX = 46; // matches #mobile-joystick's own CSS radius
  let joystickPointerId = null;
  let lastJoystickDir = { x: 0, y: 0 };
  function sendJoystickDir(x, y) {
    if (x === lastJoystickDir.x && y === lastJoystickDir.y) return;
    lastJoystickDir = { x, y };
    socket.emit('racing:input', { dx: x, dy: y });
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
    if (!latestState || latestState.status !== 'racing' || myPlayerFinished()) { sendJoystickDir(0, 0); return; }
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

  // --- Gas control: a single held/released control -- Shift (desktop) or --
  // the ⛽ GAS button (mouse or touch), same "hold it down" spirit as the
  // joystick above. Held sends true (speed climbs); released sends false
  // (speed coasts back down) -- there's no separate brake input, matching
  // racing-server.js's setGasHeld()/SPEED_BANDS, which do the actual
  // accelerating/decelerating. The `.held` class gives instant visual
  // feedback locally rather than waiting on a state-broadcast round trip.
  let lastSentGasHeld = false;
  function sendGasHeldIfChanged(held) {
    gasBtn.classList.toggle('held', held);
    if (held === lastSentGasHeld) return;
    lastSentGasHeld = held;
    socket.emit('racing:gasInput', { held });
  }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift') return;
    if (!latestState || latestState.status !== 'racing' || myPlayerFinished()) return;
    sendGasHeldIfChanged(true);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Shift') return;
    sendGasHeldIfChanged(false);
  });
  window.addEventListener('blur', () => sendGasHeldIfChanged(false));
  gasBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!latestState || latestState.status !== 'racing' || myPlayerFinished()) return;
    sendGasHeldIfChanged(true);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => {
    gasBtn.addEventListener(evt, () => sendGasHeldIfChanged(false));
  });

  // --- Item-use buttons: spend one held item of that type (see -----------
  // racing-server.js's useItem()) -- plain clicks, disabled by
  // renderControls() whenever the inventory count for that type is 0.
  Object.keys(itemButtons).forEach((type) => {
    itemButtons[type].addEventListener('click', () => {
      socket.emit('racing:useItem', { type }, (res) => {
        if (res && !res.ok && res.error === 'no-target') {
          alert('No one to stun right now — try again once you have rivals nearby.');
        }
      });
    });
  });

  socket.on('racing:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('racing:state', (state) => {
    latestState = state;
    if (state.players.some((p) => p.id === me.id)) joined = true;
    render();
  });

  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('racing:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('racing:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
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
}
