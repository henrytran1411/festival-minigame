// Client-side Sudoku generator. One verified puzzle/solution pair, varied
// each time via standard Sudoku symmetry transforms (digit relabeling,
// band/stack shuffles, transpose) — every transform preserves validity.
window.generateSudokuPuzzle = (function () {
  const BASE_SOLUTION = [
    5, 3, 4, 6, 7, 8, 9, 1, 2,
    6, 7, 2, 1, 9, 5, 3, 4, 8,
    1, 9, 8, 3, 4, 2, 5, 6, 7,
    8, 5, 9, 7, 6, 1, 4, 2, 3,
    4, 2, 6, 8, 5, 3, 7, 9, 1,
    7, 1, 3, 9, 2, 4, 8, 5, 6,
    9, 6, 1, 5, 3, 7, 2, 8, 4,
    2, 8, 7, 4, 1, 9, 6, 3, 5,
    3, 4, 5, 2, 8, 6, 1, 7, 9,
  ];

  const BASE_PUZZLE = [
    5, 3, 0, 0, 7, 0, 0, 0, 0,
    6, 0, 0, 1, 9, 5, 0, 0, 0,
    0, 9, 8, 0, 0, 0, 0, 6, 0,
    8, 0, 0, 0, 6, 0, 0, 0, 3,
    4, 0, 0, 8, 0, 3, 0, 0, 1,
    7, 0, 0, 0, 2, 0, 0, 0, 6,
    0, 6, 0, 0, 0, 0, 2, 8, 0,
    0, 0, 0, 4, 1, 9, 0, 0, 5,
    0, 0, 0, 0, 8, 0, 0, 7, 9,
  ];

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function rowsToGrid(flat) {
    const grid = [];
    for (let r = 0; r < 9; r++) grid.push(flat.slice(r * 9, r * 9 + 9));
    return grid;
  }

  function gridToFlat(grid) {
    return grid.flat();
  }

  function transpose(grid) {
    const t = [];
    for (let c = 0; c < 9; c++) {
      const row = [];
      for (let r = 0; r < 9; r++) row.push(grid[r][c]);
      t.push(row);
    }
    return t;
  }

  function createPuzzle() {
    const mapping = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const remap = (v) => (v === 0 ? 0 : mapping[v - 1]);
    let solGrid = rowsToGrid(BASE_SOLUTION.map(remap));
    let puzGrid = rowsToGrid(BASE_PUZZLE.map(remap));

    const bandOrder = shuffle([0, 1, 2]);
    const rowsWithinBand = [0, 1, 2].map(() => shuffle([0, 1, 2]));
    const permuteRows = (grid) => {
      const out = [];
      for (const band of bandOrder) {
        for (const r of rowsWithinBand[band]) out.push(grid[band * 3 + r]);
      }
      return out;
    };
    solGrid = permuteRows(solGrid);
    puzGrid = permuteRows(puzGrid);

    if (Math.random() < 0.5) {
      solGrid = transpose(solGrid);
      puzGrid = transpose(puzGrid);
    }

    const stackOrder = shuffle([0, 1, 2]);
    const colsWithinStack = [0, 1, 2].map(() => shuffle([0, 1, 2]));
    const permuteCols = (grid) =>
      grid.map((row) => {
        const out = [];
        for (const stack of stackOrder) {
          for (const c of colsWithinStack[stack]) out.push(row[stack * 3 + c]);
        }
        return out;
      });
    solGrid = permuteCols(solGrid);
    puzGrid = permuteCols(puzGrid);

    return {
      solution: gridToFlat(solGrid),
      puzzle: gridToFlat(puzGrid),
    };
  }

  return createPuzzle;
})();
