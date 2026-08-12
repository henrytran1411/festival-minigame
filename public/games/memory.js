const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  // Tết Trung Thu (Mid-Autumn Festival), harvest-season, and general festive
  // icons — 64 unique glyphs, one per matching pair (128 cards total).
  const ICONS = [
    '🌕', '🏮', '🥮', '🐇', '🎑', '🦁', '🥁', '🎆',
    '🍁', '🍂', '🌰', '🌽', '🍠', '🍯', '🌾', '🕯️',
    '🌙', '⭐', '🎇', '🧧', '🍮', '🍵', '🍇', '🍉',
    '🍊', '🍋', '🍌', '🍎', '🍐', '🍑', '🍒', '🍓',
    '🥭', '🍍', '🥥', '🌶️', '🎋', '🌻', '🍄', '🌼',
    '🐉', '🐰', '🐟', '🦋', '🐢', '🦢', '🦉', '🐿️',
    '🎐', '🎏', '🧺', '🧨', '🎊', '🎉', '🥟', '🍜',
    '🍡', '🍢', '🍧', '🍨', '🍰', '🧁', '🍪', '🍩',
  ];

  // Points earned for a match, tiered by how many times the two matched cards
  // were opened in total (including the opens that completed the match) —
  // fewer combined opens for a pair means a cleaner, more-remembered match.
  const MATCH_POINT_TIERS = [
    { maxOpens: 4, points: 15 }, // combined opens < 5
    { maxOpens: 8, points: 10 }, // 5-8
    { maxOpens: 12, points: 6 }, // 9-12
    { maxOpens: Infinity, points: 4 }, // > 12
  ];
  const GAME_TIME_LIMIT_SECONDS = 30 * 60; // 30 minutes — game force-ends if not finished by then

  // Time bonus earned for FINISHING the whole board within a given time —
  // does not apply if the 30-minute limit runs out before all pairs are found.
  const TIME_BONUS_TIERS = [
    { maxSeconds: 180, points: 400 },
    { maxSeconds: 300, points: 360 },
    { maxSeconds: 600, points: 300 },
    { maxSeconds: 1200, points: 250 },
    { maxSeconds: Infinity, points: 200 },
  ];

  // Bonus for finishing in fewer total moves — same forfeit-on-timeout rule
  // as the time bonus above.
  const MOVES_BONUS_TIERS = [
    { maxMoves: 200, points: 140 },
    { maxMoves: 400, points: 100 },
    { maxMoves: 1000, points: 60 },
    { maxMoves: Infinity, points: 40 },
  ];

  function pointsForMatch(combinedOpens) {
    return MATCH_POINT_TIERS.find((tier) => combinedOpens <= tier.maxOpens).points;
  }

  function timeBonusFor(seconds) {
    return TIME_BONUS_TIERS.find((tier) => seconds <= tier.maxSeconds).points;
  }

  function movesBonusFor(moveCount) {
    return MOVES_BONUS_TIERS.find((tier) => moveCount <= tier.maxMoves).points;
  }

  const gridEl = document.getElementById('grid');
  const timerEl = document.getElementById('timer');
  const movesEl = document.getElementById('moves');
  const liveScoreEl = document.getElementById('live-score');
  const playScreen = document.getElementById('play-screen');
  const resultScreen = document.getElementById('result-screen');
  const finalScoreEl = document.getElementById('final-score');
  const resultDetailEl = document.getElementById('result-detail');

  const meta = window.FESTIVAL_GAMES.find((g) => g.key === 'memory');
  document.getElementById('rules-body').innerHTML = meta.rules.map((r) => `<li>${r}</li>`).join('');
  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('rules-modal').classList.remove('hidden');
  });
  document.querySelector('.modal-close').addEventListener('click', () => {
    document.getElementById('rules-modal').classList.add('hidden');
  });

  let cards, cardEls, faceEls, badgeEls, flipped, matchedCount, moves, startTime, timerHandle, finished, busy;
  let cardOpenCounts, matchPoints;

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startGame() {
    cards = shuffle([...ICONS, ...ICONS]);
    flipped = [];
    matchedCount = 0;
    moves = 0;
    cardOpenCounts = new Array(cards.length).fill(0);
    matchPoints = 0;
    finished = false;
    busy = false;
    startTime = performance.now();
    movesEl.textContent = '0';
    timerEl.textContent = Festival.formatCountdown(GAME_TIME_LIMIT_SECONDS * 1000);
    resultScreen.classList.add('hidden');
    playScreen.classList.remove('hidden');
    buildGrid();
    clearInterval(timerHandle);
    timerHandle = setInterval(updateTimer, 500);
    updateLiveScore();
  }

  function updateTimer() {
    const remainingMs = GAME_TIME_LIMIT_SECONDS * 1000 - (performance.now() - startTime);
    timerEl.textContent = Festival.formatCountdown(remainingMs);
    updateLiveScore();
    if (remainingMs <= 0) timeUp();
  }

  function computeScore(seconds) {
    return Math.max(0, Math.min(1500, matchPoints + timeBonusFor(seconds) + movesBonusFor(moves)));
  }

  function updateLiveScore() {
    const seconds = Math.floor((performance.now() - startTime) / 1000);
    liveScoreEl.textContent = String(computeScore(seconds));
  }

  function buildGrid() {
    gridEl.innerHTML = '';
    badgeEls = [];
    faceEls = [];
    cardEls = cards.map((icon, i) => {
      const el = document.createElement('div');
      el.className = 'memory-card hidden-face';
      el.addEventListener('click', () => onCardClick(i));

      const face = document.createElement('span');
      face.className = 'card-face';
      el.appendChild(face);
      faceEls.push(face);

      const badge = document.createElement('span');
      badge.className = 'card-open-badge';
      badge.textContent = '0';
      el.appendChild(badge);
      badgeEls.push(badge);

      gridEl.appendChild(el);
      return el;
    });
  }

  function onCardClick(i) {
    if (busy || finished) return;
    const el = cardEls[i];
    if (el.classList.contains('matched') || flipped.includes(i)) return;

    el.classList.remove('hidden-face');
    faceEls[i].textContent = cards[i];
    flipped.push(i);

    cardOpenCounts[i] += 1;
    badgeEls[i].textContent = String(cardOpenCounts[i]);

    if (flipped.length === 2) {
      moves += 1;
      movesEl.textContent = String(moves);
      busy = true;
      const [a, b] = flipped;
      if (cards[a] === cards[b]) {
        cardEls[a].classList.add('matched');
        cardEls[b].classList.add('matched');
        matchedCount += 1;
        matchPoints += pointsForMatch(cardOpenCounts[a] + cardOpenCounts[b]);
        flipped = [];
        busy = false;
        if (matchedCount === ICONS.length) {
          finishGame();
        } else {
          updateLiveScore();
        }
      } else {
        setTimeout(() => {
          cardEls[a].classList.add('hidden-face');
          faceEls[a].textContent = '';
          cardEls[b].classList.add('hidden-face');
          faceEls[b].textContent = '';
          flipped = [];
          busy = false;
        }, 700);
      }
    } else {
      updateLiveScore();
    }
  }

  // Reaching the 30-minute cap without finishing forfeits the time bonus —
  // the tiers above reward finishing at a given speed, and this game was
  // never finished, so only the points already earned from matches count.
  function timeUp() {
    if (finished) return;
    finished = true;
    clearInterval(timerHandle);
    const score = Math.max(0, Math.min(1500, matchPoints));
    finalScoreEl.textContent = score;
    liveScoreEl.textContent = String(score);
    const detail = `Time's up · ${matchedCount}/${ICONS.length} pairs matched · ${moves} moves`;
    resultDetailEl.textContent = detail;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'memory', score, detail);
  }

  function finishGame() {
    finished = true;
    clearInterval(timerHandle);
    const seconds = Math.floor((performance.now() - startTime) / 1000);
    const score = computeScore(seconds);
    finalScoreEl.textContent = score;
    liveScoreEl.textContent = String(score);
    const detail = `${seconds}s · ${moves} moves`;
    resultDetailEl.textContent = detail;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'memory', score, detail);
  }

  const gate = Festival.gateGame(socket, 'memory', startGame);
  document.getElementById('play-again-btn').addEventListener('click', () => {
    if (gate.isOpen()) {
      startGame();
    } else {
      gate.block();
    }
  });
}
