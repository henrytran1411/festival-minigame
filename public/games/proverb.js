const me = Festival.requireNameOrRedirect();

if (me) {
  const socket = Festival.connect();
  Festival.register(socket);

  const ROUND_SECONDS = 60;
  const HINT_UNLOCK_AT = 20; // seconds elapsed in the round
  const OPTIONS_REVEAL_AT = 40; // seconds elapsed in the round
  const MAX_HINTS = 3; // total for the whole game, not per round
  const ROUNDS_PER_GAME = 15;

  // Well-known Vietnamese ca dao / tục ngữ, each represented as an emoji
  // rebus. Answers are matched leniently (accents/case/punctuation-insensitive)
  // since typing a full phrase back exactly is hard on a phone — see
  // normalizeAnswer(). Each game draws ROUNDS_PER_GAME of these at random.
  const PROVERB_POOL = [
    { emoji: '🍎🙏🌳', answer: 'Ăn quả nhớ kẻ trồng cây', hint: 'Be grateful to whoever helped you succeed' },
    { emoji: '⚒️➡️🪡', answer: 'Có công mài sắt, có ngày nên kim', hint: 'Effort and patience eventually pay off' },
    { emoji: '🌳➕🌳🌳🌳➡️⛰️', answer: 'Một cây làm chẳng nên non, ba cây chụm lại nên hòn núi cao', hint: 'Teamwork achieves what one person alone cannot' },
    { emoji: '🖋️⚫➕💡✨', answer: 'Gần mực thì đen, gần đèn thì sáng', hint: 'The company you keep shapes who you become' },
    { emoji: '🚶📅➡️🧺🧠', answer: 'Đi một ngày đàng, học một sàng khôn', hint: 'Travel and experience teach you wisdom' },
    { emoji: '💧➡️🙏🏞️', answer: 'Uống nước nhớ nguồn', hint: 'Remember and honor where you came from' },
    { emoji: '🍃🤝🍂', answer: 'Lá lành đùm lá rách', hint: 'The fortunate should help those less fortunate' },
    { emoji: '❌➡️🏆', answer: 'Thất bại là mẹ thành công', hint: 'Every failure is a step toward eventual success' },
    { emoji: '🪵❤️>🎨', answer: 'Tốt gỗ hơn tốt nước sơn', hint: 'Substance matters more than appearance' },
    { emoji: '🍽️❌🧼➕👕✂️🌸', answer: 'Đói cho sạch, rách cho thơm', hint: 'Stay honest and dignified even when poor' },
    { emoji: '💪➡️✅', answer: 'Có chí thì nên', hint: "Where there's a will, there's a way" },
    { emoji: '🚧➡️💡', answer: 'Cái khó ló cái khôn', hint: 'Hardship sparks clever solutions' },
    { emoji: '👨‍🏫❌➡️🚫✅', answer: 'Không thầy đố mày làm nên', hint: "You can't succeed without a teacher's guidance" },
    { emoji: '👨‍🏫<👫📚', answer: 'Học thầy không tày học bạn', hint: 'Learning from peers can teach you as much as a teacher' },
    { emoji: '💧➡️🪨➡️⏳', answer: 'Nước chảy đá mòn', hint: 'Persistence gradually wears down even the hardest obstacle' },
    { emoji: '🌬️➡️🌪️', answer: 'Gieo gió gặt bão', hint: 'Your actions come back to you, good or bad' },
    { emoji: '😇➡️🍀', answer: 'Ở hiền gặp lành', hint: 'Kindness is rewarded with good fortune' },
    { emoji: '🐛➡️🍲', answer: 'Con sâu làm rầu nồi canh', hint: 'One bad element spoils the whole group' },
    { emoji: '🩸➡️❤️‍🩹', answer: 'Máu chảy ruột mềm', hint: "Family shares each other's pain" },
    { emoji: '🩸1️⃣>🏞️💧', answer: 'Một giọt máu đào hơn ao nước lã', hint: 'Blood relations matter more than mere acquaintances' },
    { emoji: '📏🟫=📏🥇', answer: 'Tấc đất tấc vàng', hint: 'Land is as precious as gold' },
    { emoji: '🌲🥇➕🌊🥈', answer: 'Rừng vàng biển bạc', hint: "Natural resources are a nation's treasure" },
    { emoji: '👶➡️👨➕👴➡️👦', answer: 'Trẻ cậy cha, già cậy con', hint: 'The young depend on parents, the old depend on children' },
    { emoji: '🙏1️⃣➡️📚2️⃣', answer: 'Tiên học lễ, hậu học văn', hint: 'Learn good manners before learning knowledge' },
    { emoji: '📄✂️➡️📏', answer: 'Giấy rách phải giữ lấy lề', hint: 'Keep your dignity even in hardship' },
    { emoji: '👧⬇️➕👦⬆️', answer: 'Chị ngã em nâng', hint: 'Siblings support each other when one falls' },
    { emoji: '🍎🌳➡️🚧', answer: 'Ăn cây nào rào cây ấy', hint: 'Be loyal to whoever or wherever supports you' },
    { emoji: '❤️➡️😬', answer: 'Yêu nhau lắm, cắn nhau đau', hint: 'The people we love most can hurt us the most' },
    { emoji: '👦>👨➡️🍀🏠', answer: 'Con hơn cha là nhà có phúc', hint: 'A family is blessed when children surpass their parents' },
    { emoji: '👪➡️👶➕⛅➡️🎭', answer: 'Cha mẹ sinh con, trời sinh tính', hint: 'Parents give life, but personality is inborn' },
    { emoji: '🍽️➡️🍳', answer: 'Muốn ăn phải lăn vào bếp', hint: 'You must work for what you want' },
    { emoji: '📖🍽️🗣️🎁📦', answer: 'Học ăn, học nói, học gói, học mở', hint: 'Learn every basic social skill, from eating to speaking' },
    { emoji: '🌊😨➡️🚣💪', answer: 'Chớ thấy sóng cả mà ngã tay chèo', hint: "Don't give up just because the challenge looks big" },
    { emoji: '🔥➡️🥇➕🌪️➡️💪', answer: 'Lửa thử vàng, gian nan thử sức', hint: 'Hardship reveals true strength, like fire tests gold' },
    { emoji: '🍚💪➕👕🛡️', answer: 'Ăn chắc mặc bền', hint: 'Prefer solid and durable over flashy and fragile' },
    { emoji: '🗓️✅❌➡️🗓️➡️', answer: 'Việc hôm nay chớ để ngày mai', hint: "Don't put off today's work until tomorrow" },
    { emoji: '🌳➡️😌', answer: 'Cây ngay không sợ chết đứng', hint: 'An honest person has nothing to fear' },
    { emoji: '⛰️👀➡️⛰️', answer: 'Đứng núi này trông núi nọ', hint: 'Never satisfied, always eyeing greener grass elsewhere' },
    { emoji: '🎯🛠️➡️🌟', answer: 'Nhất nghệ tinh, nhất thân vinh', hint: 'Master one skill deeply and you will prosper' },
    { emoji: '🎃🤝🥒➡️🏠', answer: 'Bầu ơi thương lấy bí cùng, tuy rằng khác giống nhưng chung một giàn', hint: 'Compatriots should love each other despite their differences' },
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
  const playScreen = document.getElementById('play-screen');
  const resultScreen = document.getElementById('result-screen');
  const finalScoreEl = document.getElementById('final-score');
  const resultDetailEl = document.getElementById('result-detail');

  const meta = window.FESTIVAL_GAMES.find((g) => g.key === 'proverb');
  document.getElementById('rules-body').innerHTML = meta.rules.map((r) => `<li>${r}</li>`).join('');
  document.getElementById('rules-link').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('rules-modal').classList.remove('hidden');
  });
  document.querySelector('.modal-close').addEventListener('click', () => {
    document.getElementById('rules-modal').classList.add('hidden');
  });

  let rounds, index, score, solvedCount, savedTime, roundTimeLeft, roundTimerHandle, finished, hintsLeft, optionsShown, transitioning;

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

  function startGame() {
    rounds = pickRounds();
    index = 0;
    score = 0;
    solvedCount = 0;
    savedTime = 0;
    hintsLeft = MAX_HINTS;
    finished = false;
    liveScoreEl.textContent = '0';
    roundTotalEl.textContent = String(rounds.length);
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
    wordIndexEl.textContent = String(index + 1);
    emojiEl.textContent = rounds[index].emoji;
    answerInput.value = '';
    answerInput.disabled = false;
    submitBtn.disabled = false;
    skipBtn.disabled = false;
    flashEl.textContent = '';
    flashEl.className = 'scramble-flash';
    hintEl.textContent = '';
    mcOptionsEl.innerHTML = '';
    mcOptionsEl.classList.add('hidden');
    answerRevealEl.textContent = '';
    answerRevealEl.classList.add('hidden');
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
      score += 10;
      solvedCount += 1;
      savedTime += Math.max(0, roundTimeLeft);
      liveScoreEl.textContent = String(score);
      clearInterval(roundTimerHandle);
      flash('Correct!', 'good');
      if (fromOption) {
        revealAnswer();
        advance(2000);
      } else {
        advance(600);
      }
    } else if (fromOption) {
      score -= 2;
      liveScoreEl.textContent = String(score);
      clearInterval(roundTimerHandle);
      flash('Not quite!', 'bad');
      revealAnswer();
      advance(3000);
    } else {
      score -= 2;
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
    if (index >= rounds.length) {
      finishGame();
    } else {
      setTimeout(showRound, delay);
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
    const totalPossibleTime = ROUND_SECONDS * rounds.length;
    const bonus = Math.round(20 * (savedTime / totalPossibleTime));
    const finalScore = Math.max(0, Math.min(100, score + bonus));
    finalScoreEl.textContent = finalScore;
    resultDetailEl.textContent = `${solvedCount} of ${rounds.length} proverbs solved`;
    playScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    Festival.submitScore(socket, 'proverb', finalScore);
  }

  submitBtn.addEventListener('click', () => attempt(answerInput.value));
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attempt(answerInput.value);
  });
  skipBtn.addEventListener('click', () => {
    if (finished || transitioning) return;
    clearInterval(roundTimerHandle);
    flash('Skipped', 'bad');
    revealAnswer();
    advance(3000);
  });
  hintBtn.addEventListener('click', () => {
    if (finished || transitioning || hintsLeft <= 0 || elapsedInRound() < HINT_UNLOCK_AT) return;
    hintsLeft -= 1;
    updateHintButton();
    hintEl.textContent = `Hint: ${rounds[index].hint}`;
  });
  document.getElementById('play-again-btn').addEventListener('click', startGame);

  startGame();
}
