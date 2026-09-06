const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = io('/boat');
  const LAST_ROOM_KEY = 'boat_last_room_id';
  const DIR_ARROWS = { trai: '⬅️', phai: '➡️', thang: '⬆️' };

  const lobbyScreen = document.getElementById('lobby-screen');
  const createRoomScreen = document.getElementById('create-room-screen');
  const waitingScreen = document.getElementById('waiting-screen');
  const raceScreen = document.getElementById('race-screen');
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
  const crewGridEl = document.getElementById('crew-grid');
  const addBotsBtn = document.getElementById('add-bots-btn');
  const startBtn = document.getElementById('start-btn');
  const waitingLogEl = document.getElementById('waiting-log');
  const leaveWaitingBtn = document.getElementById('leave-waiting-btn');

  const fillAEl = document.getElementById('fill-a');
  const fillBEl = document.getElementById('fill-b');
  const markerAEl = document.getElementById('marker-a');
  const markerBEl = document.getElementById('marker-b');
  const labelAEl = document.getElementById('label-a');
  const labelBEl = document.getElementById('label-b');
  const turnResultsEl = document.getElementById('turn-results');

  const leaderPanelEl = document.getElementById('leader-panel');
  const upcomingDirEl = document.getElementById('upcoming-dir');
  const leaderStreakEl = document.getElementById('leader-streak');
  const leaderStreakTargetEl = document.getElementById('leader-streak-target');
  const leaderCooldownLabelEl = document.getElementById('leader-cooldown-label');
  const leaderEnergyValueEl = document.getElementById('leader-energy-value');
  const leaderEnergyBarEl = document.getElementById('leader-energy-bar');
  const leaderStunnedEl = document.getElementById('leader-stunned');

  const drummerPanelEl = document.getElementById('drummer-panel');
  const drumPhaseBannerEl = document.getElementById('drum-phase-banner');
  const drumPhaseCountdownEl = document.getElementById('drum-phase-countdown');
  const drumEffectLabelEl = document.getElementById('drum-effect-label');
  const drumTapBtn = document.getElementById('drum-tap-btn');

  const rowerPanelEl = document.getElementById('rower-panel');
  const queueStripEl = document.getElementById('queue-strip');
  const rowPhaseBannerEl = document.getElementById('row-phase-banner');
  const rowPhaseCountdownEl = document.getElementById('row-phase-countdown');
  const holdLeftBtn = document.getElementById('hold-left');
  const holdRightBtn = document.getElementById('hold-right');
  const rowerEnergyValueEl = document.getElementById('rower-energy-value');
  const rowerEnergyBarEl = document.getElementById('rower-energy-bar');
  const rowerStunnedEl = document.getElementById('rower-stunned');

  const raceLogEl = document.getElementById('race-log');
  const finishTitleEl = document.getElementById('finish-title');
  const finishDetailEl = document.getElementById('finish-detail');
  const newRaceBtn = document.getElementById('new-race-btn');
  const leaveRaceBtn = document.getElementById('leave-race-btn');

  const rulesModal = document.getElementById('rules-modal');

  let joined = false;
  let latestRooms = [];
  let latestState = null;
  let pendingJoinRoomId = null;

  function showScreen(name) {
    lobbyScreen.classList.add('hidden');
    createRoomScreen.classList.add('hidden');
    waitingScreen.classList.add('hidden');
    raceScreen.classList.add('hidden');
    finishedScreen.classList.add('hidden');
    if (name === 'lobby') lobbyScreen.classList.remove('hidden');
    else if (name === 'create') createRoomScreen.classList.remove('hidden');
    else if (name === 'waiting') waitingScreen.classList.remove('hidden');
    else if (name === 'racing') raceScreen.classList.remove('hidden');
    else if (name === 'finished') finishedScreen.classList.remove('hidden');
  }

  function statusLabel(status) {
    if (status === 'waiting') return 'Waiting for crew';
    if (status === 'racing') return 'Racing';
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
      meta.className = 'room-meta' + (room.status === 'racing' ? ' racing' : '');
      meta.textContent = `${statusLabel(room.status)} · ${room.playerCount} joined · ${room.slotsFilled}/${room.slotsTotal} seats filled`;
      info.append(name, meta);
      const joinBtn = document.createElement('button');
      joinBtn.className = 'secondary';
      joinBtn.textContent = 'Join';
      joinBtn.addEventListener('click', () => openPasswordModal(room.id, room.name));
      li.append(info, joinBtn);
      roomListEl.appendChild(li);
    });
  }

  function seatRow(label, name, claimable, onClaim) {
    const li = document.createElement('li');
    li.className = 'seat-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'seat-label';
    labelEl.textContent = label;
    const nameEl = document.createElement('span');
    nameEl.className = 'seat-name' + (name ? '' : ' empty');
    nameEl.textContent = name || 'Open seat';
    li.append(labelEl, nameEl);
    if (claimable && !name) {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = 'Claim';
      btn.addEventListener('click', onClaim);
      li.appendChild(btn);
    }
    return li;
  }

  function nameFor(state, id) {
    if (!id) return null;
    const p = state.players.find((pl) => pl.id === id);
    return p ? p.name : null;
  }

  function renderWaiting(state) {
    waitingRoomTitleEl.textContent = state.roomName || 'Waiting Room';
    crewGridEl.innerHTML = '';
    ['A', 'B'].forEach((key) => {
      const boat = state.boats[key];
      const card = document.createElement('div');
      card.className = 'crew-card';
      const h3 = document.createElement('h3');
      h3.textContent = `🚣 Boat ${key}`;
      card.appendChild(h3);
      const ul = document.createElement('ul');
      ul.className = 'seat-list';
      ul.appendChild(seatRow('🚩 Leader', nameFor(state, boat.leaderId), true, () => {
        socket.emit('boat:selectRole', { boat: key, role: 'leader' }, (res) => reportSeatError(res));
      }));
      ul.appendChild(seatRow('🥁 Drummer', nameFor(state, boat.drummerId), true, () => {
        socket.emit('boat:selectRole', { boat: key, role: 'drummer' }, (res) => reportSeatError(res));
      }));
      boat.rowerIds.forEach((id, i) => {
        ul.appendChild(seatRow(`🚣 Rower ${i + 1}`, nameFor(state, id), true, () => {
          socket.emit('boat:selectRole', { boat: key, role: 'rower', slotIndex: i }, (res) => reportSeatError(res));
        }));
      });
      card.appendChild(ul);
      crewGridEl.appendChild(card);
    });
    // Every seat on both boats must be claimed (by a real player or a bot)
    // before a race can start.
    const allFilled = ['A', 'B'].every((k) => {
      const b = state.boats[k];
      return b.leaderId && b.drummerId && b.rowerIds.every(Boolean);
    });
    startBtn.disabled = !allFilled;
    renderLog(waitingLogEl, state.log);
  }

  function reportSeatError(res) {
    if (!res || res.ok) return;
    // Seats update via the next state broadcast anyway -- a quiet no-op is
    // enough feedback for "someone beat you to that seat".
  }

  function renderTrack(elFill, elMarker, boat) {
    const pct = Math.min(100, (boat.progress / boat.length) * 100);
    elFill.style.width = pct + '%';
    elMarker.style.left = pct + '%';
  }

  function myRole(state) {
    return state.yourAssignment ? state.yourAssignment.role : null;
  }
  function myBoatKey(state) {
    return state.yourAssignment ? state.yourAssignment.boatKey : null;
  }

  function renderRace(state) {
    labelAEl.textContent = 'Boat A' + (myBoatKey(state) === 'A' ? ' (you)' : '');
    labelBEl.textContent = 'Boat B' + (myBoatKey(state) === 'B' ? ' (you)' : '');
    labelAEl.className = myBoatKey(state) === 'A' ? 'mine' : '';
    labelBEl.className = myBoatKey(state) === 'B' ? 'mine' : '';
    renderTrack(fillAEl, markerAEl, state.boats.A);
    renderTrack(fillBEl, markerBEl, state.boats.B);

    const role = myRole(state);
    const boatKey = myBoatKey(state);
    const boat = boatKey ? state.boats[boatKey] : null;

    leaderPanelEl.classList.toggle('hidden', role !== 'leader');
    drummerPanelEl.classList.toggle('hidden', role !== 'drummer');
    rowerPanelEl.classList.toggle('hidden', role !== 'rower');

    turnResultsEl.innerHTML = '';
    if (boat) {
      boat.lastTurnResults.forEach((t) => {
        const span = document.createElement('span');
        span.className = t.correct ? 'correct' : 'wrong';
        span.textContent = t.correct ? '✅' : '❌';
        turnResultsEl.appendChild(span);
      });
    }

    if (role === 'leader' && boat) {
      const next = boat.upcomingTruth && boat.upcomingTruth[0];
      upcomingDirEl.textContent = next ? DIR_ARROWS[next] : '…';
      leaderStreakEl.textContent = boat.leaderProgress ? boat.leaderProgress.streak : 0;
      leaderStreakTargetEl.textContent = boat.leaderProgress ? boat.leaderProgress.target : 5;
      leaderEnergyValueEl.textContent = Math.round(boat.leader.energy);
      leaderEnergyBarEl.style.width = boat.leader.energy + '%';
      leaderEnergyBarEl.classList.toggle('low', boat.leader.energy < 30);
      const stunned = boat.leader.stunnedUntil > Date.now();
      leaderStunnedEl.classList.toggle('hidden', !stunned);
    }

    if (role === 'drummer' && boat) {
      const phase = boat.rowCycle.phase;
      const phaseLabels = { waiting: 'Waiting for the crew…', raise: 'Giơ mái chèo', active: 'Đập / Chèo nước', cooldown: 'Rút mái chèo' };
      drumPhaseBannerEl.textContent = phaseLabels[phase] || phase;
      drumPhaseBannerEl.className = 'row-phase-banner ' + phase;
      const effect = (state.drumTapEffects && state.drumTapEffects[phase]) || 0;
      drumEffectLabelEl.textContent = `Tap now: ${effect >= 0 ? '+' : ''}${effect} energy`;
      drumEffectLabelEl.className = 'drum-effect-label' + (effect > 0 ? ' positive' : effect < 0 ? ' negative' : '');
    }

    if (role === 'rower' && boat) {
      queueStripEl.innerHTML = '';
      const shown = [boat.rowCycle.currentDirection, ...boat.queue].filter((v, i) => i < 4);
      for (let i = 0; i < 4; i += 1) {
        const chip = document.createElement('div');
        const dir = shown[i];
        chip.className = 'queue-chip' + (i === 0 && dir ? ' current' : '') + (dir ? '' : ' empty');
        chip.textContent = dir ? DIR_ARROWS[dir] : '·';
        queueStripEl.appendChild(chip);
      }
      const phase = boat.rowCycle.phase;
      const phaseLabels = { waiting: 'Waiting for a call…', raise: 'Giơ mái chèo — get ready!', active: 'CHÈO NƯỚC — hold the direction!', cooldown: 'Rút mái chèo — recovering…' };
      rowPhaseBannerEl.textContent = phaseLabels[phase] || phase;
      rowPhaseBannerEl.className = 'row-phase-banner ' + phase;

      const slotIndex = state.yourAssignment.slotIndex;
      const rower = boat.rowers[slotIndex];
      rowerEnergyValueEl.textContent = Math.round(rower.energy);
      rowerEnergyBarEl.style.width = rower.energy + '%';
      rowerEnergyBarEl.classList.toggle('low', rower.energy < 30);
      const stunned = rower.stunnedUntil > Date.now();
      rowerStunnedEl.classList.toggle('hidden', !stunned);
    }

    renderLog(raceLogEl, state.log);
  }

  // Ticks independently of the ~100ms server broadcast so the millisecond
  // countdowns (and cooldown-driven button disabling) read as genuinely
  // live -- all the values it reads are absolute timestamps from the last
  // server state, so recomputing "target - now" every 50ms locally stays
  // accurate between broadcasts instead of visibly stepping in 100ms jumps.
  function updateCountdowns() {
    if (!latestState || latestState.status !== 'racing') return;
    const boatKey = myBoatKey(latestState);
    if (!boatKey) return;
    const boat = latestState.boats[boatKey];
    const role = myRole(latestState);
    const now = Date.now();

    if (role === 'rower') {
      const remaining = Math.max(0, Math.round(boat.rowCycle.phaseEndsAt - now));
      rowPhaseCountdownEl.textContent = `${remaining} ms`;
      const stunned = boat.rowers[latestState.yourAssignment.slotIndex].stunnedUntil > now;
      holdLeftBtn.disabled = stunned;
      holdRightBtn.disabled = stunned;
    }

    if (role === 'drummer') {
      const remaining = Math.max(0, Math.round(boat.rowCycle.phaseEndsAt - now));
      drumPhaseCountdownEl.textContent = `${remaining} ms`;
      drumTapBtn.disabled = boat.drummer.nextTapReadyAt > now;
    }

    if (role === 'leader' && boat.leaderProgress) {
      const remaining = Math.max(0, Math.round(boat.leaderProgress.nextSignalReadyAt - now));
      const stunned = boat.leader.stunnedUntil > now;
      leaderCooldownLabelEl.textContent = stunned ? '' : remaining > 0 ? `Next call in ${remaining} ms` : 'Ready to call!';
      document.querySelectorAll('.flag-btn').forEach((btn) => { btn.disabled = stunned || remaining > 0; });
    }
  }
  setInterval(updateCountdowns, 50);

  function renderFinished(state) {
    const boatKey = myBoatKey(state);
    const boat = boatKey ? state.boats[boatKey] : null;
    const wonMine = boat && boat.finishRank === 1;
    finishTitleEl.textContent = boatKey ? (wonMine ? `🏆 Boat ${boatKey} wins!` : `Boat ${boatKey} finished #${boat.finishRank}`) : '🏁 Race finished!';
    const aRank = state.boats.A.finishRank;
    const bRank = state.boats.B.finishRank;
    finishDetailEl.textContent = `Boat A: rank #${aRank || '?'} · Boat B: rank #${bRank || '?'}`;
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
    } else if (latestState.status === 'racing') {
      renderRace(latestState);
      showScreen('racing');
    } else if (latestState.status === 'finished') {
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
    socket.emit('boat:listRooms', {}, (res) => {
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
    socket.emit('boat:joinRoom', { roomId, password, playerId: me.id, name: me.name }, (res) => {
      if (res && res.ok) {
        closePasswordModal();
        enterRoom(roomId);
      } else if (res && res.error === 'wrong-password') {
        passwordErrorEl.textContent = 'Wrong password — try again.';
        passwordErrorEl.style.display = 'block';
      } else {
        closePasswordModal();
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
    const teamSize = Number(document.querySelector('input[name="team-size"]:checked').value);
    socket.emit('boat:createRoom', { roomName, password, playerId: me.id, name: me.name, teamSize }, (res) => {
      if (res && res.ok) {
        enterRoom(res.roomId);
      } else {
        createRoomErrorEl.textContent = res && res.error === 'name-taken' ? 'That room name is taken.' : 'Could not create the room.';
        createRoomErrorEl.style.display = 'block';
      }
    });
  });

  addBotsBtn.addEventListener('click', () => {
    socket.emit('boat:addBots', {}, () => {});
  });
  startBtn.addEventListener('click', () => {
    socket.emit('boat:start', {}, () => {});
  });
  leaveWaitingBtn.addEventListener('click', () => {
    socket.emit('boat:leave', {}, () => backToLobby());
  });
  leaveRaceBtn.addEventListener('click', () => {
    socket.emit('boat:leave', {}, () => backToLobby());
  });
  newRaceBtn.addEventListener('click', () => {
    // The room resets back to 'waiting' server-side isn't automatic here --
    // simplest correct behavior is just returning to the hub-level lobby to
    // start or join a fresh room.
    backToLobby();
  });

  // -- Leader: flag buttons ------------------------------------------------
  document.querySelectorAll('.flag-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      socket.emit('boat:leaderSignal', { direction: btn.dataset.dir }, () => {});
    });
  });

  // -- Drummer: tap button + Space key ------------------------------------
  function drumTap() {
    socket.emit('boat:drumTap', {}, () => {});
    drumTapBtn.classList.add('pressed');
    setTimeout(() => drumTapBtn.classList.remove('pressed'), 120);
  }
  drumTapBtn.addEventListener('click', drumTap);

  // -- Rower: hold buttons (pointer + Space for "left") -------------------
  function setHold(side, pressed) {
    socket.emit('boat:rowerHold', { side, pressed }, () => {});
    const btn = side === 'left' ? holdLeftBtn : holdRightBtn;
    btn.classList.toggle('pressed', pressed);
  }
  function wireHold(btn, side) {
    const start = (e) => { e.preventDefault(); setHold(side, true); };
    const end = (e) => { e.preventDefault(); setHold(side, false); };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointerleave', end);
    btn.addEventListener('pointercancel', end);
  }
  wireHold(holdLeftBtn, 'left');
  wireHold(holdRightBtn, 'right');

  let spaceHeld = false;
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || spaceHeld) return;
    spaceHeld = true;
    if (!latestState || !joined) return;
    const role = myRole(latestState);
    if (role === 'rower') setHold('left', true);
    else if (role === 'drummer') drumTap();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    spaceHeld = false;
    if (!latestState || !joined) return;
    if (myRole(latestState) === 'rower') setHold('left', false);
  });

  socket.on('boat:rooms', (rooms) => {
    latestRooms = rooms;
    if (!joined) render();
  });

  socket.on('boat:state', (state) => {
    latestState = state;
    render();
  });

  socket.on('connect', () => {
    const lastRoomId = localStorage.getItem(LAST_ROOM_KEY);
    if (joined && latestState && latestState.roomId) {
      socket.emit('boat:joinRoom', { roomId: latestState.roomId, password: '', playerId: me.id, name: me.name }, (res) => {
        if (!res || !res.ok) backToLobby();
      });
    } else if (!joined && lastRoomId) {
      socket.emit('boat:joinRoom', { roomId: lastRoomId, password: '', playerId: me.id, name: me.name }, (res) => {
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
