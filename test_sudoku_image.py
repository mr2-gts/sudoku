"""python -m unittest test_sudoku_image で実行（opencv / numpy が必要）。

puzzles/images の画像はリポジトリに含めていない（.gitignore で除外）。
合成画像は tools/make_test_images.py で作れる。実際の写真は手元で同じフォルダに置き、
正解を puzzles/<画像名の最初の _ より前>.txt に書いておくと一緒にテストされる。
"""

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from sudoku_image import MAX_SIDE, DigitClassifier, load_gray, read_puzzle
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


if __name__ == "__main__":
    unittest.main()
