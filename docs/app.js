// 画面の操作（写真の読み込み → 読み取り → 解く → 表示、読み取り結果の修正）
// 写真はこのページの中（メモリ上）だけで扱い、送信も保存もしない。

import { DigitClassifier, readPuzzle } from "./vision.js";
import { SudokuError, solve } from "./solver.js";

const MAX_SIDE = 1200; // 大きな写真はこの大きさまで縮小してから読み取る（処理時間を抑えるため）
const UNSURE = 0.6; // 確からしさがこれ未満のマスを「不確か」として色を付ける

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
  if (!res.ok) throw new Error(`見本データを読み込めません（${res.status}）`);
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
async function loadGray(file) {
  const bitmap = await createImageBitmap(file); // 写真の向き（EXIF）はブラウザが補正する
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
  if (!file) return;
  setStatus("読み取り中…");
  await new Promise((r) => setTimeout(r, 30)); // 表示を更新してから重い処理に入る
  try {
    const [gray, classifier] = await Promise.all([loadGray(file), classifierPromise]);
    const reading = readPuzzle(gray, classifier);
    state.puzzle = reading.grid;
    state.confidence = reading.confidence;
    drawPreview(reading.board);
    solveAndShow();
  } catch (e) {
    console.error(e);
    setStatus(`読み取れませんでした: ${e.message}`, true);
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
// 解く（読み取りの誤りを見分ける判定は Python 版と同じ）
// ---------------------------------------------------------------------------
function solveAndShow() {
  const clues = state.puzzle.filter((d) => d).length;
  const unsure = state.confidence.filter((p) => p < UNSURE).length;
  state.solution = null;
  let reason = "";
  if (clues < 17) {
    // 解が一意な数独は最低 17 個の数字が必要
    reason = `読み取れた数字が ${clues} 個しかありません。盤面全体が写るように撮り直すか、手で直してください。`;
  } else {
    try {
      const r = solve(state.puzzle, 2);
      if (!r.solution) reason = "解がありません。読み取りを誤った可能性があります。";
      else if (r.solutionCount > 1) reason = "解が複数あります。数字を読み落とした可能性があります。";
      else state.solution = r.solution;
    } catch (e) {
      if (!(e instanceof SudokuError)) throw e;
      reason = `${e.message}。読み取りを誤った可能性があります。`;
    }
  }

  $("result").hidden = false;
  if (state.solution) {
    setStatus("解けました");
    setEditing(false);
  } else {
    setStatus(`解けませんでした: ${reason}`, true);
    setEditing(true);
  }
  $("legend").textContent = [
    state.solution ? "黒 = 問題の数字、青 = 答え。" : "数字のマスをタップして直し、「この内容で解く」を押してください。",
    unsure ? "黄色 = 読み取りが不確かなマス。" : "",
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
  b.textContent = d ? String(d) : "消す";
  b.addEventListener("click", () => inputDigit(d));
  $("pad").append(b);
}
$("camera").addEventListener("change", onPhoto);
$("picker").addEventListener("change", onPhoto);
$("solve").addEventListener("click", solveAndShow);
$("edit").addEventListener("click", () => {
  setEditing(true);
  setStatus("");
  $("legend").textContent = "数字のマスをタップして直し、「この内容で解く」を押してください。";
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
  $("legend").textContent = "マスをタップして数字を入れ、「この内容で解く」を押してください。";
  renderGrid();
});
classifierPromise.catch((e) => setStatus(e.message, true));
