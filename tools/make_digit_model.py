"""数字認識用の見本データ digit_model.npz を作る（一度実行すれば再実行不要）。

手元のフォントで 1〜9 を描画し、大きさ・太さ・傾き・位置を少しずつ変えた見本を作る。
変形で別の数字と同じ形になってしまった見本は除く（drop_inconsistent）。
使い方: python tools/make_digit_model.py [フォントファイル ...]
"""

import random
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from digit_features import normalize_digit, to_feature  # noqa: E402

DEFAULT_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",
    "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansOblique.ttf",
]
OUT = Path(__file__).resolve().parent.parent / "digit_model.npz"


def render(font_path: str, digit: int, rng: random.Random) -> np.ndarray:
    size = rng.randint(28, 60)
    font = ImageFont.truetype(font_path, size)
    img = Image.new("L", (100, 100), 0)
    ImageDraw.Draw(img).text((50, 50), str(digit), fill=255, font=font, anchor="mm")
    img = img.rotate(rng.uniform(-6, 6), resample=Image.BILINEAR)
    a = np.array(img)
    k = rng.choice([0, 0, 1, 2])  # 線の太さを変える
    if k:
        a = cv2.dilate(a, np.ones((k, k), np.uint8)) if rng.random() < 0.6 else cv2.erode(a, np.ones((2, 2), np.uint8))
    a = cv2.resize(a, (rng.randint(20, 50),) * 2)  # 低解像度化
    _, a = cv2.threshold(a, 127, 255, cv2.THRESH_BINARY)
    return a


def drop_inconsistent(feats: np.ndarray, labels: np.ndarray, k: int = 5) -> np.ndarray:
    """似ている見本 k 件の多数決（DigitClassifier と同じ判定）がラベルと食い違う見本を見つける（ENN）。

    細い書体を小さく描いて細らせると、4 の斜め線と横線が消えて縦棒だけ残るなど、
    別の数字と同じ形の見本ができる。そのまま残すと、きれいな 1 を 4 と読み間違える原因になる。
    戻り値は残す見本を True とする配列。
    """
    f = feats.astype(np.float32)
    sims = f @ f.T
    np.fill_diagonal(sims, -np.inf)  # 自分自身は数えない
    nearest = labels[np.argsort(sims, axis=1)[:, -k:]]
    votes = np.apply_along_axis(np.bincount, 1, nearest, minlength=10)
    return votes.argmax(axis=1) == labels


def main(fonts):
    rng = random.Random(0)
    feats, labels = [], []
    for f in fonts:
        if not Path(f).exists():
            continue
        for d in range(1, 10):
            for _ in range(30):
                a = render(f, d, rng)
                if a.any():
                    feats.append(to_feature(normalize_digit(a)))
                    labels.append(d)
    feats, labels = np.array(feats, np.float16), np.array(labels, np.uint8)
    keep = drop_inconsistent(feats, labels)
    np.savez_compressed(OUT, features=feats[keep], labels=labels[keep])
    print(f"{OUT} に {keep.sum()} 件の見本を保存しました（ラベルと形が食い違う {(~keep).sum()} 件を除外）")


if __name__ == "__main__":
    main(sys.argv[1:] or DEFAULT_FONTS)
