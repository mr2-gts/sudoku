// 解説モード用: 人が使う手筋で、最初の盤面から1手ずつ解く手順を求める
//
// 各空きマスの候補（入りうる数字）を持ち、次の手を、やさしい手筋から順に探す。
// 1. 数字を置く手（シングル）
//    - ヒドゥンシングル … ある行・列・ブロックの中で、その数字が入りうるマスが1か所しかない
//    - ネイキッドシングル … そのマスの候補が1つしか残っていない
// 2. シングルが見つからなければ、候補を消す手（中級の手筋、X-Wing、XY-Wing、ソードフィッシュ、XYZ-Wing、クアッド、ジェリーフィッシュ、
//    チェーン系の W-Wing、シンプルカラーリング、X-Chain）
//    - ロックト・キャンディデート … ブロック（行・列）の中で、その数字が入りうるマスが、1つの行・列（ブロック）との重なりに限られる
//    - ネイキッドペア・トリプル・クアッド … 行・列・ブロックの2〜4マスの候補が、合わせて同じ数の数字しかない
//    - ヒドゥンペア・トリプル・クアッド … 行・列・ブロックの中で、2〜4個の数字が入りうるマスが、同じ数のマスに限られる
//    - X-Wing … 2つの行（列）で、ある数字が入りうるマスがそれぞれ2つだけで、それが同じ2つの列（行）に並ぶ
//    - XY-Wing … 候補が x・y の軸のマスから、候補が x・z と y・z の2つのマス（羽）が見える。軸がどちらでも、羽のどちらかが z になる
//    - ソードフィッシュ … X-Wing を3本に広げたもの。3つの行（列）で、ある数字が入りうるマスが、合わせて3つの列（行）に収まる
//    - XYZ-Wing … XY-Wing の軸の候補が x・y・z の3つになったもの。軸か羽のどれかが z になる
//    - ジェリーフィッシュ … X-Wing を4本に広げたもの
//    チェーン系の手筋は、2つのマスのつながり（リンク）を使う。ある数字が入りうるマスが2つだけの行・列・ブロックの2マスは、
//    どちらかに必ずその数字が入る（強いリンク）。同じ行・列・ブロックの2マスは、両方にその数字が入ることはない（弱いリンク）
//    - W-Wing … 候補が x・y の2つのマスが、x の強いリンクの両端からそれぞれ見える。2つとも x にはなれず、どちらかが y になる
//    - シンプルカラーリング … ある数字の強いリンクでつながったマスを交互に2色に塗ると、どちらかの色のマスがすべてその数字になる
//    - X-Chain … ある数字の強いリンクと弱いリンクを交互にたどると、両端のどちらかにその数字が入る
// クアッドとジェリーフィッシュが必要になる場面はまれ。例えば空きマスが k 個のユニットのヒドゥンクアッドでは、残りの k-4 マスが
// ネイキッドの形になって同じ候補を消せるので、k が8以下なら先にペア・トリプル・クアッドとして見つかる（k=9 のときだけ残る）。
// ジェリーフィッシュも、反対向きのより小さい X-Wing・ソードフィッシュとして先に見つかることが多い
// 3. どれも見つからないときは、答えから1マス埋めて続ける（理由は示せない）。

import { PEERS, UNITS } from "./solver.js?v=af66d12c";

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
// - "nakedSubset" / "hiddenSubset": unitKind（cells の数が2ならペア、3ならトリプル、4ならクアッド）
// - "xWing" / "swordfish" / "jellyfish": baseKind（数字が入りうるマスが限られる行または列。X-Wing は2本、
//   ソードフィッシュは3本、ジェリーフィッシュは4本）、
//   coverKind（候補を消す行または列）
// - "xyWing": pivot（軸のマス）、pincers（2つの羽のマス。1つ目の候補は x・z、2つ目は y・z）。cells は [軸, 羽, 羽]、
//   digits は [x, y, z]（軸の候補 x・y と、消す数字 z）、area は両方の羽から見えるマス（軸を除く）
// - "xyzWing": "xyWing" と同じ項目。軸の候補は x・y・z の3つで、area は軸と両方の羽のすべてから見えるマス
// チェーン系の手は、links（[{ from, to, digit, strong }]: マス from と to の、数字 digit のリンク。strong が true なら強いリンク）も持つ。
// links の両端のマスも手筋の形をつくる（その数字だけ）
// - "wWing": pincers（候補が x・y の2つのマス）、cells は pincers、digits は [x, y]（x はリンクの数字、y は消す数字）、
//   unitKind（強いリンクのユニットの種類）、area は2つのマスの両方から見えるマス。links は [羽 - 強いリンクの端, 強いリンク, 端 - 羽]
// - "simpleColoring": colors（[1色目のマス, 2色目のマス]）、cells は両方の色のマス、digits は [その数字]、
//   links は塗り分けに使った強いリンク、rule（"wrap" か "trap"）。
//   "wrap" は、同じ色のマスが2つある行・列・ブロックがあるので、その色（wrongColor: 0 か 1）のマスから数字を消す。
//   unitKind はそのユニットの種類で、area はそのユニットとその色のマス。
//   "trap" は、両方の色のマスから見えるマス（area）から数字を消す
// - "xChain": cells はチェーンのマスを順に並べたもの、digits は [その数字]、links はその順のリンク（強い・弱いが交互で、両端は強い）、
//   area は両端から見えるマス（チェーンのマスを除く）
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
    findFish(cand, 2) ??
    findXyWing(cand) ??
    findFish(cand, 3) ??
    findXyzWing(cand) ??
    findNakedSubset(cand, 4) ??
    findHiddenSubset(cand, 4) ??
    findFish(cand, 4) ??
    findWWing(cand) ??
    findSimpleColoring(cand) ??
    findXChain(cand)
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

// ユニットの n 個の数字が入りうるマスが合わせて n マスしかなければ、そのマスにはほかの数字は入らない。
// 公開しているのはテストのため（ヒドゥンクアッドが必要な問題はまれで、候補の状態を直接与えて確かめる）
export function findHiddenSubset(cand, n) {
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

// n 本の行で digit が入りうるマスがそれぞれ n 個以下で、それが合わせて n 本の列に収まれば、その n 列の digit は
// これらのマスに入るので、n 列のほかのマスに digit は入らない（行と列を入れ替えても同じ）。n=2 が X-Wing、n=3 がソードフィッシュ
function findFish(cand, n) {
  for (const digit of DIGITS) {
    const bit = bitOf(digit);
    for (const baseStart of [0, 9]) {
      const coverStart = 9 - baseStart;
      const coverOf = (c) => (baseStart === 0 ? c % 9 : Math.floor(c / 9));
      const places = (i) => UNITS[baseStart + i].filter((c) => cand[c] & bit).length;
      const lines = [...Array(9).keys()].filter((i) => places(i) >= 2 && places(i) <= n);
      for (const bases of combinations(lines, n)) {
        const baseCells = bases.flatMap((i) => UNITS[baseStart + i]);
        const cells = baseCells.filter((c) => cand[c] & bit);
        const covers = [...new Set(cells.map(coverOf))];
        if (covers.length !== n) continue;
        const coverCells = covers.flatMap((j) => UNITS[coverStart + j]);
        const removed = removalsOf(cand, coverCells.filter((c) => !cells.includes(c)), bit);
        if (!removed.length) continue;
        return {
          technique: { 2: "xWing", 3: "swordfish", 4: "jellyfish" }[n],
          baseKind: kindOf(baseStart),
          coverKind: kindOf(coverStart),
          cells,
          digits: [digit],
          area: [...new Set([...baseCells, ...coverCells])],
          removed,
        };
      }
    }
  }
  return null;
}

// 候補が x・y の軸のマスから、候補が x・z と y・z の2つの羽のマスが見えれば、軸が x なら1つ目の羽が z、y なら2つ目の羽が z になる。
// どちらでも羽のどちらかに z が入るので、両方の羽から見えるマスに z は入らない
function findXyWing(cand) {
  const pairs = [...Array(81).keys()].filter((c) => popcount(cand[c]) === 2);
  for (const pivot of pairs) {
    const [x, y] = digitsOf(cand[pivot]);
    const wings = pairs.filter((c) => PEERS[pivot].includes(c));
    for (const a of wings) {
      if (!(cand[a] & bitOf(x)) || cand[a] & bitOf(y)) continue; // 1つ目の羽は x と、y でない z
      const zBit = cand[a] & ~bitOf(x);
      for (const b of wings) {
        if (cand[b] !== (bitOf(y) | zBit)) continue; // 2つ目の羽は y と z
        const seen = PEERS[a].filter((c) => c !== pivot && PEERS[b].includes(c));
        const removed = removalsOf(cand, seen, zBit);
        if (!removed.length) continue;
        return { technique: "xyWing", pivot, pincers: [a, b], cells: [pivot, a, b], digits: [x, y, digitsOf(zBit)[0]], area: seen, removed };
      }
    }
  }
  return null;
}

// 候補が x・y・z の軸のマスから、候補が x・z と y・z の2つの羽のマスが見えれば、軸が z ならそのまま、x なら1つ目の羽、
// y なら2つ目の羽が z になる。どれでも軸か羽に z が入るので、軸と両方の羽のすべてから見えるマスに z は入らない
function findXyzWing(cand) {
  const pairs = [...Array(81).keys()].filter((c) => popcount(cand[c]) === 2);
  for (let pivot = 0; pivot < 81; pivot++) {
    if (popcount(cand[pivot]) !== 3) continue;
    const wings = pairs.filter((c) => PEERS[pivot].includes(c) && (cand[c] & ~cand[pivot]) === 0); // 軸の候補のうち2つを持つ
    for (const [a, b] of combinations(wings, 2)) {
      const zBit = cand[a] & cand[b];
      if (popcount(zBit) !== 1 || (cand[a] | cand[b]) !== cand[pivot]) continue; // 羽は z を共有し、合わせて軸の3つの候補になる
      const seen = PEERS[pivot].filter((c) => PEERS[a].includes(c) && PEERS[b].includes(c));
      const removed = removalsOf(cand, seen, zBit);
      if (!removed.length) continue;
      const z = digitsOf(zBit)[0];
      const [x, y] = [cand[a], cand[b]].map((m) => digitsOf(m & ~zBit)[0]);
      return { technique: "xyzWing", pivot, pincers: [a, b], cells: [pivot, a, b], digits: [x, y, z], area: seen, removed };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// チェーン系の手筋
// ---------------------------------------------------------------------------

// 数字 d の強いリンク（行・列・ブロックの中で d が入りうるマスが2つだけのときの、その2マス）を [{ cells: [a, b], unitKind }] で返す。
// 同じ2マスが2つのユニットで組になるとき（同じ行とブロックなど）は、先に調べたユニットで1回だけ返す
function strongLinks(cand, d) {
  const found = new Set();
  const links = [];
  for (const u of SEARCH_ORDER) {
    const cells = UNITS[u].filter((c) => cand[c] & bitOf(d));
    if (cells.length !== 2 || found.has(cells.join())) continue;
    found.add(cells.join());
    links.push({ cells, unitKind: kindOf(u) });
  }
  return links;
}

// 強いリンクの相手（マス → 相手のマスの一覧）
function strongPartners(links) {
  const partners = new Map();
  for (const { cells: [a, b] } of links) {
    partners.set(a, [...(partners.get(a) ?? []), b]);
    partners.set(b, [...(partners.get(b) ?? []), a]);
  }
  return partners;
}

// 候補が x・y の2つのマス（互いに見えない）があり、x の強いリンクの両端が、それぞれのマスから見えるとする。
// 2つのマスがどちらも x なら、リンクの両端のどちらにも x が入らなくなるので、2つとも x にはなれない。
// どちらかは y になるので、両方から見えるマスに y は入らない
function findWWing(cand) {
  const pairs = [...Array(81).keys()].filter((c) => popcount(cand[c]) === 2);
  for (const [i, a] of pairs.entries()) {
    for (const b of pairs.slice(i + 1)) {
      if (cand[a] !== cand[b] || PEERS[a].includes(b)) continue;
      const seen = PEERS[a].filter((c) => PEERS[b].includes(c));
      for (const x of digitsOf(cand[a])) {
        const yBit = cand[a] & ~bitOf(x);
        const removed = removalsOf(cand, seen, yBit);
        if (!removed.length) continue;
        for (const { cells: [p, q], unitKind } of strongLinks(cand, x)) {
          // リンクの端の一方が a から、もう一方が b から見える
          const ends = PEERS[a].includes(p) && PEERS[b].includes(q) ? [p, q] : PEERS[a].includes(q) && PEERS[b].includes(p) ? [q, p] : null;
          if (!ends) continue;
          const links = [
            { from: a, to: ends[0], digit: x, strong: false },
            { from: ends[0], to: ends[1], digit: x, strong: true },
            { from: ends[1], to: b, digit: x, strong: false },
          ];
          return { technique: "wWing", pincers: [a, b], cells: [a, b], digits: [x, digitsOf(yBit)[0]], unitKind, links, area: seen, removed };
        }
      }
    }
  }
  return null;
}

// 数字 d の強いリンクでつながったマスを、交互に2色に塗り分ける。リンクの両端のどちらかに d が入るので、
// どちらかの色のマスがすべて d になる。
// - 同じ色のマスが2つ同じ行・列・ブロックにあれば、その色のマスがすべて d だと矛盾するので、その色のマスから d を消せる（wrap）
// - 両方の色のマスから見えるマスには、どちらにしても d が入らない（trap）
function findSimpleColoring(cand) {
  for (const d of DIGITS) {
    const links = strongLinks(cand, d);
    const partners = strongPartners(links);
    const done = new Set();
    for (const root of [...partners.keys()].sort((m, n) => m - n)) {
      if (done.has(root)) continue;
      // 幅優先で塗り分け、塗るのに使ったリンクを覚える
      const color = new Map([[root, 0]]);
      const used = [];
      for (const queue = [root]; queue.length; ) {
        const c = queue.shift();
        for (const n of partners.get(c)) {
          if (color.has(n)) continue;
          color.set(n, 1 - color.get(c));
          used.push({ from: c, to: n, digit: d, strong: true });
          queue.push(n);
        }
      }
      color.forEach((_, c) => done.add(c));
      const colors = [0, 1].map((k) => [...color.keys()].filter((c) => color.get(c) === k).sort((m, n) => m - n));
      const step = { technique: "simpleColoring", colors, cells: [...colors[0], ...colors[1]], digits: [d], links: used };
      for (const k of [0, 1]) {
        const u = SEARCH_ORDER.find((u) => UNITS[u].filter((c) => color.get(c) === k).length >= 2);
        if (u === undefined) continue;
        const removed = colors[k].map((cell) => ({ cell, digits: [d] }));
        return { ...step, rule: "wrap", wrongColor: k, unitKind: kindOf(u), area: [...new Set([...UNITS[u], ...colors[k]])], removed };
      }
      const seen = [...Array(81).keys()].filter((c) => !color.has(c) && colors.every((g) => g.some((p) => PEERS[c].includes(p))));
      const removed = removalsOf(cand, seen, bitOf(d));
      if (removed.length) return { ...step, rule: "trap", area: seen, removed };
    }
  }
  return null;
}

// 数字 d の強いリンク（=）と弱いリンク（-。同じ行・列・ブロックにある、d が入りうる2マス）を交互にたどる c0 = c1 - c2 = … = cn では、
// c0 が d でなければ c1 が d、すると c2 は d でなく c3 が d … と進み、cn が d になる。どちらにしても両端のどちらかに d が入るので、
// 両端から見えるマスに d は入らない。説明しやすいよう、最も短いチェーンを選ぶ
function findXChain(cand) {
  let best = null;
  for (const d of DIGITS) {
    const bit = bitOf(d);
    const partners = strongPartners(strongLinks(cand, d));
    for (const start of [...partners.keys()].sort((m, n) => m - n)) {
      // 幅優先で、短い順にたどる。状態は「マス×2 + 次にたどるリンク（0: 強い、1: 弱い）」で、prev は1つ前の状態
      const prev = new Map([[start * 2, -1]]);
      let frontier = [start * 2];
      for (let len = 1; frontier.length && (!best || len < best.cells.length - 1); len++) {
        const next = [];
        for (const state of frontier) {
          const c = state >> 1, strong = (state & 1) === 0;
          for (const n of strong ? partners.get(c) ?? [] : PEERS[c].filter((p) => cand[p] & bit)) {
            const to = n * 2 + (strong ? 1 : 0);
            if (prev.has(to)) continue;
            prev.set(to, state);
            next.push(to);
            if (!strong || (best && best.cells.length - 1 <= len)) continue;
            // 強いリンクで終わったので、ここまでのチェーンで消せる候補を調べる
            const cells = [];
            for (let s = to; s >= 0; s = prev.get(s)) cells.unshift(s >> 1);
            // 同じマスを2回通るものは使わない。そのとき、同じ状態を通る別の道は探さずに見送る
            // （幅優先で状態ごとに最短の道だけを覚えるため。見送っても、ほかの始点や長いチェーンで見つかることが多い）
            if (new Set(cells).size !== cells.length) continue;
            const area = PEERS[start].filter((p) => PEERS[n].includes(p) && !cells.includes(p));
            const removed = removalsOf(cand, area, bit);
            if (!removed.length) continue;
            const links = cells.slice(1).map((cell, i) => ({ from: cells[i], to: cell, digit: d, strong: i % 2 === 0 }));
            best = { technique: "xChain", cells, digits: [d], links, area, removed };
          }
        }
        frontier = next;
      }
    }
  }
  return best;
}
