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
    gameWindowStates[g.key] = gameWindowStates[g.key] || { game: g.key, isOpen: false, openedAt: null, closesAt: null };

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h3 style="text-align:center; margin-top:0;">${g.icon} ${g.title}</h3>
      <div class="admin-status closed" data-role="status">🔒 Closed</div>
      <div class="admin-actions">
        <button data-role="open">▶ Open (2 min)</button>
        <button data-role="close" class="danger" disabled>■ Close Now</button>
        <button data-role="reset-attempts" class="secondary">↺ Reset Attempts</button>
      </div>
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
}

function showResetNote(game, playerCount) {
  const card = cardEls[game];
  if (!card) return;
  const statusEl = card.querySelector('[data-role="status"]');
  statusEl.textContent = `↺ Attempts reset for ${playerCount} player${playerCount === 1 ? '' : 's'}`;
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

const savedPassword = localStorage.getItem(PASSWORD_KEY);
if (savedPassword) {
  attemptLogin(savedPassword);
} else {
  showLogin();
}
