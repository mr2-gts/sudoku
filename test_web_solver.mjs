// Web版（docs/solver.js）のテスト。node --test で実行する（Node.js 18 以上）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SudokuError, parse, solve } from "./docs/solver.js";

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
