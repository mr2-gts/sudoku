"""python -m unittest test_sudoku_image で実行（opencv / numpy が必要）。

puzzles/images の画像はリポジトリに含めていない（.gitignore で除外）。
合成画像は tools/make_test_images.py で作れる。実際の写真は手元で同じフォルダに置き、
正解を puzzles/<画像名の最初の _ より前>.txt に書いておくと一緒にテストされる。
"""

import unittest
from pathlib import Path

from sudoku_image import DigitClassifier, read_puzzle
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


if __name__ == "__main__":
    unittest.main()
