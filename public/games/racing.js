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
    // Near-layer only here -- this preview is tiny (260px), and with
    // decoration counts roughly doubled for richness in the main views
    // (see racing-server.js's scatterDecorations()), drawing the sparser
    // far layer too would just be noise at this scale.
    (state.decorations || []).forEach((d) => {
      if (d.layer === 'far') return;
      tpctx.fillText(d.emoji, d.x * sx, d.y * sy);
    });

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
  // reloads/races on this browser, same as LAST_ROOM_KEY above. Used to be
  // "how many road-widths across" the old straight-down camera showed;
  // now (see cameraParams() below) it's "how far back/how far ahead" the
  // 2.5D chase-cam sits -- same knob, same UI, just repurposed for the
  // new camera model. Defaults to 8 (wide/far) so there's plenty of
  // forward visibility out of the box.
  const ZOOM_STORAGE_KEY = 'racing_viewport_road_widths';
  const ZOOM_OPTIONS = [3, 4, 5, 6, 8];
  let VIEWPORT_ROAD_WIDTHS = (() => {
    const saved = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
    return ZOOM_OPTIONS.includes(saved) ? saved : 8;
  })();
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

  // Which camera to draw with -- a per-viewer preference (same pattern as
  // the zoom control above), not a room-wide setting: there's no "host"
  // with special authority anywhere else in this game (see
  // racing-server.js's own "host-less lobby" comments), and different
  // players may honestly want different views, so each browser remembers
  // its own pick.
  //   '2d'    -- the original straight-down camera: no rotation, no
  //              perspective, easiest to read, most context at once.
  //   '2.25d' -- a forward-facing chase-cam like '2.5d' (rotates with your
  //              own heading, see currentHeadingAngle()), but tilted down
  //              at a real pitch angle (see cameraParams()'s own
  //              VIEW_MODE_PITCH_DEG) rather than looking dead level --
  //              the ground climbs toward the top of the screen much
  //              faster than in '2.5d', reading as a genuinely higher,
  //              more overhead angle rather than just a more zoomed-out
  //              version of the same view.
  //   '2.5d'  -- the low, close-behind chase-cam (pitch 0, dead level):
  //              the most "in the driver's seat" feel, but the narrowest
  //              peripheral view and the most severe foreshortening.
  const VIEW_MODE_STORAGE_KEY = 'racing_view_mode';
  const VIEW_MODES = ['2d', '2.25d', '2.5d'];
  let viewMode = (() => {
    const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return VIEW_MODES.includes(saved) ? saved : '2.25d';
  })();
  const viewModeButtons = document.querySelectorAll('.view-mode-btn');
  function renderViewModeButtons() {
    viewModeButtons.forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.viewMode === viewMode);
    });
  }
  viewModeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.viewMode;
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
      renderViewModeButtons();
    });
  });
  renderViewModeButtons();
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

  // A small procedurally-speckled tile, cached per base color and reused
  // as a repeating ctx.createPattern() fill instead of a single flat
  // color -- turns the "off-road, can't drive here" ground into something
  // that reads as actual terrain (grass/dirt/rock grain) rather than a
  // plain block of color, in both the top-down and forward-facing views.
  // Speckle positions are seeded FROM the base color string (a simple
  // additive char-code hash feeding a linear-congruential PRNG) so the
  // exact same color always produces the exact same tile -- deterministic
  // rather than reshuffling every time a track's colors happen to repeat.
  const groundPatternCache = new Map();
  function getGroundPattern(baseColor) {
    let pattern = groundPatternCache.get(baseColor);
    if (pattern) return pattern;
    const tile = document.createElement('canvas');
    tile.width = 64;
    tile.height = 64;
    const tctx = tile.getContext('2d');
    tctx.fillStyle = baseColor;
    tctx.fillRect(0, 0, 64, 64);
    let seed = 1;
    for (let i = 0; i < baseColor.length; i++) seed = (seed * 31 + baseColor.charCodeAt(i)) % 233280;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < 90; i++) {
      tctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';
      tctx.beginPath();
      tctx.arc(rand() * 64, rand() * 64, 1 + rand() * 2, 0, Math.PI * 2);
      tctx.fill();
    }
    pattern = ctx.createPattern(tile, 'repeat');
    groundPatternCache.set(baseColor, pattern);
    return pattern;
  }

  // A deterministic (seeded by track key, so it never flickers/reshuffles
  // between frames) jagged silhouette drawn just above the horizon in the
  // forward-facing views -- breaks up what would otherwise be a flat sky
  // gradient with a bit of distant-mountain atmosphere.
  function drawHorizonSilhouette(state, horizonY) {
    let seed = 1;
    const key = state.trackKey || '';
    for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) % 233280;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const segments = 16;
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    for (let i = 0; i <= segments; i++) {
      const x = (canvasPixelWidth / segments) * i;
      ctx.lineTo(x, horizonY - 8 - rand() * 30);
    }
    ctx.lineTo(canvasPixelWidth, horizonY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(10, 14, 22, 0.35)';
    ctx.fill();
  }

  // --- 2.5D chase-cam rendering -------------------------------------------
  // Replaces the old straight-down orthographic camera: the camera now
  // sits BEHIND the player (opposite their own current heading -- see
  // currentHeadingAngle()) and looks FORWARD along it, projecting the flat
  // 2D world with simple similar-triangles perspective (closer = bigger
  // and lower on screen, farther = smaller and closer to the horizon) --
  // classic OutRun/Pole Position style, plain trigonometry, no WebGL.
  // Ground-plane things that are actually PAINTED ON the road (the road
  // surface itself, the finish-line band) are projected corner-by-corner
  // for correct trapezoidal foreshortening; everything else (checkpoints,
  // potholes, racers, decorations) is drawn as a camera-facing "billboard"
  // sprite -- scaled by distance but never rotated/sheared -- the standard
  // simplification this whole pseudo-3D genre uses for anything that
  // isn't the ground. Landmark text labels are dropped entirely in this
  // view (illegible at an angle/distance); they're still on the minimap
  // and the waiting-room track preview.

  // Heading comes from the player's own `moveDir` (see racing-server.js's
  // tick() -- the same heading that already drives movement inertia)
  // rather than the road's own tangent, so the camera turns exactly the
  // way the player is actually facing/moving -- no gameplay changes, this
  // is purely a different way of drawing the same free-2D-steering world.
  // Falls back to facing checkpoint 1 from the start line before there's
  // ever been real movement to derive a heading from (moveDir starts at
  // {0,0}), and otherwise just keeps the LAST known heading rather than
  // snapping back to that fallback the moment a racer briefly lets go of
  // every key (moveDir decays toward {0,0} but a small residual magnitude
  // isn't trustworthy enough to derive a heading from -- see the 0.05
  // threshold below).
  let lastHeadingAngle = null;
  function currentHeadingAngle(state, myPlayer) {
    if (myPlayer && myPlayer.moveDir) {
      const mag = Math.hypot(myPlayer.moveDir.x, myPlayer.moveDir.y);
      if (mag > 0.05) lastHeadingAngle = Math.atan2(myPlayer.moveDir.y, myPlayer.moveDir.x);
    }
    if (lastHeadingAngle === null) {
      const cp0 = state.checkpoints[0];
      const cp1 = state.checkpoints[1];
      lastHeadingAngle = Math.atan2(cp1.y - cp0.y, cp1.x - cp0.x);
    }
    return lastHeadingAngle;
  }

  // Fixed compositional choices: where the horizon sits, and where the
  // player's own car (always exactly at the camera's reference depth)
  // lands on screen. Everything ELSE (how far back the camera sits, its
  // focal length) is DERIVED from these plus the current track's own
  // trackWidth and the canvas's actual pixel size (see cameraParams()),
  // rather than hand-picked world-unit constants, so the framing stays
  // consistent across all 6 tracks and any canvas size.
  const HORIZON_FRAC = 0.38;
  const REFERENCE_Y_FRAC = 0.85;
  const ROAD_SCREEN_WIDTH_FRAC = 0.8; // road spans this much of canvas width at the closest point
  const NEAR_CLIP = 30 * WORLD_SCALE; // world units in front of the camera EYE; closer is culled rather than blown up toward infinity
  const MIN_SPRITE_SCALE = 0.035; // below this, a billboard is too small/far to bother drawing

  // cameraBack (how far behind the player the camera eye sits, measured
  // along the GROUND) scales with the current track's own trackWidth (so
  // the road reads at a similar on-screen width across all 6 tracks) and
  // with VIEWPORT_ROAD_WIDTHS -- the same corner zoom buttons that used to
  // size the old top-down window.
  //
  // '2.25d' vs '2.5d' differ in PITCH -- how far the camera physically
  // tilts down from looking dead-level ('2.5d' uses pitch=0, an
  // eye-level chase-cam) toward looking down at the ground from above
  // ('2.25d' tilts noticeably further). This isn't just "further back and
  // still flat" (that was tried first -- it only stretched the same curve
  // without changing its shape, which is why the two views looked nearly
  // identical): tilting the camera itself changes how quickly the ground
  // climbs toward the top of the screen as it recedes, which is what
  // actually reads as "a different camera angle" rather than "the same
  // view, zoomed." cameraHeight is solved FROM the desired pitch (plus the
  // same close-up framing targets as before) rather than picked directly,
  // so both modes still frame the player's own car identically -- only
  // what happens further out differs.
  const VIEW_MODE_PITCH_DEG = { '2.25d': 18, '2.5d': 0 };
  function cameraParams(state, mode) {
    const pitch = (VIEW_MODE_PITCH_DEG[mode] || 0) * Math.PI / 180;
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const cameraBack = state.trackWidth * (VIEWPORT_ROAD_WIDTHS / 4);
    const scaleAtReference = (ROAD_SCREEN_WIDTH_FRAC * canvasPixelWidth) / state.trackWidth;
    // Solved so the player's own car (ahead=0) still lands at exactly
    // REFERENCE_Y_FRAC down the screen regardless of pitch -- see the
    // derivation in this file's own history/commit notes if this ever
    // needs revisiting; the short version is cameraHeight has to grow
    // with tan(pitch) to compensate for the tilt.
    const cameraHeight = ((REFERENCE_Y_FRAC - HORIZON_FRAC) * canvasPixelHeight) / (scaleAtReference * cosPitch) + cameraBack * Math.tan(pitch);
    const viewDepthSelf = cameraBack * cosPitch + cameraHeight * sinPitch;
    const focal = scaleAtReference * viewDepthSelf;
    return { cameraBack, cameraHeight, focal, cosPitch, sinPitch };
  }

  // Projects one world point into screen space given the camera's own
  // position + heading (pre-split into cosH/sinH so a whole frame's worth
  // of calls -- a few hundred -- don't each recompute the same two trig
  // calls) + params -- null if the point is behind (or right on top of)
  // the camera EYE, so callers can just skip drawing it. `cam`'s own pitch
  // (baked into cosPitch/sinPitch, see cameraParams()) tilts the view
  // vertically; at pitch=0 this collapses to the plain "camera at a fixed
  // height, looking dead level" formula '2.5d' has always used.
  function projectPoint(wx, wy, camX, camY, cosH, sinH, cam) {
    const relX = wx - camX;
    const relY = wy - camY;
    const groundForward = relX * cosH + relY * sinH; // + = ahead of the player, along the ground
    const lateral = relX * -sinH + relY * cosH; // + = to the player's right (pitch doesn't affect this)
    const camGroundForward = groundForward + cam.cameraBack; // ground distance from the camera EYE
    const viewDepth = camGroundForward * cam.cosPitch + cam.cameraHeight * cam.sinPitch;
    if (viewDepth <= NEAR_CLIP) return null;
    const viewHeight = camGroundForward * cam.sinPitch - cam.cameraHeight * cam.cosPitch;
    const scale = cam.focal / viewDepth;
    return {
      x: canvasPixelWidth / 2 + lateral * scale,
      y: HORIZON_FRAC * canvasPixelHeight - viewHeight * scale,
      scale,
      camDepth: viewDepth,
    };
  }

  // Draws a "billboard" sprite: translates + uniformly scales the canvas
  // to `proj`'s screen position/scale, then runs `drawFn` using plain
  // WORLD-unit coordinates relative to (0,0) -- so every per-object draw
  // call below stays nearly identical to how the old top-down camera drew
  // things relative to their own raw world position, just re-based around
  // a local origin. Never rotated to face the camera's heading (a
  // billboard always faces the viewer square-on).
  function drawBillboard(proj, drawFn) {
    ctx.save();
    ctx.translate(proj.x, proj.y);
    ctx.scale(proj.scale, proj.scale);
    drawFn();
    ctx.restore();
  }

  // Closest point to `p` on the closed loop, like racing-server.js's own
  // closestPointOnLoop(), but also returns WHICH segment and how far along
  // it (0..1) -- needed to then walk further along the road from that
  // point (see walkAlongLoop()) to sample the strip ahead.
  function closestPointOnLoopWithSegment(p, checkpoints) {
    let best = null;
    let bestDist = Infinity;
    let bestSeg = 0;
    let bestT = 0;
    const n = checkpoints.length;
    for (let i = 0; i < n; i++) {
      const a = checkpoints[i];
      const b = checkpoints[(i + 1) % n];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby;
      let t = lenSq > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + abx * t;
      const cy = a.y + aby * t;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bestDist) { bestDist = d; best = { x: cx, y: cy }; bestSeg = i; bestT = t; }
    }
    return { point: best, dist: bestDist, segIndex: bestSeg, t: bestT };
  }

  // Walks `arcLen` world units (either direction) along the loop from a
  // {segIndex, t} position, crossing segment boundaries (and wrapping
  // around the loop's seam) as needed, returning the new position AND the
  // local tangent direction there -- used to sample a "ribbon" of
  // road-edge points following the road's actual path (curves included),
  // independent of which way the camera itself happens to be facing.
  function walkAlongLoop(checkpoints, segIndex, t, arcLen) {
    const n = checkpoints.length;
    let seg = segIndex;
    let tt = t;
    let remaining = Math.abs(arcLen);
    const dir = arcLen >= 0 ? 1 : -1;
    let guard = 0;
    while (remaining > 0 && guard < n * 4) {
      guard++;
      const a = checkpoints[seg];
      const b = checkpoints[(seg + 1) % n];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      if (dir > 0) {
        const remainingOnSeg = (1 - tt) * segLen;
        if (remainingOnSeg >= remaining) { tt += remaining / segLen; remaining = 0; }
        else { remaining -= remainingOnSeg; seg = (seg + 1) % n; tt = 0; }
      } else {
        const remainingOnSeg = tt * segLen;
        if (remainingOnSeg >= remaining) { tt -= remaining / segLen; remaining = 0; }
        else { remaining -= remainingOnSeg; seg = (seg - 1 + n) % n; tt = 1; }
      }
    }
    const a = checkpoints[seg];
    const b = checkpoints[(seg + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: a.x + dx * tt, y: a.y + dy * tt, tangentX: dx / len, tangentY: dy / len };
  }

  const ROAD_SAMPLE_STEP = 24 * WORLD_SCALE; // world units between consecutive road-ribbon rings
  const ROAD_SAMPLES_AHEAD = 60;
  const ROAD_SAMPLES_BEHIND = 4;

  // A checkered start/finish band across the road at checkpoint 0 --
  // computed the same way as the old top-down version, but each of its 4
  // corners per cell is projected INDIVIDUALLY (not drawn as a billboard)
  // so the band gets correct flat-ground perspective foreshortening,
  // matching the road surface it's painted on. Silently skipped if any
  // corner falls behind the camera -- it simply pops into view once fully
  // in front of it.
  function drawFinishLine(state, camX, camY, cosH, sinH, cam) {
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
      const corners = [
        [c0.x + perpX * s0 - dirX * thickness / 2, c0.y + perpY * s0 - dirY * thickness / 2],
        [c0.x + perpX * s1 - dirX * thickness / 2, c0.y + perpY * s1 - dirY * thickness / 2],
        [c0.x + perpX * s1 + dirX * thickness / 2, c0.y + perpY * s1 + dirY * thickness / 2],
        [c0.x + perpX * s0 + dirX * thickness / 2, c0.y + perpY * s0 + dirY * thickness / 2],
      ].map(([wx, wy]) => projectPoint(wx, wy, camX, camY, cosH, sinH, cam));
      if (corners.some((c) => !c)) continue;
      ctx.fillStyle = i % 2 === 0 ? '#14161c' : '#eef1f6';
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      corners.slice(1).forEach((c) => ctx.lineTo(c.x, c.y));
      ctx.closePath();
      ctx.fill();
    }
  }

  // Checkpoint index a racer must reach NEXT, given how many they've
  // already passed -- same logic as racing-server.js's own
  // nextCheckpointIndex(), just under this file's own name.
  function nextCheckpointIndexClient(checkpointsPassed, numCheckpoints) {
    return (checkpointsPassed + 1) % numCheckpoints;
  }

  // --- '2d' view: the original straight-down camera ------------------------
  // A completely different, much simpler technique than the perspective
  // renderer above -- one flat orthographic canvas transform (uniform
  // scale + translate, no rotation), everything drawn at its raw world
  // (x, y) under that same transform. No foreshortening, no billboards,
  // the most context at once -- the easiest of the 3 views to read, at
  // the cost of not "seeing the road ahead" the way '2.25d'/'2.5d' do.

  // How much forward/backward visibility to guarantee in THIS view, as a
  // multiple of the horizontal viewport width -- kept as an explicit
  // world-unit target (like the perspective camera's own reference
  // framing) rather than just whatever falls out of the canvas's own
  // pixel width:height ratio, which is what silently broke forward
  // visibility on this view once before (see git history / an earlier
  // #track-wrap CSS resize). Generous (1.5x) since these tracks are
  // switchback climbs where seeing far ahead matters more than side margin.
  const VIEWPORT_HEIGHT_TO_WIDTH_RATIO = 1.5;
  // The viewport actually shown, in world units -- computed fresh in
  // drawTrackTopDown() every frame, then reused by drawMinimap() (which
  // runs right after it in renderGame()) so the rectangle it draws in '2d'
  // mode always matches the real camera exactly.
  let lastViewportWidth = 0;
  let lastViewportHeight = 0;

  function drawFinishLineTopDown(state) {
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

  function drawCheckpointMarkersTopDown(state) {
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

  function drawTrackTopDown(state) {
    syncCanvasResolution();

    const myPlayer = state.players.find((p) => p.id === me.id);
    const camX = myPlayer ? myPlayer.x : state.checkpoints[0].x;
    const camY = myPlayer ? myPlayer.y : state.checkpoints[0].y;
    const targetViewportWidth = state.trackWidth * VIEWPORT_ROAD_WIDTHS;
    const targetViewportHeight = targetViewportWidth * VIEWPORT_HEIGHT_TO_WIDTH_RATIO;
    const zoom = Math.min(canvasPixelWidth / targetViewportWidth, canvasPixelHeight / targetViewportHeight);
    lastViewportWidth = canvasPixelWidth / zoom;
    lastViewportHeight = canvasPixelHeight / zoom;

    ctx.save();
    ctx.setTransform(zoom, 0, 0, zoom, canvasPixelWidth / 2 - camX * zoom, canvasPixelHeight / 2 - camY * zoom);

    // Speckled ground texture first (see getGroundPattern()), the same
    // per-track color gradient tinted semi-transparently on top -- keeps
    // each pass's own color mood while the "can't drive here" terrain
    // reads as actual ground instead of one flat color.
    ctx.fillStyle = getGroundPattern(state.bgFrom || '#16321f');
    ctx.fillRect(0, 0, state.mapWidth, state.mapHeight);
    ctx.save();
    ctx.globalAlpha = 0.55;
    const bg = ctx.createLinearGradient(0, 0, state.mapWidth, 0);
    bg.addColorStop(0, state.bgFrom || '#16321f');
    bg.addColorStop(1, state.bgTo || '#0d2b3d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, state.mapWidth, state.mapHeight);
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Far-layer pieces (see racing-server.js's scatterDecorations()) drawn
    // faded and a touch smaller -- a simple stand-in for atmospheric
    // distance in a view that has no real depth of its own.
    (state.decorations || []).forEach((d) => {
      const isFar = d.layer === 'far';
      ctx.globalAlpha = isFar ? 0.55 : 1;
      ctx.font = `${(isFar ? 20 : 24) * WORLD_SCALE}px sans-serif`;
      ctx.fillText(d.emoji, d.x, d.y);
    });
    ctx.globalAlpha = 1;

    const pts = state.checkpoints;
    const pathIt = () => {
      ctx.beginPath();
      pts.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
      ctx.closePath();
    };

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

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 3 * WORLD_SCALE;
    ctx.setLineDash([14 * WORLD_SCALE, 14 * WORLD_SCALE]);
    pathIt();
    ctx.stroke();
    ctx.setLineDash([]);

    drawFinishLineTopDown(state);
    drawCheckpointMarkersTopDown(state);

    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${16 * WORLD_SCALE}px sans-serif`;
    ctx.fillStyle = '#eef1f6';
    (state.landmarks || []).forEach((l) => ctx.fillText(`${l.icon} ${l.label}`, l.x, l.y));

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${20 * WORLD_SCALE}px sans-serif`;
    (state.potholes || []).forEach((h) => ctx.fillText('🕳️', h.x, h.y));

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const showNames = state.players.length <= NAME_LABEL_THRESHOLD;
    state.players.forEach((p) => {
      const charDef = (state.characters && p.character && state.characters[p.character]) || null;
      const emoji = charDef ? charDef.emoji : '🏃';
      const isMe = p.id === me.id;

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
        ctx.beginPath();
        ctx.strokeStyle = `hsl(${Math.round(120 - (p.damage / 100) * 120)}, 80%, 55%)`;
        ctx.lineWidth = 2 * WORLD_SCALE;
        ctx.arc(p.x, p.y, 14 * WORLD_SCALE, -Math.PI / 2, -Math.PI / 2 + (p.damage / 100) * Math.PI * 2);
        ctx.stroke();
      }

      const markerSize = (isMe ? 20 : 16) * WORLD_SCALE;
      const imgEntry = getCharacterImage(charDef);
      if (imgEntry && imgEntry.loaded && !imgEntry.failed) {
        const s = Math.min(markerSize / imgEntry.img.naturalWidth, markerSize / imgEntry.img.naturalHeight);
        const w = imgEntry.img.naturalWidth * s;
        const h = imgEntry.img.naturalHeight * s;
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

  // Dispatches to whichever camera the viewer currently has picked (see
  // the view-mode buttons above) -- '2d' is a completely different
  // rendering technique (a single flat orthographic transform, no
  // rotation), so it gets its own function entirely; '2.25d'/'2.5d' share
  // 100% of the same perspective renderer, differing only in cameraParams().
  function drawTrack(state) {
    if (viewMode === '2d') { drawTrackTopDown(state); return; }
    drawTrackPerspective(state, viewMode);
  }

  function drawTrackPerspective(state, mode) {
    syncCanvasResolution();

    const myPlayer = state.players.find((p) => p.id === me.id);
    const camPos = myPlayer || state.checkpoints[0];
    const heading = currentHeadingAngle(state, myPlayer);
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    const cam = cameraParams(state, mode);

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Sky (top -> horizon) and ground (horizon -> bottom) -- reuses the
    // track's own two theme colors (see TRACKS in racing-server.js), the
    // same ones the old top-down view used for its left-to-right
    // gradient, just reinterpreted here as "distant/hazy" -> "near/
    // horizon" for a bit of per-track atmosphere without real color math.
    const horizonY = HORIZON_FRAC * canvasPixelHeight;
    const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, state.bgFrom || '#16321f');
    sky.addColorStop(1, state.bgTo || '#0d2b3d');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, canvasPixelWidth, horizonY);

    // A deterministic distant-mountain silhouette breaks up the otherwise
    // flat sky gradient right at the horizon (see drawHorizonSilhouette()).
    drawHorizonSilhouette(state, horizonY);

    // Ground: same speckled-texture-plus-tint treatment as the top-down
    // view's own background (see getGroundPattern()) instead of one flat
    // fill color.
    ctx.fillStyle = getGroundPattern(state.bgTo || '#0d2b3d');
    ctx.fillRect(0, horizonY, canvasPixelWidth, canvasPixelHeight - horizonY);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = state.bgTo || '#0d2b3d';
    ctx.fillRect(0, horizonY, canvasPixelWidth, canvasPixelHeight - horizonY);
    ctx.restore();

    // --- Road ribbon: sample the actual path (curves included) near the
    // player, project each sample's edge points, and connect consecutive
    // rings into filled quads -- drawn FARTHEST ring first so nearer ones
    // correctly paint over them.
    const { segIndex, t } = closestPointOnLoopWithSegment(camPos, state.checkpoints);
    const half = state.trackWidth / 2;
    const barrierRimWidth = 9 * WORLD_SCALE;
    const rings = [];
    for (let i = -ROAD_SAMPLES_BEHIND; i <= ROAD_SAMPLES_AHEAD; i++) {
      const s = walkAlongLoop(state.checkpoints, segIndex, t, i * ROAD_SAMPLE_STEP);
      const nx = -s.tangentY;
      const ny = s.tangentX;
      rings.push({
        center: projectPoint(s.x, s.y, camPos.x, camPos.y, cosH, sinH, cam),
        left: projectPoint(s.x + nx * half, s.y + ny * half, camPos.x, camPos.y, cosH, sinH, cam),
        right: projectPoint(s.x - nx * half, s.y - ny * half, camPos.x, camPos.y, cosH, sinH, cam),
        outerLeft: projectPoint(s.x + nx * (half + barrierRimWidth), s.y + ny * (half + barrierRimWidth), camPos.x, camPos.y, cosH, sinH, cam),
        outerRight: projectPoint(s.x - nx * (half + barrierRimWidth), s.y - ny * (half + barrierRimWidth), camPos.x, camPos.y, cosH, sinH, cam),
      });
    }
    for (let i = rings.length - 2; i >= 0; i--) {
      const a = rings[i];
      const b = rings[i + 1];
      if (!a.outerLeft || !a.outerRight || !b.outerLeft || !b.outerRight) continue;
      // Guardrail rim (wider quad, gold) drawn first, road surface
      // (narrower quad, dark) drawn on top -- the "stroke twice" trick the
      // old top-down view used, just as filled quads now.
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.moveTo(a.outerLeft.x, a.outerLeft.y);
      ctx.lineTo(b.outerLeft.x, b.outerLeft.y);
      ctx.lineTo(b.outerRight.x, b.outerRight.y);
      ctx.lineTo(a.outerRight.x, a.outerRight.y);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#3a4152';
      ctx.beginPath();
      ctx.moveTo(a.left.x, a.left.y);
      ctx.lineTo(b.left.x, b.left.y);
      ctx.lineTo(b.right.x, b.right.y);
      ctx.lineTo(a.right.x, a.right.y);
      ctx.closePath();
      ctx.fill();
    }
    // Center dashed line, following the same ring centers.
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    let started = false;
    rings.forEach((r) => {
      if (!r.center) { started = false; return; }
      if (!started) { ctx.moveTo(r.center.x, r.center.y); started = true; } else ctx.lineTo(r.center.x, r.center.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    drawFinishLine(state, camPos.x, camPos.y, cosH, sinH, cam);

    // --- Everything else: billboard sprites, collected then drawn --------
    // farthest-camDepth-first so nearer sprites correctly paint over
    // farther ones (a checkpoint behind a closer racer, etc).
    const sprites = [];

    (state.decorations || []).forEach((d) => {
      const proj = projectPoint(d.x, d.y, camPos.x, camPos.y, cosH, sinH, cam);
      if (!proj || proj.scale < MIN_SPRITE_SCALE) return;
      const isFar = d.layer === 'far';
      sprites.push({
        camDepth: proj.camDepth,
        draw: () => drawBillboard(proj, () => {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // Faded a bit more on top of whatever perspective already does
          // to it -- a simple atmospheric-haze cue for the far layer (see
          // racing-server.js's scatterDecorations()).
          ctx.globalAlpha = isFar ? 0.6 : 1;
          ctx.font = `${24 * WORLD_SCALE}px sans-serif`;
          ctx.fillText(d.emoji, 0, 0);
          ctx.globalAlpha = 1;
        }),
      });
    });

    (state.potholes || []).forEach((h) => {
      const proj = projectPoint(h.x, h.y, camPos.x, camPos.y, cosH, sinH, cam);
      if (!proj || proj.scale < MIN_SPRITE_SCALE) return;
      sprites.push({
        camDepth: proj.camDepth,
        draw: () => drawBillboard(proj, () => {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = `${20 * WORLD_SCALE}px sans-serif`;
          ctx.fillText('🕳️', 0, 0);
        }),
      });
    });

    const myNextIndex = (myPlayer && !myPlayer.finishedAt) ? nextCheckpointIndexClient(myPlayer.checkpointsPassed, state.checkpoints.length) : null;
    state.checkpoints.forEach((pt, i) => {
      const proj = projectPoint(pt.x, pt.y, camPos.x, camPos.y, cosH, sinH, cam);
      if (!proj || proj.scale < MIN_SPRITE_SCALE) return;
      const isNext = i === myNextIndex;
      sprites.push({
        camDepth: proj.camDepth,
        draw: () => drawBillboard(proj, () => {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const radius = (isNext ? 20 : 13) * WORLD_SCALE;
          if (isNext) {
            ctx.beginPath();
            ctx.fillStyle = 'rgba(255, 209, 102, 0.35)';
            ctx.arc(0, 0, radius + 9 * WORLD_SCALE, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.beginPath();
          ctx.fillStyle = isNext ? '#ffd166' : 'rgba(255,255,255,0.82)';
          ctx.arc(0, 0, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 2 * WORLD_SCALE;
          ctx.strokeStyle = 'rgba(20,22,28,0.6)';
          ctx.stroke();
          ctx.fillStyle = '#14161c';
          ctx.font = (isNext ? `bold ${15 * WORLD_SCALE}px` : `${11 * WORLD_SCALE}px`) + ' sans-serif';
          ctx.fillText(i === 0 ? '🏁' : String(i), 0, 0);
        }),
      });
    });

    const showNames = state.players.length <= NAME_LABEL_THRESHOLD;
    state.players.forEach((p) => {
      const proj = projectPoint(p.x, p.y, camPos.x, camPos.y, cosH, sinH, cam);
      if (!proj || proj.scale < MIN_SPRITE_SCALE) return;
      const charDef = (state.characters && p.character && state.characters[p.character]) || null;
      const emoji = charDef ? charDef.emoji : '🏃';
      const isMe = p.id === me.id;
      sprites.push({
        camDepth: proj.camDepth,
        draw: () => drawBillboard(proj, () => {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (p.maxGasActive) {
            ctx.beginPath();
            ctx.fillStyle = 'rgba(255, 209, 102, 0.35)';
            ctx.arc(0, 0, 16 * WORLD_SCALE, 0, Math.PI * 2);
            ctx.fill();
          }
          if (p.shieldActive) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(91, 140, 255, 0.85)';
            ctx.lineWidth = 2.5 * WORLD_SCALE;
            ctx.arc(0, 0, 15 * WORLD_SCALE, 0, Math.PI * 2);
            ctx.stroke();
          }
          if (p.stunned) {
            ctx.beginPath();
            ctx.fillStyle = 'rgba(120, 120, 130, 0.45)';
            ctx.arc(0, 0, 16 * WORLD_SCALE, 0, Math.PI * 2);
            ctx.fill();
          }
          if (p.repairing) {
            ctx.beginPath();
            ctx.fillStyle = 'rgba(255, 159, 90, 0.45)';
            ctx.arc(0, 0, 16 * WORLD_SCALE, 0, Math.PI * 2);
            ctx.fill();
          } else if (p.damage > 0) {
            // Partial arc (not a full ring) showing damage as a fraction of
            // the circle, same idea as a health/fuel gauge -- green at low
            // damage fading to red as it climbs toward the 100% wreck point.
            ctx.beginPath();
            ctx.strokeStyle = `hsl(${Math.round(120 - (p.damage / 100) * 120)}, 80%, 55%)`;
            ctx.lineWidth = 2 * WORLD_SCALE;
            ctx.arc(0, 0, 14 * WORLD_SCALE, -Math.PI / 2, -Math.PI / 2 + (p.damage / 100) * Math.PI * 2);
            ctx.stroke();
          }

          const markerSize = (isMe ? 20 : 16) * WORLD_SCALE;
          const imgEntry = getCharacterImage(charDef);
          if (imgEntry && imgEntry.loaded && !imgEntry.failed) {
            // "Contain" fit within a markerSize x markerSize box, same idea
            // as the character picker's own `object-fit: contain` -- these
            // portraits are taller than they are wide.
            const s = Math.min(markerSize / imgEntry.img.naturalWidth, markerSize / imgEntry.img.naturalHeight);
            const w = imgEntry.img.naturalWidth * s;
            const h = imgEntry.img.naturalHeight * s;
            ctx.drawImage(imgEntry.img, -w / 2, -h / 2, w, h);
          } else {
            ctx.font = `${markerSize}px sans-serif`;
            ctx.fillText(emoji, 0, 0);
          }
          if (p.stunned) {
            ctx.font = `${12 * WORLD_SCALE}px sans-serif`;
            ctx.fillText('💫', 12 * WORLD_SCALE, -12 * WORLD_SCALE);
          }
          if (p.repairing) {
            ctx.font = `${12 * WORLD_SCALE}px sans-serif`;
            ctx.fillText('🔧', 12 * WORLD_SCALE, -12 * WORLD_SCALE);
          }
          if (showNames || isMe) {
            ctx.font = `${9 * WORLD_SCALE}px sans-serif`;
            ctx.fillStyle = isMe ? '#ffd166' : '#eef1f6';
            ctx.fillText(p.name, 0, -15 * WORLD_SCALE);
          }
        }),
      });
    });

    sprites.sort((a, b) => b.camDepth - a.camDepth);
    sprites.forEach((s) => s.draw());
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

    // What the main view currently frames -- an axis-aligned rectangle in
    // '2d' mode (that camera never rotates, see drawTrackTopDown()) or a
    // heading wedge in '2.25d'/'2.5d' (those DO rotate with your own
    // heading -- see currentHeadingAngle()'s module-level cache, reused
    // here rather than re-derived so this can never drift out of sync
    // with what the main view is actually showing).
    if (myPlayer) {
      if (viewMode === '2d') {
        mctx.strokeStyle = 'rgba(255,255,255,0.55)';
        mctx.lineWidth = 1;
        mctx.strokeRect(
          (myPlayer.x - lastViewportWidth / 2) * sx,
          (myPlayer.y - lastViewportHeight / 2) * sy,
          lastViewportWidth * sx,
          lastViewportHeight * sy,
        );
      } else {
        const heading = currentHeadingAngle(state, myPlayer);
        const wedgeLen = 22;
        const wedgeHalfAngle = 0.5;
        const mx = myPlayer.x * sx;
        const my = myPlayer.y * sy;
        mctx.beginPath();
        mctx.moveTo(mx, my);
        mctx.lineTo(mx + Math.cos(heading - wedgeHalfAngle) * wedgeLen, my + Math.sin(heading - wedgeHalfAngle) * wedgeLen);
        mctx.lineTo(mx + Math.cos(heading + wedgeHalfAngle) * wedgeLen, my + Math.sin(heading + wedgeHalfAngle) * wedgeLen);
        mctx.closePath();
        mctx.fillStyle = 'rgba(255,255,255,0.3)';
        mctx.fill();
        mctx.strokeStyle = 'rgba(255,255,255,0.55)';
        mctx.lineWidth = 1;
        mctx.stroke();
      }
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
  // In the top-down '2d' view, these map to ABSOLUTE world directions (up
  // key = world "north"/-y, etc) -- correct there, since screen directions
  // and world directions are literally the same thing in that view. The
  // forward-facing '2.25d'/'2.5d' views break that assumption: the camera
  // rotates to face wherever you're already heading, so "world north"
  // could be behind you, to either side, anywhere -- the SAME key press
  // could mean something completely different on screen depending on
  // which way you happen to be facing at that moment (a player reported
  // this directly: needing to press "down" to actually go the way the
  // road visually curves makes no sense once the camera is chasing your
  // own heading). Those two views use RELATIVE steering instead, the way
  // an actual car works: Up holds your current heading, Left/Right nudge
  // the TARGET heading by a fixed angle either way. Down is intentionally
  // unused -- there's no reverse gear, ⛽ GAS alone controls speed.
  // A much smaller nudge than a "full" 40-45 degree turn -- since Left/
  // Right keeps getting re-applied every state broadcast while held (see
  // socket.on('racing:state') below), a big single-press angle made the
  // heading (and the camera chasing it) swing wildly and feel
  // uncontrollable. 8 degrees per held tick reads as gentle, continuous
  // steering instead of a sudden snap.
  const RELATIVE_TURN_ANGLE = 8 * Math.PI / 180; // ~8 degrees
  // Reads the SAME heading the camera itself is currently using (see
  // currentHeadingAngle(), defined up in the rendering section) so
  // steering and what's actually drawn on screen can never disagree about
  // which way "forward" is.
  function steeringHeading() {
    if (!latestState) return 0;
    const myPlayer = latestState.players.find((p) => p.id === me.id);
    return currentHeadingAngle(latestState, myPlayer);
  }
  const MOVE_KEYS = {
    w: { x: 0, y: -1 }, ArrowUp: { x: 0, y: -1 },
    s: { x: 0, y: 1 }, ArrowDown: { x: 0, y: 1 },
    a: { x: -1, y: 0 }, ArrowLeft: { x: -1, y: 0 },
    d: { x: 1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  };
  const pressedKeys = new Set();
  let lastSentDir = { x: 0, y: 0 };
  function currentDir() {
    if (viewMode === '2d') {
      let x = 0;
      let y = 0;
      pressedKeys.forEach((k) => {
        const v = MOVE_KEYS[k];
        if (v) { x += v.x; y += v.y; }
      });
      return { x, y };
    }
    const left = pressedKeys.has('a') || pressedKeys.has('ArrowLeft');
    const right = pressedKeys.has('d') || pressedKeys.has('ArrowRight');
    const up = pressedKeys.has('w') || pressedKeys.has('ArrowUp');
    if (!left && !right && !up) return { x: 0, y: 0 };
    let angle = steeringHeading();
    if (left && !right) angle -= RELATIVE_TURN_ANGLE;
    else if (right && !left) angle += RELATIVE_TURN_ANGLE;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  }
  function sendDirIfChanged() {
    const dir = currentDir();
    if (dir.x !== lastSentDir.x || dir.y !== lastSentDir.y) {
      lastSentDir = dir;
      socket.emit('racing:input', { dx: dir.x, dy: dir.y });
    }
  }
  window.addEventListener('keydown', (e) => {
    if (!MOVE_KEYS[e.key]) return;
    // Arrow keys scroll the page by default (WASD never did) -- without
    // this, scrolling the page out from under a held-down mouse/pointer
    // (e.g. the ⛽ GAS button) fires a pointerleave/pointerup and silently
    // drops "held", even though the player never meant to let go of
    // anything. Skipped while actually typing into a text field (room
    // name/password etc.) so arrow-key cursor movement there still works.
    const t = e.target;
    const isTypingField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (!isTypingField) e.preventDefault();
    if (!latestState || latestState.status !== 'racing') return;
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
  let lastJoystickRaw = { x: 0, y: 0 }; // raw (-1..1) drag vector, BEFORE any heading rotation -- reapplied on every state update (see socket.on('racing:state') below) so holding the stick steady keeps tracking a rotating heading
  let lastJoystickDir = { x: 0, y: 0 }; // last vector actually SENT to the server
  function sendJoystickDir(x, y) {
    if (x === lastJoystickDir.x && y === lastJoystickDir.y) return;
    lastJoystickDir = { x, y };
    socket.emit('racing:input', { dx: x, dy: y });
  }
  // Converts the joystick's raw (-1..1) screen-relative vector into the
  // final world-space direction to send -- unchanged in '2d' (screen and
  // world directions already match there); in '2.25d'/'2.5d', rotated by
  // the current heading (see steeringHeading()) so pushing "up" always
  // means forward and "right" always means steer-right, regardless of
  // which way the camera itself is currently facing -- same reasoning as
  // the keyboard's own relative steering above, just continuous instead
  // of a fixed angle (analog input can express any in-between angle,
  // unlike 3 discrete keys). Magnitude (how far the stick is pushed) is
  // preserved either way -- it still scales actual movement speed
  // server-side (see racing-server.js's setPlayerInput()).
  function applySteeringFrame(rawX, rawY) {
    if (viewMode === '2d' || (rawX === 0 && rawY === 0)) return { x: rawX, y: rawY };
    const heading = steeringHeading();
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    const forwardWeight = -rawY; // "up" on the stick = full forward weight
    const rightWeight = rawX; // "right" on the stick = full right weight
    return { x: cosH * forwardWeight - sinH * rightWeight, y: sinH * forwardWeight + cosH * rightWeight };
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
    if (!latestState || latestState.status !== 'racing' || myPlayerFinished()) { lastJoystickRaw = { x: 0, y: 0 }; sendJoystickDir(0, 0); return; }
    lastJoystickRaw = { x: dx / JOYSTICK_RADIUS_PX, y: dy / JOYSTICK_RADIUS_PX };
    const dir = applySteeringFrame(lastJoystickRaw.x, lastJoystickRaw.y);
    sendJoystickDir(dir.x, dir.y);
  }
  function resetJoystick() {
    joystickThumbEl.style.transform = 'translate(-50%, -50%)';
    lastJoystickRaw = { x: 0, y: 0 };
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
    // Relative steering (see currentDir()/applySteeringFrame() above)
    // depends on the CURRENT heading, which keeps changing every server
    // tick due to movement inertia even with no new input at all --
    // re-evaluate on every broadcast so holding Left/Right (or a steady
    // joystick push) keeps tracking the rotating heading instead of
    // freezing at whatever angle it happened to be when first pressed.
    if (viewMode !== '2d' && latestState.status === 'racing' && !myPlayerFinished()) {
      sendDirIfChanged();
      if (lastJoystickRaw.x !== 0 || lastJoystickRaw.y !== 0) {
        const dir = applySteeringFrame(lastJoystickRaw.x, lastJoystickRaw.y);
        sendJoystickDir(dir.x, dir.y);
      }
    }
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
