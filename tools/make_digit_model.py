"""数字認識用の見本データ digit_model.npz を作る。

手元のフォントで 1〜9 を描画し、大きさ・太さ・傾き・位置を少しずつ変えた見本を作る。
変形で別の数字と同じ形になってしまった見本は除く（drop_inconsistent）。
使い方:
    python tools/make_digit_model.py [フォントファイル ...]      # 見本を作り直す（省略時は DEFAULT_FONTS）
    python tools/make_digit_model.py --add フォントファイル ...  # 今の見本を残し、指定の書体の見本を足す

今の見本は、DEFAULT_FONTS で作った見本に、ADDED_FONTS の見本を --add で足したもの。
作り直しても元と同じ見本にはならない。書体や画像処理ライブラリの版で描画が変わるため（2026-10 に Debian 12 の
同じ書体で作り直したところ、件数は同じでも特徴量はほとんど一致しなかった）。今の写真の読み取り結果を変えないよう、
書体を加えるときは --add で今の見本に足す。
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
# --add で足した書体の記録（コードからは使わない）。Google Fonts の OFL の書体で、2026-10-25 に
# https://github.com/google/fonts/tree/main/ofl から入手し、Debian 12 の python:3.12-slim（opencv-python-headless 5.0.0、
# numpy 2.5.4、Pillow 13.0.0）で足した。上側が平らな 3（「Ʒ」に近い形）を、上の横線が似た 5 と読み誤るため（Issue #15）。
# それまでの見本の 3 は、どれも上側が丸かった。同じ形の 3 を持つ Space Grotesk・Quicksand・Outfit・Josefin Sans は、
# 効果の確認用に見本へ入れていない（6 書体を足した場合は、確認用の書体での正解率が 4 書体のときより下がった）
ADDED_FONTS = ["MPLUS1p-Regular.ttf", "MPLUSRounded1c-Regular.ttf", "Lexend[wght].ttf", "Montserrat[wght].ttf"]
OUT = Path(__file__).resolve().parent.parent / "digit_model.npz"


def render(font_path: str, digit: int, rng: random.Random) -> np.ndarray:
    size = rng.randint(28, 60)
    font = ImageFont.truetype(font_path, size)
    try:
        font.set_variation_by_name("Regular")  # 可変フォントは標準の太さで描く（既定は最も細い太さのことがある）
    except (OSError, ValueError):
        pass  # 可変フォントでない、または Regular がない
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


def drop_inconsistent(feats: np.ndarray, labels: np.ndarray, k: int = 5, min_sim: float = 0.95) -> np.ndarray:
    """別の数字と同じ形になってしまった見本を見つける。

    細い書体を小さく描いて細らせると、4 の斜め線と横線が消えて縦棒だけ残るなど、
    別の数字と同じ形の見本ができる。そのまま残すと、きれいな 1 を 4 と読み間違える原因になる。
    似ている見本 k 件の多数決（DigitClassifier と同じ判定）がラベルと食い違い（ENN）、しかも
    別の数字の見本とほぼ同じ形（類似度 min_sim 以上）の見本だけを除く。食い違うだけの見本まで除くと、
    改善は同じまま、際どいマスの票が動いて読み間違えるマスが増えた（合成画像 216 枚で 1 → 5 マス）。
    戻り値は残す見本を True とする配列。
    """
    f = feats.astype(np.float32)
    sims = f @ f.T
    np.fill_diagonal(sims, -np.inf)  # 自分自身は数えない
    nearest = labels[np.argsort(sims, axis=1)[:, -k:]]
    votes = np.apply_along_axis(np.bincount, 1, nearest, minlength=10)
    other = np.where(labels[:, None] != labels[None, :], sims, -np.inf).max(axis=1)  # 別の数字の見本との最大類似度
    return (votes.argmax(axis=1) == labels) | (other < min_sim)


def make_samples(fonts):
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
    return np.array(feats, np.float16), np.array(labels, np.uint8)


def main(argv):
    if argv[:1] == ["--add"]:
        fonts = argv[1:]
        missing = [f for f in fonts if not Path(f).exists()]
        if not fonts or missing:
            raise SystemExit(f"足す書体のファイルを指定してください（見つからない: {missing}）")
        old = np.load(OUT)
        new_feats, new_labels = make_samples(fonts)
        feats = np.concatenate([old["features"], new_feats])
        labels = np.concatenate([old["labels"], new_labels])
        keep = drop_inconsistent(feats, labels)
        keep[: len(old["labels"])] = True  # 今の見本は除かない（今の写真の読み取り結果を変えないため）
        dropped = len(new_labels) - keep[len(old["labels"]) :].sum()
        message = f"{len(new_labels) - dropped} 件の見本を足し、合計 {keep.sum()} 件にしました（別の数字と同じ形の {dropped} 件を除外）"
    else:
        feats, labels = make_samples(argv or DEFAULT_FONTS)
        keep = drop_inconsistent(feats, labels)
        message = f"{keep.sum()} 件の見本を保存しました（別の数字と同じ形の {(~keep).sum()} 件を除外）"
    np.savez_compressed(OUT, features=feats[keep], labels=labels[keep])
    print(f"{OUT}: {message}")


if __name__ == "__main__":
    main(sys.argv[1:])
