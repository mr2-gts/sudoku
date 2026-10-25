// 画面の操作（写真の読み込み → 読み取り → 解く → 表示、読み取り結果の修正、解き方の解説）
// 写真はこのページの中（メモリ上）だけで扱い、送信も保存もしない。

import { DigitClassifier, readPuzzle } from "./vision.js?v=e21ac435";
import { SudokuError, solve } from "./solver.js?v=af66d12c";
import { solveSteps } from "./steps.js?v=e6e2488c";
import { t } from "./i18n.js?v=36940c4c";

const MAX_SIDE = 1200; // 大きな写真はこの大きさまで縮小してから読み取る（処理時間を抑えるため）
// 確からしさ（近い見本5件のうち同じ数字の割合）がこれ未満のマスを「不確か」として色を付ける。
// 5票中3票（0.6）でも、合成画像では3割以上が誤読だったため、4票未満を不確かとする（Python 版と同じ）。
const UNSURE = 0.8;

const $ = (id) => document.getElementById(id);
const state = {
  puzzle: new Array(81).fill(0), // 問題（0=空き）
  solution: null, // 解答（解けていなければ null）
  confidence: new Array(81).fill(1),
  editing: false,
  selected: -1,
  steps: [], // 解説モードの手順（solveSteps の結果）
  step: -1, // 解説モードで表示中の位置（0=最初の盤面、k=k手目まで置いた盤面）。解説モードでないときは -1
  showReason: false, // 解説モードで、今の手の理由を表示するか
  candidatesFrom: -1, // 解説モードで、初めて候補を消す手の番号（state.steps の添え字。なければ -1）
};

// ---------------------------------------------------------------------------
// 見本データの読み込み（ページを開いたときに始める）
// ---------------------------------------------------------------------------
const classifierPromise = (async () => {
  const res = await fetch("digit_model.bin.gz?v=86ba9f55");
  if (!res.ok) throw new Error(t("modelError", { status: res.status }));
  let buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    // gzip のまま届いたときはここで展開する（サーバーが展開済みで送ってくる場合もある）
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    buf = await new Response(stream).arrayBuffer();
  }
  return new DigitClassifier(buf);
})();

// ---------------------------------------------------------------------------
// 写真の読み込みと読み取り
// ---------------------------------------------------------------------------
// source は写真のファイル、またはページ内カメラで撮った1コマ（OffscreenCanvas）
async function loadGray(source) {
  const bitmap = await createImageBitmap(source); // 写真の向き（EXIF）はブラウザが補正する
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
  }
  return { w, h, data };
}

async function onPhoto(event) {
  const file = event.target.files[0];
  event.target.value = ""; // 同じ写真を選び直せるようにし、参照も残さない
  if (file) await readPhoto(file);
}

async function readPhoto(source) {
  $("result").hidden = true; // 前の問題の盤面と答えを、読み取り中や読み取りに失敗したときに見せない
  setStatus(t("reading"));
  await new Promise((r) => setTimeout(r, 30)); // 表示を更新してから重い処理に入る
  try {
    const [gray, classifier] = await Promise.all([loadGray(source), classifierPromise]);
    const reading = readPuzzle(gray, classifier);
    state.puzzle = reading.grid;
    state.confidence = reading.confidence;
    drawPreview(reading.board);
    solveAndShow();
  } catch (e) {
    console.error(e);
    setStatus(t("readError", { message: e.message }), true);
  }
}

function drawPreview(board) {
  const ctx = $("preview").getContext("2d");
  const img = ctx.createImageData(board.w, board.h);
  board.data.forEach((v, i) => img.data.set([v, v, v, 255], i * 4));
  ctx.putImageData(img, 0, 0);
  $("preview-box").hidden = false;
}

// ---------------------------------------------------------------------------
// ページ内カメラ（Android のみ）
// ---------------------------------------------------------------------------
// Android の Chrome は、撮影のためにカメラアプリを起動している間にメモリ不足で強制終了されることがある。
// そうなると、戻ったときに「メモリ不足のため前の操作を完了できませんでした」と出て、写真がページに届かない。
// そこで Android ではカメラアプリを使わず、ページの中にカメラの映像を出して撮る。
// iPhone と PC ではこの問題が起きないため、これまでどおりカメラアプリ（PC はファイル選択）を使う。
let useCameraApp = !/Android/i.test(navigator.userAgent) || !navigator.mediaDevices?.getUserMedia;
let cameraStream = null;
let cameraOpening = false;

async function openCamera(event) {
  if (useCameraApp) return; // input 本来の動作でカメラアプリを開く
  event.preventDefault();
  if (cameraOpening) return; // カメラが起動するのを待っている間に、もう一度押されたとき
  cameraOpening = true;
  try {
    // 読み取りは長辺 MAX_SIDE まで縮小するので、映像の大きさはこの程度で足りる
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1920 } },
    });
  } catch (e) {
    // カメラの使用を許可されなかったときなど。これ以降はカメラアプリで撮る
    console.error(e);
    useCameraApp = true;
    setStatus(t("cameraFallback"), true);
    $("camera").click(); // ボタンを押してから時間がたっていると、ブラウザに止められて開かない（そのときは案内のとおり押し直してもらう）
    return;
  } finally {
    cameraOpening = false;
  }
  $("camera-video").srcObject = cameraStream;
  $("camera-view").hidden = false;
  history.pushState({ camera: true }, ""); // スマホの「戻る」でページを離れず、カメラを閉じるようにする
}

function closeCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  $("camera-video").srcObject = null;
  $("camera-view").hidden = true;
  // 開いたときに足した履歴を戻す（「戻る」で閉じたときは、すでに戻っている）
  if (history.state?.camera) history.back();
}

function takeShot() {
  const video = $("camera-video");
  if (video.readyState < video.HAVE_CURRENT_DATA) return; // 映像がまだ届いていない
  // カメラを止める前に、今のコマを写し取っておく
  const frame = new OffscreenCanvas(video.videoWidth, video.videoHeight);
  frame.getContext("2d").drawImage(video, 0, 0);
  closeCamera();
  readPhoto(frame);
}

// ---------------------------------------------------------------------------
// 解く（読み取りの誤りを見分ける判定は Python 版と同じ）
// ---------------------------------------------------------------------------
function solveAndShow() {
  const clues = state.puzzle.filter((d) => d).length;
  state.solution = null;
  let reason = "";
  if (clues < 17) {
    // 解が一意な数独は最低 17 個の数字が必要
    reason = t("tooFew", { count: clues });
  } else {
    try {
      const r = solve(state.puzzle, 2);
      if (!r.solution) reason = t("noSolution");
      else if (r.solutionCount > 1) reason = t("multiple");
      else state.solution = r.solution;
    } catch (e) {
      if (!(e instanceof SudokuError)) throw e;
      // 画面から渡す盤面は常に 0〜9 の 81 マスなので、SudokuError になるのは数字の重複のときだけ。
      // e.message は日本語なので表示に使わない。重複以外の SudokuError が起こりうるようになったら、
      // solver.js の SudokuError に種類を表すコードを持たせて見分ける。
      reason = t("duplicate");
    }
  }

  $("result").hidden = false;
  if (state.solution) {
    setStatus(t("solved"));
    setEditing(false);
  } else {
    setStatus(t("unsolved", { reason }), true);
    setEditing(true);
  }
  $("legend").textContent = resultLegend();
  renderGrid();
}

function resultLegend() {
  const unsure = state.confidence.some((p) => p < UNSURE);
  return [state.solution ? t("legendSolved") : t("legendFix"), unsure ? t("legendUnsure") : ""].join(" ");
}

// ---------------------------------------------------------------------------
// 盤面の表示と修正
// ---------------------------------------------------------------------------
function renderGrid() {
  if (state.step >= 0) return renderExplainGrid();
  const grid = $("grid");
  grid.classList.toggle("editing", state.editing);
  grid.replaceChildren(
    ...state.puzzle.map((d, i) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      const shown = state.editing ? d : d || state.solution?.[i];
      cell.textContent = shown || "";
      if (d) cell.classList.add("given");
      else if (shown) cell.classList.add("filled");
      if (state.confidence[i] < UNSURE) cell.classList.add("unsure");
      if (state.editing && i === state.selected) cell.classList.add("selected");
      cell.addEventListener("click", () => selectCell(i));
      return cell;
    }),
  );
}

// 修正中と答えの表示を切り替える。どちらにしても解説モードは終える
function setEditing(on) {
  state.editing = on;
  state.selected = -1;
  state.step = -1;
  $("editor").hidden = !on;
  $("edit").hidden = on;
  $("explain-start").hidden = on || !state.solution;
  $("explain").hidden = true;
}

function selectCell(i) {
  if (!state.editing) return;
  state.selected = i;
  renderGrid();
}

function inputDigit(d) {
  if (state.selected < 0) return;
  state.puzzle[state.selected] = d;
  state.confidence[state.selected] = 1; // 手で直したマスは確かなものとして扱う
  state.selected = Math.min(state.selected + 1, 80); // 続けて入力しやすいよう次のマスへ
  renderGrid();
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

// ---------------------------------------------------------------------------
// 解説モード（最初の盤面から、手筋で1手ずつ数字を置いたり候補を消したりしていく）
// ---------------------------------------------------------------------------
// 行・列・ブロックの名前（単数・複数）、そのユニットのほかのマスに数字を置けない理由になる残り2種類の名前、そこにある数字の書き方
const UNIT_TEXT = {
  row: { unit: "unitRow", units: "unitsRow", others: "othersRow", seen: "seenRow" },
  col: { unit: "unitCol", units: "unitsCol", others: "othersCol", seen: "seenCol" },
  box: { unit: "unitBox", units: "unitsBox", others: "othersBox", seen: "seenBox" },
};

function startExplain() {
  state.steps = solveSteps(state.puzzle, state.solution);
  state.step = 0;
  state.showReason = false;
  state.candidatesFrom = state.steps.findIndex((s) => s.removed);
  $("explain-start").hidden = true;
  $("edit").hidden = true;
  $("explain").hidden = false;
  const guessed = state.steps.some((s) => s.technique === "answer");
  $("legend").textContent = [
    t("legendExplain"),
    guessed ? t("legendGuessed") : "",
    state.candidatesFrom >= 0 ? t("legendCandidates") : "",
  ]
    .filter(Boolean)
    .join(" ");
  renderExplain();
}

function endExplain() {
  setEditing(false);
  $("legend").textContent = resultLegend();
  renderGrid();
}

function moveStep(delta) {
  state.step = Math.min(Math.max(state.step + delta, 0), state.steps.length);
  renderExplain();
}

function renderExplain() {
  const step = state.steps[state.step - 1]; // 今の手（最初の盤面では undefined）
  const next = state.steps[state.step];
  $("step-count").textContent = `${state.step} / ${state.steps.length}`;
  $("step-prev").disabled = state.step === 0;
  $("step-next").disabled = !next;
  $("step-next").textContent = next?.technique === "answer" ? t("stepAnswer") : t("stepNext");
  $("step-note").textContent = [
    state.step === 0 ? t("explainIntro") : "",
    step?.removed ? t("eliminateNote", { name: techniqueName(step) }) : "",
    state.step === state.candidatesFrom ? t("candidatesNext") : "",
    !next ? t("explainDone") : next.technique === "answer" ? t("explainStuck") : "",
  ]
    .filter(Boolean)
    .join(" ");
  $("reason").textContent = state.showReason ? t("reasonHide") : t("reasonShow");
  $("reason-box").hidden = !(state.showReason && step);
  const name = step ? techniqueName(step) : "";
  $("reason-name").textContent = name;
  $("reason-name").hidden = !name;
  $("reason-text").textContent = step ? reasonText(step) : "";
  renderGrid();
}

const TECHNIQUE_NAMES = {
  hiddenSingle: "techHiddenSingle",
  nakedSingle: "techNakedSingle",
  lockedCandidates: "techLockedCandidates",
  xWing: "techXWing",
};

// 手筋の名前（答えから置いた手は名前なし）
function techniqueName(step) {
  if (step.technique === "answer") return "";
  if (step.technique === "hiddenSingle" && !step.excluded.length) return t("techFullHouse");
  if (step.technique === "nakedSubset") return t(step.cells.length === 2 ? "techNakedPair" : "techNakedTriple");
  if (step.technique === "hiddenSubset") return t(step.cells.length === 2 ? "techHiddenPair" : "techHiddenTriple");
  return t(TECHNIQUE_NAMES[step.technique]);
}

function reasonText(step) {
  const list = (digits) => digits.join(t("digitSep"));
  if (step.technique === "hiddenSingle") {
    const keys = UNIT_TEXT[step.unitKind];
    // ほかに空きマスがなければ、ユニットで最後に残った1マス。ほかの空きマスに置けない理由は、
    // 同じ行・列・ブロックにある数字（blockers）と、先の手で消した候補（erased）のどちらか、または両方
    const key = !step.excluded.length
      ? "fullHouse"
      : !step.erased.length
        ? "hiddenSingle"
        : step.blockers.length
          ? "hiddenSingleErased"
          : "hiddenSingleAllErased";
    return t(key, { unit: t(keys.unit), others: t(keys.others), digit: step.digit });
  }
  if (step.technique === "nakedSingle") {
    const seen = Object.entries(step.seen)
      .filter(([, digits]) => digits.length)
      .map(([kind, digits]) => t(UNIT_TEXT[kind].seen, { digits: list(digits) }))
      .join(t("seenSep"));
    return t(step.erased.length ? "nakedSingleErased" : "nakedSingle", { digit: step.digit, seen, erased: list(step.erased) });
  }
  if (step.technique === "lockedCandidates") {
    return t("lockedCandidates", { base: t(UNIT_TEXT[step.baseKind].unit), cover: t(UNIT_TEXT[step.coverKind].unit), digit: step.digits[0] });
  }
  if (step.technique === "nakedSubset" || step.technique === "hiddenSubset") {
    return t(step.technique, { unit: t(UNIT_TEXT[step.unitKind].unit), count: step.cells.length, digits: list(step.digits) });
  }
  if (step.technique === "xWing") {
    return t("xWing", { bases: t(UNIT_TEXT[step.baseKind].units), covers: t(UNIT_TEXT[step.coverKind].units), digit: step.digits[0] });
  }
  return t("answerStep");
}

// state.step 手目までを進めた盤面を表示し、その手のマスや消した候補を強調する。理由の表示中は、理由に関係するマスにも色を付ける
function renderExplainGrid() {
  const board = state.puzzle.slice();
  const guessed = new Set(); // 答えから置いたマス
  for (const s of state.steps.slice(0, state.step)) {
    if (s.removed) continue;
    board[s.cell] = s.digit;
    if (s.technique === "answer") guessed.add(s.cell);
  }
  const step = state.steps[state.step - 1];
  // 候補は、初めて候補を消す手から先で表示する（その後のシングルも、消した候補を理由にすることがあるため）
  const showCandidates = state.candidatesFrom >= 0 && state.step > state.candidatesFrom;
  const removed = new Map(step?.removed?.map((r) => [r.cell, r.digits])); // この手で消した候補
  const reason = state.showReason && step ? step : {};
  const area = new Set(reason.area), blockers = new Set(reason.blockers), excluded = new Set(reason.excluded);
  const pattern = new Set(reason.removed ? reason.cells : []); // 手筋の形をつくるマス
  $("grid").replaceChildren(
    ...board.map((d, i) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      if (d) {
        cell.textContent = d;
        cell.classList.add(state.puzzle[i] ? "given" : guessed.has(i) ? "guessed" : "filled");
      } else if (excluded.has(i)) {
        cell.textContent = "×";
        cell.classList.add("excluded");
      } else if (showCandidates) {
        cell.classList.add("candidates");
        const gone = removed.get(i) ?? [];
        for (let x = 1; x <= 9; x++) {
          const mark = document.createElement("span");
          if (step.cand[i] & (1 << (x - 1)) || gone.includes(x)) mark.textContent = x;
          if (gone.includes(x)) mark.className = "removed";
          else if (pattern.has(i) && reason.digits.includes(x)) mark.className = "key";
          cell.append(mark);
        }
      }
      if (area.has(i)) cell.classList.add("area");
      if (blockers.has(i)) cell.classList.add("blocker");
      if (pattern.has(i)) cell.classList.add("pattern");
      if (removed.has(i)) cell.classList.add("changed");
      if (i === step?.cell) cell.classList.add("current");
      return cell;
    }),
  );
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
for (const d of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = d ? String(d) : t("erase");
  b.addEventListener("click", () => inputDigit(d));
  $("pad").append(b);
}
$("camera").addEventListener("click", openCamera);
$("camera").addEventListener("change", onPhoto);
$("picker").addEventListener("change", onPhoto);
$("shutter").addEventListener("click", takeShot);
$("camera-cancel").addEventListener("click", closeCamera);
window.addEventListener("popstate", closeCamera);
$("solve").addEventListener("click", solveAndShow);
$("explain-start").addEventListener("click", startExplain);
$("explain-end").addEventListener("click", endExplain);
$("step-prev").addEventListener("click", () => moveStep(-1));
$("step-next").addEventListener("click", () => moveStep(1));
$("reason").addEventListener("click", () => {
  state.showReason = !state.showReason;
  renderExplain();
});
$("edit").addEventListener("click", () => {
  setEditing(true);
  setStatus("");
  $("legend").textContent = t("legendFix");
  renderGrid();
});
$("manual").addEventListener("click", (e) => {
  e.preventDefault();
  state.puzzle = new Array(81).fill(0);
  state.confidence = new Array(81).fill(1);
  state.solution = null;
  $("result").hidden = false;
  $("preview-box").hidden = true;
  setEditing(true);
  setStatus("");
  $("legend").textContent = t("legendManual");
  renderGrid();
});
classifierPromise.catch((e) => setStatus(e.message, true));
// ページの処理が最後まで動いたことを load-check.js に知らせる（印がなければ、読み込みの失敗として案内を出す）
document.documentElement.dataset.ready = "true";
