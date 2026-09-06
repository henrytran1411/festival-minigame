// Shared identity, socket, and leaderboard-rendering helpers used by every page.
window.Festival = (function () {
  const ID_KEY = 'festival_player_id';
  const NAME_KEY = 'festival_player_name';
  const AVATAR_KEY = 'festival_player_avatar';
  const GAME_LABELS = { sudoku: 'Sudoku', scramble: 'Word Scramble', memory: 'Memory Match', proverb: 'Ca Dao Đố Vui' };

  // The 4 Mid-Autumn folklore characters already illustrated for Đuổi Niên
  // Thú (see nien-server.js's CHARACTERS) -- reused here as preset avatar
  // choices so there's only one set of character art in the project.
  const AVATAR_PRESETS = [
    { key: 'chiHang', label: 'Chị Hằng', image: '/games/nienmonster/characters/chị hằng.png' },
    { key: 'chuCuoi', label: 'Chú Cuội', image: '/games/nienmonster/characters/chú cuội.png' },
    { key: 'ongDia', label: 'Ông Địa', image: '/games/nienmonster/characters/ông địa.png' },
    { key: 'thoNgoc', label: 'Thỏ Ngọc', image: '/games/nienmonster/characters/thỏ ngọc.png' },
  ];

  function makeId() {
    return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function getAvatar() {
    const raw = localStorage.getItem(AVATAR_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function setAvatar(avatar) {
    if (avatar) localStorage.setItem(AVATAR_KEY, JSON.stringify(avatar));
    else localStorage.removeItem(AVATAR_KEY);
  }

  // Resolves an avatar object (preset or uploaded) to a displayable <img> src,
  // or null if there's nothing to show (caller falls back to initials).
  // Preset image paths have spaces/diacritics -- encodeURI so they resolve as
  // a single path segment instead of breaking on the raw characters.
  function avatarImageUrl(avatar) {
    if (!avatar || typeof avatar !== 'object') return null;
    if (avatar.type === 'preset') {
      const preset = AVATAR_PRESETS.find((p) => p.key === avatar.key);
      return preset ? encodeURI(preset.image) : null;
    }
    if (avatar.type === 'upload' && typeof avatar.src === 'string') return avatar.src;
    return null;
  }

  function getPlayer() {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = makeId();
      localStorage.setItem(ID_KEY, id);
    }
    const name = localStorage.getItem(NAME_KEY) || '';
    return { id, name, avatar: getAvatar() };
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
    const { id, name, avatar } = getPlayer();
    s.emit('register', { playerId: id, name, avatar });
  }

  // Pushes a just-picked avatar to the server immediately (with a callback,
  // unlike register()'s fire-and-forget) so the picker UI can surface a
  // rejection -- e.g. an uploaded image that's too large or the wrong type.
  function setAvatarOnServer(s, avatar) {
    return new Promise((resolve) => {
      const { id, name } = getPlayer();
      s.emit('player:set-avatar', { playerId: id, name, avatar }, (res) => resolve(res || { ok: false, error: 'no-response' }));
    });
  }

  function submitScore(s, game, score, detail, mode) {
    const { id, name } = getPlayer();
    s.emit('score:submit', { playerId: id, name, game, score, detail, mode });
  }

  // Reserves one lifetime attempt for `game` before the caller may start play.
  // Resolves { ok:true, attemptsUsed, attemptsMax } or { ok:false, error, ... }.
  function requestAttempt(s, game) {
    const { id, name } = getPlayer();
    return new Promise((resolve) => {
      s.emit('game:start-attempt', { playerId: id, name, game }, (res) => resolve(res || { ok: false, error: 'no response' }));
    });
  }

  // Reserves one of a player's retries within the CURRENT Tournament round
  // (Sudoku/Memory only -- see server.js's TOURNAMENT_RETRY_GAMES). Separate
  // from requestAttempt's lifetime cap above. Resolves
  // { ok:true, attemptsUsed, attemptsMax } or { ok:false, error: 'exhausted'|'not-active'|... }.
  function requestTournamentAttempt(s, game) {
    const { id } = getPlayer();
    return new Promise((resolve) => {
      s.emit('tournament:request-attempt', { playerId: id, game }, (res) => resolve(res || { ok: false, error: 'no response' }));
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

  // A 'leaderboard' broadcast fires on every score submission for every
  // player, but each board (overall + 4 per-game) should only actually
  // repaint when ITS OWN visible content changed — otherwise a Memory Match
  // submission would needlessly rebuild the Sudoku board's DOM too. Callers
  // pass a signature string describing exactly what's about to be shown;
  // if it matches what's already rendered on this listEl, skip the rebuild.
  function skipIfUnchanged(listEl, signature) {
    if (listEl.dataset.renderSig === signature) return true;
    listEl.dataset.renderSig = signature;
    return false;
  }

  // Builds the small circular avatar badge shared by every leaderboard-style
  // row (real avatar image if the player picked/uploaded one, else their
  // initial letter) -- used wherever a player's identity is actually shown.
  function avatarBadge(nameForFallback, avatar) {
    const el = document.createElement('span');
    el.className = 'player-chip-avatar';
    const imgUrl = avatarImageUrl(avatar);
    if (imgUrl) {
      const img = document.createElement('img');
      img.src = imgUrl;
      img.alt = nameForFallback;
      el.appendChild(img);
    } else {
      el.textContent = (nameForFallback.trim()[0] || '?').toUpperCase();
    }
    return el;
  }

  function renderLeaderboard(listEl, entries, { myId = null, showBreakdown = false, limit = null } = {}) {
    const rows = limit ? entries.slice(0, limit) : entries;
    const signature = 'full:' + rows
      .map((p) => `${p.id}:${p.total}:${p.avatar ? JSON.stringify(p.avatar) : ''}:${showBreakdown ? JSON.stringify(p.scores) + JSON.stringify(p.details) : ''}`)
      .join('|');
    if (skipIfUnchanged(listEl, signature)) return;
    listEl.innerHTML = '';
    rows.forEach((p, i) => {
      const li = document.createElement('li');
      if (p.id === myId) li.classList.add('me');

      const rank = document.createElement('span');
      rank.className = 'rank ' + medalClass(i);
      rank.textContent = String(i + 1);

      const avatarEl = avatarBadge(p.name, p.avatar);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      if (showBreakdown) {
        const breakdown = document.createElement('div');
        breakdown.className = 'breakdown';
        breakdown.textContent = Object.keys(GAME_LABELS)
          .map((g) => {
            const detail = p.details?.[g];
            const suffix = detail ? ' (' + detail + ')' : '';
            return `${GAME_LABELS[g]}: ${p.scores[g] || 0}${suffix}`;
          })
          .join(' · ');
        name.appendChild(breakdown);
      }

      const total = document.createElement('span');
      total.className = 'total';
      total.textContent = p.total;

      li.append(rank, avatarEl, name, total);
      listEl.appendChild(li);
    });
  }

  function renderGameLeaderboard(listEl, entries, gameKey, { myId = null, limit = 10 } = {}) {
    const rows = entries
      .filter((p) => (p.scores[gameKey] || 0) > 0)
      .slice()
      .sort((a, b) => (b.scores[gameKey] || 0) - (a.scores[gameKey] || 0) || a.name.localeCompare(b.name))
      .slice(0, limit);

    const signature = 'game:' + rows.map((p) => `${p.id}:${p.scores[gameKey]}:${p.avatar ? JSON.stringify(p.avatar) : ''}:${p.details?.[gameKey] || ''}`).join('|');
    if (skipIfUnchanged(listEl, signature)) return;
    listEl.innerHTML = '';
    rows.forEach((p, i) => {
      const li = document.createElement('li');
      if (p.id === myId) li.classList.add('me');

      const rank = document.createElement('span');
      rank.className = 'rank ' + medalClass(i);
      rank.textContent = String(i + 1);

      const avatarEl = avatarBadge(p.name, p.avatar);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      const detail = p.details?.[gameKey];
      if (detail) {
        const breakdown = document.createElement('div');
        breakdown.className = 'breakdown';
        breakdown.textContent = detail;
        name.appendChild(breakdown);
      }

      const score = document.createElement('span');
      score.className = 'total';
      score.textContent = p.scores[gameKey] || 0;

      li.append(rank, avatarEl, name, score);
      listEl.appendChild(li);
    });
  }

  // Shows who's currently in the top N without revealing their rank or score —
  // names only, so list order itself can't leak standings. Membership (who's
  // in the top N) is always by total score; orderBy only controls the DISPLAY
  // order of that same set: 'name' (default, alphabetical) or 'recent' (most
  // recently submitted a result first — needs entries to include updatedAt).
  // Expects entries shaped like { id, name, total, updatedAt } (a real
  // leaderboard row, or a { name, total: scores[game] } game projection).
  function renderBlindTop(listEl, entries, { limit = 10, myId = null, orderBy = 'name' } = {}) {
    const top = entries
      .filter((p) => (p.total || 0) > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, limit)
      .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar || null, updatedAt: p.updatedAt || 0 }));

    if (orderBy === 'recent') {
      top.sort((a, b) => b.updatedAt - a.updatedAt);
    } else {
      top.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Blind rows already show the name (just not rank/score), so the avatar
    // isn't hiding anything extra here -- include it in the signature too.
    const signature = 'blind:' + top.map((p) => `${p.id ?? p.name}:${p.avatar ? JSON.stringify(p.avatar) : ''}`).join(',');
    if (skipIfUnchanged(listEl, signature)) return;

    listEl.innerHTML = '';
    top.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'blind-row';
      if (myId != null && p.id === myId) li.classList.add('me');

      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = '❔';

      const avatarEl = avatarBadge(p.name, p.avatar);

      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = p.name;

      const total = document.createElement('span');
      total.className = 'total';
      total.textContent = '???';

      li.append(rank, avatarEl, nameEl, total);
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

  // Reactively reports whether `game`'s Tournament option is currently
  // enabled by the admin (see admin:set-tournament-hidden on the server) --
  // fires immediately with the current value, then again any time it
  // changes. Doesn't block anything by itself; callers use it to show/hide
  // their own Tournament button on the mode-select screen.
  function watchTournamentMode(s, game, onChange) {
    function handle(state) {
      onChange(!state.tournamentHidden);
    }
    s.on('game-window', (state) => {
      if (state.game === game) handle(state);
    });
    s.on('game-window-all', (all) => {
      if (all[game]) handle(all[game]);
    });
  }

  // Reactively reports `game`'s Tournament round pacing -- { phase:
  // 'lobby'|'active', questionIndex, totalQuestions, playerCount } -- fires
  // immediately with whatever the server already knows (the
  // 'tournament:round-state-all' snapshot sent right after connect), then
  // again on every 'tournament:round-state' broadcast: a player joining the
  // lobby, or the admin starting the round / advancing to the next question
  // (see server.js's tournamentRound and admin:tournament-start/-next).
  function watchTournamentRoundState(s, game, onChange) {
    s.on('tournament:round-state-all', (all) => {
      if (all[game]) onChange(all[game]);
    });
    s.on('tournament:round-state', (state) => {
      if (state.game === game) onChange(state);
    });
  }

  // Reports that a Tournament player has finished (correctly answered, timed
  // out, or otherwise resolved) their CURRENT question/word -- updates their
  // live score (so the server can broadcast the live top score, see
  // watchTournamentTopScore) AND tells the server this player is done with
  // `questionIndex`, so it can detect once EVERY joined participant has
  // finished and end the turn early for anyone still waiting out their own
  // clock -- see watchTournamentQuestionOver. This is separate from the
  // final scores[game] leaderboard, which only updates once the whole run
  // finishes (submitScore).
  function submitTournamentQuestionDone(s, game, questionIndex, score, final) {
    const { id, name } = getPlayer();
    s.emit('tournament:question-done', { playerId: id, name, game, questionIndex, score, final });
  }

  // Reactively reports when EVERY currently-joined Tournament player has
  // finished the CURRENT question (see submitTournamentQuestionDone) --
  // fires with { questionIndex } so a still-active client (e.g. one that
  // answered correctly early and is otherwise just waiting out the rest of
  // its own clock) can end its own question immediately instead.
  function watchTournamentQuestionOver(s, game, onEvent) {
    s.on('tournament:question-over', (payload) => {
      if (payload.game === game) onEvent(payload);
    });
  }

  // Reactively reports `game`'s live Tournament standings -- fires
  // immediately with whatever the server already knows (the
  // 'tournament:top-score-all' snapshot sent right after connect, so a page
  // opened or refreshed after the last score change still sees the current
  // standings instead of nothing), then again on every later
  // 'tournament:top-score' broadcast, which the server sends whenever any
  // player joins or their live progress changes the lead (see
  // submitTournamentQuestionDone / server.js's tournamentLiveScores). onChange
  // receives { playerCount, top } where `top` is up to 10 { name, score }
  // entries, best-first. Resets to an empty round when the admin starts a
  // new tournament round.
  function watchTournamentTopScore(s, game, onChange) {
    s.on('tournament:top-score-all', (all) => {
      if (all[game]) onChange({ playerCount: all[game].playerCount, top: all[game].top });
    });
    s.on('tournament:top-score', (payload) => {
      if (payload.game !== game) return;
      onChange({ playerCount: payload.playerCount, top: payload.top });
    });
  }

  // Renders a Tournament lobby's joined players as avatar chips (their
  // chosen preset/uploaded avatar, or an initial-letter badge if they never
  // picked one) into a container -- bigger and more distinct than a plain
  // name list, so a crowded lobby still reads well. `players` is an array of
  // { name, avatar } (see server.js's roundStatePayload).
  function renderTournamentLobbyPlayers(containerEl, players) {
    const signature = 'players:' + players.map((p) => `${p.name}:${p.avatar ? JSON.stringify(p.avatar) : ''}`).join('|');
    if (skipIfUnchanged(containerEl, signature)) return;
    containerEl.innerHTML = '';
    players.forEach(({ name, avatar }) => {
      const chip = document.createElement('span');
      chip.className = 'player-chip';

      const avatarEl = document.createElement('span');
      avatarEl.className = 'player-chip-avatar';
      const imgUrl = avatarImageUrl(avatar);
      if (imgUrl) {
        const img = document.createElement('img');
        img.src = imgUrl;
        img.alt = name;
        avatarEl.appendChild(img);
      } else {
        avatarEl.textContent = (name.trim()[0] || '?').toUpperCase();
      }

      const label = document.createElement('span');
      label.textContent = name;

      chip.append(avatarEl, label);
      containerEl.appendChild(chip);
    });
  }

  // -- Rules language (English / Tiếng Việt) ------------------------------
  // One persisted preference, shared across every page's Rules modal (the
  // hub's 4 scored games and each of the 6 backup games) -- pick a language
  // once anywhere and it sticks everywhere. The 6 backup-game modals author
  // BOTH languages as parallel markup blocks tagged .lang-en/.lang-vi and
  // just toggle which is visible; the hub's modal is data-driven (rules.js)
  // and re-renders its list from the right language array instead -- see
  // wireRulesLangToggle() vs. each page's own re-render call.
  const RULES_LANG_KEY = 'festival_rules_lang';

  function getRulesLang() {
    return localStorage.getItem(RULES_LANG_KEY) === 'vi' ? 'vi' : 'en';
  }

  function setRulesLang(lang) {
    localStorage.setItem(RULES_LANG_KEY, lang === 'vi' ? 'vi' : 'en');
  }

  // Shows/hides a modal's .lang-en / .lang-vi blocks and highlights the
  // matching toggle button (expected classes: .rules-lang-en/.rules-lang-vi,
  // searched anywhere inside `modalEl`).
  function applyRulesLang(modalEl, lang) {
    modalEl.querySelectorAll('.lang-en').forEach((el) => { el.style.display = lang === 'en' ? '' : 'none'; });
    modalEl.querySelectorAll('.lang-vi').forEach((el) => { el.style.display = lang === 'vi' ? '' : 'none'; });
    modalEl.querySelectorAll('.rules-lang-en').forEach((b) => b.classList.toggle('active', lang === 'en'));
    modalEl.querySelectorAll('.rules-lang-vi').forEach((b) => b.classList.toggle('active', lang === 'vi'));
  }

  // Wires a static (non-data-driven) rules modal's language toggle buttons
  // and applies the persisted language immediately. Call once, right after
  // the modal exists in the DOM.
  function wireRulesLangToggle(modalEl) {
    modalEl.querySelectorAll('.rules-lang-en').forEach((b) => b.addEventListener('click', () => {
      setRulesLang('en');
      applyRulesLang(modalEl, 'en');
    }));
    modalEl.querySelectorAll('.rules-lang-vi').forEach((b) => b.addEventListener('click', () => {
      setRulesLang('vi');
      applyRulesLang(modalEl, 'vi');
    }));
    applyRulesLang(modalEl, getRulesLang());
  }

  return {
    getPlayer,
    setName,
    getAvatar,
    setAvatar,
    avatarImageUrl,
    setAvatarOnServer,
    AVATAR_PRESETS,
    requireNameOrRedirect,
    connect,
    register,
    submitScore,
    requestAttempt,
    requestTournamentAttempt,
    reportCheat,
    renderLeaderboard,
    renderGameLeaderboard,
    renderBlindTop,
    formatCountdown,
    gateGame,
    watchTournamentMode,
    watchTournamentRoundState,
    submitTournamentQuestionDone,
    watchTournamentQuestionOver,
    watchTournamentTopScore,
    renderTournamentLobbyPlayers,
    GAME_LABELS,
    getRulesLang,
    setRulesLang,
    applyRulesLang,
    wireRulesLangToggle,
  };
})();

// Background theme with a manual on/off toggle — on the hub (index.html),
// the live leaderboard display (leaderboard.html), and each of the 4 scored
// games (its own dedicated track). UNO already has its own separate
// background music, so it's excluded here. Browsers block autoplay-with-
// sound until a user gesture, so the default "on" state is an INTENT —
// actual playback starts on the first click/keypress anywhere on the page
// (or immediately if the browser happens to allow it), and the floating
// button lets players flip it off/on afterward. Uses an absolute audio path
// (leading "/") since this file is included from both root-level and nested
// (games/*) pages, and a relative audio src resolves against the CURRENT
// PAGE's URL, not common.js's own location.
(function setupThemeToggle() {
  const path = window.location.pathname;
  const isHub = path === '/' || path.endsWith('/index.html');
  const isLeaderboard = path.endsWith('/leaderboard.html');
  const GAME_BGM_FILES = {
    'sudoku.html': 'sudoku.mp3',
    'scramble.html': 'scramble.mp3',
    'memory.html': 'memory.mp3',
    'proverb.html': 'proverb.mp3',
  };
  const gamePage = Object.keys(GAME_BGM_FILES).find((f) => path.endsWith('/games/' + f));
  if (!isHub && !isLeaderboard && !gamePage) return;

  const THEME_MUTED_KEY = 'festival_theme_muted';
  const themeSrc = gamePage ? `/games/sounds/bgm/${GAME_BGM_FILES[gamePage]}` : '/sounds/mid-autumn-theme.mp3';
  const theme = new Audio(themeSrc);
  theme.loop = true;
  theme.volume = 0.15;
  let muted = localStorage.getItem(THEME_MUTED_KEY) === '1'; // default: on

  const btn = document.createElement('button');
  btn.className = 'secondary';
  btn.style.cssText = 'position:fixed; top:96px; right:14px; z-index:40; padding:8px 12px; font-size:16px; border-radius:20px;';
  function updateBtn() {
    btn.textContent = muted ? '🔇' : '🔊';
  }
  function sync() {
    if (muted) theme.pause();
    else theme.play().catch(() => {}); // still blocked until a gesture — fine, next click retries
  }
  btn.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem(THEME_MUTED_KEY, muted ? '1' : '0');
    updateBtn();
    sync();
  });
  updateBtn();
  document.body.appendChild(btn);

  sync();
  const retryOnGesture = () => {
    if (!muted) sync();
    document.removeEventListener('click', retryOnGesture);
    document.removeEventListener('keydown', retryOnGesture);
  };
  document.addEventListener('click', retryOnGesture, { once: true });
  document.addEventListener('keydown', retryOnGesture, { once: true });
})();

// Sponsor logos, fixed to the top corners on every page. Plain <img>s
// rather than markup in each HTML file, so placement stays consistent
// regardless of what each page's own header looks like.
(function setupSponsorLogos() {
  // Sizing/position lives in style.css (.sponsor-logo) instead of inline
  // styles here, so a media query there can shrink them on small screens —
  // an inline style attribute would need !important to be overridden.
  const left = document.createElement('img');
  left.src = '/assets/smd-logo.webp';
  left.alt = 'SmartDev';
  left.className = 'sponsor-logo sponsor-logo-left';

  const right = document.createElement('img');
  right.src = '/assets/smd-union-logo.png';
  right.alt = 'SmartDev Union';
  right.className = 'sponsor-logo sponsor-logo-right';

  document.body.append(left, right);
})();
