"""Загрузка NetCDF, приведение к единому виду, годовые/сезонные средние."""
from __future__ import annotations

import json
from functools import lru_cache

import numpy as np
import xarray as xr

from config import BORDERS_FILES, DATA_DIR, DATASETS, SEASONS


def available_datasets() -> list[str]:
    """Реальные наборы из data/. Если их нет, создаёт и возвращает демо-набор."""
    real = [k for k, c in DATASETS.items() if not c.demo and (DATA_DIR / c.file).exists()]
    if real:
        return real
    demo = DATASETS["demo"]
    path = DATA_DIR / demo.file
    if not path.exists():
        from make_demo_data import generate
        generate(path)
    return ["demo"]


def _find_name(da: xr.DataArray, candidates: set[str]) -> str | None:
    for name in list(da.coords) + list(da.dims):
        if name.lower() in candidates:
            return name
    return None


def _standardise(da: xr.DataArray) -> xr.DataArray:
    """Имена осей time/lat/lon, долгота -180..180, широта по возрастанию."""
    names = {
        "time": _find_name(da, {"time", "date", "valid_time"}),
        "lat": _find_name(da, {"lat", "latitude", "nav_lat", "y"}),
        "lon": _find_name(da, {"lon", "longitude", "nav_lon", "x"}),
    }
    if None in names.values():
        raise ValueError(f"Не удалось найти оси time/lat/lon в файле: {list(da.dims)}")
    da = da.rename({old: new for new, old in names.items() if old != new})
    da = da.squeeze(drop=True).transpose("time", "lat", "lon")
    da = da.assign_coords(lon=(((da["lon"] + 180) % 360) - 180)).sortby("lon").sortby("lat")
    return da


@lru_cache(maxsize=None)
def load_dataset(key: str) -> xr.DataArray:
    """Читает файл, приводит оси к единому виду и огрубляет слишком мелкую сетку."""
    cfg = DATASETS[key]
    ds = xr.open_dataset(DATA_DIR / cfg.file)
    var = cfg.variable if (cfg.variable and cfg.variable in ds) else next(
        name for name, v in ds.data_vars.items() if len(v.dims) >= 3)
    da = _standardise(ds[var]).load().astype("float32")
    ds.close()
    f = max(1, int(np.ceil(da.sizes["lat"] / 180)), int(np.ceil(da.sizes["lon"] / 360)))
    if f > 1:  # не больше ~180×360 ячеек, чтобы всё считалось за секунды
        da = da.coarsen(lat=f, lon=f, boundary="trim").mean()
    if cfg.perennial_above is not None:
        # минимум многолетнего среднего по месяцам: если он выше порога, снег в ячейке не сходит
        summer = da.groupby("time.month").mean("time", skipna=True).min("month")
        da = da.where(~(summer > cfg.perennial_above))
    return da


@lru_cache(maxsize=None)
def annual_series(key: str, season: str) -> xr.DataArray:
    """Средние по годам (или по сезону): оси year × lat × lon. Неполные годы отбрасываются."""
    da = load_dataset(key)
    months, min_months = SEASONS[season]
    idx = np.flatnonzero(da["time"].dt.month.isin(months).values)
    sel = da.isel(time=idx)
    years_all = sel["time"].dt.year.values
    uniq, counts = np.unique(years_all, return_counts=True)
    good = uniq[counts >= min_months]
    ann = sel.groupby("time.year").mean("time", skipna=True)
    return ann.sel(year=good).transpose("year", "lat", "lon")


@lru_cache(maxsize=None)
def load_borders():
    """Границы стран для карты (если файл скачан). Возвращает списки x, y с разрывами None."""
    path = next((p for p in BORDERS_FILES if p.exists()), None)
    if path is None:
        return None
    gj = json.loads(path.read_text(encoding="utf-8"))
    xs, ys = [], []
    for feat in gj["features"]:
        geom = feat["geometry"]
        if geom["type"] == "Polygon":
            polys = [geom["coordinates"]]
        elif geom["type"] == "MultiPolygon":
            polys = geom["coordinates"]
        else:
            continue
        for poly in polys:
            for ring in poly:
                for lon, lat in ring:
                    xs.append(round(lon, 3))   # ~100 м: точнее карте не нужно, а ответ API втрое легче
                    ys.append(round(lat, 3))
                xs.append(None)
                ys.append(None)
    return xs, ys
