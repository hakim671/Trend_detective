# Образ приложения: собирает интерфейс, ставит зависимости, скачивает данные NASA, запускает сервер.
# Порт 7860 — стандартный для Hugging Face Spaces; локально: docker run -p 7860:7860 <образ>.

# ---------- 1. сборка интерфейса (Angular) ----------
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- 2. сервер (FastAPI) ----------
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONIOENCODING=utf-8

# Hugging Face Spaces запускает контейнер от пользователя с uid 1000
RUN useradd --create-home --uid 1000 app
WORKDIR /home/app/trend-detective

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY api.py config.py data_io.py trends.py download_data.py make_demo_data.py ./
# Данные NASA (GISTEMP, снег и осадки NASA POWER, границы стран) кладутся в образ при сборке:
# около 220 МБ скачивания. Если GISTEMP недоступен, сборка падает, а не выходит без данных.
RUN python download_data.py

COPY --from=web /web/dist ./frontend/dist
RUN chown -R app:app /home/app
USER app

EXPOSE 7860
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "7860"]
