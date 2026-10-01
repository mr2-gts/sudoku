"""テスト用の問題画像を作る（学習に使っていないフォントで描画する）。

- *_clean.png  … スクリーンショット相当（真上・きれい）
- *_photo.jpg  … 写真相当（斜め・回転・影・ぼけ・ノイズ・余白あり）
"""

import random
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from sudoku_solver import parse  # noqa: E402

TEST_FONTS = {
    "loma": "/usr/share/fonts/opentype/tlwg/Loma.otf",
    "zenhei": "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "serifitalic": "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
}


def draw_clean(grid, font_path, cell=60):
    size = cell * 9 + 40
    img = Image.new("L", (size, size), 255)
    d = ImageDraw.Draw(img)
    o = 20
    for i in range(10):
        w = 4 if i % 3 == 0 else 1
        p = o + i * cell
        d.line([(o, p), (o + 9 * cell, p)], fill=0, width=w)
        d.line([(p, o), (p, o + 9 * cell)], fill=0, width=w)
    font = ImageFont.truetype(font_path, int(cell * 0.65))
    for i, v in enumerate(grid):
        if v:
            r, c = divmod(i, 9)
            d.text((o + c * cell + cell / 2, o + r * cell + cell / 2), str(v), fill=30, font=font, anchor="mm")
    return np.array(img)


def to_photo(clean, seed):
    rng = np.random.default_rng(seed)
    h, w = clean.shape
    canvas = np.full((h + 300, w + 300), 200, np.uint8)  # 机の上に置いた紙のつもり
    canvas[150 : 150 + h, 150 : 150 + w] = clean
    H, W = canvas.shape
    src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    jitter = rng.uniform(-60, 60, (4, 2)).astype(np.float32)
    m = cv2.getPerspectiveTransform(src, src + jitter)
    img = cv2.warpPerspective(canvas, m, (W, H), borderValue=170)
    rot = cv2.getRotationMatrix2D((W / 2, H / 2), rng.uniform(-8, 8), 1.0)
    img = cv2.warpAffine(img, rot, (W, H), borderValue=170)
    shade = np.linspace(0.65, 1.0, W)[None, :] * np.linspace(0.8, 1.0, H)[:, None]  # 影
    img = (img * shade).astype(np.float32)
    img += rng.normal(0, 8, img.shape)
    img = cv2.GaussianBlur(np.clip(img, 0, 255).astype(np.uint8), (3, 3), 0)
    return cv2.resize(img, (int(W * 0.8), int(H * 0.8)))


def main():
    out = ROOT / "puzzles" / "images"
    out.mkdir(parents=True, exist_ok=True)
    puzzles = {n: parse((ROOT / "puzzles" / f"{n}.txt").read_text()) for n in ("easy", "hard")}
    seed = 0
    for pname, grid in puzzles.items():
        for fname, fpath in TEST_FONTS.items():
            clean = draw_clean(grid, fpath)
            cv2.imwrite(str(out / f"{pname}_{fname}_clean.png"), clean)
            cv2.imwrite(str(out / f"{pname}_{fname}_photo.jpg"), to_photo(clean, seed), [cv2.IMWRITE_JPEG_QUALITY, 80])
            seed += 1
    print(f"{out} に画像を保存しました")


if __name__ == "__main__":
    main()
