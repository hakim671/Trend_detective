"""Одноразовая загрузка реальных данных (нужен интернет). После этого приложение работает офлайн.

Запуск: python download_data.py
"""
import gzip
import shutil
import sys
import time
import urllib.request
from pathlib import Path

DATA = Path(__file__).parent / "data"

# сообщения скрипта на русском: если вывод перенаправлен в файл или консоль в другой кодировке,
# непечатаемые символы заменяются, а не роняют скрипт посреди скачивания
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        if _stream.isatty():
            _stream.reconfigure(errors="replace")
        else:  # вывод в файл или конвейер: системная кодировка Windows кириллицу может не знать
            _stream.reconfigure(encoding="utf-8", errors="replace")

FILES = [
    # (адрес, имя файла, распаковать gzip?, обязательный?)
    ("https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz",
     "gistemp1200_GHCNv4_ERSSTv5.nc", True, True),
    ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
     "ne_110m_admin_0_countries.geojson",
     "ne_110m_admin_0_countries.geojson", False, False),
    # детальные границы и береговая линия: карта использует их, если файл есть
    ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
     "ne_50m_admin_0_countries.geojson",
     "ne_50m_admin_0_countries.geojson", False, False),
]


def fetch(url: str, dest: Path, gz: bool) -> None:
    print(f"Скачиваю {dest.name} …")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 trend-detective"})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
        shutil.copyfileobj(resp, out)
    if gz:
        with gzip.open(tmp, "rb") as src, open(dest, "wb") as out:
            shutil.copyfileobj(src, out)
        tmp.unlink()
    else:
        tmp.replace(dest)
    print(f"  готово: {dest} ({dest.stat().st_size / 1e6:.1f} МБ)")


# NASA POWER: открытое хранилище (без регистрации) с месячными полями MERRA-2 в формате Zarr
POWER_ZARR = "https://nasa-power.s3.amazonaws.com/merra2/temporal/power_merra2_monthly_temporal_utc.zarr"
POWER_ATTEMPTS = 4
POWER_FIELDS = [
    # (переменная, имя файла, единицы, название, примерный объём скачивания)
    ("SNODP", "snow_depth_monthly.nc", "cm", "Snow Depth", "~30 МБ"),
    ("PRECTOTCORR", "precipitation_monthly.nc", "mm/day", "Precipitation Corrected", "~120 МБ"),
]


def fetch_power(dest: Path, variable: str, units: str, long_name: str, size: str) -> None:
    """Поле NASA POWER (MERRA-2): вся Земля, по месяцам с 1981 года."""
    import numpy as np
    import xarray as xr

    print(f"Скачиваю {dest.name} (NASA POWER, {variable}, {size}) …")
    # поле лежит сотнями небольших файлов; на длинной загрузке соединение иногда рвётся, поэтому повторяем
    for attempt in range(1, POWER_ATTEMPTS + 1):
        try:
            ds = xr.open_zarr(POWER_ZARR, consolidated=True)
            da = ds[variable].load()
            ds.close()
            break
        except Exception as exc:  # noqa: BLE001
            if attempt == POWER_ATTEMPTS:
                raise
            print(f"  попытка {attempt} не удалась ({exc}), пробую ещё раз …")
            time.sleep(5 * attempt)

    # ось времени в хранилище заведена с запасом на будущее: пустые месяцы отбрасываем,
    # иначе неполный текущий год попал бы в годовые средние
    filled = np.isfinite(da).any(dim=("lat", "lon")).values
    da = da.isel(time=np.flatnonzero(filled))
    # исходная сетка 0.5°×0.625° -> 1°×1.25°: приложению хватает, файл и расчёт в 4 раза легче
    da = da.coarsen(lat=2, lon=2, boundary="trim").mean().astype("float32")
    da.attrs.update(units=units, long_name=long_name,
                    source="NASA POWER (MERRA-2), monthly; regridded to 1 x 1.25 degrees")

    tmp = dest.with_suffix(dest.suffix + ".part")
    da.to_dataset(name=variable).to_netcdf(tmp, encoding={variable: {"zlib": True, "complevel": 4}})
    tmp.replace(dest)
    first, last = (str(t)[:7] for t in da["time"].values[[0, -1]])
    print(f"  готово: {dest} ({dest.stat().st_size / 1e6:.1f} МБ), {first} … {last}")


def main() -> None:
    DATA.mkdir(exist_ok=True)
    for url, name, gz, required in FILES:
        dest = DATA / name
        if dest.exists():
            print(f"{name} уже есть, пропускаю")
            continue
        try:
            fetch(url, dest, gz)
        except Exception as exc:  # noqa: BLE001
            print(f"  не удалось: {exc}")
            if required:
                print("Скачайте файл вручную: https://data.giss.nasa.gov/gistemp/ → "
                      "Gridded data (netCDF, 1200km smoothing) и положите в папку data/")
                sys.exit(1)

    for variable, name, units, long_name, size in POWER_FIELDS:
        dest = DATA / name
        if dest.exists():
            print(f"{name} уже есть, пропускаю")
            continue
        try:
            fetch_power(dest, variable, units, long_name, size)
        except Exception as exc:  # noqa: BLE001
            print(f"  не удалось: {exc}\n  Показатель «{long_name}» будет недоступен, остальное работает.")


if __name__ == "__main__":
    main()
