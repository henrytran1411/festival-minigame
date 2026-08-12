const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  const boardEl = document.getElementById('board');
  const timerEl = document.getElementById('timer');
  const mistakesEl = document.getElementById('mistakes');
  const playScreen = document.getElementById('play-screen');
  const resultScreen = document.getElementById('result-screen');
  const finalScoreEl = document.getElementById('final-score');
  const resultDetailEl = document.getElementById('result-detail');

  const meta = window.FESTIVAL_GAMES.find((g) => g.key === 'sudoku');
  document.getElementById('rules-body').innerHTML = meta.rules.map((r) => `<li>${r}</li>`).join('');
  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('rules-modal').classList.remove('hidden');
  });
  document.querySelector('.modal-close').addEventListener('click', () => {
    document.getElementById('rules-modal').classList.add('hidden');
  });

  let puzzle, solution, board, cells, mistakes, startTime, timerHandle, finished;

  function startGame() {
    const generated = generateSudokuPuzzle();
    puzzle = generated.puzzle;
    solution = generated.solution;
    board = [...puzzle];
    mistakes = 0;
    startTime = performance.now();
    finished = false;
    mistakesEl.textContent = '0';
    timerEl.textContent = '0s';
    resultScreen.classList.add('hidden');
    playScreen.classList.remove('hidden');
    buildBoard();
    clearInterval(timerHandle);
    timerHandle = setInterval(updateTimer, 500);
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
      return;
    }

    board[index] = digit;
    cell.readOnly = true;
    cell.classList.add('filled');

    if (board.every((v, i) => v === solution[i])) {
      finishGame();
    }
  }

  function finishGame() {
    finished = true;
    clearInterval(timerHandle);
    const seconds = Math.floor((performance.now() - startTime) / 1000);
    const score = Math.max(0, Math.min(100, 100 - Math.floor(seconds / 5) - mistakes * 2));
    finalScoreEl.textContent = score;
    resultDetailEl.textContent = `${seconds}s · ${mistakes} mistake${mistakes === 1 ? '' : 's'}`;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'sudoku', score);
  }

  document.getElementById('play-again-btn').addEventListener('click', startGame);
  startGame();
}
