const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  const boardEl = document.getElementById('board');
  const timerEl = document.getElementById('timer');
  const mistakesEl = document.getElementById('mistakes');
  const attemptInfoEl = document.getElementById('attempt-info');
  const playScreen = document.getElementById('play-screen');
  const resultScreen = document.getElementById('result-screen');
  const resultTitleEl = document.getElementById('result-title');
  const finalScoreEl = document.getElementById('final-score');
  const resultDetailEl = document.getElementById('result-detail');
  const exhaustedScreen = document.getElementById('exhausted-screen');

  // Anti-cheat tuning. These are best-effort deterrents, not proof of cheating —
  // anything client-side can be bypassed by someone determined enough. Tab/window
  // switching and the improbable-guess-streak check disqualify immediately; the
  // other two only flag the admin panel, since they're heuristics with real
  // false-positive risk (see checkLowProbabilityGuess for why that one still is).
  const BRUTE_FORCE_WINDOW_MS = 8000; // wrong guesses on one cell within this window...
  const BRUTE_FORCE_COUNT = 4; // ...at or above this count looks like scripted guessing
  const IMPOSSIBLE_SPEED_SECONDS = 25; // this puzzle always has 51 blanks; even a fast
  // human needs longer than this to read, click, and type each one from memory
  const LOW_PROB_CANDIDATE_THRESHOLD = 3; // >=3 remaining candidates means <50% odds of a lucky guess
  const LOW_PROB_STREAK_THRESHOLD = 2; // more than 2 such correct entries in a row disqualifies

  const meta = window.FESTIVAL_GAMES.find((g) => g.key === 'sudoku');
  document.getElementById('rules-body').innerHTML = meta.rules.map((r) => `<li>${r}</li>`).join('');
  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('rules-modal').classList.remove('hidden');
  });
  document.querySelector('.modal-close').addEventListener('click', () => {
    document.getElementById('rules-modal').classList.add('hidden');
  });

  let puzzle, solution, board, cells, mistakes, startTime, timerHandle, finished, gameActive;
  let attemptsUsed = 0, attemptsMax = null;
  let cellWrongLog, flaggedBruteForceCells;
  let lowProbStreak;

  async function tryStartGame() {
    const res = await Festival.requestAttempt(socket, 'sudoku');
    if (!res?.ok) {
      showExhausted();
      return;
    }
    attemptsUsed = res.attemptsUsed;
    attemptsMax = res.attemptsMax;
    startGame();
  }

  function showExhausted() {
    playScreen.classList.add('hidden');
    resultScreen.classList.add('hidden');
    exhaustedScreen.classList.remove('hidden');
  }

  function startGame() {
    const generated = generateSudokuPuzzle();
    puzzle = generated.puzzle;
    solution = generated.solution;
    board = [...puzzle];
    mistakes = 0;
    cellWrongLog = new Map();
    flaggedBruteForceCells = new Set();
    lowProbStreak = 0;
    startTime = performance.now();
    finished = false;
    gameActive = true;
    mistakesEl.textContent = '0';
    timerEl.textContent = '0s';
    if (attemptsMax) attemptInfoEl.textContent = `${attemptsUsed}/${attemptsMax}`;
    exhaustedScreen.classList.add('hidden');
    resultScreen.classList.add('hidden');
    playScreen.classList.remove('hidden');
    buildBoard();
    clearInterval(timerHandle);
    timerHandle = setInterval(updateTimer, 500);
  }

  // Detects switching tabs/apps mid-game (e.g. to ask an AI or a solver for the
  // answer). visibilitychange catches tab switches/minimizing; window blur also
  // catches alt-tabbing to another app on a second monitor. A short grace delay
  // on blur avoids false-triggering on quick UI clicks (address bar, etc.) that
  // don't actually take focus away for long.
  function onLeaveSuspected(source) {
    if (!gameActive) return;
    setTimeout(() => {
      if (!gameActive) return;
      if (document.hidden || !document.hasFocus()) {
        disqualify('tab-switch', `Left the game via ${source}`,
          "You switched tabs or windows during play, so this attempt doesn't count.");
      }
    }, 300);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onLeaveSuspected('tab switch');
  });
  window.addEventListener('blur', () => onLeaveSuspected('window switch'));

  function disqualify(category, detail, message) {
    if (!gameActive) return;
    gameActive = false;
    finished = true;
    clearInterval(timerHandle);
    Festival.reportCheat(socket, 'sudoku', category, detail);
    resultTitleEl.textContent = '🚫 Disqualified';
    finalScoreEl.textContent = '0';
    resultDetailEl.textContent = message;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
  }

  function updateTimer() {
    timerEl.textContent = Math.floor((performance.now() - startTime) / 1000) + 's';
  }

  function buildBoard() {
    boardEl.innerHTML = '';
    cells = [];
    for (let i = 0; i < 81; i++) {
      const cell = document.createElement('input');
      cell.className = 'cell';
      cell.maxLength = 1;
      cell.inputMode = 'numeric';
      if (puzzle[i] !== 0) {
        cell.value = String(puzzle[i]);
        cell.readOnly = true;
        cell.classList.add('clue');
      } else {
        cell.addEventListener('input', () => onCellInput(cell, i));
      }
      boardEl.appendChild(cell);
      cells.push(cell);
    }
  }

  function onCellInput(cell, index) {
    if (finished) return;
    const raw = cell.value.replace(/[^1-9]/g, '');
    const digit = raw ? Number(raw.slice(-1)) : 0;
    cell.value = digit ? String(digit) : '';
    if (!digit) return;

    if (digit !== solution[index]) {
      mistakes += 1;
      mistakesEl.textContent = String(mistakes);
      cell.value = '';
      cell.classList.remove('wrong');
      cell.offsetWidth;
      cell.classList.add('wrong');
      logWrongGuess(index);
      lowProbStreak = 0;
      return;
    }

    checkLowProbabilityGuess(index);
    if (finished) return;

    board[index] = digit;
    cell.readOnly = true;
    cell.classList.add('filled');

    if (board.every((v, i) => v === solution[i])) {
      finishGame();
    }
  }

  // Lists the digits not yet ruled out for this cell by its row, column, and
  // 3x3 box alone — the info a player has without any deeper Sudoku technique.
  // Called before the current cell is filled in, so it only reflects peers.
  function remainingCandidates(index) {
    const row = Math.floor(index / 9);
    const col = index % 9;
    const boxRow = Math.floor(row / 3) * 3;
    const boxCol = Math.floor(col / 3) * 3;
    const used = new Set();
    for (let c = 0; c < 9; c++) if (board[row * 9 + c]) used.add(board[row * 9 + c]);
    for (let r = 0; r < 9; r++) if (board[r * 9 + col]) used.add(board[r * 9 + col]);
    for (let r = boxRow; r < boxRow + 3; r++) {
      for (let c = boxCol; c < boxCol + 3; c++) {
        if (board[r * 9 + c]) used.add(board[r * 9 + c]);
      }
    }
    const candidates = [];
    for (let d = 1; d <= 9; d++) if (!used.has(d)) candidates.push(d);
    return candidates;
  }

  // Disqualifies a run of correct entries that row/column/box elimination alone
  // couldn't have narrowed to better than a coin-flip — a real player without
  // outside help would need deeper technique or luck to keep landing those.
  // Real false-positive risk: skilled players do use techniques (pointing
  // pairs, hidden singles, etc.) this simple row/column/box check can't see,
  // so a genuinely skilled human can trip this. It's a deliberate trade-off
  // for a harder deterrent against reading answers off an AI/solver elsewhere.
  function checkLowProbabilityGuess(index) {
    const candidateCount = remainingCandidates(index).length;
    if (candidateCount < LOW_PROB_CANDIDATE_THRESHOLD) {
      lowProbStreak = 0;
      return;
    }
    lowProbStreak += 1;
    if (lowProbStreak > LOW_PROB_STREAK_THRESHOLD) {
      const probabilityPct = Math.round(100 / candidateCount);
      disqualify('ai-assist-suspected',
        `${lowProbStreak} correct entries in a row with no row/column/box elimination basis (latest: ${candidateCount} candidates, ~${probabilityPct}% chance)`,
        "Your last few answers were statistically far too improbable to guess without outside help, so this attempt doesn't count.");
    }
  }

  // Flags a cell that's collected several wrong guesses in a short window —
  // looks like scripted/brute-force guessing rather than solving by logic.
  // Flag-only: it doesn't block play, just surfaces on the admin panel.
  function logWrongGuess(index) {
    const now = performance.now();
    const recent = (cellWrongLog.get(index) || []).filter((t) => now - t <= BRUTE_FORCE_WINDOW_MS);
    recent.push(now);
    cellWrongLog.set(index, recent);
    if (recent.length >= BRUTE_FORCE_COUNT && !flaggedBruteForceCells.has(index)) {
      flaggedBruteForceCells.add(index);
      Festival.reportCheat(socket, 'sudoku', 'brute-force',
        `${recent.length} wrong guesses on one cell within ${Math.round(BRUTE_FORCE_WINDOW_MS / 1000)}s`);
    }
  }

  function finishGame() {
    finished = true;
    gameActive = false;
    clearInterval(timerHandle);
    const seconds = Math.floor((performance.now() - startTime) / 1000);
    if (seconds < IMPOSSIBLE_SPEED_SECONDS && mistakes === 0) {
      Festival.reportCheat(socket, 'sudoku', 'impossible-speed',
        `Solved all 51 blanks in ${seconds}s with 0 mistakes`);
    }
    const speedBonus = Math.max(0, 300 - Math.floor(seconds / 2));
    const score = Math.max(0, Math.min(1500, 1200 + speedBonus - mistakes * 20));
    finalScoreEl.textContent = score;
    resultTitleEl.textContent = 'Solved! 🎉';
    const detail = `${seconds}s · ${mistakes} mistake${mistakes === 1 ? '' : 's'}`;
    resultDetailEl.textContent = detail;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'sudoku', score, detail);
  }

  const gate = Festival.gateGame(socket, 'sudoku', tryStartGame);
  document.getElementById('play-again-btn').addEventListener('click', () => {
    if (gate.isOpen()) {
      tryStartGame();
    } else {
      gate.block();
    }
  });
}
