"""Статистика трендов: Тейл–Сен + Манн–Кендалл. Только numpy/scipy/pandas, без Streamlit."""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from scipy.stats import norm


def mk_sen_2d(y: np.ndarray, x: np.ndarray, min_valid: int = 8):
    """Тренд для каждого столбца матрицы y (время × ячейки).

    Возвращает (наклон Тейла–Сена на единицу x, p-значение Манна–Кендалла, число валидных лет).
    Пропуски (NaN) допускаются.
    """
    n, m = y.shape
    iu, ju = np.triu_indices(n, k=1)
    dx = (x[ju] - x[iu]).astype(float)
    n_valid = np.isfinite(y).sum(axis=0)
    slope = np.full(m, np.nan)
    pval = np.full(m, np.nan)
    if n < 2 or m == 0:
        return slope, pval, n_valid

    chunk = max(64, int(3_000_000 // len(iu)))  # ограничиваем потребление памяти
    for a in range(0, m, chunk):
        blk = y[:, a:a + chunk].astype(float)
        diff = blk[ju] - blk[iu]                      # (пары лет, ячейки)
        s = np.sign(np.where(np.isfinite(diff), diff, 0.0)).sum(axis=0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            slope[a:a + chunk] = np.nanmedian(diff / dx[:, None], axis=0)
        nn = n_valid[a:a + chunk].astype(float)
        var = nn * (nn - 1) * (2 * nn + 5) / 18.0
        with np.errstate(divide="ignore", invalid="ignore"):
            z = np.where(s > 0, s - 1, np.where(s < 0, s + 1, 0.0)) / np.sqrt(var)
        pval[a:a + chunk] = 2 * norm.sf(np.abs(z))

    bad = n_valid < min_valid
    slope[bad] = np.nan
    pval[bad] = np.nan
    return slope, pval, n_valid


def trend_grid(values: np.ndarray, years: np.ndarray, min_valid_frac: float = 0.7):
    """values: (годы, lat, lon). Возвращает наклон/год, p-значение, число лет с данными."""
    n, ny, nx = values.shape
    min_valid = max(8, int(np.ceil(min_valid_frac * n)))
    s, p, nv = mk_sen_2d(values.reshape(n, ny * nx), years.astype(float), min_valid)
    return s.reshape(ny, nx), p.reshape(ny, nx), nv.reshape(ny, nx)


def trend_series(years: np.ndarray, values: np.ndarray) -> dict:
    """Тренд одного ряда: slope (на год), p, intercept (для линии на графике), n."""
    ok = np.isfinite(values)
    x = np.asarray(years, float)[ok]
    y = np.asarray(values, float)[ok]
    if len(x) < 5:
        return {"slope": np.nan, "p": np.nan, "intercept": np.nan, "n": int(len(x))}
    s, p, nv = mk_sen_2d(y[:, None], x, min_valid=5)
    return {"slope": float(s[0]), "p": float(p[0]),
            "intercept": float(np.median(y - s[0] * x)), "n": int(nv[0])}


def fdr_significant(p: np.ndarray, alpha: float) -> np.ndarray:
    """Поправка Бенджамини–Хохберга: какие ячейки значимы при контроле доли ложных находок."""
    mask = np.zeros(p.shape, dtype=bool)
    valid = np.isfinite(p)
    pv = p[valid]
    if pv.size == 0:
        return mask
    ranked = np.sort(pv)
    limit = alpha * np.arange(1, pv.size + 1) / pv.size
    below = np.where(ranked <= limit)[0]
    if below.size == 0:
        return mask
    mask[valid] = pv <= ranked[below.max()]
    return mask


def significance_mask(p: np.ndarray, alpha: float, strict: bool = False) -> np.ndarray:
    if strict:
        return fdr_significant(p, alpha)
    with np.errstate(invalid="ignore"):
        return np.isfinite(p) & (p < alpha)


def region_mask(lat: np.ndarray, lon: np.ndarray, box) -> np.ndarray:
    la0, la1, lo0, lo1 = box
    m_lat = (lat >= la0) & (lat <= la1)
    m_lon = (lon >= lo0) & (lon <= lo1)
    return m_lat[:, None] & m_lon[None, :]


def regional_mean(values, lat, lon, box, cell_ok=None):
    """Среднее по региону с весами cos(широта). values: (годы, lat, lon). None, если ячеек нет."""
    mask = region_mask(lat, lon, box)
    if cell_ok is not None:
        mask = mask & cell_ok
    if not mask.any():
        return None
    sub = values[:, mask]                                       # (годы, k)
    w = np.broadcast_to(np.cos(np.deg2rad(lat))[:, None], mask.shape)[mask]
    valid = np.isfinite(sub)
    wsum = (valid * w).sum(axis=1)
    num = np.where(valid, sub, 0.0) @ w
    with np.errstate(divide="ignore", invalid="ignore"):
        out = num / wsum
    out[wsum == 0] = np.nan
    return out


def significant_share(lat, slope, sig, mask) -> float:
    """Доля площади (с весами cos(широта)) региона, где тренд значим."""
    w = np.broadcast_to(np.cos(np.deg2rad(lat))[:, None], slope.shape)
    valid = np.isfinite(slope) & mask
    total = (w * valid).sum()
    return float(100 * (w * (valid & sig)).sum() / total) if total > 0 else float("nan")


def hotspots(lat, lon, slope, sig, mask, k: int = 5):
    """Ячейки с самым сильным значимым ростом и снижением внутри региона."""
    ok = sig & np.isfinite(slope) & mask
    ii, jj = np.where(ok)
    df = pd.DataFrame({"lat": lat[ii], "lon": lon[jj], "slope": slope[ii, jj]})
    up = df[df["slope"] > 0].nlargest(k, "slope")
    down = df[df["slope"] < 0].nsmallest(k, "slope")
    return up, down


def rank_regions(values, years, lat, lon, cell_ok, regions: dict) -> list[dict]:
    """Тренд среднего ряда каждого готового региона."""
    rows = []
    for key, info in regions.items():
        series = regional_mean(values, lat, lon, info["box"], cell_ok)
        if series is None:
            continue
        tr = trend_series(years, series)
        if np.isfinite(tr["slope"]):
            rows.append({"key": key, "series": series, **tr})
    return rows
