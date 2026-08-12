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
  // switching disqualifies immediately (see onLeaveSuspected); the other two only
  // flag the admin panel, since they're heuristics with real false-positive risk.
  const BRUTE_FORCE_WINDOW_MS = 8000; // wrong guesses on one cell within this window...
  const BRUTE_FORCE_COUNT = 4; // ...at or above this count looks like scripted guessing
  const IMPOSSIBLE_SPEED_SECONDS = 25; // this puzzle always has 51 blanks; even a fast
  // human needs longer than this to read, click, and type each one from memory

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
      if (document.hidden || !document.hasFocus()) disqualify(source);
    }, 300);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onLeaveSuspected('tab switch');
  });
  window.addEventListener('blur', () => onLeaveSuspected('window switch'));

  function disqualify(reason) {
    if (!gameActive) return;
    gameActive = false;
    finished = true;
    clearInterval(timerHandle);
    Festival.reportCheat(socket, 'sudoku', 'tab-switch', `Left the game via ${reason}`);
    resultTitleEl.textContent = '🚫 Disqualified';
    finalScoreEl.textContent = '0';
    resultDetailEl.textContent = "You switched tabs or windows during play, so this attempt doesn't count.";
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
      return;
    }

    board[index] = digit;
    cell.readOnly = true;
    cell.classList.add('filled');

    if (board.every((v, i) => v === solution[i])) {
      finishGame();
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
    resultDetailEl.textContent = `${seconds}s · ${mistakes} mistake${mistakes === 1 ? '' : 's'}`;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'sudoku', score);
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
