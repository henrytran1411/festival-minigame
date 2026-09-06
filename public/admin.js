const PASSWORD_KEY = 'festival_admin_password';

const loginScreen = document.getElementById('login-screen');
const panelScreen = document.getElementById('panel-screen');
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const playerCountEl = document.getElementById('player-count');
const gameControlsEl = document.getElementById('game-controls');
const flagsListEl = document.getElementById('flags-list');
const flagsEmptyEl = document.getElementById('flags-empty');
const seedDemoBtn = document.getElementById('seed-demo-btn');
const clearDemoBtn = document.getElementById('clear-demo-btn');
const demoStatusEl = document.getElementById('demo-status');
const revealButtonsEl = document.getElementById('reveal-buttons');
const revealStatusEl = document.getElementById('reveal-status');

const REASON_LABELS = {
  'tab-switch': '🚫 Left tab/window',
  'brute-force': '🎲 Brute-force guessing',
  'impossible-speed': '⚡ Implausible solve speed',
  'ai-assist-suspected': '🤖 Suspected outside help',
};

function renderFlag(flag) {
  const li = document.createElement('li');
  li.style.padding = '8px 0';
  li.style.borderBottom = '1px solid var(--border, #333)';
  li.style.fontSize = '13px';
  const time = new Date(flag.at).toLocaleTimeString();
  li.innerHTML = `<b>${flag.name}</b> · ${flag.game} · ${REASON_LABELS[flag.reason] || flag.reason} <span style="color: var(--muted);">(${time})</span>` +
    (flag.detail ? `<div style="color: var(--muted); margin-top:2px;">${flag.detail}</div>` : '');
  return li;
}

function addFlag(flag) {
  flagsEmptyEl.classList.add('hidden');
  flagsListEl.prepend(renderFlag(flag));
}

function setFlags(flags) {
  flagsListEl.innerHTML = '';
  if (!flags || flags.length === 0) {
    flagsEmptyEl.classList.remove('hidden');
    return;
  }
  flagsEmptyEl.classList.add('hidden');
  flags.forEach((flag) => flagsListEl.appendChild(renderFlag(flag)));
}

const socket = Festival.connect();
const gameWindowStates = {};
let tickHandle = null;

function showPanel() {
  loginScreen.classList.add('hidden');
  panelScreen.classList.remove('hidden');
}

function showLogin(message) {
  panelScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  loginError.classList.toggle('hidden', !message);
  passwordInput.focus();
}

function attemptLogin(password) {
  socket.emit('admin:login', { password }, (res) => {
    if (res && res.ok) {
      localStorage.setItem(PASSWORD_KEY, password);
      if (res.state) {
        Object.values(res.state).forEach((state) => {
          gameWindowStates[state.game] = state;
        });
      }
      setFlags(res.flags);
      showPanel();
      renderAll();
      refreshTicking();
    } else {
      localStorage.removeItem(PASSWORD_KEY);
      showLogin('Wrong password.');
    }
  });
}

loginBtn.addEventListener('click', () => {
  const password = passwordInput.value;
  if (!password) return;
  attemptLogin(password);
});
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click();
});

const cardEls = {};

function buildGameCards() {
  gameControlsEl.innerHTML = '';
  window.FESTIVAL_GAMES.forEach((g) => {
    gameWindowStates[g.key] = gameWindowStates[g.key] || { game: g.key, isOpen: false, openedAt: null, closesAt: null, hidden: false, tournamentHidden: false };

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h3 style="text-align:center; margin-top:0;">${g.icon} ${g.title}</h3>
      <div class="admin-status closed" data-role="status">🔒 Closed</div>
      <div class="admin-status" data-role="hidden-status" style="color: var(--muted); font-size: 12px;"></div>
      <div class="admin-actions">
        <button data-role="open">▶ Open (5 min)</button>
        <button data-role="close" class="danger" disabled>■ Close Now</button>
      </div>
      <div class="admin-actions">
        <button data-role="toggle-hidden" class="secondary">🙈 Hide from Players</button>
        <button data-role="reset-attempts" class="secondary">↺ Reset Attempts</button>
      </div>
      ${g.hasTournamentMode ? `
      <div class="admin-actions">
        <button data-role="toggle-tournament" class="secondary">🏆 Hide Tournament Mode</button>
        <button data-role="new-tournament-round" class="secondary">🎲 New Tournament Round</button>
      </div>
      <div class="admin-status" data-role="round-status" style="color: var(--muted); font-size: 12px;"></div>
      <div class="admin-actions">
        <button data-role="tournament-start" class="secondary">▶️ Start Tournament</button>
        ${g.tournament ? '<button data-role="tournament-next" class="secondary" disabled>⏭ Next Question</button>' : ''}
      </div>` : ''}
    `;
    card.querySelector('[data-role="open"]').addEventListener('click', () => {
      socket.emit('admin:open', { game: g.key }, (res) => {
        if (res && res.ok) applyState(res.state);
      });
    });
    card.querySelector('[data-role="close"]').addEventListener('click', () => {
      socket.emit('admin:close', { game: g.key }, (res) => {
        if (res && res.ok) applyState(res.state);
      });
    });
    card.querySelector('[data-role="toggle-hidden"]').addEventListener('click', () => {
      const currentlyHidden = Boolean(gameWindowStates[g.key].hidden);
      socket.emit('admin:set-hidden', { game: g.key, hidden: !currentlyHidden }, (res) => {
        if (res && res.ok) applyState(res.state);
      });
    });
    if (g.hasTournamentMode) {
      card.querySelector('[data-role="toggle-tournament"]').addEventListener('click', () => {
        const currentlyHidden = Boolean(gameWindowStates[g.key].tournamentHidden);
        socket.emit('admin:set-tournament-hidden', { game: g.key, hidden: !currentlyHidden }, (res) => {
          if (res && res.ok) applyState(res.state);
        });
      });
    }
    if (g.hasTournamentMode) {
      card.querySelector('[data-role="new-tournament-round"]').addEventListener('click', () => {
        socket.emit('admin:new-tournament-round', { game: g.key }, (res) => {
          if (res && res.ok) showResetNote(g.key, null, '🎲 New tournament round ready — resets the lobby for new Tournament joins.');
        });
      });
      card.querySelector('[data-role="tournament-start"]').addEventListener('click', () => {
        socket.emit('admin:tournament-start', { game: g.key }, (res) => {
          if (!res || !res.ok) alert('Could not start the tournament: ' + ((res && res.error) || 'unknown error'));
        });
      });
      const nextBtn = card.querySelector('[data-role="tournament-next"]');
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          socket.emit('admin:tournament-next', { game: g.key }, (res) => {
            if (!res || !res.ok) alert('Could not advance the tournament: ' + ((res && res.error) || 'unknown error'));
          });
        });
      }
    }
    card.querySelector('[data-role="reset-attempts"]').addEventListener('click', () => {
      socket.emit('admin:reset-attempts', { game: g.key }, (res) => {
        if (res && res.ok) showResetNote(g.key, res.playerCount);
      });
    });
    cardEls[g.key] = card;
    gameControlsEl.appendChild(card);
  });
}

function renderCard(game) {
  const card = cardEls[game];
  if (!card) return;
  const state = gameWindowStates[game];
  const isOpen = state.closesAt !== null && Date.now() < state.closesAt;
  const statusEl = card.querySelector('[data-role="status"]');
  const closeBtn = card.querySelector('[data-role="close"]');
  closeBtn.disabled = !isOpen;

  if (isOpen) {
    statusEl.className = 'admin-status open';
    statusEl.textContent = `🔓 Open — closes in ${Festival.formatCountdown(state.closesAt - Date.now())}`;
  } else if (state.openedAt) {
    statusEl.className = 'admin-status closed';
    statusEl.textContent = '🔒 Closed (window expired)';
  } else {
    statusEl.className = 'admin-status closed';
    statusEl.textContent = '🔒 Closed';
  }

  const hiddenStatusEl = card.querySelector('[data-role="hidden-status"]');
  const toggleHiddenBtn = card.querySelector('[data-role="toggle-hidden"]');
  hiddenStatusEl.textContent = state.hidden ? '🙈 Hidden from index page ("Open later")' : '';
  toggleHiddenBtn.textContent = state.hidden ? '👁 Show to Players' : '🙈 Hide from Players';

  const toggleTournamentBtn = card.querySelector('[data-role="toggle-tournament"]');
  if (toggleTournamentBtn) {
    toggleTournamentBtn.textContent = state.tournamentHidden ? '🏆 Show Tournament Mode' : '🏆 Hide Tournament Mode';
  }
}

// game -> { phase, questionIndex, totalQuestions, playerCount }, only for
// tournament-capable games -- see server.js's tournamentRound.
const tournamentRoundStates = {};

function renderTournamentRound(game) {
  const card = cardEls[game];
  if (!card) return;
  const statusEl = card.querySelector('[data-role="round-status"]');
  const startBtn = card.querySelector('[data-role="tournament-start"]');
  const nextBtn = card.querySelector('[data-role="tournament-next"]'); // absent for Sudoku/Memory -- single-stage
  if (!statusEl || !startBtn) return;
  const state = tournamentRoundStates[game];
  if (!state) return;

  if (state.phase === 'lobby') {
    statusEl.textContent = `🏟 Lobby — ${state.playerCount} player${state.playerCount === 1 ? '' : 's'} waiting to start`;
    startBtn.disabled = false;
    if (nextBtn) {
      nextBtn.disabled = true;
      nextBtn.textContent = '⏭ Next Question';
    }
  } else {
    startBtn.disabled = true;
    if (nextBtn) {
      const isLast = state.questionIndex + 1 >= state.totalQuestions;
      statusEl.textContent = `▶️ Question ${state.questionIndex + 1} of ${state.totalQuestions} in progress — ${state.playerCount} joined`;
      nextBtn.disabled = isLast;
      nextBtn.textContent = isLast ? '⏭ Last Question' : '⏭ Next Question';
    } else {
      // Sudoku/Memory: no staged questions -- players just play their own
      // puzzle/board at their own pace once released from the lobby.
      statusEl.textContent = `▶️ In progress — ${state.playerCount} joined`;
    }
  }
}

function applyRoundState(state) {
  tournamentRoundStates[state.game] = state;
  renderTournamentRound(state.game);
}

function showResetNote(game, playerCount, customMessage) {
  const card = cardEls[game];
  if (!card) return;
  const statusEl = card.querySelector('[data-role="status"]');
  statusEl.textContent = customMessage || `↺ Attempts reset for ${playerCount} player${playerCount === 1 ? '' : 's'}`;
  setTimeout(() => renderCard(game), 2500);
}

function renderAll() {
  window.FESTIVAL_GAMES.forEach((g) => renderCard(g.key));
}

function anyOpen() {
  return window.FESTIVAL_GAMES.some((g) => {
    const state = gameWindowStates[g.key];
    return state && state.closesAt !== null && Date.now() < state.closesAt;
  });
}

function refreshTicking() {
  clearInterval(tickHandle);
  if (anyOpen()) tickHandle = setInterval(renderAll, 1000);
}

function applyState(state) {
  gameWindowStates[state.game] = state;
  renderCard(state.game);
  refreshTicking();
}

seedDemoBtn.addEventListener('click', () => {
  socket.emit('admin:seed-demo-data', {}, (res) => {
    demoStatusEl.textContent = res && res.ok ? `Seeded ${res.count} demo players.` : 'Failed to seed demo data.';
  });
});
clearDemoBtn.addEventListener('click', () => {
  socket.emit('admin:clear-demo-data', {}, (res) => {
    demoStatusEl.textContent = res && res.ok ? `Removed ${res.removed} demo players.` : 'Failed to clear demo data.';
  });
});

function triggerReveal(board, label) {
  socket.emit('admin:reveal-results', { board }, (res) => {
    revealStatusEl.textContent = res && res.ok
      ? `Revealing ${label} now on the big-screen leaderboard...`
      : `Failed to reveal ${label}.`;
  });
}

function buildRevealButtons() {
  revealButtonsEl.innerHTML = '';
  window.FESTIVAL_GAMES.forEach((g) => {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = `${g.icon} ${g.title}`;
    btn.addEventListener('click', () => triggerReveal(g.key, g.title));
    revealButtonsEl.appendChild(btn);
  });

  const overallBtn = document.createElement('button');
  overallBtn.textContent = '🏆 Overall';
  overallBtn.addEventListener('click', () => triggerReveal('overall', 'Overall'));
  revealButtonsEl.appendChild(overallBtn);
}

buildRevealButtons();
buildGameCards();

socket.on('game-window', (state) => applyState(state));
socket.on('game-window-all', (all) => {
  Object.values(all).forEach((state) => {
    gameWindowStates[state.game] = state;
  });
  renderAll();
  refreshTicking();
});
socket.on('leaderboard', (entries) => {
  playerCountEl.textContent = `${entries.length} player${entries.length === 1 ? '' : 's'} registered`;
});
socket.on('admin:cheat-flag', (flag) => addFlag(flag));
socket.on('tournament:round-state', (state) => applyRoundState(state));
socket.on('tournament:round-state-all', (all) => {
  Object.values(all).forEach((state) => applyRoundState(state));
});

const savedPassword = localStorage.getItem(PASSWORD_KEY);
if (savedPassword) {
  attemptLogin(savedPassword);
} else {
  showLogin();
}
