"""Синтетический набор для проверки приложения без интернета.

Запуск: python make_demo_data.py
Данные ненастоящие: потепление растёт к полюсам, в Северной Атлантике есть «холодное пятно».
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd


def build_arrays(seed: int = 7):
    rng = np.random.default_rng(seed)
    lat = np.arange(-89, 90, 2.0)
    lon = np.arange(-179, 180, 2.0)
    time = pd.date_range("1980-01-01", "2025-12-01", freq="MS")
    n = len(time)
    t_dec = (np.arange(n) / 120.0)[:, None, None]                  # десятилетия с 1980

    LAT, LON = np.meshgrid(lat, lon, indexing="ij")
    rate = 0.05 + 0.40 * (np.abs(LAT) / 90.0) ** 2                 # °C за десятилетие
    rate = rate + 0.05 * (LAT > 0)                                 # север теплеет быстрее
    cold = np.exp(-(((LAT - 55) / 8) ** 2 + ((LON + 35) / 18) ** 2))
    rate = rate - 0.55 * cold                                      # «холодное пятно»
    calm = np.exp(-(((LAT - 0) / 18) ** 2 + ((LON + 130) / 35) ** 2))
    rate = rate * (1 - 0.9 * calm)                                 # зона без тренда

    # общий межгодовой шум (как Эль-Ниньо) + локальный шум
    common = np.convolve(rng.normal(0, 0.12, n + 11), np.ones(12) / 12, mode="valid")[:n]
    local = rng.normal(0, 0.9, (n, len(lat), len(lon))) * (0.6 + np.abs(LAT) / 90.0)
    data = rate[None] * t_dec + common[:, None, None] + local
    data = data - data[:12 * 10].mean(axis=0)                      # относительно первых 10 лет

    data[:, lat < -80, :] = np.nan                                 # нет данных у Южного полюса
    data[rng.random(data.shape) < 0.02] = np.nan                   # случайные пропуски
    return time, lat, lon, data.astype("float32")


def generate(path: Path) -> None:
    import xarray as xr

    time, lat, lon, data = build_arrays()
    ds = xr.Dataset(
        {"tempanomaly": (("time", "lat", "lon"), data, {"units": "degC"})},
        coords={"time": time, "lat": lat, "lon": lon},
        attrs={"title": "SYNTHETIC demo data, not NASA"},
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(path, engine="scipy")


if __name__ == "__main__":
    from config import DATA_DIR, DATASETS

    out = DATA_DIR / DATASETS["demo"].file
    generate(out)
    print(f"Готово: {out}")
