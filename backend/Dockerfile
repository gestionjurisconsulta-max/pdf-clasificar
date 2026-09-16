FROM python:3.11-slim-bookworm

# tesseract-ocr        -> OCR de páginas escaneadas (sustituye a tesseract.js)
# tesseract-ocr-spa    -> modelo de español; sin él el OCR sale en inglés
# poppler-utils        -> pdf2image rasteriza las páginas con pdftoppm
# libpq5               -> cliente de Postgres para psycopg
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-spa \
        poppler-utils \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Las dependencias van antes que el código para que cambiar un fichero .py no
# invalide la capa de pip, que es la cara de reconstruir.
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Usuario sin privilegios: si alguien consigue ejecutar algo a través de un PDF
# malicioso, que no sea como root.
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /data && chown -R appuser:appuser /data /app
USER appuser

EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
