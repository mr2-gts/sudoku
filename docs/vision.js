// 数独の画像を読み取る（sudoku_image.py と digit_features.py を JavaScript に移植したもの）
//
// OpenCV を使わず、必要な画像処理（ぼかし・2値化・射影変換・連結成分・縮小）を自前で実装している。
// ブラウザでもテスト用の Node.js でも動くよう、画像はグレースケールの
// { w: 幅, h: 高さ, data: Uint8Array(w*h) } で受け取る。画面やファイルには触らない。
//
// 処理の流れ（Python 版と同じ）:
//   1. 盤面検出 … 適応的2値化し、いちばん大きい塊の凸包から四隅を求める。
//   2. 歪み補正 … 四隅から射影変換して 450x450 の正方形にする。
//   3. マス分割 … 50x50 ずつ 81 マスに分け、中央付近の、背景よりはっきり濃い塊を数字とみなす。
//   4. 数字認識 … 28x28 に正規化し、見本データと比べる k 近傍法（k=5）。

export const CELL = 50; // 補正後の1マスのピクセル数
export const BOARD = CELL * 9;
const SIDE = 28; // 正規化後の数字画像の大きさ
const BOX = 20; // 数字を収める枠

const newImage = (w, h) => ({ w, h, data: new Uint8Array(w * h) });
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// ---------------------------------------------------------------------------
// 基本的な画像処理
// ---------------------------------------------------------------------------

// OpenCV の getGaussianKernel と同じ係数（sigma を省略したときの値）
function gaussianKernel(ksize) {
  const fixed = { 1: [1], 3: [0.25, 0.5, 0.25], 5: [0.0625, 0.25, 0.375, 0.25, 0.0625] };
  if (fixed[ksize]) return fixed[ksize];
  const sigma = 0.3 * ((ksize - 1) * 0.5 - 1) + 0.8;
  const half = (ksize - 1) / 2;
  const k = [...Array(ksize)].map((_, i) => Math.exp(-((i - half) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  return k.map((v) => v / sum);
}

// 画像の外側の参照位置を決める。reflect101: "cb|abcd|cb"、replicate: "aa|abcd|dd"
const borderIndex = (i, n, mode) => {
  if (i >= 0 && i < n) return i;
  if (n === 1) return 0;
  if (mode === "replicate") return i < 0 ? 0 : n - 1;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
  return i;
};

// ガウスぼかし（縦横に分けて畳み込む）
function gaussianBlur(img, ksize, border = "reflect101") {
  const k = gaussianKernel(ksize), r = (ksize - 1) / 2, { w, h } = img;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * img.data[y * w + borderIndex(x + i, w, border)];
      tmp[y * w + x] = s;
    }
  }
  const out = newImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[borderIndex(y + i, h, border) * w + x];
      out.data[y * w + x] = clamp255(s);
    }
  }
  return out;
}

// 影や明るさのムラに強い適応的2値化。線・数字が白（255）、背景が黒（0）になる。
// cv2.adaptiveThreshold(GaussianBlur 5x5 後, ADAPTIVE_THRESH_GAUSSIAN_C, THRESH_BINARY_INV, block, 7) と同じ。
export function binarize(gray) {
  const blur = gaussianBlur(gray, 5);
  const block = Math.max(11, Math.floor(Math.min(gray.w, gray.h) / 30) | 1);
  const mean = gaussianBlur(blur, block, "replicate");
  const out = newImage(gray.w, gray.h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = blur.data[i] - mean.data[i] <= -7 ? 255 : 0;
  return out;
}

// 連結成分（8近傍）。ラベル画像と、成分ごとの外接矩形・面積・重心を返す（ラベル 0 は背景）。
function connectedComponents(bin) {
  const { w, h, data } = bin;
  const labels = new Int32Array(w * h);
  const stats = [null];
  const stack = [];
  let n = 0;
  for (let start = 0; start < w * h; start++) {
    if (!data[start] || labels[start]) continue;
    n++;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0, sx = 0, sy = 0;
    labels[start] = n;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      area++, sx += x, sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, q = ny * w + nx;
          if (nx < 0 || nx >= w || !data[q] || labels[q]) continue;
          labels[q] = n;
          stack.push(q);
        }
      }
    }
    stats.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area, cx: sx / area, cy: sy / area });
  }
  return { labels, stats };
}

// 双線形補間で拡大縮小する（小さい画像の拡大用）
function resizeLinear(img, nw, nh) {
  const out = newImage(nw, nh), sx = img.w / nw, sy = img.h / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), img.h - 1), y0 = Math.floor(fy), y1 = Math.min(y0 + 1, img.h - 1), ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), img.w - 1), x0 = Math.floor(fx), x1 = Math.min(x0 + 1, img.w - 1), tx = fx - x0;
      const d = img.data, w = img.w;
      const top = d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx;
      const bot = d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx;
      out.data[y * nw + x] = clamp255(top * (1 - ty) + bot * ty);
    }
  }
  return out;
}

// cv2.resize(INTER_AREA) と同じ考え方の拡大縮小。
// 縮小は元画像の対応する範囲の面積平均、拡大は OpenCV と同じ係数の補間。
function resizeArea(img, nw, nh) {
  const scaleX = img.w / nw, scaleY = img.h / nh;
  const out = newImage(nw, nh);
  if (scaleX >= 1 && scaleY >= 1) {
    const spans = (n, scale, size) =>
      [...Array(n)].map((_, i) => {
        const a = i * scale, b = Math.min((i + 1) * scale, size), s = [];
        for (let p = Math.floor(a); p < b; p++) s.push([p, Math.min(b, p + 1) - Math.max(a, p)]);
        return s;
      });
    const xs = spans(nw, scaleX, img.w), ys = spans(nh, scaleY, img.h);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let s = 0, wsum = 0;
        for (const [py, wy] of ys[y]) for (const [px, wx] of xs[x]) (s += img.data[py * img.w + px] * wy * wx), (wsum += wy * wx);
        out.data[y * nw + x] = clamp255(s / wsum);
      }
    }
    return out;
  }
  const coef = (n, scale, size) =>
    [...Array(n)].map((_, d) => {
      let s = Math.floor(d * scale), f = d + 1 - (s + 1) / scale;
      f = f <= 0 ? 0 : f - Math.floor(f);
      if (s < 0) (s = 0), (f = 0);
      if (s >= size - 1) (s = size - 1), (f = 0);
      return [s, f];
    });
  const cx = coef(nw, scaleX, img.w), cy = coef(nh, scaleY, img.h), d = img.data, w = img.w;
  for (let y = 0; y < nh; y++) {
    const [y0, fy] = cy[y], y1 = Math.min(y0 + 1, img.h - 1);
    for (let x = 0; x < nw; x++) {
      const [x0, fx] = cx[x], x1 = Math.min(x0 + 1, img.w - 1);
      const top = d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx;
      const bot = d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx;
      out.data[y * nw + x] = clamp255(top * (1 - fy) + bot * fy);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. 盤面検出
// ---------------------------------------------------------------------------

// 凸包（Andrew の単調連鎖法）。点は [x, y]。
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return half(pts).concat(half(pts.slice().reverse()));
}

// 閉じた折れ線を、誤差 eps 以内の少ない頂点で近似する（Douglas-Peucker 法、cv2.approxPolyDP 相当）
function approxClosedPolygon(poly, eps) {
  const n = poly.length;
  if (n <= 3) return poly;
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  // 互いに遠い2点を始点・終点にして、2つの折れ線に分けてから近似する
  let a = 0, b = 0;
  for (let iter = 0; iter < 3; iter++) {
    let far = a;
    for (let i = 0; i < n; i++) if (d2(poly[i], poly[a]) > d2(poly[far], poly[a])) far = i;
    b = a;
    a = far;
  }
  const simplify = (from, to) => {
    // poly[from] から poly[to] まで（循環）の途中の点のうち、残すものを返す
    const len = (to - from + n) % n;
    if (len < 2) return [];
    const p = poly[from], q = poly[to], L = Math.sqrt(d2(p, q)) || 1;
    let best = -1, bestDist = -1;
    for (let k = 1; k < len; k++) {
      const r = poly[(from + k) % n];
      const dist = Math.abs((q[0] - p[0]) * (p[1] - r[1]) - (p[0] - r[0]) * (q[1] - p[1])) / L;
      if (dist > bestDist) (bestDist = dist), (best = (from + k) % n);
    }
    if (bestDist <= eps) return [];
    return [...simplify(from, best), poly[best], ...simplify(best, to)];
  };
  return [poly[a], ...simplify(a, b), poly[b], ...simplify(b, a)];
}

// 点の集まりから 左上・右上・右下・左下 の4点を選ぶ（x+y と y-x の最大・最小）
function orderCorners(pts) {
  const pick = (f, max) => pts.reduce((best, p) => ((max ? f(p) > f(best) : f(p) < f(best)) ? p : best));
  const sum = (p) => p[0] + p[1], diff = (p) => p[1] - p[0];
  return [pick(sum, false), pick(diff, false), pick(sum, true), pick(diff, true)];
}

// 盤面の四隅 [[x,y] × 4]（左上・右上・右下・左下）を返す。見つからなければ画像全体を盤面とみなす。
export function findBoard(gray) {
  const bin = binarize(gray);
  const { w, h } = bin;
  const { labels, stats } = connectedComponents(bin);
  const imgArea = w * h;
  // いちばん大きい塊（輪郭で囲まれた面積で比べる）を探す。
  // 外接矩形が画像の 2 割に満たない塊は盤面になりえないので調べない。
  let best = -1, bestArea = imgArea * 0.2;
  for (let i = 1; i < stats.length; i++) {
    const s = stats[i];
    if (s.w * s.h < bestArea) continue;
    const area = enclosedArea(labels, w, s, i);
    if (area >= bestArea) (best = i), (bestArea = area);
  }
  if (best === -1) return [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]];

  // 凸包は各行の左端・右端の点だけから求めれば十分
  const s = stats[best], pts = [];
  for (let y = s.y; y < s.y + s.h; y++) {
    let l = -1, r = -1;
    for (let x = s.x; x < s.x + s.w; x++) if (labels[y * w + x] === best) (l = l < 0 ? x : l), (r = x);
    if (l >= 0) pts.push([l, y], [r, y]);
  }
  const hull = convexHull(pts);
  let perim = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    perim += Math.hypot(p[0] - q[0], p[1] - q[1]);
  }
  const approx = approxClosedPolygon(hull, 0.02 * perim);
  // 4角形に近似できないとき（盤面の端が写真の縁に接している等）は、凸包上の点から四隅を直接選ぶ
  return orderCorners(approx.length === 4 ? approx : hull);
}

// 塊 label の外側の輪郭で囲まれた面積（塊の画素数 + 内側の穴）。外接矩形の外周から塗りつぶして数える。
function enclosedArea(labels, w, s, label) {
  const bw = s.w + 2, bh = s.h + 2; // 外接矩形の周りに1画素の余白を付ける
  const seen = new Uint8Array(bw * bh);
  const inside = (x, y) => x > 0 && y > 0 && x <= s.w && y <= s.h && labels[(s.y + y - 1) * w + s.x + x - 1] === label;
  const stack = [0];
  seen[0] = 1;
  let outside = 0;
  while (stack.length) {
    const p = stack.pop(), x = p % bw, y = (p - x) / bw;
    outside++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, q = ny * bw + nx;
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh || seen[q] || inside(nx, ny)) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  return bw * bh - outside;
}

// ---------------------------------------------------------------------------
// 2. 歪み補正（射影変換）
// ---------------------------------------------------------------------------

// 4点 src を 4点 dst に移す射影変換の 3x3 行列（cv2.getPerspectiveTransform 相当）
function perspectiveTransform(src, dst) {
  // 8 元連立方程式をガウスの消去法で解く
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}

// 四隅 corners を 450x450 の正方形に引き伸ばす（cv2.warpPerspective 相当、双線形補間）
export function warpBoard(gray, corners) {
  const dst = [[0, 0], [BOARD - 1, 0], [BOARD - 1, BOARD - 1], [0, BOARD - 1]];
  const m = perspectiveTransform(dst, corners); // 出力の各画素が元画像のどこに当たるか
  const out = newImage(BOARD, BOARD), { w, h, data } = gray;
  for (let y = 0; y < BOARD; y++) {
    for (let x = 0; x < BOARD; x++) {
      const z = m[6] * x + m[7] * y + m[8];
      const sx = (m[0] * x + m[1] * y + m[2]) / z, sy = (m[3] * x + m[4] * y + m[5]) / z;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
      const at = (xx, yy) => (xx >= 0 && yy >= 0 && xx < w && yy < h ? data[yy * w + xx] : 0);
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bot = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      out.data[y * BOARD + x] = clamp255(top * (1 - ty) + bot * ty);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3〜4. マス分割と数字認識
// ---------------------------------------------------------------------------

// 1マス分の2値画像から数字部分だけを取り出す。数字がなければ null。
// 次の条件を満たす塊を数字の一部とみなし、まとめて1つの数字にする（Python 版と同じ）。
// - 罫線ではない（マスの幅・高さいっぱいに伸びていない）
// - マスの中央付近にある（縁に残る罫線の切れ端を避ける）
// - 背景よりはっきり濃い（画面のモアレや紙のざらつきは薄いので除外できる）
// 細い書体では1つの数字がいくつかの塊に分かれることがあるため、塊をまとめてから大きさを判定する。
export const MIN_CONTRAST = 45; // 数字とみなす濃さの下限（背景の明るさとの差、0〜255）

function median(data) {
  const hist = new Uint32Array(256);
  for (const v of data) hist[v]++;
  const half = data.length / 2;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > half) return v;
    if (acc === half) { // 要素数が偶数で、ちょうど真ん中で分かれるときは前後の平均（numpy.median と同じ）
      let u = v + 1;
      while (!hist[u]) u++;
      return (v + u) / 2;
    }
  }
  return 0;
}

export function extractDigit(cell, cellGray) {
  const { w, h } = cell;
  const { labels, stats } = connectedComponents(cell);
  const background = median(cellGray.data);
  const sums = new Float64Array(stats.length);
  for (let i = 0; i < labels.length; i++) if (labels[i]) sums[labels[i]] += cellGray.data[i];
  const keep = new Uint8Array(stats.length);
  let any = false;
  for (let i = 1; i < stats.length; i++) {
    const s = stats[i];
    if (s.area < 8 || s.w > w * 0.9 || s.h > h * 0.95) continue; // ごく小さい点・罫線
    if (!(w * 0.15 < s.cx && s.cx < w * 0.85 && h * 0.15 < s.cy && s.cy < h * 0.85)) continue; // 中央から外れている
    if (background - sums[i] / s.area < MIN_CONTRAST) continue; // 薄いノイズ
    keep[i] = 1;
    any = true;
  }
  if (!any) return null;
  const out = newImage(w, h);
  let y0 = h, y1 = -1, area = 0;
  for (let i = 0; i < labels.length; i++) {
    if (!keep[labels[i]] || !labels[i]) continue;
    out.data[i] = 255;
    area++;
    const y = (i - (i % w)) / w;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (y1 - y0 + 1 < h * 0.3 || area < h * w * 0.02) return null; // 数字にしては小さすぎる
  return out;
}

// Python の round と同じ偶数丸め（12.5 → 12）
const roundHalfEven = (v) => {
  const f = Math.floor(v), d = v - f;
  return d > 0.5 || (d === 0.5 && f % 2 === 1) ? f + 1 : f;
};

// 白い数字・黒い背景の2値画像を、28x28 の中央に寄せた画像にする
export function normalizeDigit(bin) {
  let x0 = bin.w, y0 = bin.h, x1 = -1, y1 = -1;
  for (let y = 0; y < bin.h; y++) {
    for (let x = 0; x < bin.w; x++) {
      if (bin.data[y * bin.w + x]) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
    }
  }
  const crop = newImage(x1 - x0 + 1, y1 - y0 + 1);
  for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) crop.data[y * crop.w + x] = bin.data[(y0 + y) * bin.w + x0 + x];
  const scale = BOX / Math.max(crop.w, crop.h);
  const nw = Math.max(1, roundHalfEven(crop.w * scale)), nh = Math.max(1, roundHalfEven(crop.h * scale));
  const small = resizeArea(crop, nw, nh);
  const out = newImage(SIDE, SIDE);
  const oy = Math.floor((SIDE - nh) / 2), ox = Math.floor((SIDE - nw) / 2);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out.data[(oy + y) * SIDE + ox + x] = small.data[y * nw + x];
  return out;
}

// 28x28 画像を、少しぼかした 784 次元の単位ベクトルにする
export function toFeature(norm) {
  const blurred = gaussianBlur(norm, 3);
  const v = Float32Array.from(blurred.data, (p) => p / 255);
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) + 1e-6;
  return v.map((x) => x / len);
}

// 見本データ（tools/export_web_model.py が作るファイルを展開したもの）との k 近傍法
export class DigitClassifier {
  constructor(buffer, k = 5) {
    const view = new DataView(buffer);
    this.n = view.getUint32(0, true);
    this.dim = view.getUint32(4, true);
    this.labels = new Uint8Array(buffer, 8, this.n);
    this.features = new Uint8Array(buffer, 8 + this.n, this.n * this.dim);
    this.k = k;
  }

  // { digit: 数字, confidence: 近傍 k 件のうち同じ数字の割合 }
  predict(norm) {
    const f = toFeature(norm), dim = this.dim;
    const top = []; // 類似度の高い順に k 件 [類似度, ラベル]
    for (let i = 0; i < this.n; i++) {
      let s = 0;
      const base = i * dim;
      for (let j = 0; j < dim; j++) s += this.features[base + j] * f[j];
      if (top.length < this.k || s > top[top.length - 1][0]) {
        top.push([s, this.labels[i]]);
        top.sort((a, b) => b[0] - a[0]);
        if (top.length > this.k) top.pop();
      }
    }
    const votes = new Array(10).fill(0);
    for (const [, d] of top) votes[d]++;
    const digit = votes.indexOf(Math.max(...votes));
    return { digit, confidence: votes[digit] / this.k };
  }
}

// グレースケール画像から盤面を読み取る。
// 戻り値: { grid: 81 マス（0=空き）, confidence: マスごとの確からしさ（空きは 1）, board: 補正後の盤面画像 }
export function readPuzzle(gray, classifier) {
  if (Math.max(gray.w, gray.h) < 300) gray = resizeLinear(gray, gray.w * 2, gray.h * 2); // 小さい画像は拡大してから処理する
  const board = warpBoard(gray, findBoard(gray));
  const bin = binarize(board);
  const grid = [], confidence = [];
  const m = CELL / 10; // 罫線を避ける余白
  const size = CELL - 2 * m;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = newImage(size, size), cellGray = newImage(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const src = (r * CELL + m + y) * BOARD + c * CELL + m + x;
          cell.data[y * size + x] = bin.data[src];
          cellGray.data[y * size + x] = board.data[src];
        }
      }
      const digit = extractDigit(cell, cellGray);
      if (!digit) {
        grid.push(0);
        confidence.push(1);
      } else {
        const p = classifier.predict(normalizeDigit(digit));
        grid.push(p.digit);
        confidence.push(p.confidence);
      }
    }
  }
  return { grid, confidence, board };
}
