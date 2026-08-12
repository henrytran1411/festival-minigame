// Central game metadata + "how to play" text, shared by the hub and each game page.
window.FESTIVAL_GAMES = [
  {
    key: 'sudoku',
    title: 'Sudoku Sprint',
    icon: '🔢',
    blurb: 'Fill the grid, fast and clean.',
    page: 'games/sudoku.html',
    rules: [
      'Fill every empty cell so each row, column, and 3×3 box contains the digits 1-9 exactly once.',
      'Tap a cell and type a number to fill it in. Correct numbers lock in place.',
      'A wrong number flashes red and costs you 2 points — think before you type.',
      'Your score starts at 100 and drops as time passes and mistakes add up. Finish fast and clean for the highest score.',
    ],
  },
  {
    key: 'scramble',
    title: 'Word Scramble',
    icon: '🍂',
    blurb: 'Unscramble 8 Tết Trung Thu words.',
    page: 'games/scramble.html',
    rules: [
      'You have 240 seconds and 8 Tết Trung Thu (Mid-Autumn Festival) words, shown scrambled with accents and spaces stripped away — e.g. "Chị Hằng" becomes "HCIGNAH".',
      'Type the correctly spelled, correctly accented word and press Submit (or Enter) — e.g. "CHỊ HẰNG". A correct answer is worth 10 points and moves you to the next word.',
      'A wrong guess costs 2 points, but you can try again on the same word.',
      'Stuck? Click the Hint button for a clue — you get 3 hints total for the whole game.',
      'Still stuck? Skip a word for 0 points and move on.',
      'Finishing all 8 words with time left earns a speed bonus, up to 100 points total.',
    ],
  },
  {
    key: 'memory',
    title: 'Memory Match',
    icon: '🍁',
    blurb: 'Flip cards, find the 16 matching pairs.',
    page: 'games/memory.html',
    rules: [
      'Tap two cards to flip them. If they match, they stay revealed. If not, they flip back.',
      'Find all 16 matching pairs to finish.',
      'Your score starts at 100 and drops for extra flips beyond the 16 needed for a perfect game, and for time taken.',
      'Fewer moves and a faster time both mean a higher score.',
    ],
  },
  {
    key: 'proverb',
    title: 'Ca Dao Đố Vui',
    icon: '📜',
    blurb: 'Guess 15 ca dao & tục ngữ from emoji clues.',
    page: 'games/proverb.html',
    rules: [
      'There are 15 rounds (drawn at random from a pool of 40), 1 minute (60 seconds) each. Each round shows a Vietnamese ca dao or tục ngữ as a string of emoji clues.',
      'Type the full proverb and press Submit (or Enter). Typing without accent marks is fine (e.g. "an qua nho ke trong cay" is accepted). A correct answer is worth 10 points and moves you to the next round.',
      'A wrong typed guess costs 2 points, but you can try again on the same round.',
      'The Hint button unlocks 20 seconds into each round — click it for the proverb\'s meaning in English. You get 3 hints total for the whole game.',
      'Still stuck after 40 seconds? 4 multiple-choice options appear automatically, shown in English. Picking any option — right or wrong — reveals the correct proverb and ends the round (a wrong pick still costs 2 points).',
      'Run out of time on a round and it\'s skipped for 0 points, with the answer revealed. Finishing rounds quickly banks a speed bonus, up to 100 points total.',
    ],
  },
];
