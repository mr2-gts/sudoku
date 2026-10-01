"""9x9 数独ソルバー（Python 標準ライブラリのみ）

使い方:
    python sudoku_solver.py puzzle.txt      # ファイルから読み込み
    python sudoku_solver.py < puzzle.txt    # 標準入力から読み込み
    python sudoku_solver.py --check puzzle.txt  # 解が一意かも確認

入力形式:
    1〜9 は数字、空きマスは 0 または "." 。
    数字と "." "0" 以外の文字（空白・改行・区切り線 | - + など）は無視するので、
    9行×9文字でも、81文字の1行でも読み込める。

アルゴリズム:
    1. 制約伝播 … 候補が1つしかないマス（naked single）と、
       行・列・ブロック内でその数字を置ける場所が1か所しかないマス（hidden single）を
       確定できなくなるまで繰り返し埋める。
    2. バックトラック … 伝播で埋まらなければ、候補数が最も少ないマス（MRV）を選び、
       候補を1つずつ仮置きして 1. からやり直す。矛盾したら元に戻して次の候補へ。
    候補は 9bit のビットマスク（bit0=数字1 … bit8=数字9）で持つ。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass

SIZE = 9
CELLS = SIZE * SIZE
ALL = (1 << SIZE) - 1  # 0b111111111 = 1〜9 すべて候補


# ---------------------------------------------------------------------------
# 盤面の幾何（起動時に1回だけ計算する静的な表）
# ---------------------------------------------------------------------------
def _build_units() -> tuple[list[list[int]], list[list[int]]]:
    """27個のユニット（行9・列9・ブロック9）と、各マスの「同じユニットに属する他のマス」を作る。"""
    rows = [[r * 9 + c for c in range(9)] for r in range(9)]
    cols = [[r * 9 + c for r in range(9)] for c in range(9)]
    boxes = [
        [(br * 3 + r) * 9 + (bc * 3 + c) for r in range(3) for c in range(3)]
        for br in range(3)
        for bc in range(3)
    ]
    units = rows + cols + boxes
    peers = [sorted({p for u in units if i in u for p in u} - {i}) for i in range(CELLS)]
    return units, peers


UNITS, PEERS = _build_units()


def _bit(digit: int) -> int:
    return 1 << (digit - 1)


def _digit(bit: int) -> int:
    return bit.bit_length()


# ---------------------------------------------------------------------------
# 入出力
# ---------------------------------------------------------------------------
class SudokuError(ValueError):
    """入力不正・矛盾など、解けない理由を表す例外。"""


def parse(text: str) -> list[int]:
    """テキストを 81 要素の list[int] に変換する（0 = 空き）。"""
    cells = [0 if ch == "." else int(ch) for ch in text if ch.isdigit() or ch == "."]
    if len(cells) != CELLS:
        raise SudokuError(f"マスの数が {len(cells)} 個です（81 個必要）")
    return cells


def format_grid(grid: list[int]) -> str:
    """81 要素の盤面を 3x3 区切り付きの文字列にする。"""
    lines = []
    for r in range(9):
        if r in (3, 6):
            lines.append("------+-------+------")
        row = [str(grid[r * 9 + c] or ".") for c in range(9)]
        lines.append(" | ".join(" ".join(row[i : i + 3]) for i in (0, 3, 6)))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# ソルバー本体
# ---------------------------------------------------------------------------
@dataclass
class Result:
    solution: list[int] | None  # 最初に見つかった解（なければ None）
    solution_count: int  # 見つかった解の数（max_solutions で打ち切り）
    guesses: int  # 仮置きした回数（難しさの目安）


class _Contradiction(Exception):
    pass


def _assign(cand: list[int], cell: int, bit: int) -> None:
    """cell を bit の数字に確定し、制約伝播を行う。矛盾したら _Contradiction。

    cand は各マスの候補ビットマスク。確定済みのマスは 1bit だけ立っている。
    """
    stack = [(cell, bit)]
    while stack:
        cell, bit = stack.pop()
        if not cand[cell] & bit:
            raise _Contradiction
        cand[cell] = bit  # 既に確定済みでも周りへの反映は行う（同じ消去を繰り返しても無害）
        # naked single: 周りのマスからこの数字を消す。候補が1つになったら確定させる
        for p in PEERS[cell]:
            if cand[p] & bit:
                cand[p] &= ~bit
                if cand[p] == 0:
                    raise _Contradiction
                if cand[p] & (cand[p] - 1) == 0:  # 1bit だけ = 候補が1つ
                    stack.append((p, cand[p]))
    _hidden_singles(cand)


def _hidden_singles(cand: list[int]) -> None:
    """hidden single: ユニット内である数字を置けるマスが1つしかなければ確定させる。"""
    changed = True
    while changed:
        changed = False
        for unit in UNITS:
            seen_once = seen_twice = 0
            for c in unit:
                seen_twice |= seen_once & cand[c]
                seen_once |= cand[c]
            if seen_once != ALL:
                raise _Contradiction  # どこにも置けない数字がある
            only_once = seen_once & ~seen_twice
            if not only_once:
                continue
            for c in unit:
                b = cand[c] & only_once
                if b and cand[c] != b:
                    if b & (b - 1):
                        raise _Contradiction  # 1マスに「ここしかない」数字が2つ
                    _assign(cand, c, b)
                    changed = True


def _initial_candidates(grid: list[int]) -> list[int]:
    cand = [ALL] * CELLS
    for i, d in enumerate(grid):
        if d:
            if cand[i] & _bit(d) == 0:
                raise SudokuError(f"初期配置が矛盾しています（{i // 9 + 1}行{i % 9 + 1}列の {d}）")
            try:
                _assign(cand, i, _bit(d))
            except _Contradiction:
                raise SudokuError("初期配置の時点で矛盾しています") from None
    return cand


def solve(grid: list[int], max_solutions: int = 1) -> Result:
    """盤面を解く。max_solutions=2 にすると解の一意性を判定できる。"""
    if len(grid) != CELLS or any(not 0 <= d <= 9 for d in grid):
        raise SudokuError("盤面は 0〜9 の数字 81 個で指定してください")

    # 初期配置そのものに同じ数字の重複がないか（伝播より先に分かりやすく報告する）
    for unit in UNITS:
        digits = [grid[c] for c in unit if grid[c]]
        if len(digits) != len(set(digits)):
            raise SudokuError("同じ行・列・ブロックに同じ数字があります")

    try:
        cand = _initial_candidates(grid)
    except SudokuError:
        return Result(None, 0, 0)

    solutions: list[list[int]] = []
    guesses = 0

    def search(cand: list[int]) -> None:
        nonlocal guesses
        # MRV: 未確定マスのうち候補が最も少ないものを選ぶ
        best, best_count = -1, 10
        for i, m in enumerate(cand):
            n = m.bit_count()
            if 1 < n < best_count:
                best, best_count = i, n
                if n == 2:
                    break
        if best == -1:  # 全マス確定
            solutions.append([_digit(m) for m in cand])
            return
        m = cand[best]
        while m and len(solutions) < max_solutions:
            bit = m & -m  # 最下位ビット = 最小の候補
            m &= m - 1
            guesses += 1
            trial = cand.copy()
            try:
                _assign(trial, best, bit)
            except _Contradiction:
                continue
            search(trial)

    search(cand)
    return Result(solutions[0] if solutions else None, len(solutions), guesses)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: list[str]) -> int:
    check = "--check" in argv
    args = [a for a in argv if a != "--check"]
    text = open(args[0], encoding="utf-8").read() if args else sys.stdin.read()

    try:
        grid = parse(text)
        result = solve(grid, max_solutions=2 if check else 1)
    except SudokuError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 2

    print("問題:")
    print(format_grid(grid))
    print()
    if result.solution is None:
        print("解がありません。")
        return 1
    print("解答:")
    print(format_grid(result.solution))
    print(f"\n仮置き回数: {result.guesses}")
    if check:
        print("解は一意です。" if result.solution_count == 1 else "解が複数あります（最初の1つを表示）。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
