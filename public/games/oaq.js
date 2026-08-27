const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/oaq');
  const LAST_ROOM_KEY = 'oaq_last_room_id';

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
  const turnLimitSelect = document.getElementById('turn-limit-select');
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
  const addBotBtn = document.getElementById('add-bot-btn');
  const waitingLogEl = document.getElementById('waiting-log');
  const leaveWaitingBtn = document.getElementById('leave-waiting-btn');

  const seatsRowEl = document.getElementById('seats-row');
  const turnBannerEl = document.getElementById('turn-banner');
  const moveCounterEl = document.getElementById('move-counter');
  const boardWrapEl = document.getElementById('board-wrap');
  const directionPickerEl = document.getElementById('direction-picker');
  const dirLeftBtn = document.getElementById('dir-left-btn');
  const dirRightBtn = document.getElementById('dir-right-btn');
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
  let selectedPit = null; // client-side only -- which of your own pits is armed, waiting for a direction

  // Sow animation: on-screen column of every pit (-1 = left Quan, 5 =
  // right Quan, 0-4 = the 5 dân pits in each row, left to right as
  // ACTUALLY displayed -- the bottom row is stored in loop order
  // [7,8,9,10,11] but shown reversed, so its columns are inverted here
  // to match, per oaq-server.js's board diagram).
  const PIT_COLUMN = { 0: -1, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 4, 8: 3, 9: 2, 10: 1, 11: 0 };
  function isQuanIndex(index) { return index === 0 || index === 6; }
  // Which way an arrow should point for one sowing step -- based on the
  // pit's actual on-screen column, not the raw +1/-1 loop direction
  // (which flips visual meaning between the two rows). A step into or
  // out of a Quan pit gets a "wrap around the end" glyph instead of a
  // misleading left/right, since Quan pits span both rows.
  function arrowForStep(fromIndex, toIndex) {
    if (isQuanIndex(fromIndex) || isQuanIndex(toIndex)) return '↩';
    return PIT_COLUMN[toIndex] > PIT_COLUMN[fromIndex] ? '➡️' : '⬅️';
  }

  // Each of the 5 dân box positions (by on-screen column, so a pit and
  // its mirror on the other row share a color) has its own "home" gem
  // color -- ruby/emerald/sapphire/amethyst/topaz -- but an individual
  // gem KEEPS the color of whichever box it originally started in as it
  // physically moves around the board via sowing/relay, so a box can end
  // up showing a genuine mix of colors reflecting its history. Quan pits
  // always show real diamonds instead (see buildDiamondCluster).
  const GEM_COLOR_CLASSES = ['gem-ruby', 'gem-emerald', 'gem-sapphire', 'gem-amethyst', 'gem-topaz'];
  const GEM_DISPLAY_CAP = 12; // beyond this we show a "+N" badge instead of spamming icons
  function pitHomeColor(index) {
    return GEM_COLOR_CLASSES[PIT_COLUMN[index]];
  }

  // A pile gets visibly more precious as it grows: 1-4 gems look plain,
  // 5-8 pick up a brighter glow, and 9+ gets the brightest glow plus a
  // twinkling animation -- a small reward for letting seeds pile up (via
  // a long relay chain, say) rather than sowing them out immediately.
  // Based on the TRUE count, not the capped render count, so an even
  // bigger pile hidden behind the "+N" badge still twinkles.
  function gemTierClass(count) {
    if (count >= 9) return 'gems-twinkle';
    if (count >= 5) return 'gems-glow';
    return '';
  }

  // Renders one <span> per entry in `colors` (each gem's OWN tracked
  // color, not necessarily the box's home color) -- capped so a huge
  // pile (a long relay chain can stack dozens into one pit) doesn't
  // flood the box with tiny icons; the overflow becomes a "+N" badge.
  function buildGemCluster(colors) {
    const wrap = document.createElement('div');
    wrap.className = `gem-cluster ${gemTierClass(colors.length)}`;
    const shown = Math.min(colors.length, GEM_DISPLAY_CAP);
    for (let i = 0; i < shown; i += 1) {
      const gem = document.createElement('span');
      gem.className = `gem ${colors[i]}`;
      wrap.appendChild(gem);
    }
    if (colors.length > GEM_DISPLAY_CAP) {
      const overflow = document.createElement('span');
      overflow.className = 'gem-overflow';
      overflow.textContent = `+${colors.length - GEM_DISPLAY_CAP}`;
      wrap.appendChild(overflow);
    }
    return wrap;
  }

  // --- Per-gem color tracking -------------------------------------------
  // The server only tracks aggregate seed COUNTS per pit, never individual
  // gem identity -- color-mixing is purely a client-side visual layer on
  // top of that, replayed from each move's path/relaySteps/capturedPits.
  // `pitGemColors[i]` is an array of color-class strings, one per gem
  // currently believed to be sitting in dân pit `i` (Quan pits aren't
  // tracked -- they always render as uniform diamonds regardless of a
  // seed's origin, since a Quan can never give its contents back out via
  // relay or a capture chain, so origin color stops mattering once a seed
  // lands there).
  let pitGemColors = null;

  function freshGemColors(pits) {
    return pits.map((count, i) => (isQuanIndex(i) ? [] : Array.from({ length: count }, () => pitHomeColor(i))));
  }

  function cloneGemColors(colors) {
    return colors.map((arr) => arr.slice());
  }

  // Pads/trims each dân pit's tracked color array to match the server's
  // actual count -- a safety net that also transparently "just works"
  // for events we don't explicitly simulate (e.g. bón dân borrowing):
  // any shortfall is filled in with the pit's own home color, which is
  // exactly the sensible default for a freshly-borrowed seed anyway.
  function reconcilePitColors(arr, target, index) {
    if (arr.length === target) return arr;
    if (arr.length > target) return arr.slice(0, target);
    return arr.concat(Array.from({ length: target - arr.length }, () => pitHomeColor(index)));
  }
  function reconcileGemColors(colors, pits) {
    return colors.map((arr, i) => (isQuanIndex(i) ? [] : reconcilePitColors(arr, pits[i], i)));
  }

  // Replays one move's sow/relay against a (cloned) color-tracking array,
  // returning the resulting array plus `stepColors[i]` -- the specific
  // color dropped at `move.path[i]`, for the animation to show the right
  // gem landing instead of a color-less placeholder.
  function applyMoveToGemColors(colors, move) {
    const g = cloneGemColors(colors);
    let hand = isQuanIndex(move.startPit) ? [] : g[move.startPit].slice();
    if (!isQuanIndex(move.startPit)) g[move.startPit] = [];
    const pickupsAfterStep = new Map();
    (move.relaySteps || []).forEach((r) => {
      if (!pickupsAfterStep.has(r.afterPathIndex)) pickupsAfterStep.set(r.afterPathIndex, []);
      pickupsAfterStep.get(r.afterPathIndex).push(r.pitIndex);
    });
    const stepColors = move.path.map((pitIndex, step) => {
      const color = hand.length ? hand.shift() : null; // null only if our tracking somehow desynced -- graceful no-op
      if (!isQuanIndex(pitIndex) && color) g[pitIndex].push(color);
      (pickupsAfterStep.get(step) || []).forEach((pickedUpPit) => {
        hand = hand.concat(g[pickedUpPit]);
        g[pickedUpPit] = [];
      });
      return color;
    });
    (move.capturedPits || []).forEach((idx) => { if (!isQuanIndex(idx)) g[idx] = []; });
    return { colors: g, stepColors };
  }

  // Quan pits show actual diamonds (💎) for their accompanying dân
  // seeds -- the big stone's own fixed value isn't a physical seed in
  // the pit, so it stays as text (see buildQuanEl's breakdown line).
  function buildDiamondCluster(count) {
    const wrap = document.createElement('div');
    wrap.className = `gem-cluster ${gemTierClass(count)}`;
    const shown = Math.min(count, GEM_DISPLAY_CAP);
    for (let i = 0; i < shown; i += 1) {
      const gem = document.createElement('span');
      gem.className = 'diamond-gem';
      gem.textContent = '💎';
      wrap.appendChild(gem);
    }
    if (count > GEM_DISPLAY_CAP) {
      const overflow = document.createElement('span');
      overflow.className = 'gem-overflow';
      overflow.textContent = `+${count - GEM_DISPLAY_CAP}`;
      wrap.appendChild(overflow);
    }
    return wrap;
  }

  const SOW_STEP_MS = 220;
  const MAX_SOW_ANIMATION_MS = 3200; // cap total time for a very long sow so it never drags on
  let animating = false;
  let animationTimers = [];
  let lastAnimatedMoveSeq = null;
  function clearAnimationTimers() {
    animationTimers.forEach((t) => clearTimeout(t));
    animationTimers = [];
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
      const limitText = room.turnLimit ? ` · ${room.turnLimit}-turn limit` : '';
      meta.textContent = `${statusLabel(room.status)} · ${room.playerCount}/2 players${limitText}`;
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
    waitingRoomTitleEl.textContent = (state.roomName || 'Waiting Room') + (state.turnLimit ? ` (${state.turnLimit}-turn limit)` : '');
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
    state.players.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'oaq-seat'
        + (state.status === 'playing' && p.id === state.currentPlayerId ? ' turn' : '')
        + (!p.connected ? ' offline' : '');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name + (p.id === state.yourId ? ' (You)' : '') + (p.isBot ? ' 🤖' : '');
      const score = document.createElement('div');
      score.className = 'score';
      score.textContent = `${p.score} seeds`;
      el.append(name, score);
      seatsRowEl.appendChild(el);
    });
  }

  function renderTurnBanner(state) {
    if (state.status !== 'playing') { turnBannerEl.textContent = ''; turnBannerEl.className = 'oaq-turn-banner'; return; }
    const mine = state.yourId === state.currentPlayerId;
    const currentPlayer = state.players.find((p) => p.id === state.currentPlayerId);
    const thinking = !mine && currentPlayer && currentPlayer.isBot;
    turnBannerEl.innerHTML = '';
    if (mine) {
      turnBannerEl.textContent = 'Your turn';
    } else if (thinking) {
      // The bot always waits a random stretch before playing (see
      // oaq-server.js's BOT_THINK_MS_MIN/MAX) -- make that pause visibly
      // read as "thinking" rather than a silent, unexplained delay.
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `🤔 ${currentPlayer.name} is thinking`;
      const dots = document.createElement('span');
      dots.className = 'thinking-dots';
      dots.textContent = '...';
      turnBannerEl.append(nameSpan, dots);
    } else {
      turnBannerEl.textContent = `Waiting for ${currentPlayer ? currentPlayer.name : 'opponent'}...`;
    }
    turnBannerEl.className = 'oaq-turn-banner' + (mine ? ' mine' : '') + (thinking ? ' thinking' : '');
  }

  // Ownership/position of every pit, computed once per render from the
  // server's own danPits/quanIndices (rather than hardcoding index
  // ranges here too) -- state.danPits comes back as {"0": [...], "1": [...]}
  // since object keys always serialize to strings over Socket.IO.
  function myPlayerIndex(state) {
    return state.players.findIndex((p) => p.id === state.yourId);
  }

  // `displayPits` overrides state.pits for drawing purposes only (used
  // mid-animation, where the board is at some intermediate frame between
  // the previous and the actual server state); `interactive` disables
  // click handlers/hints while an animation is playing so the board
  // can't be clicked mid-drop; `highlightIndex`/`arrow` mark the pit
  // currently receiving a seed; `capturedHighlight` flashes pits about
  // to be swept away.
  function buildPitEl(state, index, myIndex, displayPits, opts) {
    const el = document.createElement('div');
    const owner = state.danPits['0'].includes(index) ? 0 : 1;
    const isMine = owner === myIndex;
    const isMyTurn = opts.interactive && state.status === 'playing' && state.yourId === state.currentPlayerId;
    const count = displayPits[index];
    el.className = 'oaq-pit'
      + (isMine ? ' mine' : '')
      + (count === 0 ? ' empty' : '')
      + (isMine && isMyTurn && count > 0 ? ' playable' : '')
      + (opts.interactive && selectedPit === index ? ' selected' : '')
      + (opts.highlightIndex === index ? ' dropping' : '')
      + (opts.relayHighlight === index ? ' relaying' : '')
      + ((opts.capturedHighlight || []).includes(index) ? ' capturing' : '');
    el.dataset.index = index;
    const rawColors = (opts.gemColors && opts.gemColors[index]) || [];
    el.appendChild(buildGemCluster(reconcilePitColors(rawColors, count, index)));
    if (opts.arrow && opts.highlightIndex === index) {
      const arrowEl = document.createElement('div');
      arrowEl.className = 'oaq-arrow';
      arrowEl.textContent = opts.arrow;
      el.appendChild(arrowEl);
    }
    if (isMine && isMyTurn && count > 0) {
      el.addEventListener('click', () => {
        selectedPit = selectedPit === index ? null : index;
        renderBoard(latestState);
      });
    }
    return el;
  }

  // A Quan pit's `displayPits[index]` is ONLY its accompanying dân seeds
  // -- the big stone's own fixed value (state.quanBaseValue) is never
  // stored on the board, only credited the FIRST time that Quan is ever
  // captured. Being "eaten" once does NOT retire the pit: it keeps
  // collecting dân from passing sows and can be captured again once it
  // re-ripens (just without another base-value bonus) -- so ripeness and
  // the ban both still apply, and still need to be shown, even after a
  // Quan has already been eaten once. Hiding that info once `eaten` is
  // true is what made recapturing look impossible before this fix.
  function buildQuanEl(state, index, displayPits, opts) {
    const eaten = Boolean(state.quanEaten && state.quanEaten[index]);
    const accompanyingDan = displayPits[index];
    const totalWorth = accompanyingDan + (eaten ? 0 : (state.quanBaseValue || 0));
    const ripe = accompanyingDan >= (state.quanRipenessThreshold || 0);
    const banned = !state.quanCaptureAllowed;

    const el = document.createElement('div');
    el.className = 'oaq-quan'
      + (opts.highlightIndex === index ? ' dropping' : '')
      + (opts.relayHighlight === index ? ' relaying' : '')
      + (eaten ? ' eaten' : '')
      + (!ripe || banned ? ' unripe' : '');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = eaten ? 'Quan (eaten once)' : 'Quan';
    el.append(label, buildDiamondCluster(accompanyingDan));
    {
      const breakdown = document.createElement('div');
      breakdown.className = 'breakdown';
      breakdown.textContent = eaten
        ? `worth ${totalWorth} dân if recaptured (base value already claimed)`
        : `= ${totalWorth} (${state.quanBaseValue} + ${accompanyingDan} dân)`;
      el.appendChild(breakdown);
      if (banned) {
        const lock = document.createElement('div');
        lock.className = 'lock-note';
        lock.textContent = `🚫 banned ${state.movesUntilQuanCaptureAllowed} more`;
        el.appendChild(lock);
      } else if (!ripe) {
        const lock = document.createElement('div');
        lock.className = 'lock-note';
        lock.textContent = `🔒 needs ${state.quanRipenessThreshold}`;
        el.appendChild(lock);
      }
    }
    if (opts.arrow && opts.highlightIndex === index) {
      const arrowEl = document.createElement('div');
      arrowEl.className = 'oaq-arrow';
      arrowEl.textContent = opts.arrow;
      el.appendChild(arrowEl);
    }
    return el;
  }

  // `overrides` (all optional): pits (array to display instead of
  // state.pits), gemColors (per-pit color arrays to display instead of
  // the tracked pitGemColors -- used mid-animation), interactive
  // (default true -- false while animating), highlightIndex/arrow (the
  // pit currently receiving a seed), capturedHighlight (array of pits
  // about to be swept away).
  function renderBoard(state, overrides) {
    const opts = overrides || {};
    const displayPits = opts.pits || state.pits;
    if (!opts.gemColors) opts.gemColors = pitGemColors || freshGemColors(displayPits);
    const interactive = opts.interactive !== false && !animating;
    boardWrapEl.innerHTML = '';
    const myIndex = myPlayerIndex(state);
    const board = document.createElement('div');
    board.className = 'oaq-board';

    const [quanA, quanB] = state.quanIndices;
    const topRow = state.danPits['0']; // [1,2,3,4,5] -- already left-to-right physically
    const bottomRow = [...state.danPits['1']].reverse(); // stored as [7,8,9,10,11] (loop order); reversed for correct left-to-right display
    const pitOpts = { ...opts, interactive };

    const rows = document.createElement('div');
    rows.className = 'oaq-rows';
    const topRowEl = document.createElement('div');
    topRowEl.className = 'oaq-row';
    topRow.forEach((i) => topRowEl.appendChild(buildPitEl(state, i, myIndex, displayPits, pitOpts)));
    const bottomRowEl = document.createElement('div');
    bottomRowEl.className = 'oaq-row';
    bottomRow.forEach((i) => bottomRowEl.appendChild(buildPitEl(state, i, myIndex, displayPits, pitOpts)));
    rows.append(topRowEl, bottomRowEl);

    board.append(buildQuanEl(state, quanA, displayPits, pitOpts), rows, buildQuanEl(state, quanB, displayPits, pitOpts));
    boardWrapEl.appendChild(board);

    const showPicker = interactive && selectedPit !== null && state.status === 'playing' && state.yourId === state.currentPlayerId;
    directionPickerEl.classList.toggle('hidden', !showPicker);
  }

  // Plays the sow out step by step using the PREVIOUS board (prevPits)
  // as the starting point and newState.lastMove's recorded path, so the
  // viewer watches each seed actually land instead of the board just
  // snapping to the final result. Calls onDone() once the animation
  // (including any capture flash) finishes.
  function animateMove(prevPits, prevGemColors, newState, onDone) {
    const move = newState.lastMove;
    animating = true;
    clearAnimationTimers();
    const working = prevPits.slice();
    working[move.startPit] = 0;
    const workingColors = cloneGemColors(prevGemColors);
    if (!isQuanIndex(move.startPit)) workingColors[move.startPit] = [];
    const { stepColors } = applyMoveToGemColors(prevGemColors, move);
    renderBoard(newState, { pits: working, gemColors: workingColors, interactive: false, highlightIndex: move.startPit });

    const stepDelay = Math.min(SOW_STEP_MS, Math.max(60, MAX_SOW_ANIMATION_MS / Math.max(1, move.path.length)));
    // A relay ("rải nối tiếp") pickup happens to pit B -- the pit right
    // after the last drop -- which is a DIFFERENT pit from anything in
    // `path` (no seed is ever dropped into B itself, its pile was
    // already sitting there). `relaySteps` tells us, for each path index
    // where a pickup follows, which pit to flash-and-empty before the
    // next drop continues from C onward. Group by afterPathIndex in case
    // more than one ever lands on the same step (shouldn't happen, but
    // cheap to support).
    const pickupsAfterStep = new Map();
    (move.relaySteps || []).forEach((r) => {
      if (!pickupsAfterStep.has(r.afterPathIndex)) pickupsAfterStep.set(r.afterPathIndex, []);
      pickupsAfterStep.get(r.afterPathIndex).push(r.pitIndex);
    });
    const relayPauseMs = 320;
    let prevIndex = move.startPit;
    let cumulativeDelay = 0;
    move.path.forEach((pitIndex, step) => {
      const arrow = arrowForStep(prevIndex, pitIndex);
      cumulativeDelay += stepDelay;
      const dropDelay = cumulativeDelay;
      animationTimers.push(setTimeout(() => {
        working[pitIndex] += 1;
        if (!isQuanIndex(pitIndex) && stepColors[step]) workingColors[pitIndex].push(stepColors[step]);
        renderBoard(newState, { pits: working, gemColors: workingColors, interactive: false, highlightIndex: pitIndex, arrow });
      }, dropDelay));
      prevIndex = pitIndex;
      (pickupsAfterStep.get(step) || []).forEach((pickedUpPit) => {
        cumulativeDelay += relayPauseMs;
        const pickupDelay = cumulativeDelay;
        animationTimers.push(setTimeout(() => {
          working[pickedUpPit] = 0;
          workingColors[pickedUpPit] = [];
          renderBoard(newState, { pits: working, gemColors: workingColors, interactive: false, relayHighlight: pickedUpPit });
        }, pickupDelay));
      });
    });

    const afterSowDelay = cumulativeDelay + 120;
    if (move.capturedPits.length) {
      animationTimers.push(setTimeout(() => {
        move.capturedPits.forEach((idx) => { if (!isQuanIndex(idx)) workingColors[idx] = []; });
        renderBoard(newState, { pits: working, gemColors: workingColors, interactive: false, capturedHighlight: move.capturedPits });
      }, afterSowDelay));
      animationTimers.push(setTimeout(() => {
        animating = false;
        onDone();
      }, afterSowDelay + 500));
    } else {
      animationTimers.push(setTimeout(() => {
        animating = false;
        onDone();
      }, afterSowDelay + 150));
    }
  }

  // "Left"/"right" only mean the same loop direction (+1/-1) on every
  // pit if you happen to be looking at the top row -- the bottom row
  // runs the opposite way on screen (see the PIT_COLUMN comment above),
  // so which raw direction is actually "left" vs "right" has to be
  // worked out fresh for whichever pit is currently selected, using the
  // same column comparison the sow animation's arrows use.
  function directionsForPit(pitIndex) {
    const next = (pitIndex + 1) % 12;
    const prev = (pitIndex + 11) % 12;
    const nextIsRight = PIT_COLUMN[next] > PIT_COLUMN[prev];
    return { left: nextIsRight ? -1 : 1, right: nextIsRight ? 1 : -1 };
  }

  function sow(side) {
    if (selectedPit === null) return;
    const pitIndex = selectedPit;
    const direction = directionsForPit(pitIndex)[side];
    selectedPit = null;
    socket.emit('oaq:sow', { pitIndex, direction }, (res) => {
      if (!res || !res.ok) {
        alert('Could not play that move: ' + ((res && res.error) || 'unknown error'));
      }
    });
    renderBoard(latestState);
  }
  dirLeftBtn.addEventListener('click', () => sow('left'));
  dirRightBtn.addEventListener('click', () => sow('right'));

  function renderMoveCounter(state) {
    if (!state.turnLimit) { moveCounterEl.textContent = ''; return; }
    const remaining = Math.max(0, state.turnLimit - state.moveSeq);
    moveCounterEl.textContent = `Move ${state.moveSeq} / ${state.turnLimit} · ${remaining} left`;
  }

  function renderGame(state) {
    renderSeats(state);
    renderTurnBanner(state);
    renderMoveCounter(state);
    renderBoard(state);
    renderLog(gameLogEl, state.log);
  }

  function renderFinished(state) {
    winnerTextEl.textContent = state.resultText || 'Game over.';
    scoreTableEl.innerHTML = '';
    const rows = [['Player', 'Seeds']].concat(state.players.map((p) => [p.name, p.score]));
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
    selectedPit = null;
    clearAnimationTimers();
    animating = false;
    lastAnimatedMoveSeq = null;
    pitGemColors = null;
    localStorage.removeItem(LAST_ROOM_KEY);
    createRoomScreen.classList.add('hidden');
    socket.emit('oaq:listRooms', {}, (res) => {
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
    socket.emit('oaq:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
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
    turnLimitSelect.value = '0';
    createRoomErrorEl.style.display = 'none';
    showScreen('create');
  });
  cancelCreateBtn.addEventListener('click', () => showScreen('lobby'));

  createRoomBtn.addEventListener('click', () => {
    const roomName = roomNameInput.value.trim();
    const password = roomPasswordInput.value;
    const turnLimit = Number(turnLimitSelect.value) || 0;
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
    socket.emit('oaq:createRoom', { roomName, password, playerId: me.id, name: me.name, turnLimit }, (res) => {
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
    socket.emit('oaq:addBot', {}, (res) => {
      if (!res || !res.ok) alert('Could not add a bot: ' + ((res && res.error) || 'unknown error'));
    });
  });

  startBtn.addEventListener('click', () => socket.emit('oaq:start'));
  newGameBtn.addEventListener('click', () => socket.emit('oaq:newGame'));
  leaveWaitingBtn.addEventListener('click', () => { socket.emit('oaq:leave'); backToLobby(); });
  leaveBtn.addEventListener('click', () => { socket.emit('oaq:leave'); backToLobby(); });

  socket.on('oaq:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('oaq:state', (state) => {
    if (state.players.some((p) => p.id === state.yourId)) joined = true;

    // Animate only when there's an actual PREVIOUS board to animate
    // FROM (not e.g. right after a fresh page load/reconnect, where
    // there's nothing to replay) and this is a genuinely new move we
    // haven't already played (state broadcasts can repeat the same move,
    // e.g. a reconnect mid-game).
    const isNewMove = state.lastMove && state.lastMove.seq !== lastAnimatedMoveSeq;
    const canAnimate = isNewMove && latestState && latestState.roomId === state.roomId && Array.isArray(latestState.pits);
    if (state.lastMove) lastAnimatedMoveSeq = state.lastMove.seq;

    // Per-gem color tracking: a brand-new game (or a rematch) always
    // resets to the canonical one-color-per-box layout; otherwise either
    // replay this move's gem movement (if we have one to replay) or just
    // reconcile against the server's real counts (covers everything we
    // don't explicitly simulate, like bón dân borrowing, by padding any
    // shortfall with each pit's own home color).
    let prevGemColors = pitGemColors;
    if (pitGemColors === null || state.moveSeq === 0) {
      pitGemColors = freshGemColors(state.pits);
      prevGemColors = pitGemColors;
    } else if (canAnimate) {
      prevGemColors = pitGemColors;
      pitGemColors = reconcileGemColors(applyMoveToGemColors(pitGemColors, state.lastMove).colors, state.pits);
    } else {
      pitGemColors = reconcileGemColors(pitGemColors, state.pits);
    }

    if (canAnimate) {
      const prevPits = latestState.pits;
      latestState = state; // seats/score/log/turn already reflect the real outcome immediately
      renderSeats(state);
      renderTurnBanner(state);
      renderLog(gameLogEl, state.log);
      showScreen('playing');
      animateMove(prevPits, prevGemColors, state, () => render());
    } else {
      latestState = state;
      render();
    }
  });

  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('oaq:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('oaq:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
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
