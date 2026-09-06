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
  const tournamentLobbyScreenEl = document.getElementById('tournament-lobby-screen');
  const tournamentLobbyCountEl = document.getElementById('tournament-lobby-count');
  const tournamentLobbyPlayersEl = document.getElementById('tournament-lobby-players');
  const playScreen = document.getElementById('play-screen');
  const resultScreen = document.getElementById('result-screen');
  const resultTitleEl = document.getElementById('result-title');
  const finalScoreEl = document.getElementById('final-score');
  const resultDetailEl = document.getElementById('result-detail');
  const exhaustedScreen = document.getElementById('exhausted-screen');
  const exhaustedTitleEl = document.getElementById('exhausted-title');
  const exhaustedDetailEl = document.getElementById('exhausted-detail');
  const exhaustedBackBtn = document.getElementById('exhausted-back-btn');
  const modeBadgeEl = document.getElementById('mode-badge');
  const soloModeBtn = document.getElementById('solo-mode-btn');
  const tournamentModeBtn = document.getElementById('tournament-mode-btn');
  Festival.watchTournamentMode(socket, 'sudoku', (available) => {
    tournamentModeBtn.style.display = available ? '' : 'none';
    // While the admin has Tournament mode open, only Tournament is offered
    // -- Solo comes back once the admin hides Tournament again.
    soloModeBtn.style.display = available ? 'none' : '';
  });

  // Tournament round pacing, server-authoritative (see server.js's
  // tournamentRound) -- shared with Proverb/Scramble's lobby mechanism, but
  // Sudoku's puzzle itself is never shared content (see the comment on
  // `currentMode` below), so there's just one "question" (totalQuestions=1):
  // once the admin starts the round, this player's own puzzle begins right
  // away, same as Solo, with no further admin action needed.
  let roundState = null;
  function renderLobby(state) {
    tournamentLobbyCountEl.textContent = `👥 ${state.playerCount} joined`;
    Festival.renderTournamentLobbyPlayers(tournamentLobbyPlayersEl, state.players);
  }
  Festival.watchTournamentRoundState(socket, 'sudoku', (state) => {
    const wasLobby = roundState && roundState.phase === 'lobby';
    roundState = state;
    if (currentMode !== 'tournament' || tournamentLobbyScreenEl.classList.contains('hidden')) return;
    renderLobby(state);
    if (state.phase === 'active' && wasLobby) {
      tournamentLobbyScreenEl.classList.add('hidden');
      tryTournamentAttempt();
    }
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
  let tournamentAttemptsUsed = 0, tournamentAttemptsMax = null;
  let cellWrongLog, flaggedBruteForceCells;
  let lowProbStreak, flaggedLowProbStreak;
  let lastReportedLiveScore = null; // dedupe: updateLiveScore ticks every 500ms, the score doesn't
  // 'solo' | 'tournament' -- picked on the mode screen before each attempt.
  // Unlike Proverb/Scramble, Sudoku's Tournament puzzle is NOT shared -- each
  // player still gets their own random puzzle, same as Solo. Solo draws from
  // the lifetime attemptsUsed/attemptsMax pool (Festival.requestAttempt,
  // via tryStartGame()); every Tournament attempt -- including the first,
  // right after the admin releases the lobby -- instead draws from a
  // SEPARATE tournamentAttemptsUsed/Max pool (Festival.requestTournamentAttempt,
  // via tryTournamentAttempt(), up to TOURNAMENT_MAX_ATTEMPTS on the server)
  // that never touches the lifetime one, so Solo's cap is unaffected either way.
  let currentMode = 'solo';

  function showModeScreen() {
    tournamentLobbyScreenEl.classList.add('hidden');
    playScreen.classList.add('hidden');
    resultScreen.classList.add('hidden');
    exhaustedScreen.classList.add('hidden');
    modeScreen.classList.remove('hidden');
  }

  async function tryStartGame() {
    const res = await Festival.requestAttempt(socket, 'sudoku');
    if (!res?.ok) {
      showExhausted('lifetime');
      return;
    }
    attemptsUsed = res.attemptsUsed;
    attemptsMax = res.attemptsMax;
    startGame();
  }

  // Tournament-only: reserves one of this round's separate retry attempts
  // (see the `currentMode` comment above) instead of the lifetime pool.
  async function tryTournamentAttempt() {
    const res = await Festival.requestTournamentAttempt(socket, 'sudoku');
    if (!res?.ok) {
      if (res && res.error === 'exhausted') {
        showExhausted('tournament');
      } else {
        // Round no longer active (e.g. admin started a new one) -- nothing
        // left to retry into, so send them back to pick a mode again.
        showModeScreen();
      }
      return;
    }
    tournamentAttemptsUsed = res.attemptsUsed;
    tournamentAttemptsMax = res.attemptsMax;
    startGame();
  }

  function showExhausted(kind) {
    playScreen.classList.add('hidden');
    resultScreen.classList.add('hidden');
    modeScreen.classList.add('hidden');
    exhaustedTitleEl.textContent = kind === 'tournament' ? '🔒 No tournament attempts left' : '🔒 No attempts left';
    exhaustedDetailEl.textContent = kind === 'tournament'
      ? `You've used all ${tournamentAttemptsMax} of your Tournament attempts for this round.`
      : "You've used all 3 of your Sudoku attempts for this event.";
    // A Tournament player who's out of THIS round's retries may still have
    // Solo attempts left, so send them back to choose rather than the hub.
    exhaustedBackBtn.textContent = kind === 'tournament' ? '← Choose a Mode' : 'Back to Hub';
    exhaustedBackBtn.onclick = kind === 'tournament' ? showModeScreen : () => { window.location.href = '../index.html'; };
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
    lastReportedLiveScore = null;
    startTime = performance.now();
    finished = false;
    gameActive = true;
    mistakesEl.textContent = '0';
    timerEl.textContent = '0s';
    timeScoreEl.textContent = String(speedBonusFor(0));
    inputScoreEl.textContent = String(inputScoreFor());
    if (currentMode === 'tournament') {
      attemptInfoEl.textContent = `🏆 ${tournamentAttemptsUsed}/${tournamentAttemptsMax}`;
    } else if (attemptsMax) {
      attemptInfoEl.textContent = `${attemptsUsed}/${attemptsMax}`;
    }
    modeBadgeEl.textContent = currentMode === 'tournament' ? '🏆 Tournament' : '';
    modeScreen.classList.add('hidden');
    tournamentLobbyScreenEl.classList.add('hidden');
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
    if (currentMode === 'tournament') Festival.submitTournamentQuestionDone(socket, 'sudoku', 0, 0, true);
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
    if (currentMode === 'tournament') {
      // No staged "questions" here (see tournamentRound comment above), so
      // questionIndex is always 0 -- this just keeps the admin's Live Top
      // Score page updated with this player's current in-progress score.
      // Only emit when it actually changed -- this ticks every 500ms for the
      // whole game, but the score itself only moves on a cell fill or every
      // couple of seconds of speed-bonus decay.
      const liveScore = computeScore(seconds);
      if (liveScore !== lastReportedLiveScore) {
        lastReportedLiveScore = liveScore;
        Festival.submitTournamentQuestionDone(socket, 'sudoku', 0, liveScore, false);
      }
    }
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
    Festival.submitScore(socket, 'sudoku', score, detail, currentMode);
    if (currentMode === 'tournament') Festival.submitTournamentQuestionDone(socket, 'sudoku', 0, score, true);
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
    Festival.submitScore(socket, 'sudoku', score, detail, currentMode);
    if (currentMode === 'tournament') Festival.submitTournamentQuestionDone(socket, 'sudoku', 0, score, true);
  }

  document.getElementById('give-up-btn').addEventListener('click', giveUp);

  soloModeBtn.addEventListener('click', () => {
    currentMode = 'solo';
    tryStartGame();
  });
  tournamentModeBtn.addEventListener('click', () => {
    tournamentModeBtn.disabled = true;
    const { id: playerId, name } = Festival.getPlayer();
    socket.emit('tournament:join', { playerId, name, game: 'sudoku' }, (res) => {
      tournamentModeBtn.disabled = false;
      if (!res || !res.ok) {
        if (res && res.error === 'round-in-progress') {
          alert('A Tournament round is already in progress. Please wait for the admin to start a new round.');
        } else {
          alert('Could not join the tournament: ' + ((res && res.error) || 'unknown error'));
        }
        return;
      }
      currentMode = 'tournament';
      roundState = res.round;
      modeScreen.classList.add('hidden');
      renderLobby(res.round);
      tournamentLobbyScreenEl.classList.remove('hidden');
    });
  });

  const gate = Festival.gateGame(socket, 'sudoku', showModeScreen);
  document.getElementById('play-again-btn').addEventListener('click', () => {
    // Still an active Tournament participant -- retry with a fresh puzzle
    // (up to TOURNAMENT_MAX_ATTEMPTS) instead of leaving the round entirely.
    if (currentMode === 'tournament' && roundState && roundState.phase === 'active') {
      tryTournamentAttempt();
      return;
    }
    if (gate.isOpen()) {
      showModeScreen();
    } else {
      gate.block();
    }
  });
}
