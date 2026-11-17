import type { Data, Layout } from 'plotly.js-dist-min';

import { Analysis, Box, DatasetMeta } from './api';
import { fill, mean, percentile, signed } from './format';
import { MapLayer, MapView, WORLD, cellHasLand, renderMap } from './map-image';
import { Texts } from './i18n';

export interface Figure {
  data: Data[];
  layout: Partial<Layout>;
  /** Анимация при отрисовке: рост значений по оси или плавная смена границ карты. */
  anim?: 'grow-x' | 'grow-y' | 'zoom';
  /**
   * Карта: резкая картинка слоя данных для окна, которое сейчас на экране (размер в пикселях
   * устройства). Вызывается после ручного увеличения; null = дорисовка не нужна.
   */
  sharpen?: (x: [number, number], y: [number, number], widthPx: number, heightPx: number) => object | null;
}

/** Границы оси с запасом и обязательно с нулём: фиксированы, чтобы ось не прыгала во время анимации. */
function padRange(values: (number | null)[]): [number, number] {
  const nums = values.filter((v): v is number => v !== null);
  const lo = Math.min(0, ...nums);
  const hi = Math.max(0, ...nums);
  const pad = (hi - lo || 1) * 0.06;
  return [lo < 0 ? lo - pad : 0, hi > 0 ? hi + pad : 0];
}

const INK = '#264653';
const SEA = '#B8872A'; // тёмный песочный: линия тренда
const GRID = 'rgba(38,70,83,0.1)';
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

function baseLayout(height: number): Partial<Layout> {
  return {
    height,
    margin: { l: 4, r: 4, t: 8, b: 8 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: FONT, color: INK, size: 13 },
    legend: { orientation: 'h', y: -0.12, x: 0 },
    hoverlabel: { font: { family: FONT } },
    xaxis: { automargin: true },
    yaxis: { automargin: true },
    // выделение области выключено: на телефоне оно срабатывало при прокрутке страницы и
    // «увеличивало» график до пустоты; карта включает его обратно сама
    dragmode: false,
  };
}

export interface Stripe {
  color: string;
  title: string;
}

/** Полосы «год за годом»: цвет = отклонение от среднего за период. */
export function stripes(series: (number | null)[], years: number[], palette: string[], decimals: number): Stripe[] {
  const m = mean(series);
  const dev = series.map((v) => (v === null ? null : v - m));
  const vmax = percentile(dev.filter((d): d is number => d !== null).map(Math.abs), 95) || 1;
  const last = palette.length - 1;
  return dev.map((d, i) => {
    if (d === null) return { color: '#E4ECF0', title: `${years[i]}` };
    const t = Math.max(-1, Math.min(1, d / vmax)) * 0.5 + 0.5;
    return { color: palette[Math.round(t * last)], title: `${years[i]}: ${signed(d, decimals)}` };
  });
}

/** Предел цветовой шкалы карты: 98-й перцентиль модуля тренда, чтобы выбросы не съедали контраст. */
export function trendScale(a: Analysis): number {
  const finite: number[] = [];
  for (const row of a.slope10) for (const v of row) if (v !== null) finite.push(Math.abs(v));
  return percentile(finite, 98) || 1;
}

const OCEAN = '#DCE4E2';
/** Ширина картинки всего мира, пикселей (6 на градус): хватает для общего вида и на экранах 2×. */
const WORLD_WIDTH = 2160;
/** Запас вокруг окна при дорисовке: при небольшом сдвиге картинка не кончается у края. */
const PATCH_MARGIN = 0.2;

/** Описание картинки слоя для Plotly: окно view, отрисованное в width×height пикселей. */
function mapPatch(layer: MapLayer, view: MapView, width: number, height: number) {
  return {
    source: renderMap(layer, view, width, height),
    xref: 'x' as const, yref: 'y' as const, x: view.x[0], y: view.y[1],
    sizex: view.x[1] - view.x[0], sizey: view.y[1] - view.y[0],
    xanchor: 'left' as const, yanchor: 'top' as const, sizing: 'stretch' as const, layer: 'below' as const,
  };
}

/** Резкая картинка для окна карты (с запасом по краям). null, если окно — почти весь мир. */
function sharpPatch(layer: MapLayer, x: [number, number], y: [number, number], widthPx: number, heightPx: number) {
  const spanX = x[1] - x[0];
  const spanY = y[1] - y[0];
  if (spanX > 300) return null; // общий вид: хватает картинки всего мира
  const view: MapView = {
    x: [Math.max(-180, x[0] - spanX * PATCH_MARGIN), Math.min(180, x[1] + spanX * PATCH_MARGIN)],
    y: [Math.max(-90, y[0] - spanY * PATCH_MARGIN), Math.min(90, y[1] + spanY * PATCH_MARGIN)],
  };
  // плотность пикселей как на экране, но не больше разумного предела
  const scale = Math.min(1, 2600 / (widthPx * (view.x[1] - view.x[0]) / spanX));
  const width = Math.round((widthPx * (view.x[1] - view.x[0])) / spanX * scale);
  const height = Math.round((heightPx * (view.y[1] - view.y[0])) / spanY * scale);
  return mapPatch(layer, view, Math.max(64, width), Math.max(64, height));
}

/**
 * Карта трендов за десятилетие. Яркий цвет = значимый тренд, приглушённый = незначимый; рамка =
 * выбранный регион. Слой данных, суша и границы приходят готовой картинкой (см. map-image.ts):
 * одна на весь мир и вторая, резкая, на текущее окно. Невидимая тепловая карта даёт подсказки.
 */
export function trendMap(
  a: Analysis, cfg: DatasetMeta, tx: Texts, box: Box, zoom: boolean, layer: MapLayer, compact = false,
): Figure {
  const { lat, lon, slope10, sig } = a;
  const { borders, vmax } = layer;
  const d = cfg.decimals + 1;
  const n = cfg.palette.length - 1;
  const colorscale = cfg.palette.map((c, i) => [i / n, c] as [number, string]);

  // у наземного показателя над морем лежат нули или пропуски: подсказку там не показываем
  const dx = lon[1] - lon[0];
  const dy = lat[1] - lat[0];
  const hoverZ =
    cfg.landOnly && borders
      ? slope10.map((row, i) => row.map((v, j) => (v !== null && cellHasLand(borders, lon[j], lat[i], dx, dy) ? v : null)))
      : slope10;

  const data: Data[] = [
    {
      // невидимая: нужна только для подсказки со значением ячейки под курсором
      type: 'heatmap',
      z: hoverZ,
      hoverongaps: false, // над ячейками без данных подсказки нет
      x: lon,
      y: lat,
      text: sig.map((row) => row.map((s) => (s ? tx.rank_sig : tx.rank_notsig))),
      opacity: 0,
      showscale: false,
      hovertemplate:
        fill(tx.hover_cell, { lat: '%{y:.1f}', lon: '%{x:.1f}' }) +
        `<br><b>%{z:+.${d}f} ${cfg.unit}</b> · %{text}<extra></extra>`,
    } as unknown as Data,
    {
      // пустой ряд, который несёт цветовую шкалу
      type: 'scatter',
      x: [null],
      y: [null],
      mode: 'markers',
      showlegend: false,
      hoverinfo: 'skip',
      marker: {
        color: [0],
        cmin: -vmax,
        cmax: vmax,
        colorscale,
        showscale: true,
        // на телефоне шкала лежит под картой: справа она отнимала бы пятую часть ширины
        colorbar: compact
          ? {
              orientation: 'h', x: 0.5, xanchor: 'center', y: -0.16, yanchor: 'top', thickness: 8, len: 0.92,
              outlinewidth: 0, title: { text: fill(tx.colorbar, { unit: cfg.unit }), side: 'top' },
            }
          : {
              title: { text: fill(tx.colorbar, { unit: cfg.unit }), side: 'right' },
              thickness: 10,
              len: 0.8,
              outlinewidth: 0,
            },
      },
    } as Data,
  ];

  const [la0, la1, lo0, lo1] = box;
  const isGlobal = la0 === -90 && la1 === 90 && lo0 === -180 && lo1 === 180;
  let xr: [number, number] = [-180, 180];
  let yr: [number, number] = [-90, 90];
  if (zoom && !isGlobal) {
    const padY = Math.max(3, (la1 - la0) * 0.15);
    const padX = Math.max(3, (lo1 - lo0) * 0.15);
    xr = [Math.max(-180, lo0 - padX), Math.min(180, lo1 + padX)];
    yr = [Math.max(-90, la0 - padY), Math.min(90, la1 + padY)];
  }

  // до первой отрисовки размер карты неизвестен: берём типичный, после зума Plot дорисует точно
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const images = [mapPatch(layer, WORLD, WORLD_WIDTH, WORLD_WIDTH / 2)];
  const sharp = sharpPatch(layer, xr, yr, Math.round(1000 * dpr), Math.round(470 * dpr));
  if (sharp) images.push(sharp);

  const axis = {
    showgrid: true, gridcolor: 'rgba(38,70,83,0.09)', zeroline: false, ticksuffix: '°', automargin: true,
  };
  const layout: Partial<Layout> = {
    ...baseLayout(compact ? 340 : 520),
    showlegend: false,
    // на телефоне выделение области пальцем мешало бы прокрутке страницы: приближает только тумблер
    dragmode: compact ? false : 'zoom',
    plot_bgcolor: OCEAN,
    xaxis: { ...axis, range: xr },
    yaxis: { ...axis, range: yr },
    images,
    shapes: isGlobal
      ? []
      : [{
          type: 'rect', x0: lo0, x1: lo1, y0: la0, y1: la1,
          line: { color: INK, width: 2 }, fillcolor: 'rgba(0,0,0,0)',
        }],
  };
  return {
    data, layout, anim: 'zoom',
    sharpen: (x, y, widthPx, heightPx) => sharpPatch(layer, x, y, widthPx, heightPx),
  };
}

/** Средний ряд региона и его тренд: то, что нужно для графика динамики. */
export interface SeriesInput {
  series: (number | null)[];
  slope: number;
  intercept: number;
}

/** Отклонения от среднего, скользящее среднее за 5 лет и линия тренда. */
function seriesParts(years: number[], s: SeriesInput) {
  const m = mean(s.series);
  const dev = s.series.map((v) => (v === null ? null : v - m));
  // окно 5 по центру, минимум 3 значения
  const smooth = dev.map((_, i) => {
    const win = dev.slice(Math.max(0, i - 2), i + 3).filter((v): v is number => v !== null);
    return win.length >= 3 ? win.reduce((sum, v) => sum + v, 0) / win.length : null;
  });
  const line = years.map((y) => s.slope * y + s.intercept - m);
  return { dev, smooth, line };
}

/** Общие границы оси Y для нескольких рядов: на вкладке сравнения шкала у графиков одна. */
export function seriesRange(years: number[], list: SeriesInput[]): [number, number] {
  return padRange(list.flatMap((s) => Object.values(seriesParts(years, s)).flat()));
}

/** Столбцы отклонений от среднего, среднее за 5 лет и линия тренда Тейла–Сена. */
export function seriesChart(
  years: number[], s: SeriesInput, cfg: DatasetMeta, tx: Texts,
  opts: { range?: [number, number]; height?: number; compact?: boolean } = {},
): Figure {
  const { dev, smooth, line } = seriesParts(years, s);
  const d = cfg.decimals;

  const data: Data[] = [
    {
      type: 'bar',
      x: years,
      y: dev,
      marker: { color: dev.map((v) => ((v ?? 0) >= 0 ? cfg.colorPos : cfg.colorNeg)) },
      name: tx.dev_label,
      hovertemplate: `%{x}: %{y:+.${d}f} ${cfg.unit}<extra></extra>`,
    },
    {
      type: 'scatter', x: years, y: smooth, mode: 'lines', name: tx.smooth,
      line: { color: INK, width: 2 }, hoverinfo: 'skip',
    },
    {
      type: 'scatter', x: years, y: line, mode: 'lines', name: tx.trend_line,
      line: { color: SEA, width: 3, dash: 'dash' }, hoverinfo: 'skip',
    },
  ];
  const layout: Partial<Layout> = {
    ...baseLayout(opts.height ?? 420),
    // в узком графике подпись оси «Год» не нужна (годы и так видны) и мешала бы легенде
    legend: { orientation: 'h', y: opts.compact ? -0.12 : -0.2, x: 0 },
    xaxis: { title: { text: opts.compact ? '' : tx.year }, showgrid: false, automargin: true, fixedrange: true },
    yaxis: {
      title: { text: cfg.unit }, gridcolor: GRID, zeroline: true, zerolinecolor: INK, automargin: true,
      fixedrange: true, range: opts.range ?? padRange([...dev, ...smooth, ...line]),
    },
  };
  return { data, layout, anim: 'grow-y' };
}

export interface RankView {
  name: string;
  slope10: number;
  total: number;
  p: number;
  significant: boolean;
}

/** Тренд по готовым регионам: яркие столбцы значимые, светлые нет. */
export function rankingChart(rows: RankView[], cfg: DatasetMeta, tx: Texts): Figure {
  const sorted = [...rows].sort((x, y) => x.slope10 - y.slope10);
  const d = cfg.decimals + 1;
  const data: Data[] = [
    {
      type: 'bar',
      orientation: 'h',
      x: sorted.map((r) => r.slope10),
      y: sorted.map((r) => r.name),
      marker: {
        color: sorted.map((r) => (!r.significant ? '#C9D5DD' : r.slope10 >= 0 ? cfg.colorPos : cfg.colorNeg)),
      },
      customdata: sorted.map((r) => [r.significant ? tx.rank_sig : tx.rank_notsig]),
      hovertemplate: `%{y}: %{x:+.${d}f} ${cfg.unit}<br>%{customdata[0]}<extra></extra>`,
    },
  ];
  const layout: Partial<Layout> = {
    ...baseLayout(60 + 38 * sorted.length),
    xaxis: {
      title: { text: `${cfg.unit} / ${tx.per_decade}` }, gridcolor: GRID, zeroline: true,
      zerolinecolor: INK, automargin: true, fixedrange: true, range: padRange(sorted.map((r) => r.slope10)),
    },
    yaxis: { showgrid: false, automargin: true, ticksuffix: '  ', fixedrange: true },
  };
  return { data, layout, anim: 'grow-x' };
}
