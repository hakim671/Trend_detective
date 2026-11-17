"""Настройки проекта: наборы данных NASA и готовые регионы.

Чтобы добавить новый показатель, достаточно положить NetCDF-файл в папку data/
и добавить запись в DATASETS (сетка lat/lon, время по месяцам).
"""
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
# границы стран для карты (необязательно): берётся первый найденный файл, детальный в приоритете
BORDERS_FILES = [DATA_DIR / "ne_50m_admin_0_countries.geojson",
                 DATA_DIR / "ne_110m_admin_0_countries.geojson"]

# 11 цветов от минимума к максимуму (ColorBrewer RdBu_r и BrBG)
PALETTE_WARM = ["#08306b", "#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7",
                "#fddbc7", "#f4a582", "#d6604d", "#b2182b", "#67001f"]
PALETTE_GREEN = ["#543005", "#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5",
                 "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"]

# снег: меньше = красно-коричневый, больше = синий (RdBu, то есть PALETTE_WARM наоборот)
PALETTE_SNOW = PALETTE_WARM[::-1]


@dataclass(frozen=True)
class Dataset:
    file: str                      # имя файла в data/
    variable: str | None           # имя переменной в NetCDF (None = определить автоматически)
    unit: str                      # единицы измерения
    decimals: int                  # знаков после запятой в отчётах
    names: dict = field(default_factory=dict)    # название показателя
    metric: dict = field(default_factory=dict)   # название в середине предложения
    source: dict = field(default_factory=dict)   # описание источника
    palette: tuple = tuple(PALETTE_WARM)
    demo: bool = False
    land_only: bool = False        # показатель есть только на суше: карта обрезается по берегу
    # снег: ячейки, где он не сходит даже летом (минимум по месяцам многолетнего среднего выше
    # порога), исключаются — это ледники, для них реанализ не даёт осмысленного тренда
    perennial_above: float | None = None

    @property
    def colorscale(self):
        n = len(self.palette) - 1
        return [[i / n, c] for i, c in enumerate(self.palette)]

    @property
    def color_pos(self):
        return self.palette[8]

    @property
    def color_neg(self):
        return self.palette[2]


DATASETS = {
    "temperature": Dataset(
        file="gistemp1200_GHCNv4_ERSSTv5.nc",
        variable="tempanomaly",
        unit="°C",
        decimals=2,
        names={"ru": "Температура поверхности", "en": "Surface temperature"},
        metric={"ru": "температура поверхности", "en": "surface temperature"},
        source={
            "ru": "NASA GISS, GISTEMP v4: аномалии температуры поверхности суши и океана, "
                  "сетка 2°×2°, месячные данные, базовый период 1951–1980.",
            "en": "NASA GISS, GISTEMP v4: land and ocean surface temperature anomalies, "
                  "2°×2° grid, monthly data, baseline 1951–1980.",
        },
        palette=tuple(PALETTE_WARM),
    ),
    "ndvi": Dataset(
        file="ndvi_monthly.nc",
        variable=None,
        unit="NDVI",
        decimals=3,
        names={"ru": "Растительность (NDVI)", "en": "Vegetation (NDVI)"},
        metric={"ru": "индекс растительности (NDVI)", "en": "vegetation index (NDVI)"},
        source={
            "ru": "NASA MODIS (MOD13C2), месячный NDVI. Файл ndvi_monthly.nc нужно положить в data/ "
                  "самостоятельно (сетка не мельче 0.25°).",
            "en": "NASA MODIS (MOD13C2), monthly NDVI. Put ndvi_monthly.nc into data/ yourself "
                  "(grid no finer than 0.25°).",
        },
        palette=tuple(PALETTE_GREEN),
        land_only=True,
    ),
    "snow": Dataset(
        file="snow_depth_monthly.nc",
        variable="SNODP",
        unit="cm",
        decimals=2,
        names={"ru": "Глубина снега", "en": "Snow depth"},
        metric={"ru": "глубина снега", "en": "snow depth"},
        source={
            "ru": "NASA POWER (реанализ MERRA-2): глубина снега на суше (SNODP), месячные данные "
                  "с 1981 года, сетка 0.5°×0.625°, усреднённая до 1°×1.25°. Это модельный реанализ, "
                  "а не прямые спутниковые измерения. Ячейки, где снег не сходит никогда (ледники и "
                  "ледяные шапки), исключены: их баланс массы реанализ не моделирует.",
            "en": "NASA POWER (MERRA-2 reanalysis): snow depth on land (SNODP), monthly data since 1981, "
                  "0.5°×0.625° grid averaged to 1°×1.25°. This is a model reanalysis, not direct "
                  "satellite measurements. Cells where snow never melts (glaciers and ice caps) are "
                  "excluded: the reanalysis does not model their mass balance.",
        },
        palette=tuple(PALETTE_SNOW),
        land_only=True,
        perennial_above=10.0,
    ),
    "precipitation": Dataset(
        file="precipitation_monthly.nc",
        variable="PRECTOTCORR",
        unit="mm/day",
        decimals=2,
        names={"ru": "Осадки", "en": "Precipitation"},
        metric={"ru": "количество осадков", "en": "precipitation"},
        source={
            "ru": "NASA POWER (реанализ MERRA-2): осадки с поправкой на смещение (PRECTOTCORR), дождь и снег, "
                  "месячные данные с 1981 года, сетка 0.5°×0.625°, усреднённая до 1°×1.25°. Это модельный "
                  "реанализ, а не прямые измерения.",
            "en": "NASA POWER (MERRA-2 reanalysis): bias-corrected total precipitation (PRECTOTCORR), rain "
                  "and snow, monthly data since 1981, 0.5°×0.625° grid averaged to 1°×1.25°. This is a "
                  "model reanalysis, not direct measurements.",
        },
        palette=tuple(PALETTE_GREEN),
    ),
    "demo": Dataset(
        file="demo_temperature.nc",
        variable="tempanomaly",
        unit="°C",
        decimals=2,
        names={"ru": "Температура (демо, синтетика)", "en": "Temperature (demo, synthetic)"},
        metric={"ru": "температура поверхности", "en": "surface temperature"},
        source={
            "ru": "Синтетические данные для проверки приложения. Не используйте их как данные NASA.",
            "en": "Synthetic data for testing the app. Do not present it as NASA data.",
        },
        palette=tuple(PALETTE_WARM),
        demo=True,
    ),
}

# (lat_min, lat_max, lon_min, lon_max)
REGIONS = {
    "global": {"box": (-90, 90, -180, 180), "names": {"ru": "Весь мир", "en": "Global"}},
    "tajikistan": {"box": (36.6, 41.1, 67.3, 75.2), "names": {"ru": "Таджикистан", "en": "Tajikistan"}},
    "central_asia": {"box": (35, 56, 46, 88), "names": {"ru": "Центральная Азия", "en": "Central Asia"}},
    "arctic": {"box": (66.5, 90, -180, 180), "names": {"ru": "Арктика", "en": "Arctic"}},
    "europe": {"box": (36, 70, -10, 40), "names": {"ru": "Европа", "en": "Europe"}},
    "sahel": {"box": (10, 18, -18, 40), "names": {"ru": "Сахель", "en": "Sahel"}},
    "south_asia": {"box": (8, 35, 68, 90), "names": {"ru": "Южная Азия", "en": "South Asia"}},
    "north_america": {"box": (25, 60, -130, -60), "names": {"ru": "Северная Америка", "en": "North America"}},
    "amazon": {"box": (-15, 5, -75, -45), "names": {"ru": "Амазония", "en": "Amazon"}},
    "australia": {"box": (-40, -12, 113, 154), "names": {"ru": "Австралия", "en": "Australia"}},
}

# сезон: (месяцы, минимум месяцев с данными, чтобы год считался полным)
SEASONS = {
    "annual": ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 12),
    "djf": ([12, 1, 2], 3),
    "mam": ([3, 4, 5], 3),
    "jja": ([6, 7, 8], 3),
    "son": ([9, 10, 11], 3),
}
