const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  // Tết Trung Thu (Mid-Autumn Festival) vocabulary. The scrambled display
  // strips diacritics/spaces down to plain Latin letters and shuffles them
  // as one block (e.g. "CHỊ HẰNG" -> "HCIGNAH"); the typed answer must
  // still match the correctly accented word, see submitAnswer().
  const ROUND_SECONDS = 60; // seconds per word
  const WORDS_PER_GAME = 12; // Solo mode's draw size. Tournament mode's round is
  // longer (see server.js's TOURNAMENT_SCRAMBLE_ROUND_LENGTH) to fit its two
  // fixed-position words, so the speed bonus below is computed from the
  // actual `words.length` for whichever mode is running, not this constant.
  const HINT_UNLOCK_AT = 15; // seconds elapsed in the current word before the button unlocks
  const AUTO_HINT_AT = 30; // seconds elapsed before the hint is shown automatically
  const MAX_HINTS = 3; // starting hints for the whole game
  const HINT_BONUS_STREAK = 3; // correct answers in a row without a hint to earn a bonus hint
  const MAX_HINT_BONUSES = 2; // bonus hints obtainable this way, for a max of 3 + 2 = 5
  const WORD_POINTS = 100; // Solo mode: flat points for a correct word
  const WRONG_PENALTY = 20; // Solo mode: points lost per wrong guess
  const MAX_SPEED_BONUS = 300;

  // Tournament mode's correct-word score decays with elapsed time instead of
  // the flat WORD_POINTS Solo uses, in two phases:
  //  - Phase 1 (0s to AUTO_HINT_AT): steps down every 0.5s, from 100 to
  //    TOURNAMENT_PHASE1_END_POINTS over that span (so 0-0.5s = 100,
  //    0.5-1s = 99, ...), floored to a whole number each half-second tick.
  //  - Phase 2 (AUTO_HINT_AT to ROUND_SECONDS): once the hint has auto-shown,
  //    decay slows to 1 point per 1.5 elapsed seconds, continuing from
  //    wherever phase 1 left off.
  // Needs sub-second precision (see wordStartTime), since roundTimeLeft only
  // ticks once per second and can't resolve the 0.5s phase-1 steps.
  const TOURNAMENT_PHASE1_END_POINTS = 70;
  const TOURNAMENT_PHASE2_STEP_SECONDS = 1.5;
  const TOURNAMENT_WRONG_PENALTY = 4;
  const MAX_TOURNAMENT_WRONG_GUESSES = 5; // per word -- Solo stays unlimited retries

  function tournamentPointsForCorrectAnswer(elapsedSeconds) {
    if (elapsedSeconds < AUTO_HINT_AT) {
      const perHalfStep = (WORD_POINTS - TOURNAMENT_PHASE1_END_POINTS) / (AUTO_HINT_AT * 2);
      return Math.floor(WORD_POINTS - perHalfStep * Math.floor(elapsedSeconds * 2));
    }
    const stepsSinceHint = Math.floor((elapsedSeconds - AUTO_HINT_AT) / TOURNAMENT_PHASE2_STEP_SECONDS);
    return TOURNAMENT_PHASE1_END_POINTS - stepsSinceHint;
  }

  // Tournament mode's speed bonus (replaces Solo's single MAX_SPEED_BONUS=300
  // savedTime-based figure) splits the same 300-point total into three parts:
  //  - Up to 150 (10/word): only for a correct word typed with full
  //    Vietnamese diacritics -- e.g. "BÁNH DẺO" earns it, "BANH DEO" (still
  //    accepted as correct, see normalizeForCompare) does not.
  //  - Up to 75 (5/word): only for a correct word answered before the
  //    AUTO_HINT_AT auto-hint has shown (hintUsedThisWord still false).
  //  - Up to 75: a single tiered bonus on TOTAL time used across all 15
  //    words (see totalTimeUsed) -- 75 points for 0-60s total, stepping
  //    down 5 points per additional 60s, floor of 25 past 600s total.
  const TOURNAMENT_DIACRITICS_BONUS = 10;
  const TOURNAMENT_NO_HINT_BONUS = 5;

  function tournamentTimeBonus(totalSeconds) {
    if (totalSeconds > 600) return 25;
    const tier = Math.max(1, Math.ceil(totalSeconds / 60));
    return 75 - 5 * (tier - 1);
  }

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
  const modeScreen = document.getElementById('mode-screen');
  const tournamentLobbyScreenEl = document.getElementById('tournament-lobby-screen');
  const tournamentLobbyCountEl = document.getElementById('tournament-lobby-count');
  const tournamentLobbyPlayersEl = document.getElementById('tournament-lobby-players');
  const tournamentWaitMsgEl = document.getElementById('tournament-wait-msg');
  const playScreen = document.getElementById('play-screen');
  const resultScreen = document.getElementById('result-screen');
  const finalScoreEl = document.getElementById('final-score');
  const resultDetailEl = document.getElementById('result-detail');
  const bonusBreakdownEl = document.getElementById('bonus-breakdown');
  const modeBadgeEl = document.getElementById('mode-badge');
  const wrongGuessCounterEl = document.getElementById('wrong-guess-counter');
  const soloModeBtn = document.getElementById('solo-mode-btn');
  const tournamentModeBtn = document.getElementById('tournament-mode-btn');
  Festival.watchTournamentMode(socket, 'scramble', (available) => {
    tournamentModeBtn.style.display = available ? '' : 'none';
    // While the admin has Tournament mode open, only Tournament is offered
    // -- Solo comes back once the admin hides Tournament again.
    soloModeBtn.style.display = available ? 'none' : '';
  });

  // Tournament-only: shows the running wrong-guess count against
  // MAX_TOURNAMENT_WRONG_GUESSES (e.g. "❌ 2/5"), turning solid red once the
  // cap is hit and the word locks -- see submitAnswer()'s wrong-guess branch.
  function renderWrongGuessCounter() {
    if (currentMode !== 'tournament') {
      wrongGuessCounterEl.classList.add('hidden');
      return;
    }
    wrongGuessCounterEl.classList.remove('hidden');
    wrongGuessCounterEl.textContent = `❌ ${wrongGuessCount}/${MAX_TOURNAMENT_WRONG_GUESSES}`;
    wrongGuessCounterEl.style.fontWeight = wrongGuessCount >= MAX_TOURNAMENT_WRONG_GUESSES ? '700' : '400';
  }

  // Tournament round pacing, server-authoritative (see server.js's
  // tournamentRound). While this player is in the lobby, `pendingWordOrder`
  // holds the content already fetched at tournament:join -- startGame() isn't
  // called until admin:tournament-start flips the round to 'active'. Once
  // playing, `waitingForAdmin` marks the gap after a question ends until
  // admin:tournament-next bumps questionIndex -- see advance() and
  // enterWaitingForAdmin()/exitWaitingForAdmin() below.
  let roundState = null;
  let pendingWordOrder = null;
  let waitingForAdmin = false;
  function renderLobby(state) {
    tournamentLobbyCountEl.textContent = `👥 ${state.playerCount} joined`;
    Festival.renderTournamentLobbyPlayers(tournamentLobbyPlayersEl, state.players);
  }
  Festival.watchTournamentRoundState(socket, 'scramble', (state) => {
    const wasLobby = roundState && roundState.phase === 'lobby';
    roundState = state;
    if (currentMode !== 'tournament') return;
    if (!tournamentLobbyScreenEl.classList.contains('hidden')) {
      renderLobby(state);
      if (state.phase === 'active' && wasLobby) {
        tournamentLobbyScreenEl.classList.add('hidden');
        startGame(pendingWordOrder);
      }
      return;
    }
    if (waitingForAdmin && state.phase === 'active' && state.questionIndex > index) {
      index = state.questionIndex;
      exitWaitingForAdmin();
      showWord();
    }
  });

  // Tournament-only: once every joined participant has finished this word
  // (see submitTournamentQuestionDone above), end it early for anyone still
  // locked in and just watching their own clock count down for no reason --
  // whether they answered correctly or ran out of wrong guesses (see
  // submitAnswer()), well before everyone else finally does too.
  Festival.watchTournamentQuestionOver(socket, 'scramble', (payload) => {
    if (currentMode !== 'tournament' || payload.questionIndex !== index) return;
    if ((answeredCorrectly || outOfGuesses) && !transitioning) {
      clearInterval(roundTimerHandle);
      advance(0);
    }
  });

  const meta = window.FESTIVAL_GAMES.find((g) => g.key === 'scramble');
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

  let words, index, score, solvedCount, savedTime, startTime, roundTimeLeft, roundTimerHandle,
    finished, hintsLeft, hintBonusesGranted, noHintStreak, hintUsedThisWord, transitioning,
    answeredCorrectly, wordStartTime, diacriticsBonusTotal, noHintBonusTotal, totalTimeUsed,
    wrongGuessCount, outOfGuesses;
  // 'solo' | 'tournament' -- picked on the mode screen before each run. In
  // tournament mode `words` comes from the server's shared shuffle (see
  // tournament-mode-btn's handler below) instead of a fresh random draw, so
  // everyone who plays Tournament faces the identical word list and order.
  // Tournament also runs on a fixed clock, unlike Solo's self-paced flow:
  // there's no Skip, a correct answer doesn't jump ahead early (the full
  // ROUND_SECONDS still has to elapse). It's also admin-paced end to end: a
  // fresh join lands in a lobby until admin:tournament-start releases
  // everyone into question 0 together, and after each word the player waits
  // (see enterWaitingForAdmin()) until admin:tournament-next releases
  // everyone into the next one -- see watchTournamentRoundState above. The
  // manual Hint button stays hidden in Tournament, but the automatic
  // AUTO_HINT_AT reveal still fires, same as Solo.
  let currentMode = 'solo';

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

  // Same accent-stripping as stripDiacritics but keeps spaces, so it can compare
  // a typed guess against the answer word-for-word — accepts either the fully
  // accented spelling or the plain-Latin one (e.g. "banh deo" for "BÁNH DẺO").
  function normalizeForCompare(word) {
    return word
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replaceAll('Đ', 'D')
      .replaceAll('đ', 'd')
      .toUpperCase()
      .trim()
      .replace(/\s+/g, ' ');
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

  function showModeScreen() {
    tournamentLobbyScreenEl.classList.add('hidden');
    playScreen.classList.add('hidden');
    resultScreen.classList.add('hidden');
    modeScreen.classList.remove('hidden');
  }

  function startGame(wordOrder) {
    words = wordOrder ? wordOrder.map((i) => WORD_POOL[i]) : pickWords();
    index = 0;
    score = 0;
    solvedCount = 0;
    savedTime = 0;
    startTime = performance.now();
    hintsLeft = MAX_HINTS;
    hintBonusesGranted = 0;
    noHintStreak = 0;
    finished = false;
    waitingForAdmin = false;
    diacriticsBonusTotal = 0;
    noHintBonusTotal = 0;
    totalTimeUsed = 0;
    liveScoreEl.textContent = '0';
    if (wordTotalEl) wordTotalEl.textContent = String(words.length);
    modeBadgeEl.textContent = currentMode === 'tournament' ? '🏆 Tournament' : '';
    hintBtn.style.display = currentMode === 'tournament' ? 'none' : '';
    skipBtn.style.display = currentMode === 'tournament' ? 'none' : '';
    modeScreen.classList.add('hidden');
    tournamentLobbyScreenEl.classList.add('hidden');
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
    if (currentMode === 'tournament') return;
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
    answeredCorrectly = false;
    wordStartTime = performance.now();
    wrongGuessCount = 0;
    outOfGuesses = false;
    renderWrongGuessCounter();
    wordIndexEl.textContent = String(index + 1);
    scrambledEl.textContent = scramble(words[index].word);
    answerInput.value = '';
    answerInput.disabled = false;
    submitBtn.disabled = false;
    skipBtn.disabled = currentMode === 'tournament';
    flashEl.textContent = '';
    flashEl.className = 'scramble-flash';
    hintEl.textContent = '';
    tournamentWaitMsgEl.style.display = 'none';
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
    if (!answeredCorrectly && elapsedInRound() >= AUTO_HINT_AT && !hintEl.textContent) {
      hintEl.textContent = `Hint: ${words[index].hint}`;
      hintUsedThisWord = true;
    }
    updateHintButton();
    if (roundTimeLeft <= 0) {
      clearInterval(roundTimerHandle);
      // In Tournament, a correct answer (or running out of guesses, see
      // submitAnswer()) locks input but keeps the clock running instead of
      // advancing early. Don't stomp that flash with "Time's up!" once the
      // round ends, and don't double-report it as done -- that already
      // happened there.
      if (!answeredCorrectly && !outOfGuesses) {
        flash("Time's up!", 'bad');
        noHintStreak = 0;
        if (currentMode === 'tournament') {
          totalTimeUsed += ROUND_SECONDS;
          Festival.submitTournamentQuestionDone(socket, 'scramble', index, score, true);
        }
      }
      advance(900);
    }
  }

  function flash(message, cls) {
    flashEl.textContent = message;
    flashEl.className = 'scramble-flash ' + cls;
  }

  function submitAnswer() {
    if (finished || transitioning || answeredCorrectly || outOfGuesses) return;
    const guess = answerInput.value.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!guess) return;

    if (normalizeForCompare(guess) === normalizeForCompare(words[index].word)) {
      if (currentMode === 'tournament') {
        const elapsedSeconds = (performance.now() - wordStartTime) / 1000;
        score += tournamentPointsForCorrectAnswer(elapsedSeconds);
        // Bonus-eligible only when typed with full Vietnamese diacritics --
        // `guess` is already trimmed/uppercased, so an exact match against
        // the WORD_POOL entry (also stored uppercase, with diacritics) means
        // they didn't rely on the accent-insensitive fallback in
        // normalizeForCompare above.
        if (guess === words[index].word) diacriticsBonusTotal += TOURNAMENT_DIACRITICS_BONUS;
        if (!hintUsedThisWord) noHintBonusTotal += TOURNAMENT_NO_HINT_BONUS;
        totalTimeUsed += elapsedSeconds;
      } else {
        score += WORD_POINTS;
      }
      solvedCount += 1;
      savedTime += Math.max(0, roundTimeLeft);
      liveScoreEl.textContent = String(score);
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
      if (currentMode === 'tournament') {
        // Lock the word instead of advancing early -- Tournament makes
        // everyone wait out the full ROUND_SECONDS before the next word.
        answeredCorrectly = true;
        answerInput.disabled = true;
        submitBtn.disabled = true;
        Festival.submitTournamentQuestionDone(socket, 'scramble', index, score, true);
      } else {
        clearInterval(roundTimerHandle);
        advance(400);
      }
    } else {
      if (currentMode === 'tournament') {
        score -= TOURNAMENT_WRONG_PENALTY;
        wrongGuessCount += 1;
        renderWrongGuessCounter();
      } else {
        score -= WRONG_PENALTY;
      }
      liveScoreEl.textContent = String(score);
      if (currentMode === 'tournament' && wrongGuessCount >= MAX_TOURNAMENT_WRONG_GUESSES) {
        // Out of guesses -- lock the word like a correct answer does
        // (waits out the clock/early group-end instead of advancing right
        // away), but Scramble has no fallback input method to offer.
        outOfGuesses = true;
        answerInput.disabled = true;
        submitBtn.disabled = true;
        flash('Out of guesses', 'bad');
        const elapsedSeconds = (performance.now() - wordStartTime) / 1000;
        totalTimeUsed += elapsedSeconds;
        Festival.submitTournamentQuestionDone(socket, 'scramble', index, score, true);
      } else {
        flash('Not quite, try again', 'bad');
        answerInput.value = '';
        answerInput.focus();
      }
    }
  }

  function advance(delay) {
    if (transitioning) return;
    transitioning = true;
    if (currentMode === 'tournament') {
      // Tournament's questionIndex is server-authoritative (see
      // watchTournamentRoundState above) -- this player's own `index` isn't
      // bumped until admin:tournament-next says so, except for the very last
      // word, which needs no admin release: there's nothing left to advance
      // to, so this player's own run just ends.
      if (index >= words.length - 1) {
        finishGame();
      } else {
        enterWaitingForAdmin();
      }
      return;
    }
    index += 1;
    if (index >= words.length) {
      finishGame();
    } else {
      setTimeout(showWord, delay);
    }
  }

  // Tournament-only: this word is done, but the next one doesn't appear until
  // admin:tournament-next bumps questionIndex (see watchTournamentRoundState
  // above, which calls exitWaitingForAdmin() + showWord() when it does).
  function enterWaitingForAdmin() {
    waitingForAdmin = true;
    answerInput.disabled = true;
    submitBtn.disabled = true;
    timerEl.textContent = 'Waiting…';
    tournamentWaitMsgEl.style.display = '';
  }

  function exitWaitingForAdmin() {
    waitingForAdmin = false;
    tournamentWaitMsgEl.style.display = 'none';
  }

  function finishGame() {
    if (finished) return;
    finished = true;
    clearInterval(roundTimerHandle);
    answerInput.disabled = true;
    submitBtn.disabled = true;
    skipBtn.disabled = true;
    hintBtn.disabled = true;
    let bonus;
    let timeBonus;
    if (currentMode === 'tournament') {
      // See the constants/comment above: 150 (diacritics) + 75 (no-hint) +
      // up to 75 (total-time tier) = the same 300-point ceiling Solo's
      // MAX_SPEED_BONUS uses, just split into three earned components.
      timeBonus = tournamentTimeBonus(totalTimeUsed);
      bonus = diacriticsBonusTotal + noHintBonusTotal + timeBonus;
    } else {
      const totalGameSeconds = ROUND_SECONDS * words.length;
      bonus = Math.round(MAX_SPEED_BONUS * (savedTime / totalGameSeconds));
    }
    // Tournament's round has 15 words (1500 base points) vs. solo's 12, so its
    // cap is raised to 1800 to leave room for the same up-to-300 speed bonus.
    const maxScore = currentMode === 'tournament' ? 1800 : 1500;
    const finalScore = Math.max(0, Math.min(maxScore, score + bonus));
    finalScoreEl.textContent = finalScore;
    const seconds = Math.floor((performance.now() - startTime) / 1000);
    const detail = `${seconds}s · ${solvedCount} of ${words.length} words solved${currentMode === 'tournament' ? ' · Tournament' : ''}`;
    resultDetailEl.textContent = detail;
    if (currentMode === 'tournament') {
      const diacriticsMax = TOURNAMENT_DIACRITICS_BONUS * words.length;
      const noHintMax = TOURNAMENT_NO_HINT_BONUS * words.length;
      bonusBreakdownEl.textContent = `🎁 Speed bonus: ${bonus}/300 — 🇻🇳 diacritics ${diacriticsBonusTotal}/${diacriticsMax} · 💡 no-hint ${noHintBonusTotal}/${noHintMax} · ⏱ time ${timeBonus}/75`;
      bonusBreakdownEl.classList.remove('hidden');
    } else {
      bonusBreakdownEl.classList.add('hidden');
    }
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'scramble', finalScore, detail, currentMode);
    if (currentMode === 'tournament') {
      // Every question-done report so far only carried the running
      // per-word score -- the diacritics/no-hint/time bonuses above are
      // only known once the whole run ends. Push the bonus-inclusive final
      // score into the live standings too, so the live top score converges
      // to the real total instead of looking permanently short by up to 300.
      Festival.submitTournamentQuestionDone(socket, 'scramble', index, finalScore, true);
    }
  }

  submitBtn.addEventListener('click', submitAnswer);
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAnswer();
  });
  skipBtn.addEventListener('click', () => {
    if (currentMode === 'tournament' || finished || transitioning) return;
    clearInterval(roundTimerHandle);
    flash('Skipped', 'bad');
    noHintStreak = 0;
    advance(400);
  });
  hintBtn.addEventListener('click', () => {
    if (currentMode === 'tournament' || finished || transitioning || hintsLeft <= 0 || elapsedInRound() < HINT_UNLOCK_AT || hintEl.textContent) return;
    hintsLeft -= 1;
    hintUsedThisWord = true;
    hintEl.textContent = `Hint: ${words[index].hint}`;
    updateHintButton();
  });
  soloModeBtn.addEventListener('click', () => {
    currentMode = 'solo';
    startGame();
  });
  tournamentModeBtn.addEventListener('click', () => {
    tournamentModeBtn.disabled = true;
    const { id: playerId, name } = Festival.getPlayer();
    socket.emit('tournament:join', { playerId, name, game: 'scramble' }, (res) => {
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
      pendingWordOrder = res.content.wordOrder;
      modeScreen.classList.add('hidden');
      renderLobby(res.round);
      tournamentLobbyScreenEl.classList.remove('hidden');
    });
  });

  const gate = Festival.gateGame(socket, 'scramble', showModeScreen);
  document.getElementById('play-again-btn').addEventListener('click', () => {
    if (gate.isOpen()) {
      showModeScreen();
    } else {
      gate.block();
    }
  });
}
