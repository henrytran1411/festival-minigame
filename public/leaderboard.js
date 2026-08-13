const leaderboardList = document.getElementById('leaderboard-list');
const emptyMsg = document.getElementById('empty-msg');
const gameBoardsEl = document.getElementById('game-boards');
const overallCard = document.getElementById('overall-card');

// One entry per board (the overall ranking + each of the 4 games). Each
// tracks its own reveal state independently, since the ceremony runs all
// boards concurrently rather than as one combined sequence.
const boards = {
  overall: {
    listEl: leaderboardList,
    bannerEl: document.getElementById('overall-reveal-banner'),
    fireworksEl: overallCard.querySelector('.fireworks-layer'),
    kind: 'overall',
    revealing: false,
    revealed: false,
  },
};

const gameListEls = {};
window.FESTIVAL_GAMES.forEach((g) => {
  const card = document.createElement('div');
  card.className = 'card lb-card';
  card.innerHTML = `
    <h3>${g.icon} ${g.title} — Top 10</h3>
    <p class="reveal-banner hidden">🎉 Revealing...</p>
    <ul class="leaderboard-list"></ul>
    <div class="fireworks-layer"></div>
  `;
  gameListEls[g.key] = card.querySelector('ul');
  gameBoardsEl.appendChild(card);
  boards[g.key] = {
    listEl: card.querySelector('ul'),
    bannerEl: card.querySelector('.reveal-banner'),
    fireworksEl: card.querySelector('.fireworks-layer'),
    kind: 'game',
    revealing: false,
    revealed: false,
  };
});

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function medalClassForRank(rank) {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  return '';
}

// Reveal tiers: rank 1 gets the biggest effects and longest spotlight, ranks
// 2-3 get a smaller version of the same treatment, 4-10 get the plain reveal.
function tierForRank(rank) {
  if (rank === 1) return 'champion';
  if (rank <= 3) return 'podium';
  return 'normal';
}

function spotlightMsForTier(tier) {
  if (tier === 'champion') return 20000;
  if (tier === 'podium') return 10000;
  return 5000;
}

// A small burst of colored sparks bursting outward from a random point in
// the card, using the Web Animations API so no per-particle CSS is needed —
// each element animates itself and removes itself when done.
function spawnFirework(container) {
  const originX = 15 + Math.random() * 70;
  const originY = 15 + Math.random() * 50;
  const colors = ['#ffb703', '#fb8500', '#e63946', '#ffd166', '#f4a261', '#e0b13c'];
  const count = 16;
  for (let i = 0; i < count; i++) {
    const particle = document.createElement('span');
    particle.className = 'firework-particle';
    particle.style.left = originX + '%';
    particle.style.top = originY + '%';
    particle.style.background = colors[Math.floor(Math.random() * colors.length)];
    container.appendChild(particle);

    const angle = (Math.PI * 2 * i) / count + (Math.random() * 0.4 - 0.2);
    const distance = 30 + Math.random() * 50;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const anim = particle.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0 },
      ],
      { duration: 700 + Math.random() * 400, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)' },
    );
    anim.onfinish = () => particle.remove();
  }
}

// Mid-Autumn Festival flourish — a lantern/moon/mooncake emoji drifting
// upward and fading, alongside the firework sparks.
function spawnFestivalEmoji(container) {
  const emojis = ['🏮', '🌕', '🥮', '🍁', '✨'];
  const el = document.createElement('span');
  el.className = 'festival-emoji';
  el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
  el.style.left = (10 + Math.random() * 80) + '%';
  container.appendChild(el);

  const anim = el.animate(
    [
      { transform: 'translateY(0) rotate(0deg)', opacity: 0 },
      { transform: 'translateY(-30px) rotate(8deg)', opacity: 1, offset: 0.2 },
      { transform: 'translateY(-160px) rotate(-8deg)', opacity: 0 },
    ],
    { duration: 1800, easing: 'ease-out' },
  );
  anim.onfinish = () => el.remove();
}

// A richer dose of the festival flourish above — several lantern/moon/
// mooncake emoji instead of just one, for game boards' ranks 4-10.
function spawnFestivalBurst(container, count) {
  for (let i = 0; i < count; i++) spawnFestivalEmoji(container);
}

// Money rain for the overall board's ranks 4-10 — coins/cash/lucky-money
// envelopes falling from the top of the card and fading out.
function spawnMoneyRain(container, count) {
  const moneyEmojis = ['💰', '💵', '🧧', '💸', '🪙'];
  for (let i = 0; i < count; i++) {
    const el = document.createElement('span');
    el.className = 'money-emoji';
    el.textContent = moneyEmojis[Math.floor(Math.random() * moneyEmojis.length)];
    el.style.left = (5 + Math.random() * 90) + '%';
    container.appendChild(el);

    const anim = el.animate(
      [
        { transform: 'translateY(-20px) rotate(0deg)', opacity: 0 },
        { transform: 'translateY(20px) rotate(15deg)', opacity: 1, offset: 0.2 },
        { transform: 'translateY(150px) rotate(-15deg)', opacity: 1, offset: 0.8 },
        { transform: 'translateY(180px) rotate(10deg)', opacity: 0 },
      ],
      { duration: 1800 + Math.random() * 600, easing: 'ease-in' },
    );
    anim.onfinish = () => el.remove();
  }
}

// Champion flourish for the podium (ranks 1-3) — a crown for 1st, a trophy
// for 2nd/3rd, scaling up from the center of the card and fading out.
function spawnChampionBadge(container, big) {
  const el = document.createElement('span');
  el.className = 'champion-badge';
  el.textContent = big ? '👑' : '🏆';
  el.style.fontSize = big ? '72px' : '48px';
  container.appendChild(el);

  const anim = el.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0) rotate(-15deg)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1.3) rotate(5deg)', opacity: 1, offset: 0.35 },
      { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1, offset: 0.75 },
      { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 0 },
    ],
    { duration: big ? 3000 : 2200, easing: 'ease-out' },
  );
  anim.onfinish = () => el.remove();
}

// Calls out the revealed player's name as part of the effect itself, not
// just the static list row — bigger and gold for the podium/champion tiers.
// Always shown for exactly 2s, once per player (see revealRow / celebrateFor).
function spawnNameCallout(container, name, tier) {
  const el = document.createElement('span');
  el.className = 'name-callout' + (tier !== 'normal' ? ' ' + tier : '');
  el.textContent = name;
  container.appendChild(el);

  const anim = el.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.5)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1.1)', opacity: 1, offset: 0.2 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.8 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 },
    ],
    { duration: 2000, easing: 'ease-out' },
  );
  anim.onfinish = () => el.remove();
}

// "Cheer girl" squad — a burst of cheering/dancing emoji bouncing up from
// the bottom of the card, for the podium finishers.
function spawnCheerSquad(container, count) {
  const cheerEmojis = ['🙌', '🎉', '💃', '🥳', '🎊', '👏'];
  for (let i = 0; i < count; i++) {
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
      { duration: 2000 + Math.random() * 800, easing: 'ease-in-out' },
    );
    anim.onfinish = () => el.remove();
  }
}

// Keeps the celebration going for the whole spotlight duration, instead of
// one burst followed by a long static pause — every tier gets this now, just
// at a pace that fits its spotlight length. The name callout re-fires on
// every tick (each showing is still a fixed 2s, see spawnNameCallout) so it
// keeps reappearing throughout, rather than showing only once.
function celebrateFor(board, durationMs, tier, name) {
  const big = tier === 'champion';
  const interval = { champion: 2200, podium: 2600, normal: 3000 }[tier];
  const handle = setInterval(() => {
    spawnFirework(board.fireworksEl);
    spawnNameCallout(board.fireworksEl, name, tier);
    if (tier === 'normal') {
      if (board.kind === 'overall') {
        spawnFestivalEmoji(board.fireworksEl);
        spawnMoneyRain(board.fireworksEl, 3);
      } else {
        spawnFestivalBurst(board.fireworksEl, 2);
      }
    } else {
      spawnFestivalEmoji(board.fireworksEl);
      spawnCheerSquad(board.fireworksEl, big ? 8 : 5);
      if (Math.random() < 0.6) spawnChampionBadge(board.fireworksEl, big);
    }
  }, interval);
  return sleep(durationMs).then(() => clearInterval(handle));
}

// Full info for the revealed row, not just name + score — a per-game
// time/moves/mistakes breakdown for the overall board (same shape Festival.
// renderLeaderboard shows), or the single game's own detail string otherwise.
// Stays visible after the celebration effect ends, since it's part of the
// static row rather than a transient animation.
function detailTextFor(board, entry) {
  if (board.kind === 'overall') {
    if (!entry.scores) return '';
    return Object.keys(Festival.GAME_LABELS)
      .map((g) => {
        const score = entry.scores[g] || 0;
        const detail = entry.details?.[g];
        const suffix = detail ? ' (' + detail + ')' : '';
        return `${Festival.GAME_LABELS[g]}: ${score}${suffix}`;
      })
      .join(' · ');
  }
  return entry.detail || '';
}

// Keeps the visible list sorted by rank (1 at top, 10 at bottom) even though
// rows are revealed in a random order — inserts each new row at its correct
// position instead of just appending it at the end.
function insertRowSorted(listEl, li, rank) {
  li.dataset.rank = String(rank);
  const before = [...listEl.children].find((el) => Number(el.dataset.rank) > rank);
  if (before) {
    before.before(li);
  } else {
    listEl.appendChild(li);
  }
}

function revealRow(board, entry, rank, tier) {
  return new Promise((resolve) => {
    const li = document.createElement('li');
    li.className = 'reveal-row' + (tier !== 'normal' ? ' ' + tier : '');

    const rankEl = document.createElement('span');
    rankEl.className = 'rank ' + medalClassForRank(rank);
    rankEl.textContent = String(rank);

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = entry.name;

    const detailText = detailTextFor(board, entry);
    if (detailText) {
      const breakdown = document.createElement('div');
      breakdown.className = 'breakdown';
      breakdown.textContent = detailText;
      nameEl.appendChild(breakdown);
    }

    const totalEl = document.createElement('span');
    totalEl.className = 'total';
    totalEl.textContent = entry.total;

    li.append(rankEl, nameEl, totalEl);
    insertRowSorted(board.listEl, li, rank);
    requestAnimationFrame(() => li.classList.add('shown'));

    spawnFirework(board.fireworksEl);
    spawnNameCallout(board.fireworksEl, entry.name, tier);
    if (tier === 'normal') {
      if (board.kind === 'overall') {
        spawnFestivalEmoji(board.fireworksEl);
        spawnMoneyRain(board.fireworksEl, 6);
      } else {
        spawnFestivalBurst(board.fireworksEl, 4);
      }
    } else {
      spawnFestivalEmoji(board.fireworksEl);
      spawnChampionBadge(board.fireworksEl, tier === 'champion');
      spawnCheerSquad(board.fireworksEl, tier === 'champion' ? 8 : 5);
    }

    const entranceMs = { champion: 1000, podium: 800, normal: 550 }[tier];
    setTimeout(resolve, entranceMs);
  });
}

// Reveals ranks 10→2 in random order, then rank 1 last. Ranks 4-10 get a
// plain reveal + 5s spotlight; ranks 2-3 get the podium effect + 10s; rank 1
// gets the full champion effect + 20s, with the celebration sustained across
// the whole spotlight instead of a single burst followed by a long pause.
// Runs independently per board — the 5 ceremonies overlap rather than queue.
async function runReveal(board, top10) {
  if (board.revealing || board.revealed || !top10.length) return;
  board.revealing = true;
  board.bannerEl.classList.remove('hidden');
  emptyMsg.classList.add('hidden');
  board.listEl.innerHTML = '';

  const champion = top10[0];
  const rest = shuffleArray(top10.slice(1));
  for (const entry of rest) {
    const rank = top10.indexOf(entry) + 1;
    const tier = tierForRank(rank);
    await revealRow(board, entry, rank, tier);
    await celebrateFor(board, spotlightMsForTier(tier), tier, entry.name);
  }
  if (champion) {
    await sleep(800);
    await revealRow(board, champion, 1, 'champion');
    await celebrateFor(board, spotlightMsForTier('champion'), 'champion', champion.name);
  }

  board.bannerEl.classList.add('hidden');
  board.revealing = false;
  board.revealed = true;
}

const socket = Festival.connect();

socket.on('leaderboard', (entries) => {
  const withScores = entries.filter((p) => p.total > 0);
  emptyMsg.classList.toggle('hidden', withScores.length > 0 || boards.overall.revealing || boards.overall.revealed);

  if (boards.overall.revealed) {
    Festival.renderLeaderboard(leaderboardList, withScores, { showBreakdown: true, limit: 10 });
  } else if (!boards.overall.revealing) {
    Festival.renderBlindTop(leaderboardList, withScores, { limit: 10 });
  }

  window.FESTIVAL_GAMES.forEach((g) => {
    const board = boards[g.key];
    if (board.revealed) {
      Festival.renderGameLeaderboard(board.listEl, entries, g.key, { limit: 10 });
    } else if (!board.revealing) {
      const projected = entries.map((p) => ({ name: p.name, total: p.scores[g.key] || 0 }));
      Festival.renderBlindTop(board.listEl, projected, { limit: 10 });
    }
  });
});

// Each of the 5 boards (4 games + overall) is revealed independently, on
// its own admin button — the admin controls the pacing, not the client.
socket.on('reveal-results', (payload) => {
  const board = boards[payload.board];
  if (board) runReveal(board, payload.top10 || []);
});
