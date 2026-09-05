// Admin-only "big screen" view of each Tournament game's LIVE (in-progress)
// top score -- moved out of the players' own game pages (scramble.js /
// proverb.js) so players can't see it while they're still playing; only
// someone who knows the admin password can open this page.
const PASSWORD_KEY = 'festival_admin_password';

const loginScreen = document.getElementById('login-screen');
const pageScreen = document.getElementById('page-screen');
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const tlGridEl = document.getElementById('tl-grid');

const socket = Festival.connect();

function showPage() {
  loginScreen.classList.add('hidden');
  pageScreen.classList.remove('hidden');
}

function showLogin(message) {
  pageScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  loginError.classList.toggle('hidden', !message);
  passwordInput.focus();
}

function attemptLogin(password) {
  socket.emit('admin:login', { password }, (res) => {
    if (res && res.ok) {
      localStorage.setItem(PASSWORD_KEY, password);
      showPage();
      buildGameCards();
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

// One card per tournament-capable game (Scramble, Proverb) -- content-shared
// Tournament games only (window.FESTIVAL_GAMES's `tournament: true` flag),
// same set as server.js's TOURNAMENT_GAMES.
function buildGameCards() {
  tlGridEl.innerHTML = '';
  window.FESTIVAL_GAMES.filter((g) => g.tournament).forEach((g) => {
    const card = document.createElement('div');
    card.className = 'card tl-card';
    card.innerHTML = `
      <h2>${g.icon} ${g.title}</h2>
      <p class="tl-status" data-role="status"></p>
      <div class="tl-reveal-row">
        <button type="button" class="secondary" data-role="reveal-btn">🎭 Reveal Top 10</button>
      </div>
      <ol class="leaderboard-list" data-role="list"></ol>
    `;
    tlGridEl.appendChild(card);

    const statusEl = card.querySelector('[data-role="status"]');
    const listEl = card.querySelector('[data-role="list"]');
    const revealBtn = card.querySelector('[data-role="reveal-btn"]');

    // Suspense mode: names stay hidden (rank + score only) so players
    // watching the board can't tell who's who -- just that SOMEONE'S score
    // just changed. Clicking Reveal opens names one at a time from #10 up
    // to #1 (worst-to-best), 0.5s apart, saving the leader for last.
    // Toggling back to hidden is instant, so the admin can re-arm suspense
    // for the next question. `top` is always the latest live standings,
    // whether currently shown blind or revealed.
    const state = { top: [], revealed: false, revealedCount: 0, timer: null };

    function renderList() {
      const rows = state.top.slice(0, 10);
      const total = rows.length;
      const signature = `tl:${state.revealed}:${state.revealedCount}:` + rows.map((p) => `${p.name}:${p.score}`).join('|');
      if (listEl.dataset.renderSig === signature) return;
      listEl.dataset.renderSig = signature;
      listEl.innerHTML = '';
      if (rows.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'No scores yet';
        listEl.appendChild(li);
        return;
      }
      rows.forEach((p, i) => {
        const rank = i + 1;
        // Reveal order is rank 10 first, rank 1 last: after N reveal steps,
        // every rank from 10 down to (11-N) is open.
        const isRevealed = state.revealed && (total - rank) < state.revealedCount;
        const li = document.createElement('li');

        const rankEl = document.createElement('span');
        rankEl.className = 'rank ' + (rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '');
        rankEl.textContent = String(rank);

        const nameEl = document.createElement('span');
        if (isRevealed) {
          nameEl.className = 'name tl-name-reveal';
          nameEl.textContent = p.name;
        } else {
          nameEl.className = 'name tl-name-hidden';
          nameEl.textContent = '❔ ???';
        }

        const scoreEl = document.createElement('span');
        scoreEl.className = 'total';
        scoreEl.textContent = p.score;

        li.append(rankEl, nameEl, scoreEl);
        listEl.appendChild(li);
      });
    }

    function updateRevealButton() {
      if (state.timer) {
        revealBtn.disabled = true;
        revealBtn.textContent = `🎭 Revealing… (${state.revealedCount}/${Math.min(state.top.length, 10)})`;
      } else if (state.revealed) {
        revealBtn.disabled = false;
        revealBtn.textContent = '🙈 Hide Names';
      } else {
        revealBtn.disabled = false;
        revealBtn.textContent = '🎭 Reveal Top 10';
      }
    }

    revealBtn.addEventListener('click', () => {
      if (state.timer) return;
      if (state.revealed) {
        state.revealed = false;
        state.revealedCount = 0;
        renderList();
        updateRevealButton();
        return;
      }
      state.revealed = true;
      state.revealedCount = 0;
      const total = Math.min(state.top.length, 10);
      renderList();
      updateRevealButton();
      state.timer = setInterval(() => {
        state.revealedCount += 1;
        renderList();
        if (state.revealedCount >= total) {
          clearInterval(state.timer);
          state.timer = null;
        }
        updateRevealButton();
      }, 500);
    });

    Festival.watchTournamentRoundState(socket, g.key, (roundState) => {
      if (roundState.phase === 'lobby') {
        statusEl.textContent = `🏟 Lobby — ${roundState.playerCount} joined`;
      } else {
        statusEl.textContent = `▶️ Question ${roundState.questionIndex + 1} of ${roundState.totalQuestions} — ${roundState.playerCount} joined`;
      }
    });

    Festival.watchTournamentTopScore(socket, g.key, (standings) => {
      state.top = standings.top;
      renderList();
      updateRevealButton();
    });

    updateRevealButton();
  });
}

const savedPassword = localStorage.getItem(PASSWORD_KEY);
if (savedPassword) {
  attemptLogin(savedPassword);
} else {
  showLogin();
}
