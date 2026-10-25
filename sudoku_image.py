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
    4. 解く   … sudoku_solver.solve で解く。読み取った盤面が成り立たない（重複・解なし・解が複数）ときは、
       近い見本の票が割れていたマスの数字を置き換えて、解がちょうど1つになる盤面を探す（auto_correct）。
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
from itertools import combinations, product
from pathlib import Path

import cv2
import numpy as np

from digit_features import normalize_digit, to_feature
from sudoku_solver import SudokuError, format_grid, solve

CELL = 50  # 補正後の1マスのピクセル数
BOARD = CELL * 9
MODEL_PATH = Path(__file__).with_name("digit_model.npz")
MAX_SIDE = 1200  # 大きな写真はこの大きさまで縮小してから読み取る（Web 版と同じ。理由は load_gray を参照）
MIN_CONTRAST = 45  # 数字とみなす濃さの下限（背景の明るさとの差、0〜255）。写真の数字は 60 以上、ノイズは 40 以下だった
WEAK_CONTRAST_RATIO = 0.25  # 数字の濃い部分の何割の濃さまでを、つながった線として数字に含めるか
WEAK_CONTRAST_MIN = 15  # 同上の下限（背景の明るさとの差）
ALT_K = 15  # 読み取りを自動で直すとき、置き換える候補を選ぶために見る近い見本の件数
ALT_MIN_VOTES = 2  # 置き換える候補にする数字の票数の下限（ALT_K 件中）。1票だけの数字は候補にしない
MAX_FIXES = 4  # 自動で直すまとまり（形の似たマスどうし。_lookalike_groups）の数の上限
MAX_TRIALS = 2000  # 自動で直すときに試す盤面の数の上限（候補のマスが多い写真で時間がかかりすぎないように）


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

    def predict(self, norm: np.ndarray) -> tuple[int, float, list[int]]:
        """(数字, 確からしさ 0〜1, ほかの候補) を返す。

        確からしさ = 近傍 k 件のうち同じ数字の割合。
        ほかの候補 = 近傍 ALT_K 件で ALT_MIN_VOTES 票以上を得た、選んだ数字以外の数字（票の多い順）。
        """
        sims = self.features @ to_feature(norm)  # 正規化済みベクトルの内積 = コサイン類似度
        nearest = self.labels[np.argsort(sims)[-max(self.k, ALT_K) :]]  # 類似度の低い順
        votes = np.bincount(nearest[-self.k :], minlength=10)
        digit = int(votes.argmax())
        wide = np.bincount(nearest, minlength=10)
        alternatives = [int(d) for d in np.argsort(-wide, kind="stable") if d != digit and wide[d] >= ALT_MIN_VOTES]
        return digit, votes[digit] / self.k, alternatives


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
    alternatives: list[list[int]]  # マスごとの、ほかの候補の数字（DigitClassifier.predict。空きは []）
    lookalike: list[int]  # マスごとの、同じ画像の中でいちばん形の似た数字のマス（空きや、ほかに数字がないときは -1）


def load_gray(image_path: str | Path) -> np.ndarray:
    """画像をグレースケールで読み込み、読み取りに向く大きさにそろえる（Web 版の loadGray と同じ）。

    長辺が MAX_SIDE を超える写真は縮小する。大きいまま処理すると、画面のモアレなどの細かい模様で
    2値化した盤面の外枠が途切れ、盤面を見つけられずに画像全体を盤面とみなしてしまうことがある
    （縮小すると周りの画素が平均されて線がつながる。Issue #18）。小さい画像は拡大する。
    """
    data = np.fromfile(str(image_path), np.uint8)  # 日本語のファイル名でも読めるようにする
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)  # 写真の向き（EXIF）は OpenCV が補正する
    if img is None:
        raise ImageReadError(f"画像を開けません: {image_path}")
    h, w = img.shape
    if max(h, w) > MAX_SIDE:
        s = MAX_SIDE / max(h, w)
        # 大きさの丸めは Web 版（Math.round）と同じ。周りの画素の平均で縮小する（INTER_AREA）
        img = cv2.resize(img, (int(w * s + 0.5), int(h * s + 0.5)), interpolation=cv2.INTER_AREA)
    elif max(h, w) < 300:
        img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    return img


def read_puzzle(image_path: str | Path, classifier: DigitClassifier | None = None) -> Reading:
    img = load_gray(image_path)
    board = warp_board(img, find_board(img))
    binary = _binarize(board)
    clf = classifier or DigitClassifier()

    grid, conf, alts, feats = [], [], [], {}
    m = CELL // 10  # 罫線を避ける余白
    for r in range(9):
        for c in range(9):
            ys, xs = slice(r * CELL + m, (r + 1) * CELL - m), slice(c * CELL + m, (c + 1) * CELL - m)
            digit_img = extract_digit(binary[ys, xs], board[ys, xs])
            if digit_img is None:
                grid.append(0)
                conf.append(1.0)
                alts.append([])
            else:
                norm = normalize_digit(digit_img)
                d, p, a = clf.predict(norm)
                grid.append(d)
                conf.append(p)
                alts.append(a)
                feats[r * 9 + c] = to_feature(norm)
    return Reading(grid, conf, board, alts, _lookalikes(feats))


def _lookalikes(feats: dict[int, np.ndarray]) -> list[int]:
    """マスごとに、同じ画像の中でいちばん形の似た数字のマスを返す（空きや、ほかに数字がないときは -1）。"""
    result = [-1] * 81
    cells = list(feats)
    if len(cells) < 2:
        return result
    sims = np.array([feats[i] for i in cells]) @ np.array([feats[i] for i in cells]).T
    np.fill_diagonal(sims, -np.inf)
    for a, i in enumerate(cells):
        result[i] = cells[int(sims[a].argmax())]
    return result


# ---------------------------------------------------------------------------
# 4. 読み取りの自動修正
# ---------------------------------------------------------------------------
def _has_one_solution(grid: list[int]) -> bool:
    try:
        return solve(grid, max_solutions=2).solution_count == 1
    except SudokuError:  # 同じ行・列・ブロックに同じ数字がある
        return False


def _lookalike_groups(grid: list[int], lookalike: list[int]) -> list[list[int]]:
    """いちばん形の似たマスと同じ数字に読んだマスどうしを、つないでまとめる。

    同じ画像の中で同じ数字が2回以上あるとき、いちばん形の似たマスは同じ数字だった（確認した 21 枚すべて）。
    同じ形の数字は同じように読み誤るので、まとめて直す。1つだけ直すと、残りを誤ったまま
    解がちょうど1つの盤面になり、違う答えを出すことがあった（Issue #21 のスクリーンショットの1枚）。
    """
    parent = list(range(81))

    def root(i: int) -> int:
        while parent[i] != i:
            i = parent[i]
        return i

    for i, j in enumerate(lookalike):
        if j >= 0 and grid[i] == grid[j]:
            parent[root(i)] = root(j)
    groups: dict[int, list[int]] = {}
    for i in range(81):
        if grid[i]:
            groups.setdefault(root(i), []).append(i)
    return list(groups.values())


def auto_correct(
    grid: list[int], alternatives: list[list[int]], lookalike: list[int]
) -> tuple[list[int], list[int]] | None:
    """読み取った盤面が成り立たない（重複・解なし・解が複数）とき、ほかの候補の数字に置き換えて直す。

    形の似たマスのまとまり（_lookalike_groups）ごとに、まとまりのどれかのマスのほかの候補の数字に置き換える。
    置き換えるまとまりの数を 1 つ、2 つ…と MAX_FIXES まで増やし、解がちょうど 1 つになる盤面を探す。
    最も少ない置き換えで見つかった盤面が 1 つだけで、置き換えを 1 つ増やすと解がちょうど 1 つになる盤面がないなら
    (直した盤面, 置き換えたマス) を返す。それ以外（盤面が成り立つ・見つからない・1 つに決められない・
    試す盤面が MAX_TRIALS を超える）は None（そのときは今までどおり利用者に直してもらう）。
    """
    if sum(1 for d in grid if d) < 17 or _has_one_solution(grid):
        return None  # 17 個未満は、どう置き換えても解が 1 つにならない（盤面を見つけ損ねた可能性が高い）
    groups = []
    for members in _lookalike_groups(grid, lookalike):
        digits = sorted({d for i in members for d in alternatives[i]} - {grid[members[0]]})
        if digits:
            groups.append((members, digits))
    trials = 0

    def boards(n: int) -> list[tuple[list[int], list[int]]] | None:
        """まとまりを n 個置き換えて、解がちょうど 1 つになる盤面の一覧。試す盤面が MAX_TRIALS を超えたら None。"""
        nonlocal trials
        found = []
        for chosen in combinations(groups, n):
            for digits in product(*(ds for _, ds in chosen)):
                trials += 1
                if trials > MAX_TRIALS:
                    return None
                trial = grid[:]
                for (members, _), d in zip(chosen, digits):
                    for i in members:
                        trial[i] = d
                if _has_one_solution(trial):
                    found.append((trial, sorted(i for members, _ in chosen for i in members)))
        return found

    for n in range(1, min(MAX_FIXES, len(groups)) + 1):
        found = boards(n)
        if found is None or len(found) > 1:
            return None
        if found:
            # 読み誤りが 2 か所あるとき、1 か所だけ直した盤面でも解がちょうど 1 つになり、違う答えを出すことがある
            # （読み誤りを入れて試すと 3% ほど）。置き換えを 1 つ増やして解が 1 つになる盤面があれば、決めない。
            more = boards(n + 1) if n < len(groups) else []
            return found[0] if more == [] else None
    return None


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
    unsure = [i for i, p in enumerate(reading.confidence) if p < 0.8]  # 5票中3票以下（3票でも3割以上が誤読だった）
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

    puzzle = reading.grid
    fix = auto_correct(puzzle, reading.alternatives, reading.lookalike) if result is None else None
    if fix:
        puzzle, fixed = fix
        changes = "、".join(f"{i // 9 + 1}行{i % 9 + 1}列 {reading.grid[i]}→{puzzle[i]}" for i in fixed)
        print(f"\n※ 読み取ったままでは解けない（{reason}）ため、数字を自動で直しました: {changes}")
        print("  元の画像と見比べて、正しいか確かめてください。")
        result = solve(puzzle)

    if result is None:
        print(f"\n解けませんでした（{reason}）。読み取りを誤った可能性があります。")
        print("上の読み取り結果を直してテキストファイルに保存し、`python sudoku_solver.py <ファイル>` で解けます。")
        return 1

    print("\n解答:")
    print(format_grid(result.solution))
    if args.output:
        out = Path(args.output)
        _save_png(out, render_answer(puzzle, result.solution))
        print(f"\n解答画像を保存しました: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
