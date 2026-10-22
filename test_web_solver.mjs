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

// 解説モードの手順を最後まで進め、各手の数字が答えと同じで、示した理由が正しいことを確かめる
function checkSteps(grid) {
  const { solution } = solve(grid);
  const steps = solveSteps(grid, solution);
  const board = grid.slice();
  for (const s of steps) {
    assert.equal(board[s.cell], 0);
    assert.equal(s.digit, solution[s.cell]);
    if (s.technique === "hiddenSingle") {
      assert.ok(s.area.includes(s.cell));
      assert.ok(s.area.every((c) => board[c] !== s.digit));
      assert.deepEqual(s.excluded, s.area.filter((c) => !board[c] && c !== s.cell));
      // ほかの空きマスはどれも、同じ行・列・ブロックに示したマスの digit がある
      assert.ok(s.blockers.every((b) => board[b] === s.digit));
      assert.ok(s.excluded.every((c) => s.blockers.some((b) => PEERS[c].includes(b))));
    } else if (s.technique === "nakedSingle") {
      // 同じ行・列・ブロックに、digit 以外の8つの数字がすべてある
      assert.deepEqual(s.blockers.map((b) => board[b]).sort(), [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d !== s.digit));
      assert.ok(s.blockers.every((b) => PEERS[s.cell].includes(b)));
      assert.deepEqual([...s.seen.row, ...s.seen.col, ...s.seen.box].sort(), s.blockers.map((b) => board[b]).sort());
    } else {
      assert.equal(s.technique, "answer");
    }
    board[s.cell] = s.digit;
  }
  assert.deepEqual(board, solution);
  return steps;
}

test("解説の手順: easy はシングルだけで最後まで解ける", () => {
  const steps = checkSteps(parse(readFileSync(new URL("puzzles/easy.txt", import.meta.url), "utf8")));
  assert.ok(steps.every((s) => s.technique !== "answer"));
  assert.ok(steps.some((s) => s.technique === "hiddenSingle"));
});

test("解説の手順: hard はシングルで進めないので、答えから置いて続ける", () => {
  const steps = checkSteps(parse(readFileSync(new URL("puzzles/hard.txt", import.meta.url), "utf8")));
  assert.equal(steps[0].technique, "answer");
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
