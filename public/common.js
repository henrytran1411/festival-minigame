// Shared identity, socket, and leaderboard-rendering helpers used by every page.
window.Festival = (function () {
  const ID_KEY = 'festival_player_id';
  const NAME_KEY = 'festival_player_name';
  const GAME_LABELS = { sudoku: 'Sudoku', scramble: 'Word Scramble', memory: 'Memory Match', proverb: 'Ca Dao Đố Vui' };

  function makeId() {
    return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function getPlayer() {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = makeId();
      localStorage.setItem(ID_KEY, id);
    }
    const name = localStorage.getItem(NAME_KEY) || '';
    return { id, name };
  }

  function setName(name) {
    localStorage.setItem(NAME_KEY, name);
  }

  function requireNameOrRedirect() {
    const { name } = getPlayer();
    if (!name) {
      window.location.href = 'index.html';
      return null;
    }
    return getPlayer();
  }

  let socket = null;
  function connect() {
    if (!socket) socket = io();
    return socket;
  }

  function register(s) {
    const { id, name } = getPlayer();
    s.emit('register', { playerId: id, name });
  }

  function submitScore(s, game, score) {
    const { id, name } = getPlayer();
    s.emit('score:submit', { playerId: id, name, game, score });
  }

  function medalClass(rank) {
    if (rank === 0) return 'gold';
    if (rank === 1) return 'silver';
    if (rank === 2) return 'bronze';
    return '';
  }

  function renderLeaderboard(listEl, entries, { myId = null, showBreakdown = false, limit = null } = {}) {
    listEl.innerHTML = '';
    const rows = limit ? entries.slice(0, limit) : entries;
    rows.forEach((p, i) => {
      const li = document.createElement('li');
      if (p.id === myId) li.classList.add('me');

      const rank = document.createElement('span');
      rank.className = 'rank ' + medalClass(i);
      rank.textContent = String(i + 1);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      if (showBreakdown) {
        const breakdown = document.createElement('div');
        breakdown.className = 'breakdown';
        breakdown.textContent = Object.keys(GAME_LABELS)
          .map((g) => `${GAME_LABELS[g]}: ${p.scores[g] || 0}`)
          .join(' · ');
        name.appendChild(breakdown);
      }

      const total = document.createElement('span');
      total.className = 'total';
      total.textContent = p.total;

      li.append(rank, name, total);
      listEl.appendChild(li);
    });
  }

  function renderGameLeaderboard(listEl, entries, gameKey, { myId = null, limit = 10 } = {}) {
    const rows = entries
      .filter((p) => (p.scores[gameKey] || 0) > 0)
      .slice()
      .sort((a, b) => (b.scores[gameKey] || 0) - (a.scores[gameKey] || 0) || a.name.localeCompare(b.name))
      .slice(0, limit);

    listEl.innerHTML = '';
    rows.forEach((p, i) => {
      const li = document.createElement('li');
      if (p.id === myId) li.classList.add('me');

      const rank = document.createElement('span');
      rank.className = 'rank ' + medalClass(i);
      rank.textContent = String(i + 1);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;

      const score = document.createElement('span');
      score.className = 'total';
      score.textContent = p.scores[gameKey] || 0;

      li.append(rank, name, score);
      listEl.appendChild(li);
    });
  }

  return { getPlayer, setName, requireNameOrRedirect, connect, register, submitScore, renderLeaderboard, renderGameLeaderboard, GAME_LABELS };
})();
