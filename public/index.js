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

let latestLeaderboard = [];
let me = Festival.getPlayer();

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
}

function buildGameGrid() {
  gameGrid.innerHTML = '';
  const myEntry = latestLeaderboard.find((p) => p.id === me.id);
  window.FESTIVAL_GAMES.forEach((g) => {
    const tile = document.createElement('div');
    tile.className = 'game-tile';

    const best = myEntry ? myEntry.scores[g.key] || 0 : 0;
    tile.innerHTML = `
      <div class="icon">${g.icon}</div>
      <h3>${g.title}</h3>
      <p>${g.blurb}</p>
      <div class="actions">
        <button class="play-btn">Play</button>
        <button class="secondary rules-btn">Rules</button>
      </div>
      <div class="best">${best ? 'Your best: ' + best : ''}</div>
    `;
    tile.querySelector('.play-btn').addEventListener('click', () => {
      window.location.href = g.page;
    });
    tile.querySelector('.rules-btn').addEventListener('click', () => openRules(g));
    gameGrid.appendChild(tile);
  });
}

function openRules(g) {
  rulesTitle.textContent = `${g.icon} ${g.title}`;
  rulesBody.innerHTML = g.rules.map((r) => `<li>${r}</li>`).join('');
  rulesModal.classList.remove('hidden');
}

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
  Festival.renderLeaderboard(leaderboardList, entries, { myId: me.id, limit: 5 });
  if (!hubScreen.classList.contains('hidden')) buildGameGrid();
});

if (me.name) {
  showHub();
  Festival.register(socket);
} else {
  showNameScreen();
}
