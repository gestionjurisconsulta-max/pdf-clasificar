"""Leer y trocear PDF.

Sustituye a pdf.js + Tesseract.js + pdf-lib del navegador. El texto sale de
pdfplumber; si una página no tiene capa de texto (es un escaneo), se rasteriza
y se le pasa Tesseract nativo, que es bastante más rápido que el WASM.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path

import pdfplumber
from pypdf import PdfReader, PdfWriter

logger = logging.getLogger(__name__)

# Si una página tiene menos texto que esto, se considera escaneada y se manda
# a OCR. Mismo umbral que usaba el frontend.
MIN_TEXT_CHARS = 10

# Resolución del rasterizado para OCR. 200 dpi es el equilibrio habitual entre
# acierto y tiempo en facturas.
OCR_DPI = 200


def page_count(path: Path) -> int:
    return len(PdfReader(str(path)).pages)


def _ocr_page(path: Path, page_index: int, language: str) -> str:
    """Rasteriza una página y le pasa OCR. Devuelve '' si el entorno no tiene
    tesseract o poppler: preferimos una página sin texto a un lote caído."""
    try:
        import pytesseract
        from pdf2image import convert_from_path
    except ImportError:
        logger.warning("OCR no disponible: faltan pytesseract o pdf2image")
        return ""

    try:
        images = convert_from_path(
            str(path), dpi=OCR_DPI, first_page=page_index + 1, last_page=page_index + 1
        )
        if not images:
            return ""
        return pytesseract.image_to_string(images[0], lang=language)
    except Exception as exc:  # noqa: BLE001 - una página ilegible no debe tumbar el lote
        logger.warning("OCR falló en la página %s de %s: %s", page_index + 1, path.name, exc)
        return ""


def extract_text_per_page(
    path: Path,
    language: str = "spa",
    on_page: Callable[[int], None] | None = None,
) -> list[str]:
    """Texto de cada página, en orden, con OCR de respaldo.

    `on_page` se llama con el índice de cada página en cuanto su texto es
    definitivo. Hace falta porque en un PDF escaneado esta función se lleva casi
    todo el tiempo del lote: sin avisar por página, la barra de progreso se
    queda quieta varios minutos y parece que el proceso está colgado.
    """
    texts: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        for index, page in enumerate(pdf.pages):
            try:
                text = page.extract_text() or ""
            except Exception as exc:  # noqa: BLE001
                logger.warning("No se pudo leer la página %s: %s", index + 1, exc)
                text = ""
            texts.append(text)

    # Las páginas con texto embebido ya están listas: se cuentan de inmediato y
    # el resto del tiempo es OCR puro, que es lo que hay que ir reportando.
    necesitan_ocr = [i for i, t in enumerate(texts) if len(t.strip()) < MIN_TEXT_CHARS]
    if on_page:
        pendientes = set(necesitan_ocr)
        for index in range(len(texts)):
            if index not in pendientes:
                on_page(index)

    if necesitan_ocr:
        logger.info("OCR de %s de %s páginas de %s", len(necesitan_ocr), len(texts), path.name)

    for index in necesitan_ocr:
        texts[index] = _ocr_page(path, index, language)
        if on_page:
            on_page(index)

    return texts


def extract_pages(source: Path, page_indices: list[int], destination: Path) -> None:
    """Escribe un PDF nuevo con las páginas indicadas, en ese orden,
    conservando la rotación que ya traían."""
    reader = PdfReader(str(source))
    writer = PdfWriter()
    for index in page_indices:
        writer.add_page(reader.pages[index])

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as handle:
        writer.write(handle)
