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
      // Built from the login response itself, not the connection-time
      // broadcasts -- those fire before buildGameCards() has attached any
      // listeners (it only runs after login succeeds), so relying on them
      // would miss the initial state and show nothing until the next live
      // change (e.g. a Sudoku/Memory board no one has touched since the
      // last score update).
      buildGameCards(res.roundStates || {}, res.topScores || {});
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

// -- Top-3 celebration effects (a scaled-down version of leaderboard.html's
// reveal-ceremony flourishes, sized for this page's smaller cards) ----------

// A small burst of colored sparks from a random point in the card.
function spawnFirework(container) {
  const originX = 15 + Math.random() * 70;
  const originY = 15 + Math.random() * 50;
  const colors = ['#ffb703', '#fb8500', '#e63946', '#ffd166', '#f4a261', '#e0b13c'];
  const count = 14;
  for (let i = 0; i < count; i += 1) {
    const particle = document.createElement('span');
    particle.className = 'firework-particle';
    particle.style.left = originX + '%';
    particle.style.top = originY + '%';
    const color = colors[Math.floor(Math.random() * colors.length)];
    particle.style.background = color;
    particle.style.color = color;
    container.appendChild(particle);

    const angle = (Math.PI * 2 * i) / count + (Math.random() * 0.4 - 0.2);
    const distance = 25 + Math.random() * 40;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const anim = particle.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0 },
      ],
      { duration: 650 + Math.random() * 350, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)' },
    );
    anim.onfinish = () => particle.remove();
  }
}

// A crown for rank 1, a trophy for ranks 2-3, popping up from the podium.
function spawnChampionBadge(container, big) {
  const el = document.createElement('span');
  el.className = 'champion-badge';
  el.textContent = big ? '👑' : '🏆';
  el.style.fontSize = big ? '48px' : '32px';
  container.appendChild(el);

  const anim = el.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0) rotate(-15deg)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1.3) rotate(5deg)', opacity: 1, offset: 0.35 },
      { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1, offset: 0.75 },
      { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 0 },
    ],
    { duration: big ? 2200 : 1600, easing: 'ease-out' },
  );
  anim.onfinish = () => el.remove();
}

// Cheering/dancing emoji bouncing up from the bottom of the card.
function spawnCheerSquad(container, count) {
  const cheerEmojis = ['🙌', '🎉', '💃', '🥳', '🎊', '👏'];
  for (let i = 0; i < count; i += 1) {
    const el = document.createElement('span');
    el.className = 'cheer-emoji';
    el.textContent = cheerEmojis[Math.floor(Math.random() * cheerEmojis.length)];
    el.style.left = (5 + Math.random() * 90) + '%';
    container.appendChild(el);

    const anim = el.animate(
      [
        { transform: 'translateY(20px) scale(0.5)', opacity: 0 },
        { transform: 'translateY(-14px) scale(1.2)', opacity: 1, offset: 0.3 },
        { transform: 'translateY(-8px) scale(1)', opacity: 1, offset: 0.7 },
        { transform: 'translateY(12px) scale(0.8)', opacity: 0 },
      ],
      { duration: 1600 + Math.random() * 600, easing: 'ease-in-out' },
    );
    anim.onfinish = () => el.remove();
  }
}

// Calls out the just-revealed player's name over the card, bigger and gold
// the closer to #1 they are.
function spawnNameCallout(container, name, rank) {
  const el = document.createElement('span');
  el.className = 'name-callout' + (rank === 1 ? ' champion' : rank <= 3 ? ' podium' : '');
  el.textContent = name;
  container.appendChild(el);

  const anim = el.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.5)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1.1)', opacity: 1, offset: 0.2 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.8 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 },
    ],
    { duration: 1800, easing: 'ease-out' },
  );
  anim.onfinish = () => el.remove();
}

// Confetti pieces -- small colored rectangles tumbling down from the top of
// the card, on top of the round firework sparks -- reads as a much more
// festive/garish burst than sparks alone.
function spawnConfetti(container, count) {
  const colors = ['#ffb703', '#fb8500', '#e63946', '#ffd166', '#f4a261', '#5b8cff', '#06d6a0', '#ef476f'];
  for (let i = 0; i < count; i += 1) {
    const el = document.createElement('span');
    el.className = 'confetti-piece';
    el.style.left = (Math.random() * 100) + '%';
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    const drift = (Math.random() * 80 - 40);
    const spin = 360 + Math.random() * 360;
    container.appendChild(el);
    const anim = el.animate(
      [
        { transform: `translate(0, -10%) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${drift}px, 130%) rotate(${spin}deg)`, opacity: 0.9 },
      ],
      { duration: 1400 + Math.random() * 900, easing: 'cubic-bezier(0.3, 0.2, 0.7, 1)' },
    );
    anim.onfinish = () => el.remove();
  }
}

// One big showy burst -- fireworks + confetti + cheer squad + name callout +
// badge, all at once -- repeated every beat for the sustain duration, so the
// celebration reads as ongoing rather than a single quick flash. Rank 1 gets
// the longest sustain and the richest burst.
function celebrateFor(fireworksEl, durationMs, rank, name) {
  const big = rank === 1;
  const burst = () => {
    spawnFirework(fireworksEl);
    if (big) spawnFirework(fireworksEl);
    spawnConfetti(fireworksEl, big ? 22 : 12);
    spawnNameCallout(fireworksEl, name, rank);
    spawnChampionBadge(fireworksEl, big);
    spawnCheerSquad(fireworksEl, big ? 9 : 5);
  };
  burst();
  const handle = setInterval(burst, big ? 700 : 850);
  setTimeout(() => clearInterval(handle), durationMs);
}

// Fills one podium slot (1st/2nd/3rd) with the just-revealed player's avatar,
// name, and score, adds a PERMANENT medal badge to the slot (so the win stays
// visible after the transient burst ends), and kicks off a sustained
// celebration -- bigger and longer for rank 1 than ranks 2-3.
function fillPodiumSlot(podiumSlots, fireworksEl, rank, entry) {
  const slot = podiumSlots[rank];
  if (!slot) return;
  const avatarEl = slot.querySelector('.tl-podium-avatar');
  avatarEl.innerHTML = '';
  const imgUrl = Festival.avatarImageUrl(entry.avatar);
  if (imgUrl) {
    const img = document.createElement('img');
    img.src = imgUrl;
    img.alt = entry.name;
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = (entry.name.trim()[0] || '?').toUpperCase();
  }
  slot.querySelector('.tl-podium-name').textContent = entry.name;
  slot.querySelector('.tl-podium-score').textContent = entry.score;
  let medalEl = slot.querySelector('.tl-podium-medal');
  if (!medalEl) {
    medalEl = document.createElement('div');
    medalEl.className = 'tl-podium-medal';
    slot.insertBefore(medalEl, slot.firstChild);
  }
  medalEl.textContent = rank === 1 ? '👑' : '🏆';
  // Forces the browser to commit the un-hidden layout first (same reason as
  // leaderboard.js's revealRow) -- otherwise the very first slot filled (rank
  // 3, right when the podium goes from hidden to visible in the same tick)
  // can skip its pop-in transition entirely.
  requestAnimationFrame(() => slot.classList.add('filled'));

  celebrateFor(fireworksEl, rank === 1 ? 4000 : 2200, rank, entry.name);
}

// Reveal pacing: a flat 0.5s per step for ranks 10-4, then slowing down for
// the final drumroll to the champion -- 0.5s before rank 3, 1s before rank
// 2, 1.5s before rank 1 -- so the suspense builds right when it matters most.
function revealDelayFor(stepsFromEnd) {
  if (stepsFromEnd === 3) return 500;
  if (stepsFromEnd === 2) return 1000;
  if (stepsFromEnd === 1) return 1500;
  return 500;
}

function renderRoundStatus(statusEl, roundState) {
  if (roundState.phase === 'lobby') {
    statusEl.textContent = `🏟 Lobby — ${roundState.playerCount} joined`;
  } else if (roundState.totalQuestions > 1) {
    statusEl.textContent = `▶️ Question ${roundState.questionIndex + 1} of ${roundState.totalQuestions} — ${roundState.playerCount} joined`;
  } else {
    // Sudoku/Memory: no staged questions -- everyone's just playing their
    // own puzzle/board at their own pace.
    statusEl.textContent = `▶️ In progress — ${roundState.playerCount} joined`;
  }
}

// One card per Tournament-capable game (all 4) -- window.FESTIVAL_GAMES's
// `hasTournamentMode: true` flag, same set as server.js's TOURNAMENT_GAMES.
// `initialRoundStates`/`initialTopScores` (game -> snapshot) come straight
// from the admin:login response -- see attemptLogin() for why.
function buildGameCards(initialRoundStates, initialTopScores) {
  tlGridEl.innerHTML = '';
  window.FESTIVAL_GAMES.filter((g) => g.hasTournamentMode).forEach((g) => {
    const card = document.createElement('div');
    card.className = 'card tl-card';
    card.innerHTML = `
      <h2>${g.icon} ${g.title}</h2>
      <p class="tl-status" data-role="status"></p>
      <div class="tl-reveal-row">
        <button type="button" class="secondary" data-role="reveal-btn">🎭 Reveal Top 10</button>
      </div>
      <div class="tl-podium hidden" data-role="podium">
        <div class="tl-podium-slot tl-podium-2" data-role="podium-2">
          <div class="tl-podium-avatar"></div>
          <div class="tl-podium-name"></div>
          <div class="tl-podium-score"></div>
          <div class="tl-podium-stand">2</div>
        </div>
        <div class="tl-podium-slot tl-podium-1" data-role="podium-1">
          <div class="tl-podium-avatar"></div>
          <div class="tl-podium-name"></div>
          <div class="tl-podium-score"></div>
          <div class="tl-podium-stand">1</div>
        </div>
        <div class="tl-podium-slot tl-podium-3" data-role="podium-3">
          <div class="tl-podium-avatar"></div>
          <div class="tl-podium-name"></div>
          <div class="tl-podium-score"></div>
          <div class="tl-podium-stand">3</div>
        </div>
      </div>
      <ol class="leaderboard-list" data-role="list"></ol>
      <div class="fireworks-layer" data-role="fireworks"></div>
    `;
    tlGridEl.appendChild(card);

    const statusEl = card.querySelector('[data-role="status"]');
    const listEl = card.querySelector('[data-role="list"]');
    const revealBtn = card.querySelector('[data-role="reveal-btn"]');
    const podiumEl = card.querySelector('[data-role="podium"]');
    const podiumSlots = {
      1: card.querySelector('[data-role="podium-1"]'),
      2: card.querySelector('[data-role="podium-2"]'),
      3: card.querySelector('[data-role="podium-3"]'),
    };
    const fireworksEl = card.querySelector('[data-role="fireworks"]');

    // Suspense mode: names stay hidden (rank + score only) so players
    // watching the board can't tell who's who -- just that SOMEONE'S score
    // just changed. Clicking Reveal opens names one at a time from #10 up
    // to #1 (worst-to-best), 0.5s apart (ranks 10-4), slowing to 1s/1.5s for
    // ranks 2 and 1 -- see revealDelayFor() -- with a podium + celebration
    // effects for the top 3, saving the champion for last. Toggling back to
    // hidden is instant, so the admin can re-arm suspense for the next
    // question. `top` is always the latest live standings, whether
    // currently shown blind or revealed.
    const initialTop = initialTopScores[g.key];
    const state = { top: (initialTop && initialTop.top) || [], revealed: false, revealedCount: 0, timer: null };

    const initialRound = initialRoundStates[g.key];
    if (initialRound) renderRoundStatus(statusEl, initialRound);

    function renderList() {
      const rows = state.top.slice(0, 10);
      const total = rows.length;
      const signature = `tl:${state.revealed}:${state.revealedCount}:` + rows.map((p) => `${p.name}:${p.score}:${p.avatar ? JSON.stringify(p.avatar) : ''}`).join('|');
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

        // The avatar is part of a player's identity just like their name, so
        // it stays hidden behind the same generic placeholder until this row
        // is revealed -- a distinctive photo/character would otherwise give
        // away who's who before the suspense reveal gets there.
        const avatarEl = document.createElement('span');
        avatarEl.className = 'player-chip-avatar tl-avatar';
        if (isRevealed) {
          const imgUrl = Festival.avatarImageUrl(p.avatar);
          if (imgUrl) {
            const img = document.createElement('img');
            img.src = imgUrl;
            img.alt = p.name;
            avatarEl.appendChild(img);
          } else {
            avatarEl.textContent = (p.name.trim()[0] || '?').toUpperCase();
          }
        } else {
          avatarEl.textContent = '❔';
        }

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

        li.append(rankEl, avatarEl, nameEl, scoreEl);
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

    function resetPodium() {
      podiumEl.classList.add('hidden');
      [1, 2, 3].forEach((rank) => {
        const slot = podiumSlots[rank];
        slot.classList.remove('filled');
        slot.querySelector('.tl-podium-avatar').innerHTML = '';
        slot.querySelector('.tl-podium-name').textContent = '';
        slot.querySelector('.tl-podium-score').textContent = '';
        const medalEl = slot.querySelector('.tl-podium-medal');
        if (medalEl) medalEl.remove();
      });
    }

    revealBtn.addEventListener('click', () => {
      if (state.timer) return;
      if (state.revealed) {
        state.revealed = false;
        state.revealedCount = 0;
        resetPodium();
        renderList();
        updateRevealButton();
        return;
      }
      const total = Math.min(state.top.length, 10);
      if (total === 0) return;
      state.revealed = true;
      state.revealedCount = 0;
      resetPodium();
      renderList();
      updateRevealButton();

      // Chained (rather than fixed-interval) so the delay BEFORE each step
      // can vary -- flat 0.5s for ranks 10-4, then slowing to 1s/1.5s for
      // ranks 2/1 (see revealDelayFor), building suspense into the champion.
      const stepReveal = () => {
        const stepsFromEnd = total - state.revealedCount;
        state.timer = setTimeout(() => {
          state.revealedCount += 1;
          renderList();
          const revealedRank = total - state.revealedCount + 1;
          if (revealedRank <= 3) {
            podiumEl.classList.remove('hidden');
            const entry = state.top[revealedRank - 1];
            if (entry) fillPodiumSlot(podiumSlots, fireworksEl, revealedRank, entry);
          }
          if (state.revealedCount >= total) {
            state.timer = null;
          } else {
            stepReveal();
          }
          updateRevealButton();
        }, revealDelayFor(stepsFromEnd));
      };
      stepReveal();
    });

    Festival.watchTournamentRoundState(socket, g.key, (roundState) => renderRoundStatus(statusEl, roundState));

    Festival.watchTournamentTopScore(socket, g.key, (standings) => {
      state.top = standings.top;
      renderList();
      updateRevealButton();
    });

    renderList();
    updateRevealButton();
  });
}

const savedPassword = localStorage.getItem(PASSWORD_KEY);
if (savedPassword) {
  attemptLogin(savedPassword);
} else {
  showLogin();
}
