// 表示言語の切り替え（日本語 / 英語）
// ブラウザの第一言語が日本語なら日本語、それ以外は英語で表示する。
// URL に ?lang=ja / ?lang=en があればそちらを優先する（ページ下部の切替リンクが使う。選んだ言語は記憶しない）。
// index.html に書いた日本語は、このファイルが動くまでの仮の表示。文言はこのファイルの MESSAGES が正。

const MESSAGES = {
  ja: {
    title: "ナンプレ カメラ解答",
    note: "写真はこの端末の中だけで読み取ります。どこにも送信・保存しません。",
    camera: "カメラで撮影",
    picker: "写真を選ぶ",
    hintShoot: "盤面全体が写るよう、なるべく真上から撮ってください。",
    hintCamera: "「カメラで撮影」はスマホ専用です。PCでは「写真を選ぶ」で画像ファイルを読み込めます。",
    board: "盤面",
    solve: "この内容で解く",
    edit: "読み取り結果を直す",
    preview: "読み取った盤面の画像",
    manual: "写真を使わず手で入力する",
    otherLanguage: "English",
    erase: "消す",
    modelError: "見本データを読み込めません（{status}）",
    reading: "読み取り中…",
    readError: "読み取れませんでした: {message}",
    tooFew: "読み取れた数字が {count} 個しかありません。盤面全体が写るように撮り直すか、手で直してください。",
    noSolution: "解がありません。読み取りを誤った可能性があります。",
    multiple: "解が複数あります。数字を読み落とした可能性があります。",
    duplicate: "同じ行・列・ブロックに同じ数字があります。読み取りを誤った可能性があります。",
    solved: "解けました",
    unsolved: "解けませんでした: {reason}",
    legendSolved: "黒 = 問題の数字、青 = 答え。",
    legendFix: "数字のマスをタップして直し、「この内容で解く」を押してください。",
    legendUnsure: "黄色 = 読み取りが不確かなマス。",
    legendManual: "マスをタップして数字を入れ、「この内容で解く」を押してください。",
  },
  en: {
    title: "Sudoku Camera Solver",
    note: "Your photo is read only on this device. It is never sent or saved anywhere.",
    camera: "Take a photo",
    picker: "Choose a photo",
    hintShoot: "Shoot from as directly above as you can, with the whole grid in the frame.",
    hintCamera: "“Take a photo” works on smartphones only. On a PC, use “Choose a photo” to load an image file.",
    board: "Sudoku grid",
    solve: "Solve",
    edit: "Fix misread digits",
    preview: "Image of the scanned grid",
    manual: "Enter the puzzle by hand instead",
    otherLanguage: "日本語",
    erase: "Erase",
    modelError: "Could not load the digit recognition data ({status})",
    reading: "Reading…",
    readError: "Could not read the photo: {message}",
    tooFew: "Too few digits were read ({count}). Retake the photo with the whole grid in view, or fix the digits by hand.",
    noSolution: "There is no solution. Some digits may have been misread.",
    multiple: "There is more than one solution. Some digits may have been missed.",
    duplicate: "The same digit appears twice in a row, column, or box. Some digits may have been misread.",
    solved: "Solved",
    unsolved: "Could not solve: {reason}",
    legendSolved: "Black = given digits, blue = answers.",
    legendFix: "Tap a cell to fix it, then press “Solve”.",
    legendUnsure: "Yellow = uncertain readings.",
    legendManual: "Tap a cell to enter a digit, then press “Solve”.",
  },
};

const requested = new URLSearchParams(location.search).get("lang");
// Object.hasOwn は iOS 15.3 以前の Safari に無く、ページ全体が動かなくなるため使わない。
// navigator.language は優先言語の先頭（navigator.languages[0]、Accept-Language の先頭）と同じ値になる（Chrome で確認）。
const lang = Object.keys(MESSAGES).includes(requested)
  ? requested
  : navigator.language.startsWith("ja") ? "ja" : "en";

// 文言を返す。{name} は params の値に置き換える。
export function t(key, params = {}) {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (_, name) => params[name]);
}

// ページの固定の文言を差し替える
document.documentElement.lang = lang;
document.title = t("title");
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-label]")) el.setAttribute("aria-label", t(el.dataset.i18nLabel));
// 切替リンクは ?lang= を付けてページを開き直すので、表示中の盤面は消える。
// 切り替えるのはふつう開いた直後なので、開き直さずに文言だけ差し替える仕組み（表示中のメッセージも訳し直す必要がある）は入れていない。
const other = lang === "ja" ? "en" : "ja";
const langSwitch = document.getElementById("lang-switch");
langSwitch.href = `?lang=${other}`;
langSwitch.lang = other;
