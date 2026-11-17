import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, effect, inject, input, signal } from '@angular/core';

import { Figure } from './charts';

type PlotlyModule = typeof import('plotly.js-dist-min');
type Series = (number | null)[];
type Ranges = { x: [number, number]; y: [number, number] };

let plotly: Promise<PlotlyModule> | undefined;

/** Plotly большой, поэтому грузится отдельным чанком при первом графике. */
function loadPlotly(): Promise<PlotlyModule> {
  plotly ??= import('plotly.js-dist-min').then((m) => (m as unknown as { default?: PlotlyModule }).default ?? m);
  return plotly;
}

/** PNG фигуры (data URL) для отчётов: рисуется вне экрана, с белым фоном и удвоенной плотностью. */
export async function figureToPng(fig: Figure, width: number, height: number): Promise<string> {
  const P = await loadPlotly();
  const layout = { ...structuredClone(fig.layout), width, height, paper_bgcolor: '#FFFFFF' };
  return P.toImage({ data: fig.data, layout }, { format: 'png', width, height, scale: 2 });
}

const CONFIG = { responsive: true, displaylogo: false, displayModeBar: false };
/** У карты двойной щелчок обрабатываем сами: встроенный сброс Plotly возвращает к устаревшим границам. */
const MAP_CONFIG = { ...CONFIG, doubleClick: false as const };
const sameRanges = (a: Ranges, b: Ranges) =>
  [0, 1].every((i) => Math.abs(a.x[i] - b.x[i]) < 1e-6 && Math.abs(a.y[i] - b.y[i]) < 1e-6);
const GROW_MS = 1700;
const ZOOM_MS = 1100;
/** Доля длительности, на которую растянут «каскад»: последний столбец стартует позже первого. */
const STAGGER = 0.45;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/**
 * Plotly меняет переданный layout (например, стирает height при авторазмере), а фигура у нас
 * кэшируется и переиспользуется при возврате на вкладку, поэтому отдаём ему только копии.
 */
const copy = (layout: Figure['layout']) => structuredClone(layout);

@Component({
  selector: 'app-plot',
  template: '',
  styles: ':host { display: block; width: 100%; }',
  // Высота задаётся явно: место под график занято ещё до отрисовки и не зависит от внутренней вёрстки Plotly.
  host: { '[style.height.px]': 'figure().layout.height' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Plot implements OnDestroy {
  readonly figure = input.required<Figure>();
  /** Карта: пользователь сдвинул или увеличил вид мышью, и он отличается от заданного фигурой. */
  readonly moved = signal(false);

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private destroyed = false;
  /** Номер текущей отрисовки: новая фигура отменяет анимацию предыдущей. */
  private run = 0;
  private raf = 0;
  private prevValues: Series[] | null = null;
  private animating = false;
  private listening = false;
  private sharpenTimer = 0;

  constructor() {
    effect(() => void this.render(this.figure()));
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.sharpenTimer);
    void loadPlotly().then((P) => P.purge(this.host));
  }

  private async render(fig: Figure): Promise<void> {
    const run = ++this.run;
    cancelAnimationFrame(this.raf);
    const P = await loadPlotly();
    if (this.destroyed || run !== this.run) return;

    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (fig.anim === 'zoom') {
      await this.renderZoom(P, fig, run, still);
    } else if (fig.anim) {
      this.renderGrow(P, fig, run, still);
    } else {
      await P.react(this.host, fig.data, copy(fig.layout), CONFIG);
    }
  }

  /** Столбцы и линии вырастают от нуля (первый показ) или перетекают из прежних значений. */
  private renderGrow(P: PlotlyModule, fig: Figure, run: number, still: boolean): void {
    const key = fig.anim === 'grow-x' ? 'x' : 'y';
    const traces = fig.data as unknown as Record<string, unknown>[];
    const targets = traces.map((t) => t[key] as Series);
    const starts = targets.map((arr, k) => {
      const prev = this.prevValues?.[k];
      return prev?.length === arr.length ? prev : arr.map(() => 0);
    });
    this.prevValues = targets;

    const changed = targets.some((arr, k) => arr.some((v, i) => v !== starts[k][i]));
    if (still || !changed) {
      void P.react(this.host, fig.data, copy(fig.layout), CONFIG);
      return;
    }
    this.tween(run, GROW_MS, (t) => {
      const data = traces.map((trace, k) => {
        const n = Math.max(1, targets[k].length - 1);
        const values = targets[k].map((to, i) => {
          if (to === null) return null;
          const local = Math.min(1, Math.max(0, (t - (STAGGER * i) / n) / (1 - STAGGER)));
          return lerp(starts[k][i] ?? 0, to, easeOutCubic(local));
        });
        return { ...trace, [key]: values };
      });
      return P.react(this.host, t < 1 ? (data as unknown as Figure['data']) : fig.data, copy(fig.layout), CONFIG);
    });
  }

  /** Карта: плавный «наезд» на регион при смене границ осей. */
  private async renderZoom(P: PlotlyModule, fig: Figure, run: number, still: boolean): Promise<void> {
    const to: Ranges = {
      x: fig.layout.xaxis!.range as [number, number],
      y: fig.layout.yaxis!.range as [number, number],
    };
    // стартуем от того, что сейчас на экране (включая ручное увеличение мышью)
    const from = this.currentRanges();
    if (still || !from || sameRanges(from, to)) {
      await P.react(this.host, fig.data, copy(fig.layout), MAP_CONFIG);
      this.listen();
      this.moved.set(false);
      return;
    }
    const startLayout = {
      ...fig.layout,
      xaxis: { ...fig.layout.xaxis, range: from.x },
      yaxis: { ...fig.layout.yaxis, range: from.y },
    };
    this.animating = true;
    await P.react(this.host, fig.data, copy(startLayout), MAP_CONFIG);
    if (this.destroyed || run !== this.run) return;
    this.flyTo(P, from, to, run);
  }

  /** Возвращает карту к границам, заданным фигурой (кнопка сброса и двойной щелчок). */
  resetView(): void {
    const fig = this.figure();
    if (fig.anim !== 'zoom') return;
    const to: Ranges = {
      x: fig.layout.xaxis!.range as [number, number],
      y: fig.layout.yaxis!.range as [number, number],
    };
    const run = ++this.run;
    cancelAnimationFrame(this.raf);
    void loadPlotly().then((P) => {
      const from = this.currentRanges();
      if (this.destroyed || run !== this.run || !from) return;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        void P.relayout(this.host, { 'xaxis.range': [...to.x], 'yaxis.range': [...to.y] } as Parameters<PlotlyModule['relayout']>[1]);
        this.moved.set(false);
      } else {
        this.flyTo(P, from, to, run);
      }
    });
  }

  private flyTo(P: PlotlyModule, from: Ranges, to: Ranges, run: number): void {
    this.animating = true;
    this.tween(run, ZOOM_MS, async (t) => {
      const e = easeInOutCubic(t);
      const update = {
        'xaxis.range': t < 1 ? [lerp(from.x[0], to.x[0], e), lerp(from.x[1], to.x[1], e)] : [...to.x],
        'yaxis.range': t < 1 ? [lerp(from.y[0], to.y[0], e), lerp(from.y[1], to.y[1], e)] : [...to.y],
      };
      await P.relayout(this.host, update as Parameters<PlotlyModule['relayout']>[1]);
      if (t === 1) {
        this.animating = false;
        this.moved.set(false);
        this.listen();
      }
    });
  }

  /** Границы осей, которые сейчас реально показаны (null до первой отрисовки). */
  private currentRanges(): Ranges | null {
    const full = (this.host as unknown as { _fullLayout?: { xaxis?: { range?: number[] }; yaxis?: { range?: number[] } } })
      ._fullLayout;
    const x = full?.xaxis?.range;
    const y = full?.yaxis?.range;
    return x && y ? { x: [x[0], x[1]], y: [y[0], y[1]] } : null;
  }

  /** Следит за ручным изменением вида и перехватывает двойной щелчок. Подписка одна на весь срок жизни графика. */
  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    const el = this.host as unknown as { on(event: string, handler: (e: Record<string, unknown>) => void): void };
    el.on('plotly_relayout', (e) => {
      // интересуют только изменения границ осей (подмена картинки тоже приходит как relayout)
      if (this.animating || !Object.keys(e ?? {}).some((k) => k.startsWith('xaxis.') || k.startsWith('yaxis.'))) return;
      const fig = this.figure();
      const now = this.currentRanges();
      if (fig.anim !== 'zoom' || !now) return;
      const target = { x: fig.layout.xaxis!.range, y: fig.layout.yaxis!.range } as Ranges;
      this.moved.set(!sameRanges(now, target));
      clearTimeout(this.sharpenTimer);
      this.sharpenTimer = window.setTimeout(() => this.sharpen(), 180);
    });
    el.on('plotly_doubleclick', () => this.resetView());
  }

  /** После ручного увеличения подменяет картинку карты на резкую, отрисованную под текущее окно. */
  private sharpen(): void {
    const fig = this.figure();
    const now = this.currentRanges();
    const size = (this.host as unknown as { _fullLayout?: { _size?: { w: number; h: number } } })._fullLayout?._size;
    if (this.destroyed || this.animating || !fig.sharpen || !now || !size) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const image = fig.sharpen(now.x, now.y, Math.round(size.w * dpr), Math.round(size.h * dpr));
    if (!image) return;
    void loadPlotly().then((P) => {
      if (!this.destroyed) void P.relayout(this.host, { 'images[1]': image } as Parameters<PlotlyModule['relayout']>[1]);
    });
  }

  /** Кадры идут строго по очереди: следующий запрашивается только после завершения отрисовки предыдущего. */
  private tween(run: number, duration: number, frame: (t: number) => Promise<unknown>): void {
    const t0 = performance.now();
    const step = async (now: number) => {
      if (this.destroyed || run !== this.run) return;
      const t = Math.min(1, (now - t0) / duration);
      await frame(t);
      if (t < 1 && !this.destroyed && run === this.run) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
}
