"""数字認識用の見本データ digit_model.npz を作る（一度実行すれば再実行不要）。

手元のフォントで 1〜9 を描画し、大きさ・太さ・傾き・位置を少しずつ変えた見本を作る。
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
    np.savez_compressed(OUT, features=np.array(feats, np.float16), labels=np.array(labels, np.uint8))
    print(f"{OUT} に {len(labels)} 件の見本を保存しました")


if __name__ == "__main__":
    main(sys.argv[1:] or DEFAULT_FONTS)
