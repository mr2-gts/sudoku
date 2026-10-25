// 画面の操作（写真の読み込み → 読み取り → 解く → 表示、読み取り結果の修正、解き方の解説）
// 写真はこのページの中（メモリ上）だけで扱い、送信も保存もしない。

import { DigitClassifier, autoCorrect, readPuzzle } from "./vision.js?v=3ada0f02";
import { SudokuError, solve } from "./solver.js?v=af66d12c";
import { solveSteps } from "./steps.js?v=81bd711e";
import { t } from "./i18n.js?v=fbad9f19";

const MAX_SIDE = 1200; // 大きな写真はこの大きさまで縮小してから読み取る（処理時間を抑えるため）。
// 大きいまま処理すると、画面のモアレなどで2値化した盤面の外枠が途切れ、盤面を見つけられないこともある（Python 版で確認。Issue #18）
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
    const fix = autoCorrect(reading.grid, reading.alternatives, reading.lookalike);
    state.puzzle = fix ? fix.grid : reading.grid;
    state.confidence = reading.confidence;
    fix?.cells.forEach((i) => (state.confidence[i] = 0)); // 自動で直したマスは「不確か」の黄色で示し、確かめてもらう
    drawPreview(reading.board);
    solveAndShow(fix ? fix.cells.length : 0);
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
// fixed: 読み取りを自動で直したマスの数（知らせるため）
function solveAndShow(fixed = 0) {
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
    setStatus(fixed ? t("solvedFixed", { count: fixed }) : t("solved"));
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
  xyWing: "techXyWing",
  swordfish: "techSwordfish",
  xyzWing: "techXyzWing",
  jellyfish: "techJellyfish",
  wWing: "techWWing",
  simpleColoring: "techSimpleColoring",
  xChain: "techXChain",
};
// シンプルカラーリングの2色の名前（盤面の 1色目は青、2色目は緑）
const COLOR_NAMES = ["colorBlue", "colorGreen"];
// ネイキッド／ヒドゥンの手筋の名前（マスの数ごと）
const SUBSET_NAMES = {
  nakedSubset: { 2: "techNakedPair", 3: "techNakedTriple", 4: "techNakedQuad" },
  hiddenSubset: { 2: "techHiddenPair", 3: "techHiddenTriple", 4: "techHiddenQuad" },
};

// 手筋の名前（答えから置いた手は名前なし）
function techniqueName(step) {
  if (step.technique === "answer") return "";
  if (step.technique === "hiddenSingle" && !step.excluded.length) return t("techFullHouse");
  if (SUBSET_NAMES[step.technique]) return t(SUBSET_NAMES[step.technique][step.cells.length]);
  return t(TECHNIQUE_NAMES[step.technique]);
}

function reasonText(step) {
  const list = (digits) => digits.join(t("digitSep"));
  const sorted = (...digits) => list(digits.sort((m, n) => m - n)); // 候補は小さい順に書く
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
  if (step.technique === "xWing" || step.technique === "swordfish" || step.technique === "jellyfish") {
    return t(step.technique, { bases: t(UNIT_TEXT[step.baseKind].units), covers: t(UNIT_TEXT[step.coverKind].units), digit: step.digits[0] });
  }
  if (step.technique === "xyWing" || step.technique === "xyzWing") {
    const [x, y, z] = step.digits;
    return t(step.technique, { x, y, z, xz: sorted(x, z), yz: sorted(y, z), xyz: sorted(x, y, z) });
  }
  if (step.technique === "wWing") {
    const [x, y] = step.digits;
    return t("wWing", { x, y, xy: sorted(x, y), unit: t(UNIT_TEXT[step.unitKind].unit) });
  }
  if (step.technique === "simpleColoring") {
    if (step.rule === "trap") return t("coloringTrap", { digit: step.digits[0] });
    const [wrong, right] = [step.wrongColor, 1 - step.wrongColor].map((k) => t(COLOR_NAMES[k]));
    return t("coloringWrap", { digit: step.digits[0], unit: t(UNIT_TEXT[step.unitKind].unit), wrong, right });
  }
  if (step.technique === "xChain") return t("xChain", { digit: step.digits[0] });
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
  // 手筋の形をつくるマスと、その候補。リンクの両端のマスは、リンクの数字だけ
  const keys = new Map(reason.removed ? reason.cells.map((c) => [c, reason.digits]) : []);
  for (const { from, to, digit } of reason.links ?? []) {
    for (const c of [from, to]) keys.set(c, [...new Set([...(keys.get(c) ?? []), digit])]);
  }
  const alt = new Set(reason.colors?.[1]); // シンプルカラーリングの2色目（緑）のマス
  // 青い枠で示すマス: XY-Wing・XYZ-Wing の軸、W-Wing の2つのマス、X-Chain の両端
  const outlined = new Set(
    reason.technique === "wWing" ? reason.pincers : reason.technique === "xChain" ? [reason.cells[0], reason.cells.at(-1)] : [reason.pivot],
  );
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
          else if (keys.get(i)?.includes(x)) mark.className = alt.has(i) ? "key-alt" : "key";
          cell.append(mark);
        }
      }
      if (area.has(i)) cell.classList.add("area");
      if (blockers.has(i)) cell.classList.add("blocker");
      if (keys.has(i)) cell.classList.add(alt.has(i) ? "pattern-alt" : "pattern");
      if (outlined.has(i)) cell.classList.add("pivot");
      if (removed.has(i)) cell.classList.add("changed");
      if (i === step?.cell) cell.classList.add("current");
      return cell;
    }),
    ...(reason.links ? [linkLayer(reason.links)] : []),
  );
}

// チェーン系の手筋のリンクを、盤面に重ねる線で描く（強いリンクは実線、弱いリンクは点線）。
// 座標は、盤面の左上を (0, 0) とし、1マスを 1 とする
const SVG_NS = "http://www.w3.org/2000/svg";
const LINK_GAP = 0.15; // 線の端を、候補の数字に重ならないよう中心から離す長さ
// 線は、途中のマスの大きな数字を横切らないよう、候補から横にずらした位置を通す。候補がマスの端寄り（9 なら右下）なら
// その端の側へ、中央寄りなら盤面の中心の側へ、マスの境目の少し手前（候補から境目までの LINK_ROOM 倍）までずらす。
// 長い線は、両端のマスの中で曲がってずらした位置に移り、そこをまっすぐ進む。隣のマスへの短い線は弓なりに曲げるだけにする
const LINK_ROOM = 0.8, LINK_SHORT = 1.2;

// 候補 digit の、マスの中での位置（0〜1。候補は 3x3 に並べている）
const candidateOffset = (digit) => [(((digit - 1) % 3) + 0.5) / 3, (Math.floor((digit - 1) / 3) + 0.5) / 3];

// 2次ベジェ曲線 p0 →（制御点 c）→ p2 の p0 側を、p0 から LINK_GAP 離れるところまで切り落とす。[新しい始点, 新しい制御点] を返す
function trimBezier(p0, c, p2) {
  const at = (t) => [0, 1].map((k) => (1 - t) ** 2 * p0[k] + 2 * t * (1 - t) * c[k] + t ** 2 * p2[k]);
  let t = 0;
  while (t < 0.5 && Math.hypot(at(t)[0] - p0[0], at(t)[1] - p0[1]) < LINK_GAP) t += 0.01;
  return [at(t), [0, 1].map((k) => (1 - t) * c[k] + t * p2[k])];
}

function linkLayer(links) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "links");
  svg.setAttribute("viewBox", "0 0 9 9");
  svg.setAttribute("aria-hidden", "true");
  for (const { from, to, digit, strong } of links) {
    const [fx, fy] = candidateOffset(digit);
    const [x1, y1] = [(from % 9) + fx, Math.floor(from / 9) + fy], [x2, y2] = [(to % 9) + fx, Math.floor(to / 9) + fy];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len]; // 線の向き
    let [nx, ny] = [-uy, ux]; // ずらす向き（線に垂直）
    const side = nx * (fx - 0.5) + ny * (fy - 0.5);
    const [mx, my] = [(x1 + x2) / 2, (y1 + y2) / 2];
    if (side < 0 || (side === 0 && nx * (4.5 - mx) + ny * (4.5 - my) < 0)) [nx, ny] = [-nx, -ny];
    // 候補から、ずらす向きにマスの境目までの長さ
    const room = Math.min(...[[nx, fx], [ny, fy]].filter(([n]) => n !== 0).map(([n, f]) => (n > 0 ? 1 - f : f) / Math.abs(n)));
    const shift = LINK_ROOM * room;
    const p1 = [x1, y1], p2 = [x2, y2];
    let d;
    if (len < LINK_SHORT) {
      // 両端を切り落とした弓なりの曲線（頂点のずれは shift の半分）
      const [s, c] = trimBezier(p1, [mx + nx * shift, my + ny * shift], p2);
      const [e, c2] = trimBezier(p2, c, s);
      d = `M ${s} Q ${c2} ${e}`;
    } else {
      // 両端のマスの中で曲がってずらした位置に移り（a、b）、その間はまっすぐ進む
      const turn = Math.max(shift, 0.25); // ずらした位置に移るまでに、線の向きに進む長さ
      const c1 = [x1 + nx * shift, y1 + ny * shift], c2 = [x2 + nx * shift, y2 + ny * shift];
      const a = [c1[0] + ux * turn, c1[1] + uy * turn], b = [c2[0] - ux * turn, c2[1] - uy * turn];
      const [s, sc] = trimBezier(p1, c1, a), [e, ec] = trimBezier(p2, c2, b);
      d = `M ${s} Q ${sc} ${a} L ${b} Q ${ec} ${e}`;
    }
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", strong ? "strong" : "weak");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
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
$("solve").addEventListener("click", () => solveAndShow()); // クリックのイベントを fixed に渡さない
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
