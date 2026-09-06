const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  const ROUND_SECONDS = 60;
  const HINT_UNLOCK_AT = 20; // seconds elapsed in the round
  const OPTIONS_REVEAL_AT = 35; // seconds elapsed in the round
  const MAX_HINTS = 3; // total for the whole game, not per round
  const ROUNDS_PER_GAME = 15;
  const WRONG_PENALTY = 5;
  const MAX_SPEED_BONUS = 300;

  // Correct-answer points decay the longer a round takes — answering
  // instantly is worth much more than answering right before time runs out.
  // Piecewise-linear between these (elapsed seconds, points) checkpoints:
  // flat 40 through 10s -> 20 at 20s -> 10 at 40s -> 5 at 60s.
  const CORRECT_POINT_CHECKPOINTS = [
    { atSeconds: 0, points: 40 },
    { atSeconds: 10, points: 40 },
    { atSeconds: 20, points: 20 },
    { atSeconds: 40, points: 10 },
    { atSeconds: 60, points: 5 },
  ];

  function pointsForCorrectAnswer(elapsedSeconds) {
    const t = Math.min(Math.max(elapsedSeconds, 0), ROUND_SECONDS);
    for (let i = 0; i < CORRECT_POINT_CHECKPOINTS.length - 1; i++) {
      const start = CORRECT_POINT_CHECKPOINTS[i];
      const end = CORRECT_POINT_CHECKPOINTS[i + 1];
      if (t <= end.atSeconds) {
        const ratio = (t - start.atSeconds) / (end.atSeconds - start.atSeconds);
        return Math.round(start.points + ratio * (end.points - start.points));
      }
    }
    return CORRECT_POINT_CHECKPOINTS[CORRECT_POINT_CHECKPOINTS.length - 1].points;
  }

  // Tournament mode's correct-answer score decays differently from Solo's
  // pointsForCorrectAnswer above, in two phases:
  //  - Phase 1 (0s to OPTIONS_REVEAL_AT): steps down every 0.5s, from 100 to
  //    TOURNAMENT_PHASE1_END_POINTS over that span (so 0-0.5s = 100,
  //    0.5-1s = 99, ...), floored to a whole number each half-second tick.
  //  - Phase 2 (OPTIONS_REVEAL_AT to ROUND_SECONDS): once the multiple-choice
  //    options have auto-revealed, decay slows to 1 point per 1.5 elapsed
  //    seconds, continuing from wherever phase 1 left off.
  // Needs sub-second precision (see roundStartTime), since roundTimeLeft only
  // ticks once per second and can't resolve the 0.5s phase-1 steps.
  const TOURNAMENT_PHASE1_START_POINTS = 100;
  const TOURNAMENT_PHASE1_END_POINTS = 65;
  const TOURNAMENT_PHASE2_STEP_SECONDS = 1.5;
  const TOURNAMENT_WRONG_PENALTY = 4;
  const MAX_TOURNAMENT_WRONG_GUESSES = 5; // per round (typed guesses only) -- Solo stays unlimited retries

  function tournamentPointsForCorrectAnswer(elapsedSeconds) {
    if (elapsedSeconds < OPTIONS_REVEAL_AT) {
      const perHalfStep = (TOURNAMENT_PHASE1_START_POINTS - TOURNAMENT_PHASE1_END_POINTS) / (OPTIONS_REVEAL_AT * 2);
      return Math.floor(TOURNAMENT_PHASE1_START_POINTS - perHalfStep * Math.floor(elapsedSeconds * 2));
    }
    const stepsSinceReveal = Math.floor((elapsedSeconds - OPTIONS_REVEAL_AT) / TOURNAMENT_PHASE2_STEP_SECONDS);
    return TOURNAMENT_PHASE1_END_POINTS - stepsSinceReveal;
  }

  // Tournament mode's speed bonus (replaces Solo's single MAX_SPEED_BONUS=300
  // savedTime-based figure) splits the same 300-point total into three parts:
  //  - Up to 150 (10/round): only for a correct answer typed with full
  //    Vietnamese diacritics -- e.g. "Ăn quả nhớ kẻ trồng cây" earns it, "an
  //    qua nho ke trong cay" (still accepted as correct, see
  //    normalizeAnswer()) does not. Picking a multiple-choice option always
  //    earns it, since the option button submits the exact accented text.
  //  - Up to 75 (5/round): only for a correct answer given before the
  //    multiple-choice options have auto-revealed (optionsShown still false).
  //  - Up to 75: a single tiered bonus on TOTAL time used across all 15
  //    rounds (see totalTimeUsed) -- 75 points for 0-60s total, stepping
  //    down 5 points per additional 60s, floor of 25 past 600s total.
  const TOURNAMENT_DIACRITICS_BONUS = 10;
  const TOURNAMENT_NO_HINT_BONUS = 5;

  function tournamentTimeBonus(totalSeconds) {
    if (totalSeconds > 600) return 25;
    const tier = Math.max(1, Math.ceil(totalSeconds / 60));
    return 75 - 5 * (tier - 1);
  }

  // Case/punctuation-insensitive like normalizeAnswer(), but keeps
  // diacritics -- used only to detect the TOURNAMENT_DIACRITICS_BONUS above.
  function normalizeKeepDiacritics(text) {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Well-known Vietnamese ca dao / tục ngữ, each represented as an emoji
  // rebus. Answers are matched leniently (accents/case/punctuation-insensitive)
  // since typing a full phrase back exactly is hard on a phone — see
  // normalizeAnswer(). Each game draws ROUNDS_PER_GAME of these at random.
  const PROVERB_POOL = [
    { emoji: '🍎🙏🌳', answer: 'Ăn quả nhớ kẻ trồng cây', hint: 'Be grateful to whoever helped you succeed' },
    { emoji: '⚒️➡️💉', answer: 'Có công mài sắt, có ngày nên kim', hint: 'Effort and patience eventually pay off' },
    { emoji: '🌳➕🌳🌳🌳➡️⛰️', answer: 'Một cây làm chẳng nên non, ba cây chụm lại nên hòn núi cao', hint: 'Teamwork achieves what one person alone cannot' },
    { emoji: '🖋️⚫➕💡✨', answer: 'Gần mực thì đen, gần đèn thì sáng', hint: 'The company you keep shapes who you become' },
    { emoji: '🚶📅➡️🧺🧠', answer: 'Đi một ngày đàng, học một sàng khôn', hint: 'Travel and experience teach you wisdom' },
    { emoji: '💧➡️🙏🏞️', answer: 'Uống nước nhớ nguồn', hint: 'Remember and honor where you came from' },
    { emoji: '🍃🤝🍂', answer: 'Lá lành đùm lá rách', hint: 'The fortunate should help those less fortunate' },
    { emoji: '❌➡️🏆', answer: 'Thất bại là mẹ thành công', hint: 'Every failure is a step toward eventual success' },
    { emoji: '🌳>🎨', answer: 'Tốt gỗ hơn tốt nước sơn', hint: 'Substance matters more than appearance' },
    { emoji: '🍽️❌🧼➕👕✂️🌸', answer: 'Đói cho sạch, rách cho thơm', hint: 'Stay honest and dignified even when poor' },
    { emoji: '💪➡️✅', answer: 'Có chí thì nên', hint: "Where there's a will, there's a way" },
    { emoji: '🚧➡️💡', answer: 'Cái khó ló cái khôn', hint: 'Hardship sparks clever solutions' },
    { emoji: '👨‍🏫❌➡️🚫✅', answer: 'Không thầy đố mày làm nên', hint: "You can't succeed without a teacher's guidance" },
    { emoji: '👨‍🏫<👫📚', answer: 'Học thầy không tày học bạn', hint: 'Learning from peers can teach you as much as a teacher' },
    { emoji: '💧💧➡️🕳️➡️🗿', answer: 'Nước chảy đá mòn', hint: 'Persistence gradually wears down even the hardest obstacle' },
    { emoji: '🌬️➡️🌪️', answer: 'Gieo gió gặt bão', hint: 'Your actions come back to you, good or bad' },
    { emoji: '😇➡️🍀', answer: 'Ở hiền gặp lành', hint: 'Kindness is rewarded with good fortune' },
    { emoji: '🐛➡️🍲', answer: 'Con sâu làm rầu nồi canh', hint: 'One bad element spoils the whole group' },
    { emoji: '🧘🙏➡️🤰🔪', answer: 'Miệng nam mô, bụng bồ dao găm', hint: 'Sweet words can mask a harmful, deceitful heart' },
    { emoji: '🩸1️⃣>🏞️💧', answer: 'Một giọt máu đào hơn ao nước lã', hint: 'Blood relations matter more than mere acquaintances' },
    { emoji: '📏🟫=📏🥇', answer: 'Tấc đất tấc vàng', hint: 'Land is as precious as gold' },
    { emoji: '🌲🥇➕🌊🥈', answer: 'Rừng vàng biển bạc', hint: "Natural resources are a nation's treasure" },
    { emoji: '👶➡️👨➕👴➡️👦', answer: 'Trẻ cậy cha, già cậy con', hint: 'The young depend on parents, the old depend on children' },
    { emoji: '🙏1️⃣➡️📚2️⃣', answer: 'Tiên học lễ, hậu học văn', hint: 'Learn good manners before learning knowledge' },
    { emoji: '📄✂️➡️📏✅', answer: 'Giấy rách phải giữ lấy lề', hint: 'Keep your dignity even in hardship' },
    { emoji: '👧⬇️➕👦⬆️', answer: 'Chị ngã em nâng', hint: 'Siblings support each other when one falls' },
    { emoji: '😋🍎🌳➡️🚧🌳', answer: 'Ăn cây nào rào cây ấy', hint: 'Be loyal to whoever or wherever supports you' },
    { emoji: '❤️❤️➡️🦷😣', answer: 'Yêu nhau lắm, cắn nhau đau', hint: 'The people we love most can hurt us the most' },
    { emoji: '👦>👨➡️🍀🏠', answer: 'Con hơn cha là nhà có phúc', hint: 'A family is blessed when children surpass their parents' },
    { emoji: '👪➡️👶➕⛅➡️🎭', answer: 'Cha mẹ sinh con, trời sinh tính', hint: 'Parents give life, but personality is inborn' },
    { emoji: '🍽️➡️🍳', answer: 'Muốn ăn phải lăn vào bếp', hint: 'You must work for what you want' },
    { emoji: '📖🍽️🗣️🎁📦', answer: 'Học ăn, học nói, học gói, học mở', hint: 'Learn every basic social skill, from eating to speaking' },
    { emoji: '🌊😨➡️🚣💪', answer: 'Chớ thấy sóng cả mà ngã tay chèo', hint: "Don't give up just because the challenge looks big" },
    { emoji: '🔥➡️🥇➕🌪️➡️💪', answer: 'Lửa thử vàng, gian nan thử sức', hint: 'Hardship reveals true strength, like fire tests gold' },
    { emoji: '🍚💪➕👕🛡️', answer: 'Ăn chắc mặc bền', hint: 'Prefer solid and durable over flashy and fragile' },
    { emoji: '🗓️✅❌➡️🗓️➡️', answer: 'Việc hôm nay chớ để ngày mai', hint: "Don't put off today's work until tomorrow" },
    { emoji: '🌳➡️💀➡️😌', answer: 'Cây ngay không sợ chết đứng', hint: 'An honest person has nothing to fear' },
    { emoji: '⛰️👀➡️⛰️', answer: 'Đứng núi này trông núi nọ', hint: 'Never satisfied, always eyeing greener grass elsewhere' },
    { emoji: '1️⃣🛠️✨➡️👑', answer: 'Nhất nghệ tinh, nhất thân vinh', hint: 'Master one skill deeply and you will prosper' },
    { emoji: '🥒🤝🎃➡️🏠', answer: 'Bầu ơi thương lấy bí cùng, tuy rằng khác giống nhưng chung một giàn', hint: 'Compatriots should love each other despite their differences' },
  ];

  const timerEl = document.getElementById('timer');
  const liveScoreEl = document.getElementById('live-score');
  const wordIndexEl = document.getElementById('word-index');
  const roundTotalEl = document.getElementById('round-total');
  const emojiEl = document.getElementById('emoji-clue');
  const answerInput = document.getElementById('answer-input');
  const submitBtn = document.getElementById('submit-btn');
  const skipBtn = document.getElementById('skip-btn');
  const flashEl = document.getElementById('flash');
  const hintEl = document.getElementById('hint');
  const hintBtn = document.getElementById('hint-btn');
  const mcOptionsEl = document.getElementById('mc-options');
  const answerRevealEl = document.getElementById('answer-reveal');
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
  Festival.watchTournamentMode(socket, 'proverb', (available) => {
    tournamentModeBtn.style.display = available ? '' : 'none';
    // While the admin has Tournament mode open, only Tournament is offered
    // -- Solo comes back once the admin hides Tournament again.
    soloModeBtn.style.display = available ? 'none' : '';
  });

  // Tournament-only: shows the running wrong-guess count against
  // MAX_TOURNAMENT_WRONG_GUESSES (e.g. "❌ 2/5"), turning solid red once the
  // cap is hit and typed input locks -- see attempt()'s wrong-guess branch.
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
  // tournamentRound). While this player is in the lobby, `pendingProverbOrder`
  // holds the content already fetched at tournament:join -- startGame() isn't
  // called until admin:tournament-start flips the round to 'active'. Once
  // playing, `waitingForAdmin` marks the gap after a round ends until
  // admin:tournament-next bumps questionIndex -- see advance() and
  // enterWaitingForAdmin()/exitWaitingForAdmin() below.
  let roundState = null;
  let pendingProverbOrder = null;
  let waitingForAdmin = false;
  function renderLobby(state) {
    tournamentLobbyCountEl.textContent = `👥 ${state.playerCount} joined`;
    Festival.renderTournamentLobbyPlayers(tournamentLobbyPlayersEl, state.players);
  }
  Festival.watchTournamentRoundState(socket, 'proverb', (state) => {
    const wasLobby = roundState && roundState.phase === 'lobby';
    roundState = state;
    if (currentMode !== 'tournament') return;
    if (!tournamentLobbyScreenEl.classList.contains('hidden')) {
      renderLobby(state);
      if (state.phase === 'active' && wasLobby) {
        tournamentLobbyScreenEl.classList.add('hidden');
        startGame(pendingProverbOrder);
      }
      return;
    }
    if (waitingForAdmin && state.phase === 'active' && state.questionIndex > index) {
      index = state.questionIndex;
      exitWaitingForAdmin();
      showRound();
    }
  });

  const meta = window.FESTIVAL_GAMES.find((g) => g.key === 'proverb');
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

  let rounds, index, score, solvedCount, savedTime, startTime, roundTimeLeft, roundTimerHandle, finished, hintsLeft, optionsShown, transitioning, roundStartTime,
    diacriticsBonusTotal, noHintBonusTotal, totalTimeUsed, wrongGuessCount;
  // 'solo' | 'tournament' -- picked on the mode screen before each run.
  // Tournament mode draws its 15 rounds from the server's shared order
  // (see tournament-mode-btn's handler below) instead of a fresh random
  // draw, so everyone who plays Tournament faces the identical proverbs
  // in the identical order -- and has no Hint button and no Skip at all.
  // It's also admin-paced: a fresh join lands in a lobby until
  // admin:tournament-start releases everyone into round 0 together, and
  // after each round the player waits (see enterWaitingForAdmin()) until
  // admin:tournament-next releases everyone into the next one -- see
  // watchTournamentRoundState above.
  let currentMode = 'solo';

  function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function normalizeAnswer(text) {
    return text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replaceAll('Đ', 'D')
      .replaceAll('đ', 'd')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function pickRounds() {
    return shuffleArray(PROVERB_POOL).slice(0, ROUNDS_PER_GAME);
  }

  function showModeScreen() {
    tournamentLobbyScreenEl.classList.add('hidden');
    playScreen.classList.add('hidden');
    resultScreen.classList.add('hidden');
    modeScreen.classList.remove('hidden');
  }

  function startGame(proverbOrder) {
    rounds = proverbOrder ? proverbOrder.map((i) => PROVERB_POOL[i]) : pickRounds();
    index = 0;
    score = 0;
    solvedCount = 0;
    savedTime = 0;
    startTime = performance.now();
    hintsLeft = MAX_HINTS;
    finished = false;
    waitingForAdmin = false;
    diacriticsBonusTotal = 0;
    noHintBonusTotal = 0;
    totalTimeUsed = 0;
    liveScoreEl.textContent = '0';
    roundTotalEl.textContent = String(rounds.length);
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
    showRound();
  }

  function elapsedInRound() {
    return ROUND_SECONDS - roundTimeLeft;
  }

  function updateHintButton() {
    if (currentMode === 'tournament') return; // no Hint button in Tournament mode at all
    const unlocked = elapsedInRound() >= HINT_UNLOCK_AT;
    hintBtn.disabled = finished || hintsLeft <= 0 || !unlocked;
    if (finished) return;
    if (!unlocked) {
      hintBtn.textContent = `💡 Hint (unlocks in ${HINT_UNLOCK_AT - elapsedInRound()}s)`;
    } else {
      hintBtn.textContent = `💡 Hint (${hintsLeft} left)`;
    }
  }

  function showRound() {
    transitioning = false;
    roundStartTime = performance.now();
    wrongGuessCount = 0;
    renderWrongGuessCounter();
    wordIndexEl.textContent = String(index + 1);
    emojiEl.textContent = rounds[index].emoji;
    answerInput.value = '';
    answerInput.disabled = false;
    submitBtn.disabled = false;
    skipBtn.disabled = currentMode === 'tournament';
    flashEl.textContent = '';
    flashEl.className = 'scramble-flash';
    hintEl.textContent = '';
    mcOptionsEl.innerHTML = '';
    mcOptionsEl.classList.add('hidden');
    answerRevealEl.textContent = '';
    answerRevealEl.classList.add('hidden');
    tournamentWaitMsgEl.style.display = 'none';
    optionsShown = false;
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
    updateHintButton();
    if (elapsedInRound() >= OPTIONS_REVEAL_AT) revealOptions();
    if (roundTimeLeft <= 0) {
      clearInterval(roundTimerHandle);
      flash("Time's up!", 'bad');
      revealAnswer();
      if (currentMode === 'tournament') {
        totalTimeUsed += ROUND_SECONDS;
        Festival.submitTournamentQuestionDone(socket, 'proverb', index, score, true);
      }
      advance(3000);
    }
  }

  function revealOptions() {
    if (optionsShown) return;
    optionsShown = true;
    const correctProverb = rounds[index];
    const others = PROVERB_POOL.filter((p) => p.answer !== correctProverb.answer);
    const distractors = shuffleArray(others).slice(0, 3);
    const choices = shuffleArray([correctProverb, ...distractors]);
    mcOptionsEl.innerHTML = '';
    choices.forEach((proverb) => {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = proverb.hint;
      btn.addEventListener('click', () => attempt(proverb.answer, true));
      mcOptionsEl.appendChild(btn);
    });
    mcOptionsEl.classList.remove('hidden');
  }

  function flash(message, cls) {
    flashEl.textContent = message;
    flashEl.className = 'scramble-flash ' + cls;
  }

  function revealAnswer() {
    answerRevealEl.textContent = `Answer: ${rounds[index].answer}`;
    answerRevealEl.classList.remove('hidden');
    answerInput.disabled = true;
    submitBtn.disabled = true;
    skipBtn.disabled = true;
    hintBtn.disabled = true;
    Array.from(mcOptionsEl.children).forEach((btn) => { btn.disabled = true; });
  }

  function attempt(raw, fromOption) {
    if (finished || transitioning) return;
    const guess = normalizeAnswer(raw);
    if (!guess) return;

    if (guess === normalizeAnswer(rounds[index].answer)) {
      if (currentMode === 'tournament') {
        const elapsedSeconds = (performance.now() - roundStartTime) / 1000;
        score += tournamentPointsForCorrectAnswer(elapsedSeconds);
        // Bonus-eligible only when typed with full Vietnamese diacritics --
        // a multiple-choice pick always passes this too, since `raw` is then
        // the option's own accented text (see revealOptions()'s button
        // handler), matched here case/punctuation-insensitively.
        if (normalizeKeepDiacritics(raw) === normalizeKeepDiacritics(rounds[index].answer)) {
          diacriticsBonusTotal += TOURNAMENT_DIACRITICS_BONUS;
        }
        if (!optionsShown) noHintBonusTotal += TOURNAMENT_NO_HINT_BONUS;
        totalTimeUsed += elapsedSeconds;
      } else {
        score += pointsForCorrectAnswer(elapsedInRound());
      }
      solvedCount += 1;
      savedTime += Math.max(0, roundTimeLeft);
      liveScoreEl.textContent = String(score);
      clearInterval(roundTimerHandle);
      flash('Correct!', 'good');
      if (fromOption) {
        revealAnswer();
        if (currentMode === 'tournament') Festival.submitTournamentQuestionDone(socket, 'proverb', index, score, true);
        advance(2000);
      } else {
        if (currentMode === 'tournament') Festival.submitTournamentQuestionDone(socket, 'proverb', index, score, true);
        advance(600);
      }
    } else if (fromOption) {
      score -= currentMode === 'tournament' ? TOURNAMENT_WRONG_PENALTY : WRONG_PENALTY;
      liveScoreEl.textContent = String(score);
      clearInterval(roundTimerHandle);
      flash('Not quite!', 'bad');
      revealAnswer();
      if (currentMode === 'tournament') {
        totalTimeUsed += (performance.now() - roundStartTime) / 1000;
        Festival.submitTournamentQuestionDone(socket, 'proverb', index, score, true);
      }
      advance(3000);
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
        // Out of typed guesses -- unlike Scramble, Proverb has a fallback:
        // force the multiple-choice options open (if they haven't already)
        // so this player can still finish the round that way.
        answerInput.disabled = true;
        submitBtn.disabled = true;
        flash('Out of guesses — pick an option below', 'bad');
        if (!optionsShown) revealOptions();
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
      // round, which needs no admin release: there's nothing left to advance
      // to, so this player's own run just ends.
      if (index >= rounds.length - 1) {
        finishGame();
      } else {
        enterWaitingForAdmin();
      }
      return;
    }
    index += 1;
    if (index >= rounds.length) {
      finishGame();
    } else {
      setTimeout(showRound, delay);
    }
  }

  // Tournament-only: this round is done, but the next one doesn't appear
  // until admin:tournament-next bumps questionIndex (see
  // watchTournamentRoundState above, which calls exitWaitingForAdmin() +
  // showRound() when it does).
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
      const totalPossibleTime = ROUND_SECONDS * rounds.length;
      bonus = Math.round(MAX_SPEED_BONUS * (savedTime / totalPossibleTime));
    }
    // Tournament's correct-answer score can reach 100/round (vs. Solo's 40
    // max from CORRECT_POINT_CHECKPOINTS), so 15 rounds alone can already
    // reach 1,500 -- the cap is raised to 1,800 there to leave room for the
    // same up-to-300 speed bonus, same reasoning as Scramble's.
    const maxScore = currentMode === 'tournament' ? 1800 : 1500;
    const finalScore = Math.max(0, Math.min(maxScore, score + bonus));
    finalScoreEl.textContent = finalScore;
    const detail = `${solvedCount} of ${rounds.length} proverbs solved${currentMode === 'tournament' ? ' · Tournament' : ''}`;
    resultDetailEl.textContent = detail;
    if (currentMode === 'tournament') {
      const diacriticsMax = TOURNAMENT_DIACRITICS_BONUS * rounds.length;
      const noHintMax = TOURNAMENT_NO_HINT_BONUS * rounds.length;
      bonusBreakdownEl.textContent = `🎁 Speed bonus: ${bonus}/300 — 🇻🇳 diacritics ${diacriticsBonusTotal}/${diacriticsMax} · 💡 no-hint ${noHintBonusTotal}/${noHintMax} · ⏱ time ${timeBonus}/75`;
      bonusBreakdownEl.classList.remove('hidden');
    } else {
      bonusBreakdownEl.classList.add('hidden');
    }
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'proverb', finalScore, detail, currentMode);
    if (currentMode === 'tournament') {
      // Every question-done report so far only carried the running
      // per-round score -- the diacritics/no-hint/time bonuses above are
      // only known once the whole run ends. Push the bonus-inclusive final
      // score into the live standings too, so the live top score converges
      // to the real total instead of looking permanently short by up to 300.
      Festival.submitTournamentQuestionDone(socket, 'proverb', index, finalScore, true);
    }
  }

  submitBtn.addEventListener('click', () => attempt(answerInput.value));
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attempt(answerInput.value);
  });
  skipBtn.addEventListener('click', () => {
    if (currentMode === 'tournament' || finished || transitioning) return;
    clearInterval(roundTimerHandle);
    flash('Skipped', 'bad');
    revealAnswer();
    advance(3000);
  });
  hintBtn.addEventListener('click', () => {
    if (currentMode === 'tournament' || finished || transitioning || hintsLeft <= 0 || elapsedInRound() < HINT_UNLOCK_AT) return;
    hintsLeft -= 1;
    updateHintButton();
    hintEl.textContent = `Hint: ${rounds[index].hint}`;
  });
  soloModeBtn.addEventListener('click', () => {
    currentMode = 'solo';
    startGame();
  });
  tournamentModeBtn.addEventListener('click', () => {
    tournamentModeBtn.disabled = true;
    const { id: playerId, name } = Festival.getPlayer();
    socket.emit('tournament:join', { playerId, name, game: 'proverb' }, (res) => {
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
      pendingProverbOrder = res.content.proverbOrder;
      modeScreen.classList.add('hidden');
      renderLobby(res.round);
      tournamentLobbyScreenEl.classList.remove('hidden');
    });
  });

  const gate = Festival.gateGame(socket, 'proverb', showModeScreen);
  document.getElementById('play-again-btn').addEventListener('click', () => {
    if (gate.isOpen()) {
      showModeScreen();
    } else {
      gate.block();
    }
  });
}
