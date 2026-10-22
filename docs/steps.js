// 解説モード用: 人が使う手筋で、最初の盤面から1手ずつ解く手順を求める
//
// 各空きマスの候補（入りうる数字）を持ち、次の手を、やさしい手筋から順に探す。
// 1. 数字を置く手（シングル）
//    - ヒドゥンシングル … ある行・列・ブロックの中で、その数字が入りうるマスが1か所しかない
//    - ネイキッドシングル … そのマスの候補が1つしか残っていない
// 2. シングルが見つからなければ、候補を消す手（中級の手筋と X-Wing）
//    - ロックト・キャンディデート … ブロック（行・列）の中で、その数字が入りうるマスが、1つの行・列（ブロック）との重なりに限られる
//    - ネイキッドペア・トリプル … 行・列・ブロックの2〜3マスの候補が、合わせて同じ数の数字しかない
//    - ヒドゥンペア・トリプル … 行・列・ブロックの中で、2〜3個の数字が入りうるマスが、同じ数のマスに限られる
//    - X-Wing … 2つの行（列）で、ある数字が入りうるマスがそれぞれ2つだけで、それが同じ2つの列（行）に並ぶ
// 3. どれも見つからないときは、答えから1マス埋めて続ける（理由は示せない）。

import { PEERS, UNITS } from "./solver.js";

const UNIT_KINDS = ["row", "col", "box"]; // UNITS は行9・列9・ブロック9の順
// ブロックを先に調べる（人がまず探すのはブロックの中であることが多いため）
const SEARCH_ORDER = [...Array(27)].map((_, k) => (k + 18) % 27);
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const ALL = 0x1ff;

const bitOf = (d) => 1 << (d - 1);
const digitsOf = (mask) => DIGITS.filter((d) => mask & bitOf(d));
const popcount = (m) => {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
};
const kindOf = (u) => UNIT_KINDS[Math.floor(u / 9)];

// 手順を返す。puzzle は問題（0=空き）、solution はその解答。
// どの手にもある項目: technique、cand（この手の後の各マスの候補。9bit のビットマスク。数字のあるマスは 0）
// 数字を置く手は cell・digit を持つ。technique ごとの項目:
// - "hiddenSingle": unitKind（"row" / "col" / "box"）、area（そのユニットのマス）、
//   excluded（ユニット内のほかの空きマス。空なら、ユニットで空いているのがこのマスだけ）、
//   blockers（excluded のうち同じ行・列・ブロックに digit があるマスについて、その digit があるマス）、
//   erased（excluded のうち、先の手で候補から digit を消したマス）
// - "nakedSingle": area（同じ行・列・ブロックのマス）、seen（{ row, col, box }: それぞれにある digit 以外の数字）、
//   blockers（その数字があるマス）、erased（seen になく、先の手で候補から消した数字）
// - "answer": 追加の項目なし
// 候補を消す手は removed（[{ cell, digits }]: 消す候補）、cells（手筋の形をつくるマス）、digits（その数字）、
// area（関係する行・列・ブロックのマス）を持つ。technique ごとの項目:
// - "lockedCandidates": baseKind（数字が重なりに限られるユニットの種類）、coverKind（候補を消すユニットの種類）
// - "nakedSubset" / "hiddenSubset": unitKind（cells の数が2ならペア、3ならトリプル）
// - "xWing": baseKind（数字が2マスに限られる2本の種類）、coverKind（候補を消す2本の種類）
export function solveSteps(puzzle, solution) {
  const board = puzzle.slice();
  const cand = board.map((d, i) => (d ? 0 : DIGITS.filter((x) => !PEERS[i].some((p) => board[p] === x)).reduce((m, x) => m | bitOf(x), 0)));
  const steps = [];
  for (;;) {
    const step =
      findHiddenSingle(board, cand) ?? findNakedSingle(board, cand) ?? findElimination(cand) ?? fromAnswer(board, cand, solution);
    if (!step) return steps;
    if (step.removed) {
      for (const { cell, digits } of step.removed) for (const d of digits) cand[cell] &= ~bitOf(d);
    } else {
      board[step.cell] = step.digit;
      cand[step.cell] = 0;
      for (const p of PEERS[step.cell]) cand[p] &= ~bitOf(step.digit);
    }
    step.cand = cand.slice();
    steps.push(step);
  }
}

// ---------------------------------------------------------------------------
// 数字を置く手
// ---------------------------------------------------------------------------
function findHiddenSingle(board, cand) {
  for (const u of SEARCH_ORDER) {
    const unit = UNITS[u];
    for (const digit of DIGITS) {
      if (unit.some((c) => board[c] === digit)) continue;
      const open = unit.filter((c) => cand[c] & bitOf(digit));
      if (open.length !== 1) continue;
      const cell = open[0];
      const excluded = unit.filter((c) => !board[c] && c !== cell);
      // ほかの空きマスを、同じ行・列・ブロックに digit があるマスと、先の手で候補から digit を消したマスに分ける
      const blocked = excluded.filter((c) => PEERS[c].some((p) => board[p] === digit));
      return {
        cell,
        digit,
        technique: "hiddenSingle",
        unitKind: kindOf(u),
        area: unit,
        excluded,
        blockers: pickBlockers(board, blocked, digit),
        erased: excluded.filter((c) => !blocked.includes(c)),
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

function findNakedSingle(board, cand) {
  for (let cell = 0; cell < 81; cell++) {
    if (popcount(cand[cell]) !== 1) continue;
    const digit = digitsOf(cand[cell])[0];
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
    const erased = DIGITS.filter((d) => d !== digit && !found.has(d));
    return { cell, digit, technique: "nakedSingle", area: PEERS[cell], seen, blockers, erased };
  }
  return null;
}

// 手筋で次の1手が見つからないときは、候補が最も少ない空きマスに答えの数字を置く
function fromAnswer(board, cand, solution) {
  let best = -1, bestCount = 10;
  for (let cell = 0; cell < 81; cell++) {
    if (board[cell]) continue;
    const n = popcount(cand[cell]);
    if (n < bestCount) {
      best = cell;
      bestCount = n;
    }
  }
  return best < 0 ? null : { cell: best, digit: solution[best], technique: "answer" };
}

// ---------------------------------------------------------------------------
// 候補を消す手（やさしい順に探す）
// ---------------------------------------------------------------------------
function findElimination(cand) {
  return (
    findLockedCandidates(cand) ??
    findNakedSubset(cand, 2) ??
    findHiddenSubset(cand, 2) ??
    findNakedSubset(cand, 3) ??
    findHiddenSubset(cand, 3) ??
    findXWing(cand)
  );
}

// cells の候補から mask の数字を消す手の removed（消せる候補がなければ空）
const removalsOf = (cand, cells, mask) =>
  cells.filter((c) => cand[c] & mask).map((c) => ({ cell: c, digits: digitsOf(cand[c] & mask) }));

// arr から k 個を選ぶ組み合わせをすべて返す
function combinations(arr, k, start = 0) {
  if (k === 0) return [[]];
  const out = [];
  for (let i = start; i <= arr.length - k; i++) {
    for (const rest of combinations(arr, k - 1, i + 1)) out.push([arr[i], ...rest]);
  }
  return out;
}

// ブロックと行・列の重なり（3マス）について、ブロックの中で digit が入りうるマスが重なりに限られれば行・列のほかのマスから
// （ポインティング）、行・列の中で限られればブロックのほかのマスから（クレーミング）、digit を消せる
function findLockedCandidates(cand) {
  for (const pointing of [true, false]) {
    for (let box = 18; box < 27; box++) {
      for (let line = 0; line < 18; line++) {
        const overlap = UNITS[box].filter((c) => UNITS[line].includes(c));
        if (!overlap.length) continue;
        const [base, cover] = pointing ? [box, line] : [line, box];
        for (const digit of DIGITS) {
          const cells = UNITS[base].filter((c) => cand[c] & bitOf(digit));
          if (!cells.length || !cells.every((c) => overlap.includes(c))) continue;
          const removed = removalsOf(cand, UNITS[cover].filter((c) => !overlap.includes(c)), bitOf(digit));
          if (!removed.length) continue;
          return {
            technique: "lockedCandidates",
            baseKind: kindOf(base),
            coverKind: kindOf(cover),
            cells,
            digits: [digit],
            area: [...new Set([...UNITS[base], ...UNITS[cover]])],
            removed,
          };
        }
      }
    }
  }
  return null;
}

// ユニットの n マスの候補が、合わせて n 個の数字しかなければ、その数字はユニットのほかのマスに入らない
function findNakedSubset(cand, n) {
  for (const u of SEARCH_ORDER) {
    const unit = UNITS[u];
    const open = unit.filter((c) => cand[c]);
    for (const cells of combinations(open.filter((c) => popcount(cand[c]) <= n), n)) {
      const mask = cells.reduce((m, c) => m | cand[c], 0);
      if (popcount(mask) !== n) continue;
      const removed = removalsOf(cand, open.filter((c) => !cells.includes(c)), mask);
      if (!removed.length) continue;
      return { technique: "nakedSubset", unitKind: kindOf(u), cells, digits: digitsOf(mask), area: unit, removed };
    }
  }
  return null;
}

// ユニットの n 個の数字が入りうるマスが合わせて n マスしかなければ、そのマスにはほかの数字は入らない
function findHiddenSubset(cand, n) {
  for (const u of SEARCH_ORDER) {
    const unit = UNITS[u];
    const places = (d) => unit.filter((c) => cand[c] & bitOf(d)).length;
    const candidates = DIGITS.filter((d) => places(d) >= 2 && places(d) <= n);
    for (const digits of combinations(candidates, n)) {
      const mask = digits.reduce((m, d) => m | bitOf(d), 0);
      const cells = unit.filter((c) => cand[c] & mask);
      if (cells.length !== n) continue;
      const removed = removalsOf(cand, cells, ALL & ~mask);
      if (!removed.length) continue;
      return { technique: "hiddenSubset", unitKind: kindOf(u), cells, digits, area: unit, removed };
    }
  }
  return null;
}

// 2つの行で digit が入りうるマスがそれぞれ2つだけで、それが同じ2つの列に並べば、その2列のほかのマスに digit は入らない
// （行と列を入れ替えても同じ）
function findXWing(cand) {
  for (const digit of DIGITS) {
    const bit = bitOf(digit);
    for (const baseStart of [0, 9]) {
      const coverStart = 9 - baseStart;
      const coverOf = (c) => (baseStart === 0 ? c % 9 : Math.floor(c / 9));
      const lines = [...Array(9).keys()].filter((i) => UNITS[baseStart + i].filter((c) => cand[c] & bit).length === 2);
      for (const [a, b] of combinations(lines, 2)) {
        const cells = [...UNITS[baseStart + a], ...UNITS[baseStart + b]].filter((c) => cand[c] & bit);
        const covers = [...new Set(cells.map(coverOf))];
        if (covers.length !== 2) continue;
        const coverCells = covers.flatMap((j) => UNITS[coverStart + j]);
        const removed = removalsOf(cand, coverCells.filter((c) => !cells.includes(c)), bit);
        if (!removed.length) continue;
        return {
          technique: "xWing",
          baseKind: kindOf(baseStart),
          coverKind: kindOf(coverStart),
          cells,
          digits: [digit],
          area: [...new Set([...UNITS[baseStart + a], ...UNITS[baseStart + b], ...coverCells])],
          removed,
        };
      }
    }
  }
  return null;
}
