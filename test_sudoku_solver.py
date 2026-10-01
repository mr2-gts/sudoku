"""python -m unittest test_sudoku_solver で実行。"""

import unittest
from pathlib import Path

from sudoku_solver import UNITS, SudokuError, parse, solve

HERE = Path(__file__).parent


def is_valid_solution(puzzle, solution):
    if any(p and p != s for p, s in zip(puzzle, solution)):
        return False  # 初期配置が書き換わっている
    return all(sorted(solution[c] for c in u) == list(range(1, 10)) for u in UNITS)


class SolveTest(unittest.TestCase):
    def check(self, name):
        grid = parse((HERE / "puzzles" / name).read_text())
        result = solve(grid, max_solutions=2)
        self.assertEqual(result.solution_count, 1)
        self.assertTrue(is_valid_solution(grid, result.solution))

    def test_easy(self):
        self.check("easy.txt")

    def test_hard(self):
        self.check("hard.txt")

    def test_empty_grid_has_many_solutions(self):
        result = solve([0] * 81, max_solutions=2)
        self.assertEqual(result.solution_count, 2)
        self.assertTrue(is_valid_solution([0] * 81, result.solution))

    def test_no_solution(self):
        # 1行目の空き1マスに入るべき 9 が、同じ列ですでに使われている
        grid = [0] * 81
        grid[0:8] = [1, 2, 3, 4, 5, 6, 7, 8]
        grid[9 * 4 + 8] = 9
        self.assertIsNone(solve(grid).solution)

    def test_duplicate_digits(self):
        grid = [0] * 81
        grid[0] = grid[1] = 5
        with self.assertRaises(SudokuError):
            solve(grid)

    def test_parse_accepts_one_line_and_separators(self):
        one_line = "53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79"
        framed = "\n".join("|" + l + "|" for l in (HERE / "puzzles" / "easy.txt").read_text().split())
        self.assertEqual(parse(one_line), parse(framed))

    def test_parse_wrong_length(self):
        with self.assertRaises(SudokuError):
            parse("123")


if __name__ == "__main__":
    unittest.main()
