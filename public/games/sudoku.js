const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  const boardEl = document.getElementById('board');
  const timerEl = document.getElementById('timer');
  const mistakesEl = document.getElementById('mistakes');
  const timeScoreEl = document.getElementById('time-score');
  const inputScoreEl = document.getElementById('input-score');
  const attemptInfoEl = document.getElementById('attempt-info');
  const modeScreen = document.getElementById('mode-screen');
  const playScreen = document.getElementById('play-screen');
  const resultScreen = document.getElementById('result-screen');
  const resultTitleEl = document.getElementById('result-title');
  const finalScoreEl = document.getElementById('final-score');
  const resultDetailEl = document.getElementById('result-detail');
  const exhaustedScreen = document.getElementById('exhausted-screen');
  const modeBadgeEl = document.getElementById('mode-badge');
  const soloModeBtn = document.getElementById('solo-mode-btn');
  const tournamentModeBtn = document.getElementById('tournament-mode-btn');
  Festival.watchTournamentMode(socket, 'sudoku', (available) => {
    tournamentModeBtn.style.display = available ? '' : 'none';
    // While the admin has Tournament mode open, only Tournament is offered
    // -- Solo comes back once the admin hides Tournament again.
    soloModeBtn.style.display = available ? 'none' : '';
  });

  // Anti-cheat tuning. These are best-effort deterrents, not proof of cheating —
  // anything client-side can be bypassed by someone determined enough. Tab/window
  // switching and the improbable-guess-streak check disqualify immediately; the
  // other two only flag the admin panel, since they're heuristics with real
  // false-positive risk (see checkLowProbabilityGuess for why that one still is).
  const BRUTE_FORCE_WINDOW_MS = 8000; // wrong guesses on one cell within this window...
  const BRUTE_FORCE_COUNT = 4; // ...at or above this count looks like scripted guessing
  const IMPOSSIBLE_SPEED_SECONDS = 27; // this puzzle always has 56 blanks; even a fast
  // human needs longer than this to read, click, and type each one from memory
  const LOW_PROB_CANDIDATE_THRESHOLD = 3; // >=3 remaining candidates means <50% odds of a lucky guess
  const LOW_PROB_STREAK_THRESHOLD = 5; // more than 5 such correct entries in a row disqualifies
  const GIVE_UP_POINTS_PER_BOX = 15; // partial-credit rate when a puzzle is abandoned unfinished

  const meta = window.FESTIVAL_GAMES.find((g) => g.key === 'sudoku');
  const rulesModalEl = document.getElementById('rules-modal');
  function renderRulesBody() {
    const lang = Festival.getRulesLang();
    const list = meta.rules[lang] || meta.rules.en;
    document.getElementById('rules-body').innerHTML = list.map((r) => `<li>${r}</li>`).join('');
    Festival.applyRulesLang(rulesModalEl, lang);
  }
  renderRulesBody();
  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    rulesModalEl.classList.remove('hidden');
  });
  document.querySelector('.modal-close').addEventListener('click', () => {
    rulesModalEl.classList.add('hidden');
  });
  rulesModalEl.querySelectorAll('.rules-lang-en').forEach((b) => b.addEventListener('click', () => { Festival.setRulesLang('en'); renderRulesBody(); }));
  rulesModalEl.querySelectorAll('.rules-lang-vi').forEach((b) => b.addEventListener('click', () => { Festival.setRulesLang('vi'); renderRulesBody(); }));

  let puzzle, solution, board, cells, mistakes, correctInputs, startTime, timerHandle, finished, gameActive;
  let attemptsUsed = 0, attemptsMax = null;
  let cellWrongLog, flaggedBruteForceCells;
  let lowProbStreak, flaggedLowProbStreak;
  // 'solo' | 'tournament' -- picked on the mode screen before each attempt.
  // Unlike Proverb/Scramble, Sudoku's Tournament puzzle is NOT shared -- each
  // player still gets their own random puzzle, same as Solo. Picking
  // Tournament only tags the attempt for the leaderboard. Both modes draw
  // from the same 3 total attempts.
  let currentMode = 'solo';

  function showModeScreen() {
    playScreen.classList.add('hidden');
    resultScreen.classList.add('hidden');
    exhaustedScreen.classList.add('hidden');
    modeScreen.classList.remove('hidden');
  }

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
    modeScreen.classList.add('hidden');
    exhaustedScreen.classList.remove('hidden');
  }

  function startGame() {
    const generated = generateSudokuPuzzle();
    puzzle = generated.puzzle;
    solution = generated.solution;
    board = [...puzzle];
    mistakes = 0;
    correctInputs = 0;
    cellWrongLog = new Map();
    flaggedBruteForceCells = new Set();
    lowProbStreak = 0;
    flaggedLowProbStreak = false;
    startTime = performance.now();
    finished = false;
    gameActive = true;
    mistakesEl.textContent = '0';
    timerEl.textContent = '0s';
    timeScoreEl.textContent = String(speedBonusFor(0));
    inputScoreEl.textContent = String(inputScoreFor());
    if (attemptsMax) attemptInfoEl.textContent = `${attemptsUsed}/${attemptsMax}`;
    modeBadgeEl.textContent = currentMode === 'tournament' ? '🏆 Tournament' : '';
    modeScreen.classList.add('hidden');
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
    updateLiveScore();
  }

  function speedBonusFor(seconds) {
    return Math.max(0, 300 - Math.floor(seconds / 2));
  }

  function inputScoreFor() {
    return Math.max(0, Math.min(1200, correctInputs * 25 - mistakes * 20));
  }

  function computeScore(seconds) {
    return Math.max(0, Math.min(1500, inputScoreFor() + speedBonusFor(seconds)));
  }

  function updateLiveScore() {
    const seconds = Math.floor((performance.now() - startTime) / 1000);
    timeScoreEl.textContent = String(speedBonusFor(seconds));
    inputScoreEl.textContent = String(inputScoreFor());
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
      updateLiveScore();
      return;
    }

    checkLowProbabilityGuess(index);
    if (finished) return;

    correctInputs += 1;
    board[index] = digit;
    cell.readOnly = true;
    cell.classList.add('filled');
    updateLiveScore();

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

  // Flags a run of correct entries that row/column/box elimination alone
  // couldn't have narrowed to better than a coin-flip — a real player without
  // outside help would need deeper technique or luck to keep landing those.
  // Flag-only (like logWrongGuess's brute-force check): it doesn't end the
  // attempt or touch the score, just surfaces on the admin panel for review,
  // so players aren't abruptly disqualified over a false positive.
  // Real false-positive risk: skilled players do use techniques (pointing
  // pairs, hidden singles, etc.) this simple row/column/box check can't see,
  // so a genuinely skilled human can trip this.
  function checkLowProbabilityGuess(index) {
    const candidateCount = remainingCandidates(index).length;
    if (candidateCount < LOW_PROB_CANDIDATE_THRESHOLD) {
      lowProbStreak = 0;
      return;
    }
    lowProbStreak += 1;
    if (lowProbStreak > LOW_PROB_STREAK_THRESHOLD && !flaggedLowProbStreak) {
      flaggedLowProbStreak = true;
      const probabilityPct = Math.round(100 / candidateCount);
      Festival.reportCheat(socket, 'sudoku', 'ai-assist-suspected',
        `${lowProbStreak} correct entries in a row with no row/column/box elimination basis (latest: ${candidateCount} candidates, ~${probabilityPct}% chance)`);
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
        `Solved all 56 blanks in ${seconds}s with 0 mistakes`);
    }
    const score = computeScore(seconds);
    finalScoreEl.textContent = score;
    resultTitleEl.textContent = 'Solved! 🎉';
    const detail = `${seconds}s · ${mistakes} mistake${mistakes === 1 ? '' : 's'}${currentMode === 'tournament' ? ' · Tournament' : ''}`;
    resultDetailEl.textContent = detail;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'sudoku', score, detail);
  }

  // Lets a player end a puzzle they can't finish instead of being stuck with
  // nothing — worth less than solving it (15 pts/box vs. up to 1,500 total
  // for a full clean solve), but still credits the boxes they got right.
  function giveUp() {
    if (!gameActive) return;
    gameActive = false;
    finished = true;
    clearInterval(timerHandle);
    const correctCount = board.reduce((sum, v, i) => sum + (puzzle[i] === 0 && v !== 0 ? 1 : 0), 0);
    const totalBlanks = puzzle.filter((v) => v === 0).length;
    const score = Math.max(0, Math.min(1500, correctCount * GIVE_UP_POINTS_PER_BOX));
    finalScoreEl.textContent = score;
    resultTitleEl.textContent = 'Attempt ended';
    const detail = `Gave up · ${correctCount} of ${totalBlanks} boxes filled correctly${currentMode === 'tournament' ? ' · Tournament' : ''}`;
    resultDetailEl.textContent = detail;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'sudoku', score, detail);
  }

  document.getElementById('give-up-btn').addEventListener('click', giveUp);

  soloModeBtn.addEventListener('click', () => {
    currentMode = 'solo';
    tryStartGame();
  });
  tournamentModeBtn.addEventListener('click', () => {
    currentMode = 'tournament';
    tryStartGame();
  });

  const gate = Festival.gateGame(socket, 'sudoku', showModeScreen);
  document.getElementById('play-again-btn').addEventListener('click', () => {
    if (gate.isOpen()) {
      showModeScreen();
    } else {
      gate.block();
    }
  });
}
