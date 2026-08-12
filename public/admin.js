const PASSWORD_KEY = 'festival_admin_password';

const loginScreen = document.getElementById('login-screen');
const panelScreen = document.getElementById('panel-screen');
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const playerCountEl = document.getElementById('player-count');
const gameControlsEl = document.getElementById('game-controls');

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

const savedPassword = localStorage.getItem(PASSWORD_KEY);
if (savedPassword) {
  attemptLogin(savedPassword);
} else {
  showLogin();
}
