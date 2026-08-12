const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  // Tết Trung Thu (Mid-Autumn Festival) and harvest-season icons.
  const ICONS = [
    '🌕', '🏮', '🥮', '🐇', '🎑', '🦁', '🥁', '🎆',
    '🍁', '🍂', '🌰', '🌽', '🍠', '🍯', '🌾', '🕯️',
  ];

  const gridEl = document.getElementById('grid');
  const timerEl = document.getElementById('timer');
  const movesEl = document.getElementById('moves');
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

  let cards, cardEls, flipped, matchedCount, moves, startTime, timerHandle, finished, busy;

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
    finished = false;
    busy = false;
    startTime = performance.now();
    movesEl.textContent = '0';
    timerEl.textContent = '0s';
    resultScreen.classList.add('hidden');
    playScreen.classList.remove('hidden');
    buildGrid();
    clearInterval(timerHandle);
    timerHandle = setInterval(updateTimer, 500);
  }

  function updateTimer() {
    timerEl.textContent = Math.floor((performance.now() - startTime) / 1000) + 's';
  }

  function buildGrid() {
    gridEl.innerHTML = '';
    cardEls = cards.map((icon, i) => {
      const el = document.createElement('div');
      el.className = 'memory-card hidden-face';
      el.addEventListener('click', () => onCardClick(i));
      gridEl.appendChild(el);
      return el;
    });
  }

  function onCardClick(i) {
    if (busy || finished) return;
    const el = cardEls[i];
    if (el.classList.contains('matched') || flipped.includes(i)) return;

    el.classList.remove('hidden-face');
    el.textContent = cards[i];
    flipped.push(i);

    if (flipped.length === 2) {
      moves += 1;
      movesEl.textContent = String(moves);
      busy = true;
      const [a, b] = flipped;
      if (cards[a] === cards[b]) {
        cardEls[a].classList.add('matched');
        cardEls[b].classList.add('matched');
        matchedCount += 1;
        flipped = [];
        busy = false;
        if (matchedCount === ICONS.length) finishGame();
      } else {
        setTimeout(() => {
          cardEls[a].classList.add('hidden-face');
          cardEls[a].textContent = '';
          cardEls[b].classList.add('hidden-face');
          cardEls[b].textContent = '';
          flipped = [];
          busy = false;
        }, 700);
      }
    }
  }

  function finishGame() {
    finished = true;
    clearInterval(timerHandle);
    const seconds = Math.floor((performance.now() - startTime) / 1000);
    const extraMoves = Math.max(0, moves - ICONS.length);
    const speedBonus = Math.max(0, 300 - seconds);
    const score = Math.max(0, Math.min(1500, 1200 + speedBonus - extraMoves * 15));
    finalScoreEl.textContent = score;
    resultDetailEl.textContent = `${seconds}s · ${moves} moves`;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'memory', score);
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
