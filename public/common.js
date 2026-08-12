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

  // Reserves one lifetime attempt for `game` before the caller may start play.
  // Resolves { ok:true, attemptsUsed, attemptsMax } or { ok:false, error, ... }.
  function requestAttempt(s, game) {
    const { id, name } = getPlayer();
    return new Promise((resolve) => {
      s.emit('game:start-attempt', { playerId: id, name, game }, (res) => resolve(res || { ok: false, error: 'no response' }));
    });
  }

  // Fire-and-forget anti-cheat signal for the admin panel — never blocks play.
  function reportCheat(s, game, reason, detail) {
    const { id, name } = getPlayer();
    s.emit('cheat:flag', { playerId: id, name, game, reason, detail });
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

  function formatCountdown(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Blocks a game page behind an overlay until the admin opens THAT game's
  // join window, then calls onOpen(). Gameplay already in progress is never
  // interrupted if the window later closes — the overlay only reappears
  // if the caller explicitly asks via the returned block() (e.g. a
  // "Play Again" click after the window has closed). Whenever the overlay
  // is showing and the window opens (initially, or after a later re-open),
  // onOpen() fires again automatically. Assumes it's called from a page one
  // directory below the site root (public/games/*.html), matching the
  // "../index.html" link below.
  function gateGame(s, game, onOpen) {
    let blocking = false;
    let overlay = null;
    let latestState = { isOpen: false, openedAt: null, closesAt: null };

    function render() {
      if (!overlay) return;
      const title = overlay.querySelector('.gate-title');
      const sub = overlay.querySelector('.gate-sub');
      if (latestState.openedAt && !latestState.isOpen) {
        title.textContent = 'Joining window has closed';
        sub.textContent = 'Ask the admin to open a new round.';
      } else {
        title.textContent = 'Waiting for the admin to open this game...';
        sub.textContent = "You'll be let in automatically — no need to refresh.";
      }
    }

    function showOverlay() {
      blocking = true;
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'gate-overlay';
        overlay.innerHTML =
          '<div class="gate-card">' +
          '<div class="gate-icon">🔒</div>' +
          '<h2 class="gate-title"></h2>' +
          '<p class="gate-sub"></p>' +
          '<a href="../index.html" class="gate-back">← Back to Hub</a>' +
          '</div>';
        document.body.appendChild(overlay);
      }
      render();
    }

    function hideOverlay() {
      blocking = false;
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
    }

    function handleState(state) {
      latestState = state;
      if (blocking) render();
      if (state.isOpen && blocking) {
        hideOverlay();
        onOpen();
      }
    }

    s.on('game-window', (state) => {
      if (state.game === game) handleState(state);
    });
    s.on('game-window-all', (all) => {
      if (all[game]) handleState(all[game]);
    });

    showOverlay();

    return {
      isOpen: () => latestState.isOpen,
      block: () => showOverlay(),
    };
  }

  return {
    getPlayer,
    setName,
    requireNameOrRedirect,
    connect,
    register,
    submitScore,
    requestAttempt,
    reportCheat,
    renderLeaderboard,
    renderGameLeaderboard,
    formatCountdown,
    gateGame,
    GAME_LABELS,
  };
})();
