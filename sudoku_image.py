"""画像の数独を読み取って解く。

使い方:
    python sudoku_image.py 問題.png               # 解答をテキストで表示する（ファイルは保存しない）
    python sudoku_image.py 問題.jpg -o 解答.png    # 解答画像も保存したいときだけ指定

処理の流れ:
    1. 盤面検出 … 画像を2値化し、いちばん大きい四角形を盤面とみなす。
       斜めに写った写真でも、四隅を使って真上から見た正方形に補正する。
    2. マス分割 … 補正した盤面を 9x9 に等分する。
    3. 数字認識 … 各マスの中央付近にある黒い塊を数字とみなし、見本データ
       （digit_model.npz）と形を比べていちばん近い数字を選ぶ（k近傍法）。塊がなければ空き。
    4. 解く   … sudoku_solver.solve で解く。
    5. 出力   … 解答をテキストで表示する。-o を指定したときだけ解答画像
       （元の数字=黒、埋めた数字=青）を保存する。問題や画像は保存しない。
       読み取りを誤って解けなかった場合は、表示された読み取り結果を直してテキストファイルにし、
       `python sudoku_solver.py 問題.txt` で解ける。

必要なライブラリ: opencv-python-headless, numpy
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from digit_features import normalize_digit, to_feature
from sudoku_solver import SudokuError, format_grid, solve

CELL = 50  # 補正後の1マスのピクセル数
BOARD = CELL * 9
MODEL_PATH = Path(__file__).with_name("digit_model.npz")
MIN_CONTRAST = 45  # 数字とみなす濃さの下限（背景の明るさとの差、0〜255）。写真の数字は 60 以上、ノイズは 40 以下だった
WEAK_CONTRAST_RATIO = 0.25  # 数字の濃い部分の何割の濃さまでを、つながった線として数字に含めるか
WEAK_CONTRAST_MIN = 15  # 同上の下限（背景の明るさとの差）


class ImageReadError(Exception):
    """画像から盤面を読み取れなかったときの例外。"""


# ---------------------------------------------------------------------------
# 1. 盤面検出
# ---------------------------------------------------------------------------
def _binarize(gray: np.ndarray) -> np.ndarray:
    """影や明るさのムラに強い適応的2値化。線・数字が白（255）、背景が黒（0）になる。"""
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    block = max(11, (min(gray.shape) // 30) | 1)  # 画像サイズに応じた奇数
    return cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 7)


def _order_corners(pts: np.ndarray) -> np.ndarray:
    """点の集まりから 左上・右上・右下・左下 の4点を選ぶ（x+y と y-x の最大・最小）。"""
    pts = pts.reshape(-1, 2).astype(np.float32)
    s, d = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
    return np.array([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]])


def find_board(gray: np.ndarray) -> np.ndarray:
    """盤面の四隅を返す。四角形が見つからなければ画像全体を盤面とみなす。"""
    binary = _binarize(gray)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = gray.shape[0] * gray.shape[1]
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        if cv2.contourArea(c) < img_area * 0.2:
            break
        hull = cv2.convexHull(c)
        approx = cv2.approxPolyDP(hull, 0.02 * cv2.arcLength(hull, True), True)
        if len(approx) == 4:
            return _order_corners(approx)
        # 盤面の端が写真の縁に接している・ほかの線とつながっている等で4角形にならないときは、
        # 輪郭上の点から四隅（x+y や x-y が最大・最小の点）を直接選ぶ
        return _order_corners(hull)
    h, w = gray.shape
    return np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)


def warp_board(gray: np.ndarray, corners: np.ndarray) -> np.ndarray:
    dst = np.array([[0, 0], [BOARD - 1, 0], [BOARD - 1, BOARD - 1], [0, BOARD - 1]], np.float32)
    m = cv2.getPerspectiveTransform(corners, dst)
    return cv2.warpPerspective(gray, m, (BOARD, BOARD))


# ---------------------------------------------------------------------------
# 2〜3. マス分割と数字認識
# ---------------------------------------------------------------------------
class DigitClassifier:
    """見本データとの距離で数字を判定する k 近傍法。"""

    def __init__(self, path: Path = MODEL_PATH, k: int = 5):
        data = np.load(path)
        self.features = data["features"].astype(np.float32)
        self.labels = data["labels"]
        self.k = k

    def predict(self, norm: np.ndarray) -> tuple[int, float]:
        """(数字, 確からしさ 0〜1) を返す。確からしさ = 近傍 k 件のうち同じ数字の割合。"""
        sims = self.features @ to_feature(norm)  # 正規化済みベクトルの内積 = コサイン類似度
        nearest = self.labels[np.argsort(sims)[-self.k :]]
        votes = np.bincount(nearest, minlength=10)
        digit = int(votes.argmax())
        return digit, votes[digit] / self.k


def extract_digit(cell_bin: np.ndarray, cell_gray: np.ndarray) -> np.ndarray | None:
    """1マス分の2値画像から数字部分だけを取り出す。数字がなければ None。

    次の条件を満たす塊を数字の一部とみなし、まとめて1つの数字にする。
    - 罫線ではない（マスの幅・高さいっぱいに伸びていない）
    - マスの中央付近にある（縁に残る罫線の切れ端を避ける）
    - 背景よりはっきり濃い（画面のモアレや紙のざらつきは薄いので除外できる）
    細い書体では1つの数字がいくつかの塊に分かれることがあるため、塊をまとめてから大きさを判定する。
    """
    h, w = cell_bin.shape
    n, labels, stats, cents = cv2.connectedComponentsWithStats(cell_bin, 8)
    background = float(np.median(cell_gray))
    keep = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        cx, cy = cents[i]
        if area < 8 or bw > w * 0.9 or bh > h * 0.95:
            continue  # ごく小さい点・罫線
        if not (w * 0.15 < cx < w * 0.85 and h * 0.15 < cy < h * 0.85):
            continue  # 中央から外れている
        if background - float(cell_gray[labels == i].mean()) < MIN_CONTRAST:
            continue  # 薄いノイズ
        keep.append(i)
    if not keep:
        return None
    seed = np.isin(labels, keep)
    ys, xs = np.nonzero(seed)
    if ys.max() - ys.min() + 1 < h * 0.3 or seed.sum() < h * w * 0.02:
        return None  # 数字にしては小さすぎる（数字かどうかは、はっきり濃い部分だけで判定する）
    # 細い線（4 の斜め線など）は2値化で消えたり途切れたりしやすいので、はっきり濃い塊を起点に、
    # それとつながる「やや薄い」画素まで数字の範囲を広げる（ヒステリシスしきい値処理）。
    contrast = background - cell_gray.astype(np.float32)
    peak = float(np.percentile(contrast[seed], 90))
    weak = (contrast >= max(WEAK_CONTRAST_MIN, peak * WEAK_CONTRAST_RATIO)) | seed
    _, grown = cv2.connectedComponents(weak.astype(np.uint8), connectivity=8)
    mask = np.isin(grown, np.unique(grown[seed]))
    return np.where(mask, 255, 0).astype(np.uint8)


@dataclass
class Reading:
    grid: list[int]  # 読み取った盤面（0=空き）
    confidence: list[float]  # マスごとの確からしさ（空きは 1.0）
    board: np.ndarray  # 補正後の盤面画像（グレースケール）


def read_puzzle(image_path: str | Path, classifier: DigitClassifier | None = None) -> Reading:
    data = np.fromfile(str(image_path), np.uint8)  # 日本語のファイル名でも読めるようにする
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ImageReadError(f"画像を開けません: {image_path}")
    if max(img.shape) < 300:  # 小さい画像は拡大してから処理する
        img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)

    board = warp_board(img, find_board(img))
    binary = _binarize(board)
    clf = classifier or DigitClassifier()

    grid, conf = [], []
    m = CELL // 10  # 罫線を避ける余白
    for r in range(9):
        for c in range(9):
            ys, xs = slice(r * CELL + m, (r + 1) * CELL - m), slice(c * CELL + m, (c + 1) * CELL - m)
            digit_img = extract_digit(binary[ys, xs], board[ys, xs])
            if digit_img is None:
                grid.append(0)
                conf.append(1.0)
            else:
                d, p = clf.predict(normalize_digit(digit_img))
                grid.append(d)
                conf.append(p)
    return Reading(grid, conf, board)


# ---------------------------------------------------------------------------
# 5. 出力
# ---------------------------------------------------------------------------
def render_answer(puzzle: list[int], solution: list[int]) -> np.ndarray:
    """解答画像を作る。元の数字は黒、埋めた数字は青。"""
    size = CELL * 9 + 20
    img = np.full((size, size, 3), 255, np.uint8)
    o = 10
    for i in range(10):
        t = 3 if i % 3 == 0 else 1
        p = o + i * CELL
        cv2.line(img, (o, p), (o + 9 * CELL, p), (0, 0, 0), t)
        cv2.line(img, (p, o), (p, o + 9 * CELL), (0, 0, 0), t)
    for i, d in enumerate(solution):
        r, c = divmod(i, 9)
        color = (0, 0, 0) if puzzle[i] else (200, 80, 0)  # BGR: 青
        (tw, th), _ = cv2.getTextSize(str(d), cv2.FONT_HERSHEY_SIMPLEX, 1.1, 2)
        x = o + c * CELL + (CELL - tw) // 2
        y = o + r * CELL + (CELL + th) // 2
        cv2.putText(img, str(d), (x, y), cv2.FONT_HERSHEY_SIMPLEX, 1.1, color, 2, cv2.LINE_AA)
    return img


def _save_png(path: Path, img: np.ndarray) -> None:
    ok, buf = cv2.imencode(".png", img)
    if ok:
        buf.tofile(str(path))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="画像の数独を読み取って解く")
    ap.add_argument("image", help="問題の画像ファイル（png / jpg など）")
    ap.add_argument("-o", "--output", help="解答画像の保存先（指定したときだけ保存する）")
    args = ap.parse_args(argv)

    src = Path(args.image)
    try:
        reading = read_puzzle(src)
    except ImageReadError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 2

    print("読み取った問題:")
    print(format_grid(reading.grid))
    unsure = [i for i, p in enumerate(reading.confidence) if p < 0.6]
    if unsure:
        cells = "、".join(f"{i // 9 + 1}行{i % 9 + 1}列" for i in unsure)
        print(f"\n※ 読み取りが不確かなマス: {cells}")

    clues = sum(1 for d in reading.grid if d)
    result, reason = None, ""
    if clues < 17:  # 解が一意な数独は最低 17 個の数字が必要（既知の事実）
        reason = f"読み取れた数字が {clues} 個しかなく、盤面を見つけ損ねた可能性が高い"
    else:
        try:
            result = solve(reading.grid, max_solutions=2)
        except SudokuError as e:
            reason = str(e)
        else:
            if result.solution is None:
                reason = "解がありません"
            elif result.solution_count > 1:
                reason, result = "解が複数あり、数字を読み落とした可能性が高い", None

    if result is None:
        print(f"\n解けませんでした（{reason}）。読み取りを誤った可能性があります。")
        print("上の読み取り結果を直してテキストファイルに保存し、`python sudoku_solver.py <ファイル>` で解けます。")
        return 1

    print("\n解答:")
    print(format_grid(result.solution))
    if args.output:
        out = Path(args.output)
        _save_png(out, render_answer(reading.grid, result.solution))
        print(f"\n解答画像を保存しました: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
