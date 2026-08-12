const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  // Tết Trung Thu (Mid-Autumn Festival) vocabulary. The scrambled display
  // strips diacritics/spaces down to plain Latin letters and shuffles them
  // as one block (e.g. "CHỊ HẰNG" -> "HCIGNAH"); the typed answer must
  // still match the correctly accented word, see submitAnswer().
  const GAME_SECONDS = 240;
  const MAX_HINTS = 3;
  const WORD_POOL = [
    { word: 'TRUNG THU', hint: 'The Vietnamese Mid-Autumn Festival itself' },
    { word: 'ĐÈN LỒNG', hint: 'A colorful lantern kids carry at night' },
    { word: 'MÚA LÂN', hint: 'The lion dance performance' },
    { word: 'BÁNH NƯỚNG', hint: 'A baked mooncake' },
    { word: 'BÁNH DẺO', hint: 'A soft, chewy mooncake' },
    { word: 'RƯỚC ĐÈN', hint: 'The nighttime lantern parade' },
    { word: 'PHÁ CỖ', hint: 'Sharing the festival food tray' },
    { word: 'TRĂNG RẰM', hint: 'The full moon' },
    { word: 'CHỊ HẰNG', hint: 'The Moon Goddess of folklore' },
    { word: 'CHÚ CUỘI', hint: 'The Moon Boy of folklore' },
    { word: 'ĐÈN ÔNG SAO', hint: 'A star-shaped lantern' },
    { word: 'ÔNG ĐỊA', hint: 'The Earth God character in the lion dance' },
  ];

  const timerEl = document.getElementById('timer');
  const liveScoreEl = document.getElementById('live-score');
  const wordIndexEl = document.getElementById('word-index');
  const scrambledEl = document.getElementById('scrambled');
  const answerInput = document.getElementById('answer-input');
  const submitBtn = document.getElementById('submit-btn');
  const skipBtn = document.getElementById('skip-btn');
  const flashEl = document.getElementById('flash');
  const hintEl = document.getElementById('hint');
  const hintBtn = document.getElementById('hint-btn');
  const playScreen = document.getElementById('play-screen');
  const resultScreen = document.getElementById('result-screen');
  const finalScoreEl = document.getElementById('final-score');
  const resultDetailEl = document.getElementById('result-detail');

  const meta = window.FESTIVAL_GAMES.find((g) => g.key === 'scramble');
  document.getElementById('rules-body').innerHTML = meta.rules.map((r) => `<li>${r}</li>`).join('');
  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('rules-modal').classList.remove('hidden');
  });
  document.querySelector('.modal-close').addEventListener('click', () => {
    document.getElementById('rules-modal').classList.add('hidden');
  });

  let words, index, score, solvedCount, timeLeft, timerHandle, finished, hintsLeft;

  function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function stripDiacritics(word) {
    return word
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replaceAll('Đ', 'D')
      .replaceAll('đ', 'd')
      .replace(/\s+/g, '');
  }

  function scramble(word) {
    const letters = Array.from(stripDiacritics(word));
    if (letters.length <= 1) return letters.join('');
    let arranged;
    do {
      arranged = shuffleArray(letters);
    } while (arranged.join('') === letters.join(''));
    return arranged.join('');
  }

  function pickWords() {
    const pool = [...WORD_POOL];
    const chosen = [];
    for (let i = 0; i < 8; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      chosen.push(pool.splice(idx, 1)[0]);
    }
    return chosen;
  }

  function startGame() {
    words = pickWords();
    index = 0;
    score = 0;
    solvedCount = 0;
    timeLeft = GAME_SECONDS;
    hintsLeft = MAX_HINTS;
    finished = false;
    liveScoreEl.textContent = '0';
    timerEl.textContent = GAME_SECONDS + 's';
    resultScreen.classList.add('hidden');
    playScreen.classList.remove('hidden');
    answerInput.disabled = false;
    submitBtn.disabled = false;
    skipBtn.disabled = false;
    updateHintButton();
    showWord();
    clearInterval(timerHandle);
    timerHandle = setInterval(tick, 1000);
  }

  function updateHintButton() {
    hintBtn.textContent = `💡 Hint (${hintsLeft} left)`;
    hintBtn.disabled = hintsLeft <= 0 || finished;
  }

  function showWord() {
    wordIndexEl.textContent = String(index + 1);
    scrambledEl.textContent = scramble(words[index].word);
    answerInput.value = '';
    flashEl.textContent = '';
    flashEl.className = 'scramble-flash';
    hintEl.textContent = '';
    answerInput.focus();
  }

  function tick() {
    timeLeft -= 1;
    timerEl.textContent = timeLeft + 's';
    if (timeLeft <= 0) finishGame(0);
  }

  function flash(message, cls) {
    flashEl.textContent = message;
    flashEl.className = 'scramble-flash ' + cls;
  }

  function submitAnswer() {
    if (finished) return;
    const guess = answerInput.value.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!guess) return;

    if (guess === words[index].word) {
      score += 10;
      solvedCount += 1;
      liveScoreEl.textContent = String(score);
      flash('Correct!', 'good');
      advance();
    } else {
      score -= 2;
      liveScoreEl.textContent = String(score);
      flash('Not quite, try again', 'bad');
      answerInput.value = '';
      answerInput.focus();
    }
  }

  function advance() {
    index += 1;
    if (index >= words.length) {
      finishGame(timeLeft);
    } else {
      setTimeout(showWord, 400);
    }
  }

  function finishGame(bonus) {
    if (finished) return;
    finished = true;
    clearInterval(timerHandle);
    answerInput.disabled = true;
    submitBtn.disabled = true;
    skipBtn.disabled = true;
    hintBtn.disabled = true;
    const finalScore = Math.max(0, Math.min(100, score + bonus));
    finalScoreEl.textContent = finalScore;
    resultDetailEl.textContent = `${solvedCount} of ${words.length} words solved`;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'scramble', finalScore);
  }

  submitBtn.addEventListener('click', submitAnswer);
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAnswer();
  });
  skipBtn.addEventListener('click', () => {
    if (finished) return;
    flash('Skipped', 'bad');
    advance();
  });
  hintBtn.addEventListener('click', () => {
    if (finished || hintsLeft <= 0) return;
    hintsLeft -= 1;
    updateHintButton();
    hintEl.textContent = `Hint: ${words[index].hint}`;
  });
  document.getElementById('play-again-btn').addEventListener('click', startGame);

  startGame();
}
