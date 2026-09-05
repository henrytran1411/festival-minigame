// Cờ Tướng Úp ("cờ úp", flip-chess Xiangqi) — an eighth backup game
// alongside UNO, Exploding Kittens, Go, Đuổi Niên Thú, Ô Ăn Quan,
// Battleship, and Poker. Same "casual side activity" contract as those:
// its own Socket.IO namespace, no leaderboard, no admin open/close
// gating (see server.js).
//
// Rules, matching the real-world "cờ úp" variant (see
// https://vi.wikipedia.org/wiki/C%E1%BB%9D_%C3%BAp and the rule sheets
// linked from it) rather than a from-scratch simplification:
//
//   - Setup: standard Xiangqi board and starting squares. The two
//     Generals are placed face-UP on their usual squares. Every other
//     piece (2 Advisor, 2 Elephant, 2 Horse, 2 Chariot, 2 Cannon, 5
//     Soldier per side -- 15 pieces) is shuffled and dealt face-down onto
//     that side's remaining 15 usual starting squares. So you always
//     know a hidden piece's COLOR (which half it's on, same as normal
//     Xiangqi) and, since the SQUARE layout itself is never shuffled
//     (only which piece sits on which square), you always know exactly
//     what movement pattern is *available* there -- just not which real
//     piece is underneath.
//   - A still-hidden piece's first move must follow the movement rule of
//     the SQUARE it currently occupies (e.g. a hidden piece sitting on a
//     Cannon's starting square moves and captures like a Cannon, even if
//     it turns out to actually be a Chariot) -- see effectiveType(). That
//     move, once made, flips it face-up: from then on it moves and
//     captures according to what it REALLY is. There is no separate
//     "flip in place" action -- moving *is* how a hidden piece reveals
//     itself, exactly per the source rules ("Nước đi đầu... Lật quân").
//     A hidden piece can still be captured (a "blind capture") without
//     ever having moved; whatever it turns out to be is revealed then.
//     Either way, a hidden piece still physically blocks lines of sight
//     and paths (chariot/cannon rays, horse leg, elephant eye) exactly
//     like a revealed one.
//   - Two cờ-úp-specific movement changes from standard Xiangqi: an
//     ACTUALLY-REVEALED Advisor or Elephant is no longer confined to the
//     palace / their own half of the board (the Elephant's "eye"-blocking
//     rule still applies, it just isn't stopped by the river anymore).
//     This does NOT apply to a still-hidden piece's position-based first
//     move: a hidden piece sitting on the Advisor's or Elephant's square
//     is only borrowing that square's classic, unmodified movement
//     pattern for one move (see effectiveType()/advisorMoves()'s
//     `relaxed` parameter) -- it still can't leave the palace / cross the
//     river on that first move, exactly like standard Xiangqi. The cờ-úp
//     exception only ever applies once a piece is confirmed to actually
//     BE an Advisor or Elephant.
//   - Since both Generals are visible from move one, real check rules
//     apply: you may never make a move that leaves your own General
//     under attack, and the "flying generals" rule (two Generals facing
//     each other on an open file) is enforced both as a special capture
//     move AND as a check threat (see generalMoves()/isSquareAttacked()).
//     Hidden pieces count as attackers too, using their square's
//     position-based movement -- both players can always see exactly
//     which squares hold hidden pieces and what those squares' patterns
//     are, so this is fully open information, not a secret one side
//     holds.
//   - The game ends the moment either: a General is actually captured
//     (kept as a defensive fallback in code -- with check-avoidance
//     enforced this should only ever come up via the flying-generals
//     capture), or the player to move has no legal action at all
//     (whether that's true checkmate -- in check with no escape -- or
//     merely no legal move while not in check). Xiangqi has no
//     stalemate-as-draw concept: either way, that player simply loses.
//
// A per-turn clock is optional (host-configured): if a connected human
// doesn't act in time, the server plays a random legal move on their
// behalf so the game keeps moving. Bots always act on their own short
// "thinking" delay, same as every other game's bots in this project --
// not perfect play, just a believable opponent.

const BOT_NAMES = ['🤖 Bot Long', '🤖 Bot Phượng', '🤖 Bot Hổ'];
const MAX_PLAYERS = 2;
const BOT_THINK_MS_MIN = 900;
const BOT_THINK_MS_MAX = 2200;

const TURN_TIME_OPTIONS = [30, 45, 60, 90]; // seconds; not in this list (incl. 0/null) means unlimited
const FIRST_PLAYER_OPTIONS = ['random', 'host', 'opponent']; // who gets Red (moves first)

const RED = 'r';
const BLACK = 'b';
function otherColor(color) { return color === RED ? BLACK : RED; }
function colorName(color) { return color === RED ? 'Red' : 'Black'; }

const ROWS = 10;
const COLS = 9;
function idxOf(row, col) { return row * COLS + col; }
function rowOf(idx) { return Math.floor(idx / COLS); }
function colOf(idx) { return idx % COLS; }
function inBounds(row, col) { return row >= 0 && row < ROWS && col >= 0 && col < COLS; }

const PIECE_LABEL = { G: 'General', A: 'Advisor', E: 'Elephant', H: 'Horse', R: 'Chariot', C: 'Cannon', S: 'Soldier' };
function articleFor(word) { return /^[aeiou]/i.test(word) ? 'an' : 'a'; }
const PIECE_VALUE = { G: 1000, R: 90, C: 45, H: 40, E: 20, A: 20, S: 10 };
// Vietnamese labels used on the board itself (see public/games/xq.js) --
// exported here too so both sides of the project agree on the same names.
const PIECE_LABEL_VI = { G: 'Tướng', A: 'Sĩ', E: 'Tượng', H: 'Mã', R: 'Xe', C: 'Pháo', S: 'Tốt' };

// The 15 non-General pieces on one side, shuffled and dealt onto that
// side's 15 non-General starting squares -- see buildBoard().
const PIECE_COUNTS = { A: 2, E: 2, H: 2, R: 2, C: 2, S: 5 };
function buildSideDeck() {
  const deck = [];
  Object.entries(PIECE_COUNTS).forEach(([type, count]) => { for (let i = 0; i < count; i += 1) deck.push(type); });
  return deck; // length 15
}

// All 16 of one side's standard Xiangqi starting squares (General
// included) -- used both to seed the board and, via CANONICAL_TYPE_AT
// below, to know what movement pattern a still-hidden square offers.
const BACK_RANK_TYPES = ['R', 'H', 'E', 'A', 'G', 'A', 'E', 'H', 'R'];
function homeSquares(color) {
  // Black occupies rows 0 (back rank), 2 (cannons), 3 (soldiers); Red is
  // the same shape mirrored to the other end of the board (rows 9/7/6).
  const backRow = color === BLACK ? 0 : 9;
  const cannonRow = color === BLACK ? 2 : 7;
  const soldierRow = color === BLACK ? 3 : 6;
  const squares = [];
  for (let c = 0; c < COLS; c += 1) squares.push({ row: backRow, col: c, type: BACK_RANK_TYPES[c] });
  [1, 7].forEach((c) => squares.push({ row: cannonRow, col: c, type: 'C' }));
  [0, 2, 4, 6, 8].forEach((c) => squares.push({ row: soldierRow, col: c, type: 'S' }));
  return squares; // length 16
}

// What piece type WOULD sit at each of the 32 starting squares in a
// non-shuffled game -- i.e. the movement pattern available to whatever
// hidden piece is currently sitting there (see effectiveType()). Both
// players can always see this (the square layout itself is never
// shuffled), so it's public information, not a secret.
const CANONICAL_TYPE_AT = new Array(ROWS * COLS).fill(null);
[BLACK, RED].forEach((color) => {
  homeSquares(color).forEach((sq) => { CANONICAL_TYPE_AT[idxOf(sq.row, sq.col)] = sq.type; });
});

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Builds a fresh board: 90 cells (10 rows x 9 cols), each null or
// { color, type, revealed }. The two Generals are placed face-up on
// their fixed squares; every other piece is shuffled face-down onto that
// side's remaining 15 squares.
function buildBoard() {
  const board = new Array(ROWS * COLS).fill(null);
  [BLACK, RED].forEach((color) => {
    const backRow = color === BLACK ? 0 : 9;
    board[idxOf(backRow, 4)] = { color, type: 'G', revealed: true };
    const squares = homeSquares(color).filter((sq) => !(sq.row === backRow && sq.col === 4));
    const deck = shuffle(buildSideDeck());
    squares.forEach((sq, i) => {
      board[idxOf(sq.row, sq.col)] = { color, type: deck[i], revealed: false };
    });
  });
  return board;
}

// The movement pattern currently available at `idx`: the piece's real
// type if it's already revealed, otherwise the CANONICAL type for that
// square (see the file-level comment on the "first move" rule).
function effectiveType(board, idx) {
  const p = board[idx];
  return p.revealed ? p.type : CANONICAL_TYPE_AT[idx];
}

function generalMoves(board, idx, color) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  const rows = color === BLACK ? [0, 1, 2] : [7, 8, 9];
  [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc) || !rows.includes(nr) || nc < 3 || nc > 5) return;
    const occ = board[idxOf(nr, nc)];
    if (!occ || occ.color !== color) dests.push(idxOf(nr, nc));
  });
  // Flying generals: scan away from your own palace along this file; if
  // the first piece you hit is the (always-revealed) enemy General, you
  // may capture it at range. Also doubles as the check threat that
  // stops both Generals from ever facing off on an open file, since
  // isSquareAttacked() is built directly from this move list.
  const dir = color === BLACK ? 1 : -1;
  let r = row + dir;
  while (inBounds(r, col)) {
    const occ = board[idxOf(r, col)];
    if (occ) {
      if (occ.color !== color && occ.type === 'G') dests.push(idxOf(r, col));
      break;
    }
    r += dir;
  }
  return dests;
}

function inPalace(color, row, col) {
  const rows = color === BLACK ? [0, 1, 2] : [7, 8, 9];
  return rows.includes(row) && col >= 3 && col <= 5;
}
// Elephants can never cross the river (rows 0-4 are Black's half, 5-9 Red's).
function inOwnHalf(color, row) { return color === BLACK ? row <= 4 : row >= 5; }

// Cờ-úp-specific: an Advisor is no longer confined to the palace (see
// file header) -- otherwise identical to standard Xiangqi, 1 step
// diagonally. `relaxed` is false while this is still a hidden piece's
// position-based FIRST move (see effectiveType()/pieceMoves()) -- that
// move plays by the classic, unmodified Advisor rule, since it's only
// borrowing the movement PATTERN of the square, not the cờ-úp exception
// that belongs to an actually-revealed Advisor.
function advisorMoves(board, idx, color, relaxed) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([dr, dc]) => {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc) || (!relaxed && !inPalace(color, nr, nc))) return;
    const occ = board[idxOf(nr, nc)];
    if (!occ || occ.color !== color) dests.push(idxOf(nr, nc));
  });
  return dests;
}

// Cờ-úp-specific: an Elephant may cross the river ONLY once actually
// revealed (see advisorMoves()'s `relaxed` comment -- the same rule
// applies here) -- the "eye"-blocking rule always applies regardless,
// exactly 2 diagonally.
function elephantMoves(board, idx, color, relaxed) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  [[-2, -2], [-2, 2], [2, -2], [2, 2]].forEach(([dr, dc]) => {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc) || (!relaxed && !inOwnHalf(color, nr))) return;
    if (board[idxOf(row + dr / 2, col + dc / 2)]) return; // the "eye" is blocked
    const occ = board[idxOf(nr, nc)];
    if (!occ || occ.color !== color) dests.push(idxOf(nr, nc));
  });
  return dests;
}

const HORSE_MOVES = [
  { leg: [-1, 0], d: [-2, -1] }, { leg: [-1, 0], d: [-2, 1] },
  { leg: [1, 0], d: [2, -1] }, { leg: [1, 0], d: [2, 1] },
  { leg: [0, -1], d: [-1, -2] }, { leg: [0, -1], d: [1, -2] },
  { leg: [0, 1], d: [-1, 2] }, { leg: [0, 1], d: [1, 2] },
];
function horseMoves(board, idx, color) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  HORSE_MOVES.forEach(({ leg, d }) => {
    const lr = row + leg[0];
    const lc = col + leg[1];
    if (!inBounds(lr, lc) || board[idxOf(lr, lc)]) return; // hobbled leg
    const nr = row + d[0];
    const nc = col + d[1];
    if (!inBounds(nr, nc)) return;
    const occ = board[idxOf(nr, nc)];
    if (!occ || occ.color !== color) dests.push(idxOf(nr, nc));
  });
  return dests;
}

function chariotMoves(board, idx, color) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
    let r = row + dr;
    let c = col + dc;
    while (inBounds(r, c)) {
      const occ = board[idxOf(r, c)];
      if (!occ) {
        dests.push(idxOf(r, c));
      } else {
        if (occ.color !== color) dests.push(idxOf(r, c));
        break;
      }
      r += dr; c += dc;
    }
  });
  return dests;
}

// Cannon: slides freely like a chariot while the path is empty, but can
// ONLY capture by jumping over exactly one piece (of either color, the
// "screen") and landing on the first piece found beyond it, if that one's
// an enemy. Any number of empty squares are fine on either side of the
// screen; capture is disallowed with zero or more-than-one screens.
function cannonMoves(board, idx, color) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
    let r = row + dr;
    let c = col + dc;
    let screenFound = false;
    while (inBounds(r, c)) {
      const occ = board[idxOf(r, c)];
      if (!screenFound) {
        if (!occ) dests.push(idxOf(r, c));
        else screenFound = true;
      } else if (occ) {
        if (occ.color !== color) dests.push(idxOf(r, c));
        break;
      }
      r += dr; c += dc;
    }
  });
  return dests;
}

function soldierMoves(board, idx, color) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  const forwardDr = color === BLACK ? 1 : -1;
  const crossed = color === BLACK ? row >= 5 : row <= 4;
  const deltas = crossed ? [[forwardDr, 0], [0, -1], [0, 1]] : [[forwardDr, 0]];
  deltas.forEach(([dr, dc]) => {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc)) return;
    const occ = board[idxOf(nr, nc)];
    if (!occ || occ.color !== color) dests.push(idxOf(nr, nc));
  });
  return dests;
}

// Legal destinations for the piece at `idx`, dispatched on its EFFECTIVE
// type (its real type once revealed, otherwise the canonical type for
// its still-hidden square -- see effectiveType()). Purely a function of
// the board -- never mutates it.
function pieceMoves(board, idx) {
  const p = board[idx];
  if (!p) return [];
  switch (effectiveType(board, idx)) {
    case 'G': return generalMoves(board, idx, p.color);
    case 'A': return advisorMoves(board, idx, p.color, p.revealed);
    case 'E': return elephantMoves(board, idx, p.color, p.revealed);
    case 'H': return horseMoves(board, idx, p.color);
    case 'R': return chariotMoves(board, idx, p.color);
    case 'C': return cannonMoves(board, idx, p.color);
    case 'S': return soldierMoves(board, idx, p.color);
    default: return [];
  }
}

// Does any `byColor` piece (hidden or revealed -- see pieceMoves()'s use
// of effectiveType) currently threaten `targetIdx`? The core of check
// detection and the "can't leave your own General in check" filter.
function isSquareAttacked(board, targetIdx, byColor) {
  for (let idx = 0; idx < board.length; idx += 1) {
    const p = board[idx];
    if (!p || p.color !== byColor) continue;
    if (pieceMoves(board, idx).includes(targetIdx)) return true;
  }
  return false;
}

// Every legal move available to `color` right now, for BOTH hidden
// pieces (moving per their square's canonical pattern -- this is what
// flips them face-up) and revealed pieces (moving per their true type),
// filtered down to moves that don't leave that color's own General
// attacked afterward.
function allLegalActions(board, color) {
  const moves = [];
  for (let idx = 0; idx < board.length; idx += 1) {
    const p = board[idx];
    if (!p || p.color !== color) continue;
    pieceMoves(board, idx).forEach((to) => {
      const trial = board.slice();
      trial[to] = trial[idx];
      trial[idx] = null;
      const kingIdx = trial.findIndex((pp) => pp && pp.color === color && pp.type === 'G');
      if (kingIdx !== -1 && isSquareAttacked(trial, kingIdx, otherColor(color))) return;
      moves.push({ from: idx, to });
    });
  }
  return moves;
}

// True once neither side has anything left but its own General -- a dead
// position (a lone General can never deliver check, let alone mate) that
// would otherwise let two bots (or two overly cautious humans) shuffle
// forever, since real check-avoidance means there's no other way this
// game can end. See also NO_PROGRESS_LIMIT for the general-purpose
// termination guarantee this specific check is a faster/friendlier
// special case of.
function isBareGenerals(board) {
  const pieces = board.filter(Boolean);
  return pieces.length === 2 && pieces.every((p) => p.type === 'G');
}

// This project's own addition -- the source rules this game is modeled
// on don't mention a draw condition at all, but with real check-avoidance
// enforced (see allLegalActions), some reduced positions (not just bare
// Generals -- e.g. General+Advisor vs bare General) can never be forced
// to a decision, and nothing here plays anywhere near well enough to
// avoid trading down into one. Counts halfmoves since the last capture OR
// first-ever reveal of a hidden piece (both are genuine progress -- a
// quiet reshuffle of already-revealed pieces is the only thing that
// doesn't reset it); reaching the limit forces a draw. Since at most 30
// pieces can ever be revealed for the first time and at most 30 non-
// General pieces can ever be captured, this hard-bounds every game's
// length regardless of position, the same guarantee Cờ Vua's 50-move
// rule provides there.
const NO_PROGRESS_LIMIT = 60;

function sanitizeOptions(raw) {
  const opts = raw || {};
  const timePerTurn = TURN_TIME_OPTIONS.includes(Number(opts.timePerTurn)) ? Number(opts.timePerTurn) : null;
  const firstPlayer = FIRST_PLAYER_OPTIONS.includes(opts.firstPlayer) ? opts.firstPlayer : 'random';
  return { timePerTurn, firstPlayer };
}

class XiangqiRoom {
  constructor(id, name, password, options) {
    this.id = id;
    this.name = name;
    this.password = password;
    const { timePerTurn, firstPlayer } = sanitizeOptions(options);
    this.timePerTurn = timePerTurn; // seconds, or null for unlimited
    this.firstPlayer = firstPlayer; // 'random' | 'host' | 'opponent'
    this.hostPlayerId = null; // set by attachXiangqi() right after the creator is pushed into players
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // { id, name, connected, socketId, isBot, color: 'r'|'b'|null }
    this.board = null;
    this.currentColor = RED; // Red moves first, standard Xiangqi convention
    this.captured = { r: [], b: [] }; // piece types captured FROM each color
    this.noProgressCount = 0; // halfmoves since the last capture or first-ever reveal -- see NO_PROGRESS_LIMIT
    this.log = [];
    this.winnerId = null;
    this.resultText = null;
    this.lastAction = null; // { type:'move', color, from, to, capturedType?, revealedAs? }
    this.botCounter = 0;
    this.botTimer = null;
    this.turnTimer = null;
    this.turnStartedAt = null;
    // Alternates who gets Red (moves first) on a rematch, same spirit as
    // Go's rematchSwap, so the first-move edge doesn't always land on the
    // same real player across games.
    this.rematchSwap = false;
    this.nsp = null;
  }

  pushLog(message) {
    this.log.push(message);
    if (this.log.length > 40) this.log.shift();
  }

  findPlayer(playerId) {
    return playerId ? this.players.find((p) => p.id === playerId) : undefined;
  }

  playerByColor(color) {
    return this.players.find((p) => p.color === color) || null;
  }

  currentPlayer() {
    return this.playerByColor(this.currentColor);
  }

  isEmpty() {
    return this.players.length === 0 || this.players.every((p) => !p.connected);
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      playerCount: this.players.filter((p) => p.connected).length,
      timePerTurn: this.timePerTurn,
    };
  }

  chooseFirstPlayerIndex() {
    if (this.firstPlayer === 'host') {
      const idx = this.players.findIndex((p) => p.id === this.hostPlayerId);
      if (idx !== -1) return idx;
    } else if (this.firstPlayer === 'opponent') {
      const idx = this.players.findIndex((p) => p.id !== this.hostPlayerId);
      if (idx !== -1) return idx;
    }
    return Math.random() < 0.5 ? 0 : 1;
  }

  startGame() {
    if (this.status !== 'waiting') return { ok: false, error: 'already-started' };
    if (this.players.length < MAX_PLAYERS) return { ok: false, error: 'not-enough-players' };
    this.board = buildBoard();
    let redIdx = this.chooseFirstPlayerIndex();
    if (this.rematchSwap) redIdx = 1 - redIdx;
    this.players.forEach((p, i) => { p.color = i === redIdx ? RED : BLACK; });
    this.currentColor = RED;
    this.captured = { r: [], b: [] };
    this.noProgressCount = 0;
    this.status = 'playing';
    this.winnerId = null;
    this.resultText = null;
    this.lastAction = null;
    this.log = [];
    clearTimeout(this.botTimer);
    clearTimeout(this.turnTimer);
    this.pushLog(`🀄 Game started. ${this.playerByColor(RED).name} plays Red, ${this.playerByColor(BLACK).name} plays Black. Both Generals start face-up; Red moves first.`);
    this.scheduleTurnTimer();
    return { ok: true };
  }

  // Moves the piece at `from` to `to` -- for a still-hidden piece, this
  // is simultaneously its "first move" (validated against its square's
  // canonical pattern via pieceMoves()/effectiveType()) and the act that
  // flips it face-up; for an already-revealed piece it's a normal move
  // using its real type.
  move(player, from, to) {
    if (this.status !== 'playing') return { ok: false, error: 'not-playing' };
    if (this.currentColor !== player.color) return { ok: false, error: 'not-your-turn' };
    const p = this.board[from];
    if (!p || p.color !== player.color) return { ok: false, error: 'invalid-source' };
    const legal = allLegalActions(this.board, player.color);
    if (!legal.some((m) => m.from === from && m.to === to)) return { ok: false, error: 'illegal-move' };

    const wasHidden = !p.revealed;
    const captured = this.board[to];
    this.board[to] = p;
    this.board[from] = null;
    if (wasHidden) p.revealed = true;
    if (captured) {
      captured.revealed = true; // whatever it was, it's revealed now that it's gone
      this.captured[captured.color].push(captured.type);
    }
    this.noProgressCount = (captured || wasHidden) ? 0 : this.noProgressCount + 1;

    const fr = rowOf(from); const fc = colOf(from);
    const tr = rowOf(to); const tc = colOf(to);
    let desc = wasHidden
      ? `${player.name} moved a hidden piece (${fr + 1}, ${fc + 1}) → (${tr + 1}, ${tc + 1}) — revealed ${articleFor(PIECE_LABEL[p.type])} ${PIECE_LABEL[p.type]}!`
      : `${player.name} moved ${PIECE_LABEL[p.type]} (${fr + 1}, ${fc + 1}) → (${tr + 1}, ${tc + 1})`;
    if (captured) desc += `${wasHidden ? ' and' : ''} captured ${colorName(captured.color)}'s ${PIECE_LABEL[captured.type]}!`;
    else if (!wasHidden) desc += '.';
    this.pushLog(desc);
    this.lastAction = {
      type: 'move', color: player.color, from, to, capturedType: captured ? captured.type : null, revealedAs: wasHidden ? p.type : null,
    };

    if (captured && captured.type === 'G') {
      // Defensive fallback -- with check-avoidance enforced this should
      // only ever be reachable via the flying-generals capture (see
      // generalMoves()), since no legal move can otherwise leave a
      // General exposed to a normal capture.
      this.finishGame(player, `🏆 ${player.name} wins — ${colorName(captured.color)}'s General was captured!`);
      return { ok: true };
    }
    this.advanceTurn();
    return { ok: true };
  }

  // Switches to the other color and checks whether that player has any
  // legal action at all; if not, they lose immediately (Xiangqi has no
  // draw/stalemate outcome -- checkmate and "no legal move while not in
  // check" both just end the game the same way). Otherwise arms the next
  // turn's clock.
  advanceTurn() {
    clearTimeout(this.turnTimer);
    this.currentColor = otherColor(this.currentColor);
    if (isBareGenerals(this.board)) { this.finishGame(null, '🤝 Draw — only the two Generals are left; neither can ever deliver checkmate.'); return; }
    if (this.noProgressCount >= NO_PROGRESS_LIMIT) { this.finishGame(null, `🤝 Draw — ${NO_PROGRESS_LIMIT} moves in a row with no capture and no new piece revealed.`); return; }
    const legal = allLegalActions(this.board, this.currentColor);
    const kingIdx = this.board.findIndex((p) => p && p.color === this.currentColor && p.type === 'G');
    const inCheck = kingIdx !== -1 && isSquareAttacked(this.board, kingIdx, otherColor(this.currentColor));
    if (!legal.length) {
      const loser = this.currentPlayer();
      const winner = this.playerByColor(otherColor(this.currentColor));
      const reason = inCheck ? 'is checkmated' : 'has no legal move left';
      this.finishGame(winner, `🏆 ${winner ? winner.name : colorName(otherColor(this.currentColor))} wins — ${loser ? loser.name : colorName(this.currentColor)} ${reason}!`);
      return;
    }
    this.pushLog(`${colorName(this.currentColor)}'s turn${inCheck ? ' — in check!' : ''}.`);
    this.scheduleTurnTimer();
  }

  finishGame(winner, resultText) {
    this.status = 'finished';
    this.winnerId = winner ? winner.id : null;
    this.resultText = resultText;
    this.pushLog(resultText);
    clearTimeout(this.botTimer);
    clearTimeout(this.turnTimer);
  }

  newGame() {
    if (this.status !== 'finished') return { ok: false, error: 'not-finished' };
    this.status = 'waiting';
    this.rematchSwap = !this.rematchSwap;
    this.winnerId = null;
    this.resultText = null;
    this.lastAction = null;
    this.board = null;
    this.captured = { r: [], b: [] };
    this.players.forEach((p) => { p.color = null; });
    this.log = [];
    this.pushLog('🔄 Ready for a new game — click Start when everyone is in.');
    return { ok: true };
  }

  // -- Clock --------------------------------------------------------------
  scheduleTurnTimer() {
    clearTimeout(this.turnTimer);
    this.turnStartedAt = null;
    if (this.status !== 'playing') return;
    const player = this.currentPlayer();
    if (!player || player.isBot) { this.scheduleBotTurn(); return; }
    this.turnStartedAt = Date.now();
    if (this.timePerTurn) {
      this.turnTimer = setTimeout(() => this.handleTurnTimeout(player), this.timePerTurn * 1000);
    }
  }

  // Ran out of time -- play a random legal move for them so the game
  // keeps moving. advanceTurn() already guarantees a legal move exists
  // for the current player, so this never finds an empty set.
  handleTurnTimeout(player) {
    if (this.status !== 'playing' || this.currentPlayer() !== player) return;
    const legal = allLegalActions(this.board, player.color);
    if (!legal.length) return; // shouldn't happen -- see above
    const m = legal[Math.floor(Math.random() * legal.length)];
    this.pushLog(`⏰ ${player.name} ran out of time for this turn.`);
    this.move(player, m.from, m.to);
    if (this.nsp) this.broadcast(this.nsp);
  }

  // -- Bot AI ---------------------------------------------------------------
  // Greedy capture-seeking, with a lean toward moving (and thereby
  // revealing) a still-hidden piece when nothing can be captured -- not
  // perfect play, just a believable opponent, matching this project's
  // other game bots.
  chooseBotAction(color) {
    const moves = allLegalActions(this.board, color);
    if (!moves.length) return null;
    const capturing = moves
      .map((m) => ({ ...m, value: this.board[m.to] ? PIECE_VALUE[this.board[m.to].type] : 0 }))
      .filter((m) => m.value > 0);
    if (capturing.length) {
      const best = Math.max(...capturing.map((m) => m.value));
      const bestOnes = capturing.filter((m) => m.value === best);
      return bestOnes[Math.floor(Math.random() * bestOnes.length)];
    }
    const hidden = moves.filter((m) => !this.board[m.from].revealed);
    const revealedQuiet = moves.filter((m) => this.board[m.from].revealed);
    if (hidden.length && (!revealedQuiet.length || Math.random() < 0.65)) {
      return hidden[Math.floor(Math.random() * hidden.length)];
    }
    return moves[Math.floor(Math.random() * moves.length)];
  }

  scheduleBotTurn() {
    clearTimeout(this.botTimer);
    const player = this.currentPlayer();
    if (!player || !player.isBot || this.status !== 'playing') return;
    this.botTimer = setTimeout(() => {
      if (this.status !== 'playing') return;
      const m = this.chooseBotAction(player.color);
      if (!m) return;
      this.move(player, m.from, m.to);
      if (this.nsp) this.broadcast(this.nsp);
    }, BOT_THINK_MS_MIN + Math.random() * (BOT_THINK_MS_MAX - BOT_THINK_MS_MIN));
  }

  addBot() {
    const botName = BOT_NAMES[this.botCounter % BOT_NAMES.length];
    this.botCounter += 1;
    this.players.push({ id: `bot_${this.id}_${this.botCounter}`, name: botName, connected: true, socketId: null, isBot: true, color: null });
    this.pushLog(`${botName} joined the table.`);
  }

  // -- Client state ---------------------------------------------------------
  // No hidden information is asymmetric between the two players here (a
  // face-down piece's type is unknown to BOTH players equally, not a
  // secret one side holds -- unlike Battleship's fog of war), so unlike
  // that game this is one shared broadcast for everyone, same as Go.
  state(forPlayerId) {
    const isCurrentTurn = this.status === 'playing' && this.turnStartedAt !== null;
    const turnElapsedMs = isCurrentTurn ? Date.now() - this.turnStartedAt : 0;
    const legalMoves = {};
    let checkColor = null;
    if (this.status === 'playing' && this.board) {
      const moves = allLegalActions(this.board, this.currentColor);
      moves.forEach((m) => {
        if (!legalMoves[m.from]) legalMoves[m.from] = [];
        legalMoves[m.from].push(m.to);
      });
      const kingIdx = this.board.findIndex((p) => p && p.color === this.currentColor && p.type === 'G');
      if (kingIdx !== -1 && isSquareAttacked(this.board, kingIdx, otherColor(this.currentColor))) checkColor = this.currentColor;
    }
    return {
      roomId: this.id,
      roomName: this.name,
      status: this.status,
      timePerTurn: this.timePerTurn,
      firstPlayer: this.firstPlayer,
      hostPlayerId: this.hostPlayerId,
      currentColor: this.currentColor,
      currentPlayerId: this.status === 'playing' ? (this.currentPlayer() || {}).id || null : null,
      turnTimeRemainingMs: (this.timePerTurn && isCurrentTurn) ? Math.max(0, this.timePerTurn * 1000 - turnElapsedMs) : null,
      board: this.board ? this.board.map((p) => (p ? { color: p.color, type: p.revealed ? p.type : null, revealed: p.revealed } : null)) : null,
      legalMoves,
      checkColor,
      captured: this.captured,
      log: this.log,
      winnerId: this.winnerId,
      resultText: this.resultText,
      lastAction: this.lastAction,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color || null, connected: p.connected, isBot: Boolean(p.isBot),
      })),
      yourId: forPlayerId || null,
      yourColor: (this.findPlayer(forPlayerId) || {}).color || null,
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('xq:state', this.state(p.id));
    });
  }
}

function attachXiangqi(io) {
  const nsp = io.of('/xq');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].filter((r) => !r.isEmpty()).map((r) => r.summary());
  }
  function broadcastRoomList() {
    nsp.emit('xq:rooms', roomList());
  }
  function deleteRoomIfEmpty(room) {
    if (room && room.isEmpty()) {
      clearTimeout(room.botTimer);
      clearTimeout(room.turnTimer);
      rooms.delete(room.id);
    }
  }

  nsp.on('connection', (socket) => {
    function myRoom() {
      return rooms.get(socket.roomId);
    }

    socket.on('xq:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('xq:createRoom', ({ roomName, password, playerId, name, timePerTurn, firstPlayer }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const room = new XiangqiRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, { timePerTurn, firstPlayer });
      room.nsp = nsp;
      room.hostPlayerId = playerId;
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, color: null });
      room.pushLog(`${clean} created the room.`);
      rooms.set(room.id, room);

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true, roomId: room.id });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('xq:joinRoom', ({ roomId, password, playerId, name }, callback) => {
      const room = rooms.get(roomId);
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-such-room' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
      const existing = room.findPlayer(playerId);

      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        existing.name = clean;
      } else {
        if (String(password || '') !== room.password) { if (typeof callback === 'function') callback({ ok: false, error: 'wrong-password' }); return; }
        if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'game-in-progress' }); return; }
        if (room.players.length >= MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'room-full' }); return; }
        room.players.push({ id: playerId, name: clean, connected: true, socketId: socket.id, isBot: false, color: null });
        room.pushLog(`${clean} joined the room.`);
      }

      socket.roomId = room.id;
      socket.playerId = playerId;
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
      broadcastRoomList();
    });

    socket.on('xq:addBot', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length >= MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'table-full' }); return; }
      room.addBot();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('xq:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const result = room.startGame();
      if (typeof callback === 'function') callback(result);
      if (result.ok) { room.broadcast(nsp); room.scheduleBotTurn(); }
    });

    socket.on('xq:move', ({ from, to }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.move(player, Number(from), Number(to));
      if (typeof callback === 'function') callback(result);
      if (result.ok) { room.broadcast(nsp); room.scheduleBotTurn(); }
    });

    socket.on('xq:newGame', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const result = room.newGame();
      if (typeof callback === 'function') callback(result);
      if (result.ok) { room.broadcast(nsp); broadcastRoomList(); }
    });

    function handleLeave() {
      const room = myRoom();
      if (room) {
        const player = room.findPlayer(socket.playerId);
        if (player) {
          if (room.status === 'waiting') {
            room.players = room.players.filter((p) => p.id !== socket.playerId);
            room.pushLog(`${player.name} left the room.`);
          } else if (player.socketId === socket.id) {
            player.connected = false;
            room.pushLog(`${player.name} disconnected.`);
          }
          room.broadcast(nsp);
        }
        deleteRoomIfEmpty(room);
        broadcastRoomList();
      }
      socket.roomId = null;
      socket.playerId = null;
    }

    socket.on('xq:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
}

module.exports = attachXiangqi;
module.exports.XiangqiRoom = XiangqiRoom;
module.exports.buildBoard = buildBoard;
module.exports.pieceMoves = pieceMoves;
module.exports.effectiveType = effectiveType;
module.exports.isSquareAttacked = isSquareAttacked;
module.exports.allLegalActions = allLegalActions;
module.exports.CANONICAL_TYPE_AT = CANONICAL_TYPE_AT;
module.exports.idxOf = idxOf;
module.exports.rowOf = rowOf;
module.exports.colOf = colOf;
module.exports.PIECE_LABEL = PIECE_LABEL;
module.exports.PIECE_LABEL_VI = PIECE_LABEL_VI;
module.exports.PIECE_VALUE = PIECE_VALUE;
module.exports.RED = RED;
module.exports.BLACK = BLACK;
module.exports.otherColor = otherColor;
module.exports.colorName = colorName;
module.exports.sanitizeOptions = sanitizeOptions;
module.exports.TURN_TIME_OPTIONS = TURN_TIME_OPTIONS;
module.exports.FIRST_PLAYER_OPTIONS = FIRST_PLAYER_OPTIONS;
module.exports.MAX_PLAYERS = MAX_PLAYERS;
