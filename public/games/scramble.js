const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  // Tết Trung Thu (Mid-Autumn Festival) vocabulary. The scrambled display
  // strips diacritics/spaces down to plain Latin letters and shuffles them
  // as one block (e.g. "CHỊ HẰNG" -> "HCIGNAH"); the typed answer must
  // still match the correctly accented word, see submitAnswer().
  const ROUND_SECONDS = 60; // seconds per word
  const WORDS_PER_GAME = 12;
  const TOTAL_GAME_SECONDS = ROUND_SECONDS * WORDS_PER_GAME; // 720
  const HINT_UNLOCK_AT = 15; // seconds elapsed in the current word before the button unlocks
  const AUTO_HINT_AT = 40; // seconds elapsed before the hint is shown automatically
  const MAX_HINTS = 3; // starting hints for the whole game
  const HINT_BONUS_STREAK = 3; // correct answers in a row without a hint to earn a bonus hint
  const MAX_HINT_BONUSES = 2; // bonus hints obtainable this way, for a max of 3 + 2 = 5
  const WORD_POINTS = 100;
  const WRONG_PENALTY = 20;
  const MAX_SPEED_BONUS = 300;
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
    { word: 'SMARTDEV', hint: 'The home' },
    { word: 'CÔNG ĐOÀN', hint: 'The team' },
    { word: 'MẶT NẠ', hint: 'The paper mask kids wear during the parade' },
    { word: 'THỎ NGỌC', hint: 'The Jade Rabbit living on the moon in folklore' },
    { word: 'ĐÈN KÉO QUÂN', hint: 'The rotating lantern with shadow figures inside' },
    { word: 'HOA ĐĂNG', hint: 'A flower-shaped lantern set afloat on water' },
    { word: 'TẾT ĐOÀN VIÊN', hint: "Another name for this festival — the 'Reunion Festival'" },
    { word: 'THƯỞNG TRÀ', hint: 'Sipping tea together while admiring the full moon' },
  ];

  const timerEl = document.getElementById('timer');
  const liveScoreEl = document.getElementById('live-score');
  const wordIndexEl = document.getElementById('word-index');
  const wordTotalEl = document.getElementById('word-total');
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

  let words, index, score, solvedCount, savedTime, startTime, roundTimeLeft, roundTimerHandle,
    finished, hintsLeft, hintBonusesGranted, noHintStreak, hintUsedThisWord, transitioning;

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
    for (let i = 0; i < WORDS_PER_GAME; i++) {
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
    savedTime = 0;
    startTime = performance.now();
    hintsLeft = MAX_HINTS;
    hintBonusesGranted = 0;
    noHintStreak = 0;
    finished = false;
    liveScoreEl.textContent = '0';
    if (wordTotalEl) wordTotalEl.textContent = String(words.length);
    resultScreen.classList.add('hidden');
    playScreen.classList.remove('hidden');
    answerInput.disabled = false;
    submitBtn.disabled = false;
    skipBtn.disabled = false;
    showWord();
  }

  function elapsedInRound() {
    return ROUND_SECONDS - roundTimeLeft;
  }

  function updateHintButton() {
    const alreadyShown = !!hintEl.textContent;
    const unlocked = elapsedInRound() >= HINT_UNLOCK_AT;
    hintBtn.disabled = finished || alreadyShown || hintsLeft <= 0 || !unlocked;
    if (finished) return;
    if (alreadyShown) {
      hintBtn.textContent = '💡 Hint shown';
    } else if (!unlocked) {
      hintBtn.textContent = `💡 Hint (unlocks in ${HINT_UNLOCK_AT - elapsedInRound()}s)`;
    } else {
      hintBtn.textContent = `💡 Hint (${hintsLeft} left)`;
    }
  }

  function showWord() {
    transitioning = false;
    hintUsedThisWord = false;
    wordIndexEl.textContent = String(index + 1);
    scrambledEl.textContent = scramble(words[index].word);
    answerInput.value = '';
    answerInput.disabled = false;
    submitBtn.disabled = false;
    skipBtn.disabled = false;
    flashEl.textContent = '';
    flashEl.className = 'scramble-flash';
    hintEl.textContent = '';
    roundTimeLeft = ROUND_SECONDS;
    timerEl.textContent = ROUND_SECONDS + 's';
    updateHintButton();
    answerInput.focus();
    clearInterval(roundTimerHandle);
    roundTimerHandle = setInterval(roundTick, 1000);
  }

  function roundTick() {
    if (transitioning) return;
    roundTimeLeft -= 1;
    timerEl.textContent = Math.max(0, roundTimeLeft) + 's';
    if (elapsedInRound() >= AUTO_HINT_AT && !hintEl.textContent) {
      hintEl.textContent = `Hint: ${words[index].hint}`;
      hintUsedThisWord = true;
    }
    updateHintButton();
    if (roundTimeLeft <= 0) {
      clearInterval(roundTimerHandle);
      flash("Time's up!", 'bad');
      noHintStreak = 0;
      advance(900);
    }
  }

  function flash(message, cls) {
    flashEl.textContent = message;
    flashEl.className = 'scramble-flash ' + cls;
  }

  function submitAnswer() {
    if (finished || transitioning) return;
    const guess = answerInput.value.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!guess) return;

    if (guess === words[index].word) {
      score += WORD_POINTS;
      solvedCount += 1;
      savedTime += Math.max(0, roundTimeLeft);
      liveScoreEl.textContent = String(score);
      clearInterval(roundTimerHandle);
      let message = 'Correct!';
      if (!hintUsedThisWord) {
        noHintStreak += 1;
        if (noHintStreak >= HINT_BONUS_STREAK && hintBonusesGranted < MAX_HINT_BONUSES) {
          hintsLeft += 1;
          hintBonusesGranted += 1;
          noHintStreak = 0;
          message = 'Correct! +1 bonus hint 🎉';
        }
      } else {
        noHintStreak = 0;
      }
      flash(message, 'good');
      advance(400);
    } else {
      score -= WRONG_PENALTY;
      liveScoreEl.textContent = String(score);
      flash('Not quite, try again', 'bad');
      answerInput.value = '';
      answerInput.focus();
    }
  }

  function advance(delay) {
    if (transitioning) return;
    transitioning = true;
    index += 1;
    if (index >= words.length) {
      finishGame();
    } else {
      setTimeout(showWord, delay);
    }
  }

  function finishGame() {
    if (finished) return;
    finished = true;
    clearInterval(roundTimerHandle);
    answerInput.disabled = true;
    submitBtn.disabled = true;
    skipBtn.disabled = true;
    hintBtn.disabled = true;
    const bonus = Math.round(MAX_SPEED_BONUS * (savedTime / TOTAL_GAME_SECONDS));
    const finalScore = Math.max(0, Math.min(1500, score + bonus));
    finalScoreEl.textContent = finalScore;
    const seconds = Math.floor((performance.now() - startTime) / 1000);
    const detail = `${seconds}s · ${solvedCount} of ${words.length} words solved`;
    resultDetailEl.textContent = detail;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'scramble', finalScore, detail);
  }

  submitBtn.addEventListener('click', submitAnswer);
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAnswer();
  });
  skipBtn.addEventListener('click', () => {
    if (finished || transitioning) return;
    clearInterval(roundTimerHandle);
    flash('Skipped', 'bad');
    noHintStreak = 0;
    advance(400);
  });
  hintBtn.addEventListener('click', () => {
    if (finished || transitioning || hintsLeft <= 0 || elapsedInRound() < HINT_UNLOCK_AT || hintEl.textContent) return;
    hintsLeft -= 1;
    hintUsedThisWord = true;
    hintEl.textContent = `Hint: ${words[index].hint}`;
    updateHintButton();
  });
  const gate = Festival.gateGame(socket, 'scramble', startGame);
  document.getElementById('play-again-btn').addEventListener('click', () => {
    if (gate.isOpen()) {
      startGame();
    } else {
      gate.block();
    }
  });
}
