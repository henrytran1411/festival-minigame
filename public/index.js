const nameScreen = document.getElementById('name-screen');
const hubScreen = document.getElementById('hub-screen');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const whoName = document.getElementById('who-name');
const changeNameLink = document.getElementById('change-name');
const gameGrid = document.getElementById('game-grid');
const leaderboardList = document.getElementById('leaderboard-list');
const rulesModal = document.getElementById('rules-modal');
const rulesTitle = document.getElementById('rules-title');
const rulesBody = document.getElementById('rules-body');
const avatarOptionsEl = document.getElementById('avatar-options');
const avatarUploadInputEl = document.getElementById('avatar-upload-input');
const avatarErrorEl = document.getElementById('avatar-error');

let latestLeaderboard = [];
let me = Festival.getPlayer();
let currentAvatar = Festival.getAvatar();

const AVATAR_MAX_DATA_URL_LENGTH = 190000; // stays under server.js's 200,000-char cap with room to spare
const AVATAR_THUMBNAIL_SIZE = 160;

function setAvatarError(message) {
  avatarErrorEl.textContent = message || '';
  avatarErrorEl.classList.toggle('hidden', !message);
}

function applyAvatar(avatar) {
  currentAvatar = avatar;
  Festival.setAvatar(avatar);
  Festival.setAvatarOnServer(socket, avatar).then((res) => {
    if (!res.ok) setAvatarError("Couldn't save that avatar — try a different photo.");
  });
  renderAvatarPicker();
}

function renderAvatarPicker() {
  avatarOptionsEl.innerHTML = '';
  Festival.AVATAR_PRESETS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-option' + (currentAvatar && currentAvatar.type === 'preset' && currentAvatar.key === preset.key ? ' selected' : '');
    btn.title = preset.label;
    const img = document.createElement('img');
    img.src = encodeURI(preset.image);
    img.alt = preset.label;
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      setAvatarError('');
      applyAvatar({ type: 'preset', key: preset.key });
    });
    avatarOptionsEl.appendChild(btn);
  });

  const uploadTile = document.createElement('button');
  uploadTile.type = 'button';
  const isUpload = currentAvatar && currentAvatar.type === 'upload';
  uploadTile.className = 'avatar-upload-option' + (isUpload ? ' selected' : '');
  uploadTile.title = 'Upload your own photo';
  if (isUpload) {
    const img = document.createElement('img');
    img.src = currentAvatar.src;
    img.alt = 'Your photo';
    uploadTile.appendChild(img);
  } else {
    uploadTile.textContent = '📷';
  }
  uploadTile.addEventListener('click', () => avatarUploadInputEl.click());
  avatarOptionsEl.appendChild(uploadTile);
}

function downscaleImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read-failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode-failed'));
      img.onload = () => {
        const size = AVATAR_THUMBNAIL_SIZE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Cover-crop: scale so the shorter side fills the square, centered.
        const scale = Math.max(size / img.width, size / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        ctx.drawImage(img, (size - drawW) / 2, (size - drawH) / 2, drawW, drawH);
        let dataUrl = null;
        for (const quality of [0.72, 0.5, 0.35, 0.2]) {
          const candidate = canvas.toDataURL('image/jpeg', quality);
          if (candidate.length <= AVATAR_MAX_DATA_URL_LENGTH) { dataUrl = candidate; break; }
        }
        if (!dataUrl) reject(new Error('too-large'));
        else resolve(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

avatarUploadInputEl.addEventListener('change', () => {
  const file = avatarUploadInputEl.files && avatarUploadInputEl.files[0];
  avatarUploadInputEl.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setAvatarError('Please choose an image file.');
    return;
  }
  setAvatarError('');
  downscaleImageToDataUrl(file).then((dataUrl) => {
    applyAvatar({ type: 'upload', src: dataUrl });
  }).catch(() => {
    setAvatarError("Couldn't use that photo — try a smaller or simpler image.");
  });
});

const gameWindowStates = {};
window.FESTIVAL_GAMES.forEach((g) => {
  gameWindowStates[g.key] = { isOpen: false, openedAt: null, closesAt: null, hidden: false };
});
let windowTickHandle = null;

function isGameOpen(key) {
  const state = gameWindowStates[key];
  return !!state && state.closesAt !== null && Date.now() < state.closesAt;
}

function anyGameOpen() {
  return window.FESTIVAL_GAMES.some((g) => isGameOpen(g.key));
}

function renderGridIfVisible() {
  if (!hubScreen.classList.contains('hidden')) buildGameGrid();
}

function refreshTicking() {
  clearInterval(windowTickHandle);
  if (anyGameOpen()) windowTickHandle = setInterval(renderGridIfVisible, 1000);
}

function applyGameWindowState(state) {
  gameWindowStates[state.game] = state;
  renderGridIfVisible();
  refreshTicking();
}

function showHub() {
  me = Festival.getPlayer();
  nameScreen.classList.add('hidden');
  hubScreen.classList.remove('hidden');
  whoName.textContent = me.name;
  buildGameGrid();
}

function showNameScreen() {
  hubScreen.classList.add('hidden');
  nameScreen.classList.remove('hidden');
  nameInput.value = me.name || '';
  nameInput.focus();
  setAvatarError('');
  renderAvatarPicker();
}

function buildGameGrid() {
  gameGrid.innerHTML = '';
  const myEntry = latestLeaderboard.find((p) => p.id === me.id);
  window.FESTIVAL_GAMES.forEach((g) => {
    const state = gameWindowStates[g.key];
    if (state && state.hidden) {
      const placeholder = document.createElement('div');
      placeholder.className = 'game-tile hidden-placeholder';
      placeholder.innerHTML = '<div class="open-later-label">Open later</div>';
      gameGrid.appendChild(placeholder);
      return;
    }

    const tile = document.createElement('div');
    tile.className = 'game-tile';

    const best = myEntry ? myEntry.scores[g.key] || 0 : 0;
    const open = isGameOpen(g.key);
    let statusText;
    if (open) {
      statusText = `🔓 Closes in ${Festival.formatCountdown(state.closesAt - Date.now())}`;
    } else if (state.openedAt) {
      statusText = '🔒 Closed';
    } else {
      statusText = '🔒 Not open yet';
    }
    tile.innerHTML = `
      <div class="icon">${g.icon}</div>
      <h3>${g.title}</h3>
      <p>${g.blurb}</p>
      <div class="tile-status ${open ? 'open' : 'closed'}">${statusText}</div>
      <div class="actions">
        <button class="play-btn" ${open ? '' : 'disabled'}>${open ? 'Play' : 'Locked'}</button>
        <button class="secondary rules-btn">Rules</button>
      </div>
      <div class="best">${best ? 'Your best: ' + best : ''}</div>
    `;
    tile.querySelector('.play-btn').addEventListener('click', () => {
      if (!isGameOpen(g.key)) return;
      window.location.href = g.page;
    });
    tile.querySelector('.rules-btn').addEventListener('click', () => openRules(g));
    gameGrid.appendChild(tile);
  });
}

let currentRulesGame = null;

function renderRulesBody() {
  if (!currentRulesGame) return;
  const lang = Festival.getRulesLang();
  const list = currentRulesGame.rules[lang] || currentRulesGame.rules.en;
  rulesBody.innerHTML = list.map((r) => `<li>${r}</li>`).join('');
  Festival.applyRulesLang(rulesModal, lang);
}

function openRules(g) {
  currentRulesGame = g;
  rulesTitle.textContent = `${g.icon} ${g.title}`;
  renderRulesBody();
  rulesModal.classList.remove('hidden');
}

rulesModal.querySelectorAll('.rules-lang-en').forEach((b) => b.addEventListener('click', () => {
  Festival.setRulesLang('en');
  renderRulesBody();
}));
rulesModal.querySelectorAll('.rules-lang-vi').forEach((b) => b.addEventListener('click', () => {
  Festival.setRulesLang('vi');
  renderRulesBody();
}));

rulesModal.querySelector('.modal-close').addEventListener('click', () => rulesModal.classList.add('hidden'));
rulesModal.addEventListener('click', (e) => {
  if (e.target === rulesModal) rulesModal.classList.add('hidden');
});

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  Festival.setName(name);
  Festival.register(socket);
  showHub();
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

changeNameLink.addEventListener('click', (e) => {
  e.preventDefault();
  showNameScreen();
});

const socket = Festival.connect();
socket.on('leaderboard', (entries) => {
  latestLeaderboard = entries;
  Festival.renderBlindTop(leaderboardList, entries, { myId: me.id, limit: 15, orderBy: 'recent' });
  if (!hubScreen.classList.contains('hidden')) buildGameGrid();
});
socket.on('game-window', (state) => applyGameWindowState(state));
socket.on('game-window-all', (all) => {
  Object.values(all).forEach((state) => {
    gameWindowStates[state.game] = state;
  });
  renderGridIfVisible();
  refreshTicking();
});

if (me.name) {
  showHub();
  Festival.register(socket);
} else {
  showNameScreen();
}
