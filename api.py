"""HTTP API для Angular-интерфейса. Запуск: `uvicorn api:app --port 8000`.

Вся статистика остаётся в trends.py / data_io.py, здесь только JSON-обёртка.
Если фронтенд собран (`npm run build` в frontend/), он раздаётся с того же адреса.
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

import data_io
import trends
from config import DATASETS, REGIONS, ROOT, SEASONS

app = FastAPI(title="Earth System Trend Detective API")
app.add_middleware(GZipMiddleware, minimum_size=2000)

MIN_SPAN = 9  # y1 - y0, то есть минимум 10 лет


def _clean(a, decimals: int) -> list:
    """Массив numpy -> вложенные списки для JSON: округление, NaN/inf -> null."""
    a = np.asarray(a, dtype=np.float64)
    out = np.round(a, decimals).astype(object)
    out[~np.isfinite(a)] = None
    return out.tolist()


def _num(v: float) -> float | None:
    return float(v) if np.isfinite(v) else None


@lru_cache(maxsize=32)
def _grid(ds_key: str, season: str, y0: int, y1: int):
    ann = data_io.annual_series(ds_key, season).sel(year=slice(y0, y1))
    vals = ann.values.astype(np.float64)
    years = ann["year"].values
    slope, p, _ = trends.trend_grid(vals, years)
    return vals, years, ann["lat"].values, ann["lon"].values, slope, p


@app.get("/api/meta")
def meta() -> dict:
    """Доступные наборы данных (с диапазоном лет по сезонам), регионы, сезоны."""
    datasets = []
    for key in data_io.available_datasets():
        cfg = DATASETS[key]
        years = {}
        for season in SEASONS:
            yrs = data_io.annual_series(key, season)["year"].values
            if yrs.size:
                years[season] = [int(yrs.min()), int(yrs.max())]
        datasets.append({
            "key": key, "names": cfg.names, "metric": cfg.metric, "source": cfg.source,
            "unit": cfg.unit, "decimals": cfg.decimals, "palette": list(cfg.palette),
            "colorPos": cfg.color_pos, "colorNeg": cfg.color_neg, "demo": cfg.demo,
            "landOnly": cfg.land_only,
            "years": years,
        })
    regions = [{"key": k, "names": r["names"], "box": list(r["box"])} for k, r in REGIONS.items()]
    return {"datasets": datasets, "regions": regions, "seasons": list(SEASONS)}


@app.get("/api/borders")
def borders() -> dict | None:
    """Границы стран одной ломаной (разрывы = null) или null, если файла нет."""
    b = data_io.load_borders()
    if b is None:
        return None
    return {"x": b[0], "y": b[1]}


@app.get("/api/analysis")
def analysis(
    dataset: str,
    season: str = "annual",
    y0: int = Query(...),
    y1: int = Query(...),
    lat0: float = -90, lat1: float = 90, lon0: float = -180, lon1: float = 180,
    alpha: float = Query(0.05, gt=0, lt=1),
    strict: bool = False,
) -> dict:
    if dataset not in data_io.available_datasets():
        raise HTTPException(404, "unknown dataset")
    if season not in SEASONS:
        raise HTTPException(404, "unknown season")
    if y1 - y0 < MIN_SPAN:
        raise HTTPException(400, "short_period")

    vals, yrs, lat, lon, slope, pval = _grid(dataset, season, y0, y1)
    if len(yrs) < MIN_SPAN + 1:
        raise HTTPException(400, "short_period")

    box = (lat0, lat1, lon0, lon1)
    slope10 = slope * 10
    sig = trends.significance_mask(pval, alpha, strict)
    cell_ok = np.isfinite(slope)
    rmask = trends.region_mask(lat, lon, box)

    region = None
    series = trends.regional_mean(vals, lat, lon, box, cell_ok)
    if series is not None:
        tr = trends.trend_series(yrs, series)
        if np.isfinite(tr["slope"]):
            region = {
                "series": _clean(series, 5),
                "slope": tr["slope"], "p": tr["p"], "intercept": tr["intercept"], "n": tr["n"],
                "share": _num(trends.significant_share(lat, slope, sig, rmask)),
            }

    up, down = trends.hotspots(lat, lon, slope10, sig, rmask)
    ranking = [
        {"key": r["key"], "slope": r["slope"], "p": r["p"], "significant": bool(r["p"] < alpha),
         "intercept": r["intercept"], "series": _clean(r["series"], 5)}
        for r in trends.rank_regions(vals, yrs, lat, lon, cell_ok, REGIONS)
    ]

    return {
        "years": [int(y) for y in yrs],
        "lat": lat.astype(float).tolist(),
        "lon": lon.astype(float).tolist(),
        "slope10": _clean(slope10, 5),
        "p": _clean(pval, 6),
        "sig": sig.astype(int).tolist(),
        "region": region,
        "hotspots": {"up": up.to_dict("records"), "down": down.to_dict("records")},
        "ranking": ranking,
    }


# Собранный Angular (если есть) раздаётся с корня; маршруты /api объявлены выше и имеют приоритет.
_DIST = ROOT / "frontend" / "dist" / "frontend" / "browser"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="frontend")
