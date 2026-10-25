// Web版（docs/）のテスト。node --test で実行する（Node.js 18 以上）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { PEERS, SudokuError, UNITS, parse, solve } from "./docs/solver.js";
import { findHiddenSubset, solveSteps } from "./docs/steps.js";
import { autoCorrect, lookalikeGroups } from "./docs/vision.js";

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

// チェーン系の手（W-Wing、シンプルカラーリング、X-Chain）の理由が成り立つことを確かめる。cand はこの手の前の候補
function checkChain(s, cand) {
  const has = (c, d) => (cand[c] & bitOf(d)) !== 0;
  const sees = (a, b) => PEERS[a].includes(b);
  // 強いリンクは、その数字が入りうるマスが2つだけのユニットの2マス。弱いリンクは、同じユニットにある、その数字が入りうる2マス
  const isStrong = (a, b, d) => UNITS.some((u) => u.includes(a) && u.includes(b) && u.filter((c) => has(c, d)).length === 2);
  for (const { from, to, digit, strong } of s.links) {
    assert.ok(has(from, digit) && has(to, digit) && sees(from, to));
    if (strong) assert.ok(isStrong(from, to, digit));
  }
  const removedCells = s.removed.map((r) => r.cell);
  if (s.technique === "wWing") {
    // 候補が x・y の、互いに見えない2つのマス。x の強いリンクの両端が、それぞれのマスから見える（弱いリンク）。
    // 両方のマスから見えるマスから y だけを消す
    const [x, y] = s.digits;
    const [a, b] = s.pincers;
    assert.deepEqual(s.cells, [a, b]);
    assert.ok(cand[a] === (bitOf(x) | bitOf(y)) && cand[b] === cand[a] && !sees(a, b));
    assert.deepEqual(s.links.map((l) => [l.digit, l.strong]), [[x, false], [x, true], [x, false]]);
    assert.ok(s.links[0].from === a && s.links[1].from === s.links[0].to && s.links[2].from === s.links[1].to && s.links[2].to === b);
    assert.ok(removedCells.every((c) => sees(a, c) && sees(b, c)));
    assert.ok(s.removed.every((r) => r.digits.length === 1 && r.digits[0] === y));
    return;
  }
  const d = s.digits[0];
  assert.equal(s.digits.length, 1);
  assert.ok(s.links.every((l) => l.digit === d));
  assert.ok(s.removed.every((r) => r.digits.length === 1 && r.digits[0] === d));
  if (s.technique === "xChain") {
    // cells を順に、強いリンク・弱いリンクが交互につなぐ（両端は強いリンク）。両端から見えるマス（チェーンのマスを除く）から消す
    const { cells } = s;
    assert.equal(new Set(cells).size, cells.length);
    assert.equal(s.links.length, cells.length - 1);
    assert.equal(s.links.length % 2, 1);
    s.links.forEach((l, i) => assert.ok(l.from === cells[i] && l.to === cells[i + 1] && l.strong === (i % 2 === 0)));
    assert.ok(removedCells.every((c) => !cells.includes(c) && sees(cells[0], c) && sees(cells.at(-1), c)));
    return;
  }
  assert.equal(s.technique, "simpleColoring");
  // 強いリンクでつながったマスを2色に塗り分けている（リンクの両端は別の色で、すべてのマスがつながっている）
  const [first, second] = s.colors;
  assert.deepEqual(sorted(s.cells), sorted([...first, ...second]));
  assert.equal(new Set(s.cells).size, s.cells.length);
  assert.ok(s.links.every((l) => l.strong && first.includes(l.from) !== first.includes(l.to)));
  const reached = new Set([s.cells[0]]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of s.links) {
      if (reached.has(l.from) !== reached.has(l.to)) {
        [l.from, l.to].forEach((c) => reached.add(c));
        grew = true;
      }
    }
  }
  assert.equal(reached.size, s.cells.length);
  if (s.rule === "wrap") {
    // 同じ色のマスが2つある行・列・ブロックがあり、その色のマスすべてから消す
    const wrong = s.colors[s.wrongColor];
    assert.ok(UNITS.some((u) => u.filter((c) => wrong.includes(c)).length >= 2));
    assert.deepEqual(sorted(removedCells), sorted(wrong));
  } else {
    // 両方の色のマスから見えるマスから消す
    assert.equal(s.rule, "trap");
    assert.ok(removedCells.every((c) => !s.cells.includes(c) && s.colors.every((g) => g.some((p) => sees(p, c)))));
  }
}

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
      } else if (s.technique === "xyWing" || s.technique === "xyzWing") {
        // 軸の候補は x・y（XYZ-Wing は x・y・z）、2つの羽は x・z と y・z で、どちらも軸から見える。
        // 両方の羽（XYZ-Wing は軸も）から見えるマスから z だけを消す
        const [x, y, z] = s.digits;
        const [pivot, a, b] = s.cells;
        const xyz = s.technique === "xyzWing";
        assert.equal(s.pivot, pivot);
        assert.deepEqual(s.pincers, [a, b]);
        assert.equal(cand[pivot], bitOf(x) | bitOf(y) | (xyz ? bitOf(z) : 0));
        assert.equal(cand[a], bitOf(x) | bitOf(z));
        assert.equal(cand[b], bitOf(y) | bitOf(z));
        assert.ok(PEERS[pivot].includes(a) && PEERS[pivot].includes(b));
        const watchers = xyz ? [pivot, a, b] : [a, b];
        assert.ok(s.removed.every((r) => watchers.every((c) => PEERS[c].includes(r.cell))));
        assert.ok(s.removed.every((r) => r.digits.length === 1 && r.digits[0] === z));
      } else if (s.links) {
        checkChain(s, cand);
      } else {
        assert.ok(["lockedCandidates", "xWing", "swordfish", "jellyfish"].includes(s.technique));
        assert.equal(s.digits.length, 1);
        assert.ok(s.cells.every((c) => cand[c] & bitOf(s.digits[0])));
        assert.ok(removedCells.every((c) => !s.cells.includes(c)));
        if (s.technique !== "lockedCandidates") {
          // X-Wing は2本、ソードフィッシュは3本、ジェリーフィッシュは4本の行（列）にあるマスが、同じ本数の列（行）に収まる。
          // その行（列）で digit が入りうるマスはすべて cells にあり、候補を消すのは列（行）の、cells の行（列）以外のマス
          const n = { xWing: 2, swordfish: 3, jellyfish: 4 }[s.technique];
          const [baseOf, coverOf] = s.baseKind === "row" ? [(c) => Math.floor(c / 9), (c) => c % 9] : [(c) => c % 9, (c) => Math.floor(c / 9)];
          const bases = new Set(s.cells.map(baseOf)), covers = new Set(s.cells.map(coverOf));
          assert.equal(bases.size, n);
          assert.equal(covers.size, n);
          assert.ok([...Array(81).keys()].every((c) => !bases.has(baseOf(c)) || !(cand[c] & bitOf(s.digits[0])) || s.cells.includes(c)));
          assert.ok(removedCells.every((c) => covers.has(coverOf(c)) && !bases.has(baseOf(c))));
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

// テスト用に乱数で作った問題（解は一意）。11問で、ヒドゥンクアッドとジェリーフィッシュ以外の候補を消す手筋をすべて使う
const TECHNIQUE_PUZZLES = [
  "....43.2.4.37....5...2..9.........8..9....3..2.7..14...468.97....25.....8..3.4...",
  ".2..7.8.1..89...........75.....89..2..45...........1.6..726...9.....8.....67..4.5",
  "........6..9.43..2...2.9..778.........2.5.3......1..5....4..87...4.9....8....16.4",
  "...7..368...3.....2....94...8..96.1....5......6.....4.6.29....3.7..3..2.9......51",
  "7..9..46..91..5.....87.2.....6..7158....3..9..8.....73.24.........2......1.......", // XY-Wing
  "........9..4.137.....6..3.8.52....4..389.......1.8.........6....2..7.19.4......2.", // ソードフィッシュ
  "....5...91.53.7.....9...3....8...2..69.1....4..2.7..61543..2.7...1..4..2...5.....", // XYZ-Wing
  "..9....7..3........4...7.65.......2...14....6.8..3...78..5.....15...4..8.7.2.8..3", // ネイキッドクアッド
  ".72.5....3.16.........7.8...5...4..........42..7.8...9..6...1..1...25...28..1.4..", // X-Chain
  ".5..9.....17...92...8.6.......2.....36...57.....78.1.........914......86.8....3..", // シンプルカラーリング（2種類とも）
  "..7..4235.9......44.....18.9..5.2.....2.7....1...48....2..8..43.3.2....1..9...8.2", // W-Wing
];

test("解説の手順: 候補を消す手筋を使えば、答えから置かずに最後まで解ける", () => {
  const used = new Set();
  for (const text of TECHNIQUE_PUZZLES) {
    const steps = checkSteps(parse(text));
    assert.ok(steps.every((s) => s.technique !== "answer"));
    for (const s of steps) {
      if (s.technique === "lockedCandidates") used.add(s.baseKind === "box" ? "pointing" : "claiming");
      else if (s.technique === "simpleColoring") used.add(`${s.technique}:${s.rule}`);
      else if (s.removed) used.add(s.technique.endsWith("Subset") ? `${s.technique}${s.cells.length}` : s.technique);
    }
  }
  const all = [
    "claiming", "hiddenSubset2", "hiddenSubset3", "nakedSubset2", "nakedSubset3", "nakedSubset4", "pointing",
    "simpleColoring:trap", "simpleColoring:wrap", "swordfish", "wWing", "xChain", "xWing", "xyWing", "xyzWing",
  ];
  assert.deepEqual([...used].sort(), all);
});

test("解説の手順: ジェリーフィッシュも正しく使う", () => {
  // ジェリーフィッシュが必要で、答えから置かずに最後まで解ける問題は、乱数で 20 分探しても見つからなかった（まれなため）。
  // 途中で答えから置く手がある問題で、ジェリーフィッシュを含むすべての手が正しいことを確かめる
  const steps = checkSteps(parse("9....6....1.9....86..85..7..3....1.98.6....2.19...3.......2..6.......5.2..7.6...1"));
  assert.ok(steps.some((s) => s.technique === "jellyfish"));
});

test("解説の手順: ヒドゥンクアッドを見つける", () => {
  // 1行目の9マスがすべて空きで、1〜4 が入りうるのは左の4マスだけ（そこには 5・6 も入りうる）。ほかのマスは空きでない扱い。
  // ヒドゥンクアッドが必要になるのは、空きマスが9つのユニットだけなので、問題からではなく候補の状態を直接与える
  const bits = (...digits) => digits.reduce((m, d) => m | bitOf(d), 0);
  const cand = new Array(81).fill(0);
  for (let c = 0; c < 4; c++) cand[c] = bits(1, 2, 3, 4, 5, 6);
  for (let c = 4; c < 9; c++) cand[c] = bits(5, 6, 7, 8, 9);
  const step = findHiddenSubset(cand, 4);
  assert.equal(step.technique, "hiddenSubset");
  assert.equal(step.unitKind, "row");
  assert.deepEqual(step.cells, [0, 1, 2, 3]);
  assert.deepEqual(step.digits, [1, 2, 3, 4]);
  assert.deepEqual(step.removed, [0, 1, 2, 3].map((cell) => ({ cell, digits: [5, 6] })));
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

// 読み取りの自動修正（Python 版の test_sudoku_image.py の AutoCorrectTest と同じ例）。
// puzzles/easy.txt の数字を読み誤ったことにして試す。マスの番号は 0〜80（行×9+列、0 から数える）。
function misreadEasy(misreads, lookalike = new Array(81).fill(-1)) {
  const truth = parse(readFileSync(new URL("puzzles/easy.txt", import.meta.url), "utf8"));
  const grid = truth.slice(), alternatives = [...Array(81)].map(() => []);
  for (const [cell, digit, alts] of misreads) (grid[cell] = digit), (alternatives[cell] = alts);
  return { truth, grid, alternatives, lookalike };
}

test("自動修正: 読み誤った数字を、ほかの候補の数字に直す", () => {
  const { truth, grid, alternatives, lookalike } = misreadEasy([[25, 1, [6]]]); // 3行8列の 6 を 1 と読んだ
  assert.deepEqual(autoCorrect(grid, alternatives, lookalike), { grid: truth, cells: [25] });
});

test("自動修正: どちらの数字に直しても解がちょうど1つになるときは、直さない", () => {
  const { grid, alternatives, lookalike } = misreadEasy([[25, 1, [5, 6]]]);
  assert.equal(autoCorrect(grid, alternatives, lookalike), null);
});

test("自動修正: 形の似たマスは、まとめて直す", () => {
  // 1行5列と 9行8列の 7 を、どちらも 1 と読んだ。1行5列だけを 7 に直しても解がちょうど 1 つになるが、9行8列は 1 のまま
  const lookalike = new Array(81).fill(-1);
  (lookalike[4] = 79), (lookalike[79] = 4);
  const { truth, grid, alternatives } = misreadEasy([[4, 1, [7]], [79, 1, [7]]], lookalike);
  assert.deepEqual(lookalikeGroups(grid, lookalike).find((g) => g.includes(4)), [4, 79]);
  assert.deepEqual(autoCorrect(grid, alternatives, lookalike), { grid: truth, cells: [4, 79] });
  // 形の似たマスがわからなければ、1 つだけ直した盤面と 2 つとも直した盤面のどちらかに決められない
  assert.equal(autoCorrect(grid, alternatives, new Array(81).fill(-1)), null);
});

test("自動修正: 置き換えを1つ増やしても解がちょうど1つになるときは、直さない", () => {
  // 6行1列の 7 を 8、6行5列の 2 を 5 と読んだ。6行1列だけを直しても解がちょうど 1 つになるが、6行5列は誤ったまま
  const { grid, alternatives, lookalike } = misreadEasy([[45, 8, [7]], [49, 5, [2]]]);
  assert.equal(autoCorrect(grid, alternatives, lookalike), null);
});

test("自動修正: 解がちょうど1つの盤面と、数字が17個未満の盤面は直さない", () => {
  const { truth, alternatives, lookalike } = misreadEasy([[25, 6, [5]]]);
  assert.equal(autoCorrect(truth, alternatives, lookalike), null);
  const sparse = new Array(81).fill(0);
  truth.map((d, i) => (d ? i : -1)).filter((i) => i >= 0).slice(0, 16).forEach((i) => (sparse[i] = truth[i]));
  assert.equal(autoCorrect(sparse, alternatives, lookalike), null);
});

// ページが読み込むファイルの URL の版（?v=）は、そのファイルの中身の SHA-256 の先頭 8 桁（tools/stamp_web_versions.py が付ける）。
// docs/ のファイルを変えて版を付け直し忘れると、ブラウザが古いファイルを使い続け、新旧が混ざってページが動かなくなる
test("docs/ が読み込むファイルの版が、そのファイルの中身と一致する", () => {
  const docs = new URL("docs/", import.meta.url);
  const ref = /(["'])(\.\/)?([\w.-]+\.(?:js|css|gz))(?:\?v=([0-9a-f]+))?\1/g; // tools/stamp_web_versions.py の REF と同じ
  let count = 0;
  for (const name of readdirSync(docs).filter((n) => /\.(html|js)$/.test(n))) {
    for (const [, , , target, v] of readFileSync(new URL(name, docs), "utf8").matchAll(ref)) {
      if (!existsSync(new URL(target, docs))) continue;
      const expected = createHash("sha256").update(readFileSync(new URL(target, docs))).digest("hex").slice(0, 8);
      assert.equal(v, expected, `${name} が読み込む ${target} の版が古い（python tools/stamp_web_versions.py を実行する）`);
      count++;
    }
  }
  assert.ok(count >= 10); // 読み込みの書き方が変わって見つけられなくなっていないか
});
