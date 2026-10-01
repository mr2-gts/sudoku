"""数字画像の正規化（学習時と認識時で同じ処理を使うための共通部品）。"""

from __future__ import annotations

import cv2
import numpy as np

SIDE = 28  # 正規化後の画像サイズ（28x28）
BOX = 20  # 数字を収める枠（縦横比を保ったままこの大きさに収める）


def normalize_digit(binary: np.ndarray) -> np.ndarray:
    """白い数字・黒い背景の2値画像を、28x28 の中央に寄せた画像にする。

    数字の外接矩形で切り出し、長い辺が BOX になるよう拡大縮小して中央に置く。
    """
    ys, xs = np.nonzero(binary)
    crop = binary[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h, w = crop.shape
    scale = BOX / max(h, w)
    nh, nw = max(1, round(h * scale)), max(1, round(w * scale))
    crop = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA)
    out = np.zeros((SIDE, SIDE), np.uint8)
    y0, x0 = (SIDE - nh) // 2, (SIDE - nw) // 2
    out[y0 : y0 + nh, x0 : x0 + nw] = crop
    return out


def to_feature(norm: np.ndarray) -> np.ndarray:
    """28x28 画像を、少しぼかした 784 次元のベクトルにする（多少の線の太さ・位置ずれに強くする）。"""
    blurred = cv2.GaussianBlur(norm, (3, 3), 0).astype(np.float32) / 255.0
    v = blurred.ravel()
    return v / (np.linalg.norm(v) + 1e-6)
