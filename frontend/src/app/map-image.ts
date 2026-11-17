import { Borders } from './api';

/**
 * Слой данных для карты: сетка трендов, отрисованная в картинку под нужный участок и разрешение.
 *
 * Обычная тепловая карта рисует каждую ячейку квадратом. Здесь для каждого пикселя картинки
 * значение берётся сглаженной интерполяцией соседних ячеек (кубический B-сплайн, в пространстве
 * значений, а не цветов), цвет приглушается там, где тренд не значим, картинка обрезается по
 * контуру суши, и поверх рисуются границы стран. Поскольку картинка строится под конкретное окно
 * карты, при приближении её можно перерисовать, и она остаётся резкой.
 */

export interface MapLayer {
  /** Ключ кэша: всё, от чего зависит картинка (набор, сезон, период, уровень значимости). */
  key: string;
  lat: number[];
  lon: number[];
  z: (number | null)[][];
  /** 1 = тренд в ячейке значим. */
  sig: number[][];
  palette: string[];
  vmax: number;
  borders: Borders | null;
  /** Показатель определён только на суше: данные обрезаются по береговой линии. */
  landOnly: boolean;
}

export interface MapView {
  /** Долгота: запад, восток. */
  x: [number, number];
  /** Широта: юг, север. */
  y: [number, number];
}

export const WORLD: MapView = { x: [-180, 180], y: [-90, 90] };

const LAND_COLOR = '#FBF8EF';
const BORDER_COLOR = 'rgba(38, 70, 83, 0.6)';
/** К этому цвету смешиваются ячейки с незначимым трендом. */
const WASH = [244, 241, 232];
/** Доля приглушения цвета при незначимом тренде. */
const WASH_AMOUNT = 0.62;

const cache = new Map<string, string>();
const CACHE_SIZE = 10;

/** Картинка (data URL) слоя для окна view размером width×height пикселей. */
export function renderMap(layer: MapLayer, view: MapView, width: number, height: number): string {
  const key = [layer.key, layer.borders?.x.length ?? 0, ...view.x, ...view.y, width, height].join('|');
  const hit = cache.get(key);
  if (hit) return hit;
  const url = draw(layer, view, width, height);
  cache.set(key, url);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return url;
}

// ---------- суша ----------

/** Пикселей на градус в маске суши: 0.25° хватает, чтобы отличить прибрежную ячейку от морской. */
const MASK_PX = 4;
const masks = new WeakMap<Borders, Uint8ClampedArray>();

/** Контуры стран в пикселях картинки для окна view (null в ломаной разделяет кольца). */
function landPath(borders: Borders, view: MapView, width: number, height: number): Path2D {
  const kx = width / (view.x[1] - view.x[0]);
  const ky = height / (view.y[1] - view.y[0]);
  const path = new Path2D();
  let open = false;
  for (let i = 0; i < borders.x.length; i++) {
    const x = borders.x[i];
    const y = borders.y[i];
    if (x === null || y === null) {
      if (open) path.closePath();
      open = false;
      continue;
    }
    const px = (x - view.x[0]) * kx;
    const py = (view.y[1] - y) * ky;
    if (open) path.lineTo(px, py);
    else path.moveTo(px, py);
    open = true;
  }
  if (open) path.closePath();
  return path;
}

/** Маска суши растром: контуры рисуются один раз, дальше проверка точки — чтение одного пикселя. */
function landMask(borders: Borders): Uint8ClampedArray {
  let mask = masks.get(borders);
  if (!mask) {
    const canvas = document.createElement('canvas');
    canvas.width = 360 * MASK_PX;
    canvas.height = 180 * MASK_PX;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fill(landPath(borders, WORLD, canvas.width, canvas.height));
    mask = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    masks.set(borders, mask);
  }
  return mask;
}

/** Попадает ли точка на сушу (по тем же контурам, которыми обрезается картинка). */
export function onLand(borders: Borders, lon: number, lat: number): boolean {
  const w = 360 * MASK_PX;
  const x = Math.min(w - 1, Math.max(0, Math.floor((lon + 180) * MASK_PX)));
  const y = Math.min(180 * MASK_PX - 1, Math.max(0, Math.floor((90 - lat) * MASK_PX)));
  return landMask(borders)[(y * w + x) * 4 + 3] > 0;
}

/** Есть ли в ячейке сетки суша: проверяются центр и четыре точки на полпути к углам. */
export function cellHasLand(borders: Borders, lon: number, lat: number, dx: number, dy: number): boolean {
  return (
    onLand(borders, lon, lat) ||
    onLand(borders, lon - dx / 4, lat - dy / 4) || onLand(borders, lon + dx / 4, lat - dy / 4) ||
    onLand(borders, lon - dx / 4, lat + dy / 4) || onLand(borders, lon + dx / 4, lat + dy / 4)
  );
}

// ---------- сетка ----------

interface Grid {
  ny: number;
  nx: number;
  value: Float32Array;
  sig: Float32Array;
}

const grids = new Map<string, Grid>();

/** Плоские массивы значений и значимости; для наземных показателей данные дотянуты на ячейку за свой край. */
function gridOf(layer: MapLayer): Grid {
  const hit = grids.get(layer.key);
  if (hit) return hit;
  const ny = layer.lat.length;
  const nx = layer.lon.length;
  const value = new Float32Array(ny * nx);
  const sig = new Float32Array(ny * nx);
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      value[i * nx + j] = layer.z[i][j] ?? NaN;
      sig[i * nx + j] = layer.sig[i][j];
    }
  }
  // наземный показатель обрежет береговая линия, поэтому дотягиваем данные на одну ячейку за их
  // край: у берега не остаётся пустой каймы
  if (layer.landOnly && layer.borders) dilate(value, sig, ny, nx);
  const grid = { ny, nx, value, sig };
  grids.set(layer.key, grid);
  if (grids.size > 4) grids.delete(grids.keys().next().value!);
  return grid;
}

/** Пустые ячейки, соседние с заполненными, получают среднее соседей (и значение, и значимость). */
function dilate(value: Float32Array, sig: Float32Array, ny: number, nx: number): void {
  const src = value.slice();
  const srcSig = sig.slice();
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      if (src[i * nx + j] === src[i * nx + j]) continue;
      let sum = 0;
      let sumSig = 0;
      let n = 0;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const a = i + di;
          const b = j + dj;
          if (a < 0 || a >= ny || b < 0 || b >= nx) continue;
          const v = src[a * nx + b];
          if (v === v) {
            sum += v;
            sumSig += srcSig[a * nx + b];
            n++;
          }
        }
      }
      if (n) {
        value[i * nx + j] = sum / n;
        sig[i * nx + j] = sumSig / n;
      }
    }
  }
}

// ---------- отрисовка ----------

const TABLE = 512;

/** Таблица цветов: линейная интерполяция между опорными цветами палитры. */
function colorTable(palette: string[]): Uint8ClampedArray {
  const stops = palette.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  const table = new Uint8ClampedArray(TABLE * 3);
  for (let k = 0; k < TABLE; k++) {
    const pos = (k / (TABLE - 1)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const t = pos - i;
    for (let c = 0; c < 3; c++) table[k * 3 + c] = stops[i][c] + (stops[i + 1][c] - stops[i][c]) * t;
  }
  return table;
}

/**
 * Для каждого пикселя вдоль одной оси: индексы четырёх соседних ячеек и их веса (кубический
 * B-сплайн). Веса неотрицательны, поэтому пропуски в данных можно просто исключать из суммы.
 */
function taps(count: number, n: number, cellOf: (pixel: number) => number): { index: Int32Array; weight: Float32Array } {
  const index = new Int32Array(count * 4);
  const weight = new Float32Array(count * 4);
  for (let p = 0; p < count; p++) {
    const g = cellOf(p + 0.5);
    const base = Math.floor(g);
    const t = g - base;
    const w = [
      (1 - t) ** 3 / 6,
      (3 * t ** 3 - 6 * t ** 2 + 4) / 6,
      (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6,
      t ** 3 / 6,
    ];
    for (let k = 0; k < 4; k++) {
      index[p * 4 + k] = Math.min(n - 1, Math.max(0, base - 1 + k));
      weight[p * 4 + k] = w[k];
    }
  }
  return { index, weight };
}

function draw(layer: MapLayer, view: MapView, width: number, height: number): string {
  const { ny, nx, value, sig } = gridOf(layer);
  const { lat, lon, vmax, borders } = layer;
  const dx = (lon[nx - 1] - lon[0]) / (nx - 1);
  const dy = (lat[ny - 1] - lat[0]) / (ny - 1);
  const lonPerPx = (view.x[1] - view.x[0]) / width;
  const latPerPx = (view.y[1] - view.y[0]) / height;
  const cols = taps(width, nx, (p) => (view.x[0] + p * lonPerPx - lon[0]) / dx);
  const rows = taps(height, ny, (p) => (view.y[1] - p * latPerPx - lat[0]) / dy);
  const colors = colorTable(layer.palette);

  const data = document.createElement('canvas');
  data.width = width;
  data.height = height;
  const dctx = data.getContext('2d')!;
  const img = dctx.createImageData(width, height);
  const out = img.data;

  for (let py = 0; py < height; py++) {
    const r = py * 4;
    for (let px = 0; px < width; px++) {
      const c = px * 4;
      let sum = 0;
      let sumSig = 0;
      let cover = 0;
      for (let a = 0; a < 4; a++) {
        const row = rows.index[r + a] * nx;
        const wy = rows.weight[r + a];
        for (let b = 0; b < 4; b++) {
          const cell = row + cols.index[c + b];
          const v = value[cell];
          if (v === v) { // не NaN
            const w = wy * cols.weight[c + b];
            sum += v * w;
            sumSig += sig[cell] * w;
            cover += w;
          }
        }
      }
      if (cover < 0.02) continue;

      const t = Math.max(-1, Math.min(1, sum / cover / vmax)) * 0.5 + 0.5;
      const k = Math.round(t * (TABLE - 1)) * 3;
      const wash = WASH_AMOUNT * (1 - sumSig / cover);
      const o = (py * width + px) * 4;
      out[o] = colors[k] + (WASH[0] - colors[k]) * wash;
      out[o + 1] = colors[k + 1] + (WASH[1] - colors[k + 1]) * wash;
      out[o + 2] = colors[k + 2] + (WASH[2] - colors[k + 2]) * wash;
      const edge = Math.max(0, Math.min(1, (cover - 0.35) / 0.3)); // скруглённый, но чёткий край данных
      out[o + 3] = 255 * edge * edge * (3 - 2 * edge);
    }
  }
  dctx.putImageData(img, 0, 0);

  // суша, поверх неё данные (обрезанные по берегу, если нужно), поверх всего границы стран
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const land = borders ? landPath(borders, view, width, height) : null;
  if (land) {
    ctx.fillStyle = LAND_COLOR;
    ctx.fill(land);
  }
  ctx.save();
  if (land && layer.landOnly) ctx.clip(land);
  ctx.drawImage(data, 0, 0);
  ctx.restore();
  if (land) {
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = Math.max(1, width / 1700);
    ctx.lineJoin = 'round';
    ctx.stroke(land);
  }
  return canvas.toDataURL('image/png');
}
