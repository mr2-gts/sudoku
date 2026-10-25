"""python -m unittest test_sudoku_image で実行（opencv / numpy が必要）。

puzzles/images の画像はリポジトリに含めていない（.gitignore で除外）。
合成画像は tools/make_test_images.py で作れる。実際の写真は手元で同じフォルダに置き、
正解を puzzles/<画像名の最初の _ より前>.txt に書いておくと一緒にテストされる。
"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

import sudoku_image
from sudoku_image import MAX_SIDE, DigitClassifier, _lookalikes, auto_correct, load_gray, read_puzzle
from sudoku_solver import parse

PUZZLES = Path(__file__).parent / "puzzles"


class ReadPuzzleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clf = DigitClassifier()

    def test_all_sample_images(self):
        folder = PUZZLES / "images"
        images = sorted(p for p in folder.glob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg") and "_answer" not in p.name)
        if not images:  # 画像はリポジトリに含めないため、手元にないときは飛ばす
            self.skipTest(f"{folder} にテスト画像がありません（tools/make_test_images.py で作成できます）")
        for path in images:
            with self.subTest(image=path.name):
                truth = parse((PUZZLES / f"{path.name.split('_')[0]}.txt").read_text())
                self.assertEqual(read_puzzle(path, self.clf).grid, truth)


class LoadGrayTest(unittest.TestCase):
    """読み込む画像の大きさのそろえ方（Web 版の loadGray と同じ）。

    大きな写真を大きいまま処理すると、画面のモアレなどで盤面の外枠が途切れ、盤面の位置を取り違えることがあった
    （Issue #18。実際の写真でのみ起き、合成画像では再現できなかったため、縮小することそのものを確かめる）。
    """

    def load(self, w, h):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "画像.png"  # 日本語のファイル名でも読めること
            cv2.imencode(".png", np.full((h, w), 200, np.uint8))[1].tofile(str(path))
            return load_gray(path)

    def test_large_image_is_reduced_to_max_side(self):
        self.assertEqual(self.load(4000, 3000).shape, (900, MAX_SIDE))  # (高さ, 幅)
        self.assertEqual(self.load(3000, 4000).shape, (MAX_SIDE, 900))

    def test_medium_image_is_unchanged(self):
        self.assertEqual(self.load(MAX_SIDE, 800).shape, (800, MAX_SIDE))
        self.assertEqual(self.load(600, 400).shape, (400, 600))

    def test_small_image_is_enlarged(self):
        self.assertEqual(self.load(200, 150).shape, (300, 400))


class AutoCorrectTest(unittest.TestCase):
    """読み取りの自動修正（Web 版の autoCorrect も test_web_solver.mjs で同じ例を確かめる）。

    puzzles/easy.txt の数字を読み誤ったことにして試す。マスの番号は 0〜80（行×9+列、0 から数える）。
    """

    def setUp(self):
        self.truth = parse((PUZZLES / "easy.txt").read_text())
        self.alternatives = [[] for _ in range(81)]
        self.lookalike = [-1] * 81

    def misread(self, cell, digit, alternatives):
        grid = self.truth[:]
        grid[cell] = digit
        self.alternatives[cell] = alternatives
        return grid

    def test_corrects_a_misread_digit(self):
        grid = self.misread(25, 1, [6])  # 3行8列の 6 を 1 と読み、ほかの候補が 6
        self.assertEqual(auto_correct(grid, self.alternatives, self.lookalike), (self.truth, [25]))

    def test_does_not_correct_when_two_digits_both_work(self):
        grid = self.misread(25, 1, [5, 6])  # 5 に直しても 6 に直しても、解がちょうど 1 つになる
        self.assertIsNone(auto_correct(grid, self.alternatives, self.lookalike))

    def test_corrects_lookalike_cells_together(self):
        # 1行5列と 9行8列の 7 を、どちらも 1 と読んだ。1行5列だけを 7 に直しても解がちょうど 1 つになるが、
        # 9行8列は 1 のまま（違う答え）。形が似ていれば、まとめて直す
        grid = self.misread(4, 1, [7])
        grid[79] = 1
        self.alternatives[79] = [7]
        self.lookalike[4], self.lookalike[79] = 79, 4
        self.assertEqual(auto_correct(grid, self.alternatives, self.lookalike), (self.truth, [4, 79]))
        # 形の似たマスがわからなければ、1 つだけ直した盤面と 2 つとも直した盤面のどちらかに決められない
        self.lookalike[4] = self.lookalike[79] = -1
        self.assertIsNone(auto_correct(grid, self.alternatives, self.lookalike))

    def test_does_not_correct_when_one_more_fix_also_works(self):
        # 6行1列の 7 を 8、6行5列の 2 を 5 と読んだ。6行1列だけを直しても解がちょうど 1 つになるが、6行5列は誤ったまま。
        # 置き換えを 1 つ増やした盤面（正しい盤面）も解がちょうど 1 つになるので、決めない
        grid = self.misread(45, 8, [7])
        grid[49] = 5
        self.alternatives[49] = [2]
        self.assertIsNone(auto_correct(grid, self.alternatives, self.lookalike))

    def test_does_not_correct_a_valid_or_too_sparse_grid(self):
        self.alternatives[25] = [5]
        self.assertIsNone(auto_correct(self.truth, self.alternatives, self.lookalike))  # 解がちょうど 1 つの盤面
        sparse = [0] * 81
        for i in [i for i in range(81) if self.truth[i]][:16]:
            sparse[i] = self.truth[i]
        self.assertIsNone(auto_correct(sparse, self.alternatives, self.lookalike))  # 数字が 17 個未満

    def test_gives_up_when_there_are_too_many_trials(self):
        grid = self.misread(25, 1, [6])
        with mock.patch.object(sudoku_image, "MAX_TRIALS", 0):
            self.assertIsNone(auto_correct(grid, self.alternatives, self.lookalike))


class LookalikeTest(unittest.TestCase):
    def test_most_similar_digit_cell(self):
        unit = lambda *v: np.array(v, np.float32) / np.linalg.norm(v)
        result = _lookalikes({0: unit(1, 0, 0), 5: unit(0.9, 0.1, 0), 9: unit(0, 0, 1)})
        self.assertEqual((result[0], result[5], result[9]), (5, 0, 0))
        self.assertEqual(result.count(-1), 78)  # 空きのマス
        self.assertEqual(_lookalikes({3: unit(1, 0, 0)})[3], -1)  # ほかに数字がない


if __name__ == "__main__":
    unittest.main()
