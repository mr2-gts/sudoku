// 9x9 数独ソルバー（sudoku_solver.py を JavaScript に移植したもの）
//
// 盤面は 81 要素の配列（0 = 空き）。各マスの候補は 9bit のビットマスク（bit0=数字1 … bit8=数字9）。
// 1. 制約伝播 … naked single と hidden single で確定できるマスを埋める。
// 2. バックトラック … 候補が最も少ないマス（MRV）で仮置きし、矛盾したらその分岐を捨てる。

const ALL = 0x1ff; // 1〜9 すべて候補

// 27 個のユニット（行・列・ブロック）と、各マスと同じユニットに属する 20 マス
export const UNITS = [];
for (let r = 0; r < 9; r++) UNITS.push([...Array(9)].map((_, c) => r * 9 + c));
for (let c = 0; c < 9; c++) UNITS.push([...Array(9)].map((_, r) => r * 9 + c));
for (let b = 0; b < 9; b++) {
  const br = Math.floor(b / 3) * 3, bc = (b % 3) * 3;
  UNITS.push([...Array(9)].map((_, i) => (br + Math.floor(i / 3)) * 9 + bc + (i % 3)));
}
const PEERS = [...Array(81)].map((_, i) => {
  const s = new Set();
  for (const u of UNITS) if (u.includes(i)) u.forEach((p) => s.add(p));
  s.delete(i);
  return [...s];
});

export class SudokuError extends Error {}
class Contradiction extends Error {}

const bitOf = (d) => 1 << (d - 1);
const digitOf = (bit) => 31 - Math.clz32(bit) + 1;
const popcount = (m) => {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
};
const isSingle = (m) => m !== 0 && (m & (m - 1)) === 0;

// cell を bit の数字に確定し、制約伝播を行う。矛盾したら Contradiction。
function assign(cand, cell, bit) {
  const stack = [[cell, bit]];
  while (stack.length) {
    const [c, b] = stack.pop();
    if (!(cand[c] & b)) throw new Contradiction();
    cand[c] = b;
    // naked single: 周りのマスからこの数字を消す。候補が1つになったら確定させる
    for (const p of PEERS[c]) {
      if (cand[p] & b) {
        cand[p] &= ~b;
        if (cand[p] === 0) throw new Contradiction();
        if (isSingle(cand[p])) stack.push([p, cand[p]]);
      }
    }
  }
  hiddenSingles(cand);
}

// hidden single: ユニット内である数字を置けるマスが1つしかなければ確定させる
function hiddenSingles(cand) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of UNITS) {
      let once = 0, twice = 0;
      for (const c of unit) {
        twice |= once & cand[c];
        once |= cand[c];
      }
      if (once !== ALL) throw new Contradiction(); // どこにも置けない数字がある
      const onlyOnce = once & ~twice;
      if (!onlyOnce) continue;
      for (const c of unit) {
        const b = cand[c] & onlyOnce;
        if (b && cand[c] !== b) {
          if (!isSingle(b)) throw new Contradiction(); // 1マスに「ここしかない」数字が2つ
          assign(cand, c, b);
          changed = true;
        }
      }
    }
  }
}

// 盤面を解く。maxSolutions=2 にすると解の一意性を判定できる。
// 戻り値: { solution: 解 or null, solutionCount: 見つかった解の数（maxSolutions で打ち切り） }
export function solve(grid, maxSolutions = 1) {
  if (grid.length !== 81 || grid.some((d) => !(d >= 0 && d <= 9))) {
    throw new SudokuError("盤面は 0〜9 の数字 81 個で指定してください");
  }
  for (const unit of UNITS) {
    const digits = unit.map((c) => grid[c]).filter((d) => d);
    if (new Set(digits).size !== digits.length) throw new SudokuError("同じ行・列・ブロックに同じ数字があります");
  }

  const cand = new Array(81).fill(ALL);
  try {
    grid.forEach((d, i) => d && assign(cand, i, bitOf(d)));
  } catch (e) {
    if (e instanceof Contradiction) return { solution: null, solutionCount: 0 };
    throw e;
  }

  const solutions = [];
  const search = (cand) => {
    // MRV: 未確定マスのうち候補が最も少ないものを選ぶ
    let best = -1, bestCount = 10;
    for (let i = 0; i < 81; i++) {
      const n = popcount(cand[i]);
      if (n > 1 && n < bestCount) {
        best = i;
        bestCount = n;
        if (n === 2) break;
      }
    }
    if (best === -1) {
      solutions.push(cand.map(digitOf));
      return;
    }
    for (let m = cand[best]; m && solutions.length < maxSolutions; m &= m - 1) {
      const trial = cand.slice();
      try {
        assign(trial, best, m & -m); // 最下位ビット = 最小の候補
      } catch (e) {
        if (e instanceof Contradiction) continue;
        throw e;
      }
      search(trial);
    }
  };
  search(cand);
  return { solution: solutions[0] ?? null, solutionCount: solutions.length };
}

// テキスト（1〜9 は数字、空きは 0 か "."、それ以外の文字は無視）を 81 要素の配列にする
export function parse(text) {
  const cells = [...text].filter((ch) => /[0-9.]/.test(ch)).map((ch) => (ch === "." ? 0 : Number(ch)));
  if (cells.length !== 81) throw new SudokuError(`マスの数が ${cells.length} 個です（81 個必要）`);
  return cells;
}
