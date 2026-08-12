const leaderboardList = document.getElementById('leaderboard-list');
const emptyMsg = document.getElementById('empty-msg');
const gameBoardsEl = document.getElementById('game-boards');

const gameListEls = {};
window.FESTIVAL_GAMES.forEach((g) => {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<h3>${g.icon} ${g.title} — Top 10</h3><ul class="leaderboard-list"></ul>`;
  gameListEls[g.key] = card.querySelector('ul');
  gameBoardsEl.appendChild(card);
});

const socket = Festival.connect();
socket.on('leaderboard', (entries) => {
  const withScores = entries.filter((p) => p.total > 0);
  emptyMsg.classList.toggle('hidden', withScores.length > 0);
  Festival.renderLeaderboard(leaderboardList, withScores, { showBreakdown: true, limit: 10 });

  window.FESTIVAL_GAMES.forEach((g) => {
    Festival.renderGameLeaderboard(gameListEls[g.key], entries, g.key, { limit: 10 });
  });
});
