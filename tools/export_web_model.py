"""digit_model.npz を Web版（docs/）用の docs/digit_model.bin.gz に変換する。

digit_model.npz を作り直したら、このスクリプトも実行する。
使い方: python tools/export_web_model.py

ファイル形式（gzip 圧縮、リトルエンディアン）:
    uint32 件数 N, uint32 次元 D（=784）, uint8 ラベル × N, uint8 特徴量 × N×D
特徴量は float16 のままだと大きいので、全体の最大値で 0〜255 に量子化する
（類似度の大小関係はほぼ変わらず、テスト画像の読み取り結果も同じになることを確認済み）。
"""

import gzip
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "digit_model.bin.gz"


def main():
    data = np.load(ROOT / "digit_model.npz")
    feats = data["features"].astype(np.float32)
    labels = data["labels"].astype(np.uint8)
    q = np.round(feats / feats.max() * 255).astype(np.uint8)
    raw = struct.pack("<II", *q.shape) + labels.tobytes() + q.tobytes()
    OUT.write_bytes(gzip.compress(raw, 9, mtime=0))
    print(f"{OUT} に {len(labels)} 件の見本を保存しました（{OUT.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
