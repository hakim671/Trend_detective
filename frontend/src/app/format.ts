import { Box } from './api';

/** Подстановка {name} в строку перевода. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ''));
}

/** Число со знаком и фиксированным числом знаков: +0.38 / -0.12. */
export function signed(v: number, decimals: number): string {
  return (v < 0 ? '-' : '+') + Math.abs(v).toFixed(decimals);
}

export function fmtP(p: number): string {
  return p < 0.001 ? '< 0.001' : p.toFixed(3);
}

const g = (v: number) => String(Number(Math.abs(v).toPrecision(6)));

export function fmtBox([la0, la1, lo0, lo1]: Box): string {
  const ns = (v: number) => `${g(v)}°${v >= 0 ? 'N' : 'S'}`;
  const ew = (v: number) => `${g(v)}°${v >= 0 ? 'E' : 'W'}`;
  return `${ns(la0)}…${ns(la1)}, ${ew(lo0)}…${ew(lo1)}`;
}

/** Делит текст на обычные куски и `код` в обратных кавычках. */
export function codeParts(text: string): { text: string; code: boolean }[] {
  return text.split('`').map((t, i) => ({ text: t, code: i % 2 === 1 }));
}

/** Перцентиль с линейной интерполяцией (как numpy.percentile). */
export function percentile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (q / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function mean(values: (number | null)[]): number {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v !== null) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : NaN;
}

export function download(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
