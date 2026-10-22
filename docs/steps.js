// 解説モード用: 人が使う手筋で、最初の盤面から1手ずつ数字を置く手順を求める
//
// 使う手筋は次の2つ（シングル）だけ。新聞や入門書の易しい〜普通の問題は、たいていこれで最後まで解ける。
// - ヒドゥンシングル … ある行・列・ブロックの中で、その数字を置けるマスが1か所しかない
// - ネイキッドシングル … 同じ行・列・ブロックにある数字を除くと、入る数字が1つしか残らない
// どちらでも次の1手が見つからないときは、答えから1マス埋めて続ける（理由は示せない）。

import { PEERS, UNITS } from "./solver.js";

const UNIT_KINDS = ["row", "col", "box"]; // UNITS は行9・列9・ブロック9の順
// ブロックを先に調べる（人がまず探すのはブロックの中であることが多いため）
const SEARCH_ORDER = [...Array(27)].map((_, k) => (k + 18) % 27);
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// 手順を返す。puzzle は問題（0=空き）、solution はその解答。
// 各手は { cell, digit, technique, ... }。technique ごとの項目:
// - "hiddenSingle": unitKind（"row" / "col" / "box"）、area（そのユニットのマス）、
//   excluded（ユニット内のほかの空きマス。空なら、ユニットで空いているのがこのマスだけ）、
//   blockers（excluded に digit を置けない理由になる、digit があるマス）
// - "nakedSingle": area（同じ行・列・ブロックのマス）、seen（{ row, col, box }: それぞれにある digit 以外の数字）、
//   blockers（その数字があるマス）
// - "answer": 追加の項目なし
export function solveSteps(puzzle, solution) {
  const board = puzzle.slice();
  const steps = [];
  for (;;) {
    const step = findHiddenSingle(board) ?? findNakedSingle(board) ?? fromAnswer(board, solution);
    if (!step) return steps;
    board[step.cell] = step.digit;
    steps.push(step);
  }
}

// 空きマス cell に digit を置けるか（同じ行・列・ブロックに digit がないか）
const canPlace = (board, cell, digit) => !board[cell] && !PEERS[cell].some((p) => board[p] === digit);

function findHiddenSingle(board) {
  for (const u of SEARCH_ORDER) {
    const unit = UNITS[u];
    for (const digit of DIGITS) {
      if (unit.some((c) => board[c] === digit)) continue;
      const open = unit.filter((c) => canPlace(board, c, digit));
      if (open.length !== 1) continue;
      const cell = open[0];
      const excluded = unit.filter((c) => !board[c] && c !== cell);
      return {
        cell,
        digit,
        technique: "hiddenSingle",
        unitKind: UNIT_KINDS[Math.floor(u / 9)],
        area: unit,
        excluded,
        blockers: pickBlockers(board, excluded, digit),
      };
    }
  }
  return null;
}

// cells のどのマスにも、同じ行・列・ブロックのどこかに digit があるマスを選んで示す（なるべく少なく）
function pickBlockers(board, cells, digit) {
  const sources = board.flatMap((d, i) => (d === digit ? [i] : []));
  const left = new Set(cells);
  const blockers = [];
  while (left.size) {
    let best = -1, bestCover = [];
    for (const s of sources) {
      const cover = [...left].filter((c) => PEERS[c].includes(s));
      if (cover.length > bestCover.length) {
        best = s;
        bestCover = cover;
      }
    }
    blockers.push(best);
    bestCover.forEach((c) => left.delete(c));
  }
  return blockers;
}

function findNakedSingle(board) {
  for (let cell = 0; cell < 81; cell++) {
    const free = DIGITS.filter((d) => canPlace(board, cell, d));
    if (free.length !== 1) continue;
    // ほかの8つの数字が、行・列・ブロックのどこにあるか（2か所以上にあれば、行 → 列 → ブロックの順で先に見つかった方）
    const r = Math.floor(cell / 9), c = cell % 9;
    const units = { row: UNITS[r], col: UNITS[9 + c], box: UNITS[18 + Math.floor(r / 3) * 3 + Math.floor(c / 3)] };
    const seen = { row: [], col: [], box: [] };
    const found = new Set();
    const blockers = [];
    for (const kind of UNIT_KINDS) {
      for (const p of units[kind]) {
        const d = board[p];
        if (!d || found.has(d)) continue;
        found.add(d);
        seen[kind].push(d);
        blockers.push(p);
      }
      seen[kind].sort((a, b) => a - b);
    }
    return { cell, digit: free[0], technique: "nakedSingle", area: PEERS[cell], seen, blockers };
  }
  return null;
}

// 手筋で次の1手が見つからないときは、置ける数字が最も少ない空きマスに答えの数字を置く
function fromAnswer(board, solution) {
  let best = -1, bestCount = 10;
  for (let cell = 0; cell < 81; cell++) {
    if (board[cell]) continue;
    const n = DIGITS.filter((d) => canPlace(board, cell, d)).length;
    if (n < bestCount) {
      best = cell;
      bestCount = n;
    }
  }
  return best < 0 ? null : { cell: best, digit: solution[best], technique: "answer" };
}
