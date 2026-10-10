// 画面の操作（写真の読み込み → 読み取り → 解く → 表示、読み取り結果の修正）
// 写真はこのページの中（メモリ上）だけで扱い、送信も保存もしない。

import { DigitClassifier, readPuzzle } from "./vision.js";
import { SudokuError, solve } from "./solver.js";
import { t } from "./i18n.js";

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
};

// ---------------------------------------------------------------------------
// 見本データの読み込み（ページを開いたときに始める）
// ---------------------------------------------------------------------------
const classifierPromise = (async () => {
  const res = await fetch("digit_model.bin.gz");
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
  const unsure = state.confidence.filter((p) => p < UNSURE).length;
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
  $("legend").textContent = [
    state.solution ? t("legendSolved") : t("legendFix"),
    unsure ? t("legendUnsure") : "",
  ].join(" ");
  renderGrid();
}

// ---------------------------------------------------------------------------
// 盤面の表示と修正
// ---------------------------------------------------------------------------
function renderGrid() {
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

function setEditing(on) {
  state.editing = on;
  state.selected = -1;
  $("editor").hidden = !on;
  $("edit").hidden = on;
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
