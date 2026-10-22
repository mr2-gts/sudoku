// Web版（docs/solver.js・docs/steps.js）のテスト。node --test で実行する（Node.js 18 以上）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PEERS, SudokuError, parse, solve } from "./docs/solver.js";
import { solveSteps } from "./docs/steps.js";

const isValid = (g) => [...Array(9)].every((_, k) => {
  const row = new Set(), col = new Set(), box = new Set();
  for (let i = 0; i < 9; i++) {
    row.add(g[k * 9 + i]);
    col.add(g[i * 9 + k]);
    box.add(g[(Math.floor(k / 3) * 3 + Math.floor(i / 3)) * 9 + (k % 3) * 3 + (i % 3)]);
  }
  return [row, col, box].every((s) => s.size === 9 && !s.has(0));
});

for (const name of ["easy", "hard"]) {
  test(`${name} を解ける（解は一意）`, () => {
    const grid = parse(readFileSync(new URL(`puzzles/${name}.txt`, import.meta.url), "utf8"));
    const r = solve(grid, 2);
    assert.equal(r.solutionCount, 1);
    assert.ok(isValid(r.solution));
    grid.forEach((d, i) => d && assert.equal(r.solution[i], d));
  });
}

test("空の盤面は解が複数", () => {
  assert.equal(solve(new Array(81).fill(0), 2).solutionCount, 2);
});

test("同じ行に同じ数字があればエラー", () => {
  const grid = new Array(81).fill(0);
  grid[0] = grid[1] = 5;
  assert.throws(() => solve(grid), SudokuError);
});

// 解説モードの手順を最後まで進め、各手が正しいこと（置く数字が答えと同じ、消す候補が答えでない、示した理由が成り立つ）を確かめる
const bitOf = (d) => 1 << (d - 1);
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const sorted = (a) => [...a].sort((x, y) => x - y);

function checkSteps(grid) {
  const { solution } = solve(grid);
  const steps = solveSteps(grid, solution);
  const board = grid.slice();
  const erasedSoFar = new Array(81).fill(0); // 先の手で消した候補
  // 盤面の数字と、これまでに消した候補から求めた、各マスの候補
  const candidates = () => board.map((d, i) => (d ? 0 : DIGITS.filter((x) => !PEERS[i].some((p) => board[p] === x)).reduce((m, x) => m | bitOf(x), 0) & ~erasedSoFar[i]));
  for (const s of steps) {
    const cand = candidates(); // この手の前の候補
    if (s.removed) {
      assert.ok(s.removed.length > 0);
      for (const { cell, digits } of s.removed) {
        assert.ok(s.area.includes(cell));
        for (const d of digits) {
          assert.ok(cand[cell] & bitOf(d)); // 候補にある数字を消す
          assert.notEqual(d, solution[cell]); // 答えの数字は消さない
          erasedSoFar[cell] |= bitOf(d);
        }
      }
      const removedCells = s.removed.map((r) => r.cell);
      if (s.technique === "nakedSubset") {
        // cells の候補を合わせると digits だけで、ほかのマスからその数字を消す
        assert.equal(s.cells.length, s.digits.length);
        assert.deepEqual(DIGITS.filter((d) => s.cells.some((c) => cand[c] & bitOf(d))), s.digits);
        assert.ok(removedCells.every((c) => !s.cells.includes(c)));
        assert.ok(s.removed.every((r) => r.digits.every((d) => s.digits.includes(d))));
      } else if (s.technique === "hiddenSubset") {
        // ユニットで digits が入りうるのは cells だけで、cells からほかの候補を消す
        assert.equal(s.cells.length, s.digits.length);
        assert.deepEqual(s.area.filter((c) => s.digits.some((d) => cand[c] & bitOf(d))), s.cells);
        assert.ok(removedCells.every((c) => s.cells.includes(c)));
        assert.ok(s.removed.every((r) => r.digits.every((d) => !s.digits.includes(d))));
      } else {
        assert.ok(["lockedCandidates", "xWing"].includes(s.technique));
        assert.equal(s.digits.length, 1);
        assert.ok(s.cells.every((c) => cand[c] & bitOf(s.digits[0])));
        assert.ok(removedCells.every((c) => !s.cells.includes(c)));
        if (s.technique === "xWing") {
          // 4マスが2行・2列に並ぶ
          assert.equal(s.cells.length, 4);
          assert.equal(new Set(s.cells.map((c) => Math.floor(c / 9))).size, 2);
          assert.equal(new Set(s.cells.map((c) => c % 9)).size, 2);
        }
      }
    } else {
      assert.equal(board[s.cell], 0);
      assert.equal(s.digit, solution[s.cell]);
      assert.ok(cand[s.cell] & bitOf(s.digit));
      if (s.technique === "hiddenSingle") {
        // ユニットで digit が入りうるのはこのマスだけ
        assert.ok(s.area.includes(s.cell));
        assert.deepEqual(s.area.filter((c) => cand[c] & bitOf(s.digit)), [s.cell]);
        assert.deepEqual(s.excluded, s.area.filter((c) => !board[c] && c !== s.cell));
        // ほかの空きマスは、同じ行・列・ブロックに示したマスの digit があるか、先の手で候補から digit を消している
        assert.ok(s.blockers.every((b) => board[b] === s.digit));
        const blocked = s.excluded.filter((c) => s.blockers.some((b) => PEERS[c].includes(b)));
        assert.deepEqual(s.erased, s.excluded.filter((c) => !blocked.includes(c)));
        assert.ok(s.erased.every((c) => erasedSoFar[c] & bitOf(s.digit)));
      } else if (s.technique === "nakedSingle") {
        // 同じ行・列・ブロックにある数字と、先の手で消した候補で、digit 以外の8つの数字がそろう
        assert.equal(cand[s.cell], bitOf(s.digit));
        assert.ok(s.blockers.every((b) => PEERS[s.cell].includes(b)));
        assert.deepEqual(sorted([...s.seen.row, ...s.seen.col, ...s.seen.box]), sorted(s.blockers.map((b) => board[b])));
        assert.ok(s.erased.every((d) => erasedSoFar[s.cell] & bitOf(d)));
        assert.deepEqual(sorted([...s.blockers.map((b) => board[b]), ...s.erased]), DIGITS.filter((d) => d !== s.digit));
      } else {
        assert.equal(s.technique, "answer");
      }
      board[s.cell] = s.digit;
    }
    assert.deepEqual(s.cand, candidates()); // この手の後の候補
  }
  assert.deepEqual(board, solution);
  return steps;
}

test("解説の手順: easy はシングルだけで最後まで解ける", () => {
  const steps = checkSteps(parse(readFileSync(new URL("puzzles/easy.txt", import.meta.url), "utf8")));
  assert.ok(steps.every((s) => s.technique !== "answer"));
  assert.ok(steps.some((s) => s.technique === "hiddenSingle"));
});

test("解説の手順: hard は扱う手筋で進めないので、答えから置いて続ける", () => {
  const steps = checkSteps(parse(readFileSync(new URL("puzzles/hard.txt", import.meta.url), "utf8")));
  assert.equal(steps[0].technique, "answer");
});

// テスト用に乱数で作った問題（解は一意）。4問で、候補を消す手筋をすべて使う
const TECHNIQUE_PUZZLES = [
  "....43.2.4.37....5...2..9.........8..9....3..2.7..14...468.97....25.....8..3.4...",
  ".2..7.8.1..89...........75.....89..2..45...........1.6..726...9.....8.....67..4.5",
  "........6..9.43..2...2.9..778.........2.5.3......1..5....4..87...4.9....8....16.4",
  "...7..368...3.....2....94...8..96.1....5......6.....4.6.29....3.7..3..2.9......51",
];

test("解説の手順: 候補を消す手筋を使えば、答えから置かずに最後まで解ける", () => {
  const used = new Set();
  for (const text of TECHNIQUE_PUZZLES) {
    const steps = checkSteps(parse(text));
    assert.ok(steps.every((s) => s.technique !== "answer"));
    for (const s of steps) {
      if (s.technique === "lockedCandidates") used.add(s.baseKind === "box" ? "pointing" : "claiming");
      else if (s.removed) used.add(`${s.technique}${s.cells.length}`);
    }
  }
  assert.deepEqual([...used].sort(), ["claiming", "hiddenSubset2", "hiddenSubset3", "nakedSubset2", "nakedSubset3", "pointing", "xWing4"]);
});

test("解説の手順: 空きが1つだけのユニットは、ほかの空きマスなしのヒドゥンシングル", () => {
  const { solution } = solve(parse(readFileSync(new URL("puzzles/easy.txt", import.meta.url), "utf8")));
  const grid = solution.slice();
  grid[40] = 0;
  const [step] = checkSteps(grid);
  assert.equal(step.technique, "hiddenSingle");
  assert.equal(step.unitKind, "box");
  assert.deepEqual(step.excluded, []);
  assert.deepEqual(step.blockers, []);
});

test("解説の手順: ヒドゥンシングルがなければネイキッドシングル", () => {
  // 左上のマスと同じ行に 1・2・3、列に 4・5・6、ブロックに 7・8 を置く。左上のマスには 9 しか入らないが、
  // 盤面に 9 がないので、どのユニットでも 9 を置ける場所は1か所に決まらない
  const grid = new Array(81).fill(0);
  [[3, 1], [4, 2], [5, 3], [27, 4], [36, 5], [45, 6], [10, 7], [20, 8]].forEach(([cell, d]) => (grid[cell] = d));
  const [step] = checkSteps(grid);
  assert.equal(step.technique, "nakedSingle");
  assert.equal(step.cell, 0);
  assert.equal(step.digit, 9);
  assert.deepEqual(step.seen, { row: [1, 2, 3], col: [4, 5, 6], box: [7, 8] });
});
