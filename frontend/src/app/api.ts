import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type Lang = 'ru' | 'en';
export type L10n = Record<Lang, string>;
/** lat_min, lat_max, lon_min, lon_max */
export type Box = [number, number, number, number];

export interface DatasetMeta {
  key: string;
  names: L10n;
  metric: L10n;
  source: L10n;
  unit: string;
  decimals: number;
  palette: string[];
  colorPos: string;
  colorNeg: string;
  demo: boolean;
  /** Показатель определён только на суше. */
  landOnly: boolean;
  /** сезон -> [первый год, последний год] */
  years: Record<string, [number, number]>;
}

export interface RegionMeta {
  key: string;
  names: L10n;
  box: Box;
}

export interface Meta {
  datasets: DatasetMeta[];
  regions: RegionMeta[];
  seasons: string[];
}

export interface Borders {
  x: (number | null)[];
  y: (number | null)[];
}

export interface Hotspot {
  lat: number;
  lon: number;
  slope: number;
}

export interface RankRow {
  key: string;
  slope: number;
  p: number;
  significant: boolean;
  intercept: number;
  /** Средний ряд региона по годам (для вкладки сравнения). */
  series: (number | null)[];
}

export interface Analysis {
  years: number[];
  lat: number[];
  lon: number[];
  /** [lat][lon], тренд за десятилетие; null = нет данных */
  slope10: (number | null)[][];
  p: (number | null)[][];
  sig: number[][];
  /** null, если в прямоугольнике нет ячеек с данными */
  region: {
    series: (number | null)[];
    slope: number;
    p: number;
    intercept: number;
    n: number;
    share: number | null;
  } | null;
  hotspots: { up: Hotspot[]; down: Hotspot[] };
  ranking: RankRow[];
}

export interface AnalysisParams {
  dataset: string;
  season: string;
  y0: number;
  y1: number;
  box: Box;
  alpha: number;
  strict: boolean;
}

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  meta(): Observable<Meta> {
    return this.http.get<Meta>('/api/meta');
  }

  borders(): Observable<Borders | null> {
    return this.http.get<Borders | null>('/api/borders');
  }

  analysis(p: AnalysisParams): Observable<Analysis> {
    return this.http.get<Analysis>('/api/analysis', {
      params: {
        dataset: p.dataset,
        season: p.season,
        y0: p.y0,
        y1: p.y1,
        lat0: p.box[0],
        lat1: p.box[1],
        lon0: p.box[2],
        lon1: p.box[3],
        alpha: p.alpha,
        strict: p.strict,
      },
    });
  }
}
