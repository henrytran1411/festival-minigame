// Cờ Vua (International Chess) — a ninth backup game alongside UNO,
// Exploding Kittens, Go, Đuổi Niên Thú, Ô Ăn Quan, Battleship, Poker, and
// Cờ Tướng Úp. Same "casual side activity" contract as those: its own
// Socket.IO namespace, no leaderboard, no admin open/close gating (see
// server.js).
//
// Standard 8x8 chess, fully-open information (no hidden pieces this
// time), so like Go/Cờ Tướng Úp this is one shared board broadcast to
// both players rather than a per-player fog-of-war state.
//
// Implements real chess rules: legal move generation that keeps you from
// leaving (or moving into) your own check, castling (both sides, with
// the king-can't-move-through-check restriction), en passant, pawn
// promotion (player's choice of Queen/Rook/Bishop/Knight), checkmate,
// stalemate, insufficient material, and the 50-move no-capture/no-pawn-
// move rule.
//
// Scope simplifications, both documented here rather than silently
// skipped:
//   - No threefold-repetition draw. The 50-move rule alone already
//     guarantees every game terminates in bounded length (a halfmove
//     that doesn't reset its counter is a plain non-capturing, non-pawn
//     move, and the counter forces a draw at 100 such halfmoves in a
//     row), so this is a casual-play limitation, not a correctness gap
//     -- games just don't END quite as early as strict FIDE rules would
//     allow a repetition claim.
//   - Insufficient-material detection covers King vs King, King+minor vs
//     King, and King+Bishop vs King+Bishop -- it does NOT check whether
//     the two bishops sit on the same-colored squares (real chess only
//     calls that last one an automatic draw when they do). Any other
//     material combination (including King+2 Knights vs King, which is
//     usually but not always a dead draw) is left for the players to
//     actually play out or resign.
//
// A per-turn clock is optional (host-configured, like this project's
// other games' turn clocks): if a connected human doesn't act in time,
// the server plays a random legal move on their behalf so the game keeps
// moving. Bots always act on their own short "thinking" delay -- a
// simple 1-ply "prefer captures, avoid obviously losing the piece,
// recognize mate-in-1" heuristic, not a real search engine -- not
// perfect play, just a believable opponent, matching this project's
// other game bots.

const BOT_NAMES = ['🤖 Bot Vua', '🤖 Bot Hậu', '🤖 Bot Mã'];
const MAX_PLAYERS = 2;
const BOT_THINK_MS_MIN = 900;
const BOT_THINK_MS_MAX = 2200;

const TURN_TIME_OPTIONS = [30, 45, 60, 90, 120]; // seconds; not in this list (incl. 0/null) means unlimited
const FIRST_PLAYER_OPTIONS = ['random', 'host', 'opponent']; // who gets White (moves first)

const WHITE = 'w';
const BLACK = 'b';
function otherColor(color) { return color === WHITE ? BLACK : WHITE; }
function colorName(color) { return color === WHITE ? 'White' : 'Black'; }
function articleFor(word) { return /^[aeiou]/i.test(word) ? 'an' : 'a'; }

const ROWS = 8;
const COLS = 8;
function idxOf(row, col) { return row * COLS + col; }
function rowOf(idx) { return Math.floor(idx / COLS); }
function colOf(idx) { return idx % COLS; }
function inBounds(row, col) { return row >= 0 && row < ROWS && col >= 0 && col < COLS; }
const FILE_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
function squareName(idx) { return `${FILE_LETTERS[colOf(idx)]}${ROWS - rowOf(idx)}`; }

const PIECE_LABEL = { K: 'King', Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight', P: 'Pawn' };
const PIECE_VALUE = { K: 0, Q: 9, R: 5, B: 3, N: 3, P: 1 };

function buildBoard() {
  const board = new Array(ROWS * COLS).fill(null);
  const backRank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  for (let c = 0; c < COLS; c += 1) {
    board[idxOf(0, c)] = { color: BLACK, type: backRank[c] };
    board[idxOf(1, c)] = { color: BLACK, type: 'P' };
    board[idxOf(6, c)] = { color: WHITE, type: 'P' };
    board[idxOf(7, c)] = { color: WHITE, type: backRank[c] };
  }
  return board;
}

const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const QUEEN_DIRS = [...ROOK_DIRS, ...BISHOP_DIRS];
const KNIGHT_OFFSETS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING_OFFSETS = QUEEN_DIRS;

function pawnMoves(board, idx, color, enPassantTarget) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dir = color === WHITE ? -1 : 1;
  const startRow = color === WHITE ? 6 : 1;
  const dests = [];
  const r1 = row + dir;
  if (inBounds(r1, col) && !board[idxOf(r1, col)]) {
    dests.push(idxOf(r1, col));
    const r2 = row + dir * 2;
    if (row === startRow && !board[idxOf(r2, col)]) dests.push(idxOf(r2, col));
  }
  [-1, 1].forEach((dc) => {
    const nr = row + dir;
    const nc = col + dc;
    if (!inBounds(nr, nc)) return;
    const target = idxOf(nr, nc);
    const occ = board[target];
    if (occ && occ.color !== color) dests.push(target);
    else if (!occ && enPassantTarget === target) dests.push(target);
  });
  return dests;
}

function knightMoves(board, idx, color) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  KNIGHT_OFFSETS.forEach(([dr, dc]) => {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc)) return;
    const occ = board[idxOf(nr, nc)];
    if (!occ || occ.color !== color) dests.push(idxOf(nr, nc));
  });
  return dests;
}

function slideMoves(board, idx, color, dirs) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  dirs.forEach(([dr, dc]) => {
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

// Does any `byColor` piece attack (row, col) right now? The core of check
// detection, castling-through-check validation, and (via allLegalMoves)
// the "can't leave your own king in check" filter.
function isSquareAttacked(board, row, col, byColor) {
  const pawnDir = byColor === WHITE ? 1 : -1; // reversed: where an attacking pawn would stand
  for (const dc of [-1, 1]) {
    const pr = row + pawnDir;
    const pc = col + dc;
    if (inBounds(pr, pc)) {
      const occ = board[idxOf(pr, pc)];
      if (occ && occ.color === byColor && occ.type === 'P') return true;
    }
  }
  for (const [dr, dc] of KNIGHT_OFFSETS) {
    const nr = row + dr;
    const nc = col + dc;
    if (inBounds(nr, nc)) {
      const occ = board[idxOf(nr, nc)];
      if (occ && occ.color === byColor && occ.type === 'N') return true;
    }
  }
  for (const [dr, dc] of KING_OFFSETS) {
    const nr = row + dr;
    const nc = col + dc;
    if (inBounds(nr, nc)) {
      const occ = board[idxOf(nr, nc)];
      if (occ && occ.color === byColor && occ.type === 'K') return true;
    }
  }
  for (const [dr, dc] of ROOK_DIRS) {
    let r = row + dr;
    let c = col + dc;
    while (inBounds(r, c)) {
      const occ = board[idxOf(r, c)];
      if (occ) { if (occ.color === byColor && (occ.type === 'R' || occ.type === 'Q')) return true; break; }
      r += dr; c += dc;
    }
  }
  for (const [dr, dc] of BISHOP_DIRS) {
    let r = row + dr;
    let c = col + dc;
    while (inBounds(r, c)) {
      const occ = board[idxOf(r, c)];
      if (occ) { if (occ.color === byColor && (occ.type === 'B' || occ.type === 'Q')) return true; break; }
      r += dr; c += dc;
    }
  }
  return false;
}

function kingMoves(board, idx, color, ctx) {
  const row = rowOf(idx);
  const col = colOf(idx);
  const dests = [];
  KING_OFFSETS.forEach(([dr, dc]) => {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc)) return;
    const occ = board[idxOf(nr, nc)];
    if (!occ || occ.color !== color) dests.push(idxOf(nr, nc));
  });
  const backRow = color === WHITE ? 7 : 0;
  const enemy = otherColor(color);
  if (row === backRow && col === 4 && !isSquareAttacked(board, row, col, enemy)) {
    const rights = ctx.castling[color];
    const rookAt = (c) => { const p = board[idxOf(row, c)]; return p && p.type === 'R' && p.color === color; };
    if (rights.K && !board[idxOf(row, 5)] && !board[idxOf(row, 6)] && rookAt(7)
      && !isSquareAttacked(board, row, 5, enemy) && !isSquareAttacked(board, row, 6, enemy)) {
      dests.push(idxOf(row, 6));
    }
    if (rights.Q && !board[idxOf(row, 1)] && !board[idxOf(row, 2)] && !board[idxOf(row, 3)] && rookAt(0)
      && !isSquareAttacked(board, row, 3, enemy) && !isSquareAttacked(board, row, 2, enemy)) {
      dests.push(idxOf(row, 2));
    }
  }
  return dests;
}

// Pseudo-legal destinations for the piece at `idx` -- doesn't yet check
// whether the move leaves the mover's own king in check (see
// allLegalMoves for that filter).
function pieceMoves(board, idx, ctx) {
  const p = board[idx];
  if (!p) return [];
  switch (p.type) {
    case 'P': return pawnMoves(board, idx, p.color, ctx.enPassantTarget);
    case 'N': return knightMoves(board, idx, p.color);
    case 'B': return slideMoves(board, idx, p.color, BISHOP_DIRS);
    case 'R': return slideMoves(board, idx, p.color, ROOK_DIRS);
    case 'Q': return slideMoves(board, idx, p.color, QUEEN_DIRS);
    case 'K': return kingMoves(board, idx, p.color, ctx);
    default: return [];
  }
}

// Applies from->to on a COPY of `board` (never mutates the input),
// including en-passant capture removal, the rook's half of a castle, and
// promotion -- and returns the new board. Detects en passant/castling
// purely from the move shape (a pawn moving diagonally onto an empty
// square; a king moving 2 squares), so callers don't need to pass those
// in separately.
function applyMoveToBoard(board, from, to, promotionType) {
  const next = board.slice();
  const piece = next[from];
  const isEnPassant = piece.type === 'P' && colOf(from) !== colOf(to) && !board[to];
  const isCastle = piece.type === 'K' && Math.abs(colOf(to) - colOf(from)) === 2;
  next[to] = piece;
  next[from] = null;
  if (isEnPassant) {
    next[idxOf(rowOf(from), colOf(to))] = null;
  }
  if (isCastle) {
    const row = rowOf(from);
    if (colOf(to) === 6) { next[idxOf(row, 5)] = next[idxOf(row, 7)]; next[idxOf(row, 7)] = null; }
    else { next[idxOf(row, 3)] = next[idxOf(row, 0)]; next[idxOf(row, 0)] = null; }
  }
  if (piece.type === 'P' && (rowOf(to) === 0 || rowOf(to) === 7)) {
    next[to] = { color: piece.color, type: promotionType || 'Q' };
  }
  return next;
}

// Every legal move for `color`: pseudo-legal moves for each of their
// pieces, filtered down to ones that don't leave their own king attacked
// afterward (simulated on a throwaway board copy each time).
function allLegalMoves(board, color, ctx) {
  const moves = [];
  for (let idx = 0; idx < board.length; idx += 1) {
    const p = board[idx];
    if (!p || p.color !== color) continue;
    pieceMoves(board, idx, ctx).forEach((to) => {
      const trial = applyMoveToBoard(board, idx, to, 'Q');
      const kingIdx = trial.findIndex((pp) => pp && pp.color === color && pp.type === 'K');
      if (kingIdx !== -1 && isSquareAttacked(trial, rowOf(kingIdx), colOf(kingIdx), otherColor(color))) return;
      moves.push({ from: idx, to });
    });
  }
  return moves;
}

function isInsufficientMaterial(board) {
  const nonKings = board.filter((p) => p && p.type !== 'K');
  if (nonKings.length === 0) return true;
  if (nonKings.length === 1 && (nonKings[0].type === 'N' || nonKings[0].type === 'B')) return true;
  if (nonKings.length === 2 && nonKings.every((p) => p.type === 'B')) {
    const colors = new Set(nonKings.map((p) => p.color));
    if (colors.size === 2) return true; // simplified -- doesn't check bishop square color, see file header
  }
  return false;
}

function sanitizeOptions(raw) {
  const opts = raw || {};
  const timePerTurn = TURN_TIME_OPTIONS.includes(Number(opts.timePerTurn)) ? Number(opts.timePerTurn) : null;
  const firstPlayer = FIRST_PLAYER_OPTIONS.includes(opts.firstPlayer) ? opts.firstPlayer : 'random';
  return { timePerTurn, firstPlayer };
}

class ChessRoom {
  constructor(id, name, password, options) {
    this.id = id;
    this.name = name;
    this.password = password;
    const { timePerTurn, firstPlayer } = sanitizeOptions(options);
    this.timePerTurn = timePerTurn;
    this.firstPlayer = firstPlayer;
    this.hostPlayerId = null;
    this.status = 'waiting'; // 'waiting' | 'playing' | 'finished'
    this.players = []; // { id, name, connected, socketId, isBot, color: 'w'|'b'|null }
    this.board = null;
    this.currentColor = WHITE;
    this.castling = { w: { K: true, Q: true }, b: { K: true, Q: true } };
    this.enPassantTarget = null;
    this.halfmoveClock = 0;
    this.captured = { w: [], b: [] }; // piece types captured FROM each color
    this.log = [];
    this.winnerId = null;
    this.resultText = null;
    this.lastMove = null;
    this.botCounter = 0;
    this.botTimer = null;
    this.turnTimer = null;
    this.turnStartedAt = null;
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

  ctx() {
    return { enPassantTarget: this.enPassantTarget, castling: this.castling };
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
    let whiteIdx = this.chooseFirstPlayerIndex();
    if (this.rematchSwap) whiteIdx = 1 - whiteIdx;
    this.players.forEach((p, i) => { p.color = i === whiteIdx ? WHITE : BLACK; });
    this.currentColor = WHITE;
    this.castling = { w: { K: true, Q: true }, b: { K: true, Q: true } };
    this.enPassantTarget = null;
    this.halfmoveClock = 0;
    this.captured = { w: [], b: [] };
    this.status = 'playing';
    this.winnerId = null;
    this.resultText = null;
    this.lastMove = null;
    this.log = [];
    clearTimeout(this.botTimer);
    clearTimeout(this.turnTimer);
    this.pushLog(`♟️ Game started. ${this.playerByColor(WHITE).name} plays White, ${this.playerByColor(BLACK).name} plays Black. White moves first.`);
    this.scheduleTurnTimer();
    return { ok: true };
  }

  move(player, from, to, promotion) {
    if (this.status !== 'playing') return { ok: false, error: 'not-playing' };
    if (this.currentColor !== player.color) return { ok: false, error: 'not-your-turn' };
    const piece = this.board[from];
    if (!piece || piece.color !== player.color) return { ok: false, error: 'invalid-source' };
    const legal = allLegalMoves(this.board, player.color, this.ctx());
    if (!legal.some((m) => m.from === from && m.to === to)) return { ok: false, error: 'illegal-move' };

    const isEnPassant = piece.type === 'P' && colOf(from) !== colOf(to) && !this.board[to];
    const isCastle = piece.type === 'K' && Math.abs(colOf(to) - colOf(from)) === 2;
    const capturedPiece = isEnPassant ? this.board[idxOf(rowOf(from), colOf(to))] : this.board[to];
    const promoType = ['Q', 'R', 'B', 'N'].includes(promotion) ? promotion : 'Q';
    const isPromotion = piece.type === 'P' && (rowOf(to) === 0 || rowOf(to) === 7);

    this.board = applyMoveToBoard(this.board, from, to, promoType);

    if (piece.type === 'K') this.castling[player.color] = { K: false, Q: false };
    if (piece.type === 'R') {
      const homeRow = player.color === WHITE ? 7 : 0;
      if (rowOf(from) === homeRow && colOf(from) === 0) this.castling[player.color].Q = false;
      if (rowOf(from) === homeRow && colOf(from) === 7) this.castling[player.color].K = false;
    }
    if (capturedPiece && capturedPiece.type === 'R') {
      const oppColor = otherColor(player.color);
      const oppHomeRow = oppColor === WHITE ? 7 : 0;
      if (rowOf(to) === oppHomeRow && colOf(to) === 0) this.castling[oppColor].Q = false;
      if (rowOf(to) === oppHomeRow && colOf(to) === 7) this.castling[oppColor].K = false;
    }

    this.enPassantTarget = (piece.type === 'P' && Math.abs(rowOf(to) - rowOf(from)) === 2)
      ? idxOf((rowOf(from) + rowOf(to)) / 2, colOf(from)) : null;
    this.halfmoveClock = (capturedPiece || piece.type === 'P') ? 0 : this.halfmoveClock + 1;

    if (capturedPiece) this.captured[capturedPiece.color].push(capturedPiece.type);
    this.lastMove = {
      from, to, color: player.color, capturedType: capturedPiece ? capturedPiece.type : null, isCastle, isEnPassant, promoted: isPromotion ? promoType : null,
    };

    let moveDesc = `${player.name} moved ${PIECE_LABEL[piece.type]} ${squareName(from)}-${squareName(to)}`;
    if (isCastle) moveDesc = `${player.name} castled ${colOf(to) === 6 ? 'kingside' : 'queenside'}`;
    if (capturedPiece) moveDesc += ` and captured ${colorName(capturedPiece.color)}'s ${PIECE_LABEL[capturedPiece.type]}${isEnPassant ? ' en passant' : ''}!`;
    else moveDesc += '.';
    if (isPromotion) moveDesc += ` Promoted to ${articleFor(PIECE_LABEL[promoType])} ${PIECE_LABEL[promoType]}!`;
    this.pushLog(moveDesc);

    this.advanceTurnAfterMove();
    return { ok: true };
  }

  advanceTurnAfterMove() {
    const nextColor = otherColor(this.currentColor);
    this.currentColor = nextColor;
    const legal = allLegalMoves(this.board, nextColor, this.ctx());
    const kingIdx = this.board.findIndex((p) => p && p.color === nextColor && p.type === 'K');
    const inCheck = kingIdx !== -1 && isSquareAttacked(this.board, rowOf(kingIdx), colOf(kingIdx), otherColor(nextColor));
    if (!legal.length) {
      if (inCheck) {
        const winner = this.playerByColor(otherColor(nextColor));
        this.finishGame(winner, `🏆 ${winner ? winner.name : colorName(otherColor(nextColor))} wins by checkmate!`);
      } else {
        this.finishGame(null, '🤝 Draw by stalemate.');
      }
      return;
    }
    if (isInsufficientMaterial(this.board)) { this.finishGame(null, '🤝 Draw — insufficient material to checkmate.'); return; }
    if (this.halfmoveClock >= 100) { this.finishGame(null, '🤝 Draw — 50 moves without a capture or pawn move.'); return; }
    this.pushLog(`${colorName(nextColor)}'s turn${inCheck ? ' — check!' : ''}.`);
    this.scheduleTurnTimer();
  }

  resign(player) {
    const winner = this.playerByColor(otherColor(player.color));
    this.finishGame(winner, `🏳️ ${colorName(player.color)} resigned — ${winner ? winner.name : colorName(otherColor(player.color))} wins.`);
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
    this.lastMove = null;
    this.board = null;
    this.captured = { w: [], b: [] };
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

  handleTurnTimeout(player) {
    if (this.status !== 'playing' || this.currentPlayer() !== player) return;
    const legal = allLegalMoves(this.board, player.color, this.ctx());
    if (!legal.length) return; // shouldn't happen -- advanceTurnAfterMove would already have ended the game
    const m = legal[Math.floor(Math.random() * legal.length)];
    this.pushLog(`⏰ ${player.name} ran out of time for this turn.`);
    this.move(player, m.from, m.to, 'Q');
    if (this.nsp) this.broadcast(this.nsp);
  }

  // -- Bot AI ---------------------------------------------------------------
  // 1-ply heuristic: prefer captures (weighted by the captured piece's
  // value), recognize a mate-in-1 when available, mildly avoid moving
  // into an square the opponent can immediately recapture on, otherwise
  // pick a random legal move -- not a real search engine, just enough to
  // be a believable opponent, matching this project's other game bots.
  chooseBotMove(color) {
    const moves = allLegalMoves(this.board, color, this.ctx());
    if (!moves.length) return null;
    const enemy = otherColor(color);
    let best = null;
    let bestScore = -Infinity;
    moves.forEach((m) => {
      const trial = applyMoveToBoard(this.board, m.from, m.to, 'Q');
      const capturedPiece = this.board[m.to];
      let score = capturedPiece ? PIECE_VALUE[capturedPiece.type] : 0;
      const oppKingIdx = trial.findIndex((p) => p && p.color === enemy && p.type === 'K');
      const oppInCheck = oppKingIdx !== -1 && isSquareAttacked(trial, rowOf(oppKingIdx), colOf(oppKingIdx), color);
      if (oppInCheck) {
        const oppMoves = allLegalMoves(trial, enemy, this.ctx());
        if (!oppMoves.length) score += 1000; // mate in 1
        else score += 0.5;
      }
      if (isSquareAttacked(trial, rowOf(m.to), colOf(m.to), enemy)) {
        score -= PIECE_VALUE[this.board[m.from].type] * 0.5;
      }
      score += Math.random() * 0.3;
      if (score > bestScore) { bestScore = score; best = m; }
    });
    return best;
  }

  scheduleBotTurn() {
    clearTimeout(this.botTimer);
    const player = this.currentPlayer();
    if (!player || !player.isBot || this.status !== 'playing') return;
    this.botTimer = setTimeout(() => {
      if (this.status !== 'playing') return;
      const m = this.chooseBotMove(player.color);
      if (!m) return;
      this.move(player, m.from, m.to, 'Q');
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
  // Fully open information (no hidden pieces), so -- like Go and Cờ Tướng
  // Úp -- one shared broadcast for everyone.
  state(forPlayerId) {
    const isCurrentTurn = this.status === 'playing' && this.turnStartedAt !== null;
    const turnElapsedMs = isCurrentTurn ? Date.now() - this.turnStartedAt : 0;
    const legalMoves = {};
    let checkColor = null;
    if (this.status === 'playing' && this.board) {
      const moves = allLegalMoves(this.board, this.currentColor, this.ctx());
      moves.forEach((m) => {
        if (!legalMoves[m.from]) legalMoves[m.from] = [];
        legalMoves[m.from].push(m.to);
      });
      const kingIdx = this.board.findIndex((p) => p && p.color === this.currentColor && p.type === 'K');
      if (kingIdx !== -1 && isSquareAttacked(this.board, rowOf(kingIdx), colOf(kingIdx), otherColor(this.currentColor))) {
        checkColor = this.currentColor;
      }
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
      board: this.board,
      legalMoves,
      checkColor,
      captured: this.captured,
      log: this.log,
      winnerId: this.winnerId,
      resultText: this.resultText,
      lastMove: this.lastMove,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color || null, connected: p.connected, isBot: Boolean(p.isBot),
      })),
      yourId: forPlayerId || null,
      yourColor: (this.findPlayer(forPlayerId) || {}).color || null,
    };
  }

  broadcast(nsp) {
    this.players.forEach((p) => {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('chess:state', this.state(p.id));
    });
  }
}

function attachChess(io) {
  const nsp = io.of('/chess');
  const rooms = new Map();
  let roomCounter = 0;

  function roomList() {
    return [...rooms.values()].filter((r) => !r.isEmpty()).map((r) => r.summary());
  }
  function broadcastRoomList() {
    nsp.emit('chess:rooms', roomList());
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

    socket.on('chess:listRooms', (payload, callback) => {
      if (typeof callback === 'function') callback({ ok: true, rooms: roomList() });
    });

    socket.on('chess:createRoom', ({ roomName, password, playerId, name, timePerTurn, firstPlayer }, callback) => {
      const cleanRoomName = String(roomName || '').trim().slice(0, 30);
      const cleanPassword = String(password || '');
      if (!cleanRoomName) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-name' }); return; }
      if (!cleanPassword) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-password' }); return; }
      if (typeof playerId !== 'string' || !playerId) { if (typeof callback === 'function') callback({ ok: false, error: 'invalid-player' }); return; }
      const nameTaken = [...rooms.values()].some((r) => r.name.toLowerCase() === cleanRoomName.toLowerCase());
      if (nameTaken) { if (typeof callback === 'function') callback({ ok: false, error: 'name-taken' }); return; }

      roomCounter += 1;
      const room = new ChessRoom(`room_${roomCounter}`, cleanRoomName, cleanPassword, { timePerTurn, firstPlayer });
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

    socket.on('chess:joinRoom', ({ roomId, password, playerId, name }, callback) => {
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

    socket.on('chess:addBot', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      if (room.status !== 'waiting') { if (typeof callback === 'function') callback({ ok: false, error: 'already-started' }); return; }
      if (room.players.length >= MAX_PLAYERS) { if (typeof callback === 'function') callback({ ok: false, error: 'table-full' }); return; }
      room.addBot();
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('chess:start', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const result = room.startGame();
      if (typeof callback === 'function') callback(result);
      if (result.ok) { room.broadcast(nsp); room.scheduleBotTurn(); }
    });

    socket.on('chess:move', ({ from, to, promotion }, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player) { if (typeof callback === 'function') callback({ ok: false, error: 'no-player' }); return; }
      const result = room.move(player, Number(from), Number(to), promotion);
      if (typeof callback === 'function') callback(result);
      if (result.ok) { room.broadcast(nsp); room.scheduleBotTurn(); }
    });

    socket.on('chess:resign', (payload, callback) => {
      const room = myRoom();
      if (!room) { if (typeof callback === 'function') callback({ ok: false, error: 'no-room' }); return; }
      const player = room.findPlayer(socket.playerId);
      if (!player || room.status !== 'playing') { if (typeof callback === 'function') callback({ ok: false, error: 'not-playing' }); return; }
      room.resign(player);
      if (typeof callback === 'function') callback({ ok: true });
      room.broadcast(nsp);
    });

    socket.on('chess:newGame', (payload, callback) => {
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

    socket.on('chess:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
}

module.exports = attachChess;
module.exports.ChessRoom = ChessRoom;
module.exports.buildBoard = buildBoard;
module.exports.pieceMoves = pieceMoves;
module.exports.allLegalMoves = allLegalMoves;
module.exports.applyMoveToBoard = applyMoveToBoard;
module.exports.isSquareAttacked = isSquareAttacked;
module.exports.isInsufficientMaterial = isInsufficientMaterial;
module.exports.idxOf = idxOf;
module.exports.rowOf = rowOf;
module.exports.colOf = colOf;
module.exports.squareName = squareName;
module.exports.PIECE_LABEL = PIECE_LABEL;
module.exports.PIECE_VALUE = PIECE_VALUE;
module.exports.WHITE = WHITE;
module.exports.BLACK = BLACK;
module.exports.otherColor = otherColor;
module.exports.colorName = colorName;
module.exports.sanitizeOptions = sanitizeOptions;
module.exports.TURN_TIME_OPTIONS = TURN_TIME_OPTIONS;
module.exports.FIRST_PLAYER_OPTIONS = FIRST_PLAYER_OPTIONS;
module.exports.MAX_PLAYERS = MAX_PLAYERS;
