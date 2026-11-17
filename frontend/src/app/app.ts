import {
  ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal, viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { catchError, debounceTime, map, of, switchMap, tap } from 'rxjs';

import { Analysis, AnalysisParams, Api, Borders, Box, Hotspot, Meta } from './api';
import {
  RankView, SeriesInput, rankingChart, seriesChart, seriesRange, stripes, trendMap, trendScale,
} from './charts';
import { codeParts, download, fill, fmtBox, fmtP, signed } from './format';
import { TEXT } from './i18n';
import { MapLayer } from './map-image';
import { Plot, figureToPng } from './plot';
import { RangeSlider } from './range-slider';
import { Select, SelectOption } from './select';

type Tab = 'map' | 'series' | 'compare' | 'rank' | 'method';
type Direction = 'up' | 'down' | 'flat';
/** Параметры запроса + ключ региона, чтобы подписи всегда соответствовали показанным данным. */
type Request = AnalysisParams & { regionKey: string };

/** Язык, на котором берутся названия из API (там они хранятся на двух языках). */
const LANG = 'en';
const NARROW = '(max-width: 700px)';
const MIN_SPAN = 9; // y1 - y0, то есть минимум 10 лет

@Component({
  selector: 'app-root',
  imports: [Plot, RangeSlider, Select],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly api = inject(Api);

  // ---------- состояние ----------
  protected readonly lang = LANG;
  protected readonly meta = signal<Meta | null>(null);
  protected readonly metaFailed = signal(false);
  private readonly borders = signal<Borders | null>(null);

  protected readonly dsKey = signal('');
  protected readonly season = signal('annual');
  protected readonly regionKey = signal('global');
  protected readonly customLat = signal<[number, number]>([30, 50]);
  protected readonly customLon = signal<[number, number]>([60, 90]);
  protected readonly alpha = signal(0.05);
  protected readonly strict = signal(false);
  protected readonly tab = signal<Tab>('map');
  /** Телефон: фильтры свёрнуты в шапку и раскрываются кнопкой. */
  protected readonly filtersOpen = signal(false);
  /** Узкий экран: карта ниже, цветовая шкала под ней. */
  protected readonly narrow = signal(matchMedia(NARROW).matches);
  /** Какой отчёт сейчас формируется (кнопки на это время заблокированы). */
  protected readonly exporting = signal<'pdf' | 'docx' | null>(null);
  protected readonly exportFailed = signal(false);
  protected readonly mapPlot = viewChild<Plot>('mapPlot');

  protected readonly tx = TEXT;
  protected readonly cfg = computed(() => this.meta()?.datasets.find((d) => d.key === this.dsKey()) ?? null);

  /** Доступные годы для выбранного показателя и сезона. */
  protected readonly bounds = computed<[number, number] | null>(() => this.cfg()?.years[this.season()] ?? null, {
    equal: (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1],
  });

  /** Период сбрасывается на значение по умолчанию, когда меняется доступный диапазон лет. */
  protected readonly period = linkedSignal<[number, number] | null, [number, number]>({
    source: this.bounds,
    computation: (b) => {
      if (!b) return [0, 0];
      const [ymin, ymax] = b;
      return [ymax - 1980 >= MIN_SPAN ? Math.max(ymin, 1980) : ymin, ymax];
    },
  });

  protected readonly zoom = linkedSignal(() => this.regionKey() !== 'global');

  protected readonly box = computed<Box>(() => {
    const key = this.regionKey();
    if (key === 'custom') return [...this.customLat(), ...this.customLon()];
    return this.meta()?.regions.find((r) => r.key === key)?.box ?? [-90, 90, -180, 180];
  });

  protected readonly tooShort = computed(() => {
    const b = this.bounds();
    const [y0, y1] = this.period();
    return !!this.cfg() && (!b || b[1] - b[0] < MIN_SPAN || y1 - y0 < MIN_SPAN);
  });

  private readonly request = computed<Request | null>(() => {
    if (!this.cfg() || this.tooShort()) return null;
    const [y0, y1] = this.period();
    return {
      dataset: this.dsKey(), season: this.season(), y0, y1, box: this.box(),
      alpha: this.alpha(), strict: this.strict(), regionKey: this.regionKey(),
    };
  });

  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  private readonly result = signal<{ a: Analysis; req: Request } | null>(null);

  // ---------- представление ----------
  /** Всё, что выводится в шапке, карточках и таблицах; считается из последнего ответа сервера. */
  protected readonly view = computed(() => {
    const r = this.result();
    const meta = this.meta();
    const cfg = meta?.datasets.find((d) => d.key === r?.req.dataset);
    if (!r || !meta || !cfg) return null;
    const { a, req } = r;
    const tx = this.tx;
    const d = cfg.decimals;
    const y0 = a.years[0];
    const y1 = a.years[a.years.length - 1];
    const regionName = this.regionName(req.regionKey);
    const base = { a, req, cfg, regionName, y0, y1 };
    if (!a.region) return { ...base, region: null };

    const s10 = a.region.slope * 10;
    const total = a.region.slope * (y1 - y0);
    const isSig = a.region.p < req.alpha;
    const direction: Direction = s10 > 0 ? 'up' : s10 < 0 ? 'down' : 'flat';
    const metric = cfg.metric[LANG];
    const p = fmtP(a.region.p);
    const totalText = signed(total, d);

    let finding = fill(tx[`finding_${direction}`], {
      region: regionName, metric, slope: Math.abs(s10).toFixed(d), unit: cfg.unit, total: totalText, y0, y1,
    });
    if (direction !== 'flat') finding += ' ' + fill(isSig ? tx.finding_sig : tx.finding_notsig, { p });
    if (a.region.share !== null) finding += ' ' + fill(tx.finding_share, { share: a.region.share.toFixed(0) });

    const color = { up: cfg.colorPos, down: cfg.colorNeg, flat: null }[direction];
    const arrow = { up: '↗', down: '↘', flat: '→' }[direction];
    const kpis = [
      { label: tx.kpi_what, value: tx[direction], sub: metric, color, icon: arrow, sig: null },
      { label: tx.kpi_where, value: regionName, sub: fmtBox(req.box), color: null, icon: '', sig: null },
      {
        label: tx.kpi_how,
        value: `${signed(s10, d)} ${cfg.unit}`,
        sub: `${tx.per_decade}, ` + fill(tx.total_over, { total: totalText, unit: cfg.unit, y0, y1 }),
        color: null, icon: '', sig: null,
      },
      {
        label: tx.kpi_sig, value: isSig ? tx.yes : tx.no,
        sub: fill(tx.p_alpha, { p, alpha: req.alpha }), color: null, icon: '', sig: isSig as boolean | null,
      },
    ];

    const hot = (rows: Hotspot[]) =>
      rows.map((h) => ({
        lat: `${h.lat.toFixed(0)}°`, lon: `${h.lon.toFixed(0)}°`, trend: `${signed(h.slope, d + 1)} ${cfg.unit}`,
      }));

    const rank: RankView[] = a.ranking.map((row) => ({
      name: this.regionName(row.key),
      slope10: row.slope * 10,
      total: row.slope * (y1 - y0),
      p: row.p,
      significant: row.significant,
    }));
    const rankTable = [...rank]
      .sort((x, y) => Math.abs(y.slope10) - Math.abs(x.slope10))
      .map((row) => ({
        name: row.name,
        trend: `${signed(row.slope10, d)} ${cfg.unit}`,
        total: `${signed(row.total, d)} ${cfg.unit}`,
        p: fmtP(row.p),
        sig: row.significant ? tx.sig_mark : tx.notsig_mark,
        significant: row.significant,
      }));

    return {
      ...base,
      region: {
        stripes: stripes(a.region.series, a.years, cfg.palette, d),
        stripesCaption: fill(tx.stripes_caption, { region: regionName, y0, y1 }),
        kpis,
        finding,
        mapTitle: fill(tx.map_title, { y0, y1, unit: cfg.unit }),
        hotspots: [
          { title: tx.hot_up, rows: hot(a.hotspots.up) },
          { title: tx.hot_down, rows: hot(a.hotspots.down) },
        ],
        seriesTitle: fill(tx.series_title, { region: regionName }),
        rank,
        rankTable,
      },
    };
  });

  /** При слишком коротком периоде старый результат не показываем: он не соответствует выбору. */
  protected readonly shown = computed(() => (this.tooShort() ? null : this.view()));

  protected readonly mapFigure = computed(() => {
    const v = this.view();
    if (!v?.region) return null;
    const { a, cfg, req } = v;
    // картинка слоя зависит от сетки трендов и маски значимости: по этому ключу она кэшируется
    const layer: MapLayer = {
      key: `${req.dataset}|${req.season}|${req.y0}|${req.y1}|${req.alpha}|${req.strict}`,
      lat: a.lat, lon: a.lon, z: a.slope10, sig: a.sig, palette: cfg.palette, vmax: trendScale(a),
      borders: this.borders(), landOnly: cfg.landOnly,
    };
    return trendMap(a, cfg, this.tx, req.box, this.zoom(), layer, this.narrow());
  });

  protected readonly seriesFigure = computed(() => {
    const v = this.view();
    return v?.region ? seriesChart(v.a.years, v.a.region!, v.cfg, this.tx) : null;
  });

  // ---------- сравнение двух регионов ----------
  /** Левый регион по умолчанию следует за выбором в боковой панели. */
  protected readonly compareA = linkedSignal(() => this.regionKey());
  protected readonly compareB = signal('global');

  /** Два региона рядом: одинаковые графики динамики с общей шкалой и вывод, кто меняется быстрее. */
  protected readonly compare = computed(() => {
    const v = this.view();
    if (!v?.region) return null;
    const { a, req, cfg } = v;
    const tx = this.tx;
    const d = cfg.decimals;
    const span = v.y1 - v.y0;

    // готовые регионы из ответа сервера + текущий выбор (он может быть своим прямоугольником)
    type Side = SeriesInput & { name: string; p: number; significant: boolean };
    const sides = new Map<string, Side>();
    for (const row of a.ranking) sides.set(row.key, { ...row, name: this.regionName(row.key) });
    sides.set(req.regionKey, {
      name: v.regionName, series: a.region!.series, slope: a.region!.slope, intercept: a.region!.intercept,
      p: a.region!.p, significant: a.region!.p < req.alpha,
    });
    const keys = [...sides.keys()];
    const keyA = sides.has(this.compareA()) ? this.compareA() : req.regionKey;
    const wantedB = this.compareB();
    const keyB = sides.has(wantedB) && wantedB !== keyA ? wantedB : (keys.find((k) => k !== keyA) ?? keyA);
    const sideA = sides.get(keyA)!;
    const sideB = sides.get(keyB)!;

    const range = seriesRange(a.years, [sideA, sideB]);
    const panel = (key: string, side: Side) => ({
      key,
      trend: `${signed(side.slope * 10, d)} ${cfg.unit}`,
      total: `${signed(side.slope * span, d)} ${cfg.unit}`,
      p: fmtP(side.p),
      significant: side.significant,
      sigText: side.significant ? tx.rank_sig : tx.rank_notsig,
      figure: seriesChart(a.years, side, cfg, tx, { range, height: 380, compact: true }),
    });

    // скорости сравниваем только когда оба тренда значимы: отношение к почти нулевому тренду бессмысленно
    let verdict: string;
    if (!sideA.significant || !sideB.significant) {
      verdict = tx.compare_unclear;
    } else if (Math.sign(sideA.slope) !== Math.sign(sideB.slope)) {
      verdict = fill(tx.compare_opposite, { a: sideA.name, b: sideB.name });
    } else {
      const [fast, slow] = Math.abs(sideA.slope) >= Math.abs(sideB.slope) ? [sideA, sideB] : [sideB, sideA];
      const ratio = Math.abs(fast.slope) / Math.abs(slow.slope);
      verdict =
        ratio < 1.1
          ? fill(tx.compare_same, { a: sideA.name, b: sideB.name })
          : fill(tx.compare_faster, { a: fast.name, b: slow.name, ratio: ratio.toFixed(1) });
    }

    return {
      options: keys.map((k) => ({ value: k, label: sides.get(k)!.name })),
      panels: [panel(keyA, sideA), panel(keyB, sideB)],
      verdict,
    };
  });

  protected readonly rankFigure = computed(() => {
    const v = this.view();
    return v?.region?.rank.length ? rankingChart(v.region.rank, v.cfg, this.tx) : null;
  });

  protected readonly tabs = computed(() => {
    const tx = this.tx;
    return [
      { key: 'map' as Tab, label: tx.tab_map },
      { key: 'series' as Tab, label: tx.tab_series },
      { key: 'compare' as Tab, label: tx.tab_compare },
      { key: 'rank' as Tab, label: tx.tab_rank },
      { key: 'method' as Tab, label: tx.tab_method },
    ];
  });

  protected readonly datasetOptions = computed<SelectOption[]>(() =>
    (this.meta()?.datasets ?? []).map((d) => ({ value: d.key, label: d.names[LANG] })),
  );
  protected readonly seasonOptions = computed<SelectOption[]>(() =>
    (this.meta()?.seasons ?? []).map((s) => ({ value: s, label: this.tx.seasons[s] })),
  );
  protected readonly regionOptions = computed<SelectOption[]>(() => [
    ...(this.meta()?.regions ?? []).map((r) => ({ value: r.key, label: r.names[LANG] })),
    { value: 'custom', label: this.tx.region_custom },
  ]);

  /** Что сейчас выбрано: видно на телефоне, пока фильтры свёрнуты. */
  protected readonly filterSummary = computed(() => {
    const cfg = this.cfg();
    if (!cfg) return '';
    const [y0, y1] = this.period();
    return [cfg.names[LANG], this.tx.seasons[this.season()], this.regionName(this.regionKey()), `${y0}–${y1}`].join(' · ');
  });

  protected readonly codeParts = codeParts;
  /** Ползунок периода не даёт выбрать меньше 10 лет: тренд по такому отрезку не считается. */
  protected readonly minSpan = MIN_SPAN;
  /** Ручка периода упёрлась в ограничение: на несколько секунд показываем, почему. */
  protected readonly periodBlocked = signal(false);
  private blockedTimer = 0;

  protected onPeriodBlocked(): void {
    this.periodBlocked.set(true);
    clearTimeout(this.blockedTimer);
    this.blockedTimer = window.setTimeout(() => this.periodBlocked.set(false), 4000);
  }
  protected readonly alphaPct = computed(() => `${((this.alpha() - 0.01) / 0.09) * 100}%`);

  constructor() {
    const media = matchMedia(NARROW);
    media.addEventListener('change', () => this.narrow.set(media.matches));

    this.api
      .meta()
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: (m) => {
          this.meta.set(m);
          this.dsKey.set(m.datasets[0]?.key ?? '');
        },
        error: () => this.metaFailed.set(true),
      });
    this.api
      .borders()
      .pipe(takeUntilDestroyed(), catchError(() => of(null)))
      .subscribe((b) => this.borders.set(b));

    toObservable(this.request)
      .pipe(
        debounceTime(150),
        tap((req) => {
          this.loading.set(!!req);
          this.failed.set(false);
        }),
        switchMap((req) =>
          req
            ? this.api.analysis(req).pipe(
                map((a) => ({ a, req })),
                catchError(() => {
                  this.failed.set(true);
                  return of(null);
                }),
              )
            : of(null),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res) this.result.set(res);
      });

  }

  protected regionName(key: string): string {
    if (key === 'custom') return this.tx.region_custom;
    return this.meta()?.regions.find((r) => r.key === key)?.names[LANG] ?? key;
  }

  protected setAlpha(e: Event): void {
    this.alpha.set(Math.round(+(e.target as HTMLInputElement).value * 100) / 100);
  }

  protected checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  protected downloadCsv(): void {
    const v = this.view();
    if (!v) return;
    const { lat, lon, slope10, p, sig } = v.a;
    const lines = ['lat,lon,trend_per_decade,p_value,significant'];
    for (let i = 0; i < lat.length; i++) {
      for (let j = 0; j < lon.length; j++) {
        if (slope10[i][j] === null) continue;
        lines.push(`${lat[i]},${lon[j]},${slope10[i][j]},${p[i][j]},${sig[i][j] ? 'True' : 'False'}`);
      }
    }
    download('trend_map.csv', lines.join('\n') + '\n', 'text/csv');
  }

  /** Отчёт с картой трендов и выводом: PDF или Word. Библиотеки подгружаются при первом нажатии. */
  protected async exportReport(kind: 'pdf' | 'docx'): Promise<void> {
    const v = this.view();
    const fig = this.mapFigure();
    if (!v?.region || !fig || this.exporting()) return;
    this.exporting.set(kind);
    this.exportFailed.set(false);
    try {
      const tx = this.tx;
      const { cfg, req, region } = v;
      const period = `${v.y0}–${v.y1}`;
      const mapWidth = 1100;
      const mapHeight = 500;
      const [mapPng, { exportPdf, exportDocx }] = await Promise.all([
        figureToPng(fig, mapWidth, mapHeight),
        import('./export'),
      ]);
      const report = {
        fileName: `trend-report-${req.dataset}-${req.regionKey}-${v.y0}-${v.y1}`,
        title: tx.report_title,
        subtitle: [cfg.names[LANG], tx.seasons[req.season], v.regionName, period].join('  ·  '),
        findingLabel: tx.finding_label,
        finding: region.finding,
        answers: region.kpis.map((k) => ({ label: k.label, value: k.value, sub: k.sub })),
        mapTitle: region.mapTitle,
        mapNote: tx.map_note,
        mapPng,
        mapWidth,
        mapHeight,
        rankTitle: tx.rank_title,
        rankHead: [tx.col_region, tx.col_trend, tx.col_total, tx.col_p, tx.col_sig],
        rankRows: region.rankTable.map((row) => [row.name, row.trend, row.total, row.p, row.sig]),
        paramsTitle: tx.report_params,
        params: [
          `${tx.dataset}: ${cfg.names[LANG]}`,
          `${tx.season}: ${tx.seasons[req.season]}`,
          `${tx.region}: ${v.regionName} (${fmtBox(req.box)})`,
          `${tx.period}: ${period}`,
          `α = ${req.alpha}, FDR: ${req.strict ? tx.yes : tx.no}`,
        ],
        source: `${tx.source}: ${cfg.source[LANG]}`,
        footer: `${tx.title} · ${new Date().toISOString().slice(0, 10)}`,
      };
      await (kind === 'pdf' ? exportPdf(report) : exportDocx(report));
    } catch (err) {
      console.error(err);
      this.exportFailed.set(true);
    } finally {
      this.exporting.set(null);
    }
  }
}
