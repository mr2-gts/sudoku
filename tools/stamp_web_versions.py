"""Web版（docs/）のページが読み込むファイルの URL に、中身から決めた版を付ける（app.js?v=1a2b3c4d）。

GitHub Pages はブラウザにファイルを 10 分間キャッシュさせるが、それより長く古いファイルが使われることがある。
新旧のファイルが混ざるとモジュールの読み込みでエラーになり、ページの処理がまったく動かなくなる。
そこで、中身が変わったファイルは URL も変わるようにし、ブラウザが必ず新しいファイルを取りに行くようにする。
版はファイルの中身の SHA-256 の先頭 8 桁なので、変わっていないファイルはキャッシュをそのまま使える。

docs/ のファイルを変えたら、公開する前に実行する（付け忘れは node --test test_web_solver.mjs で検出する）。
使い方: python tools/stamp_web_versions.py

ほかのファイルを読み込むファイル（app.js など）は、読み込み先の版を書き換えると自分の中身も変わるので、
変化がなくなるまで繰り返す（読み込み先 → 読み込み元の順に版が決まる）。
"""

import hashlib
import re
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"
# 引用符で囲んだファイル名（"app.js" "./solver.js" "style.css?v=1a2b3c4d" など）。docs/ にあるファイルだけを書き換える
REF = re.compile(r"([\"'])(\./)?([\w.-]+\.(?:js|css|gz))(?:\?v=[0-9a-f]+)?\1")


def version(name):
    return hashlib.sha256((DOCS / name).read_bytes()).hexdigest()[:8]


def stamp(text):
    def replace(m):
        quote, dot, name = m.groups()
        if not (DOCS / name).is_file():
            return m.group(0)
        return f"{quote}{dot or ''}{name}?v={version(name)}{quote}"

    return REF.sub(replace, text)


def main():
    sources = sorted(DOCS.glob("*.html")) + sorted(DOCS.glob("*.js"))
    # 読み込みの深さはファイルの数を超えないので、その回数だけ繰り返せば必ず変化がなくなる
    for _ in range(len(sources) + 1):
        changed = []
        for path in sources:
            text = path.read_text(encoding="utf-8")
            new = stamp(text)
            if new != text:
                path.write_text(new, encoding="utf-8")
                changed.append(path.name)
        if not changed:
            print("版を付けました" if _ else "版はすでに最新です")
            return
        print("更新:", ", ".join(changed))
    raise SystemExit("版が定まりません（ファイルが互いに読み込み合っていないか確認してください）")


if __name__ == "__main__":
    main()
