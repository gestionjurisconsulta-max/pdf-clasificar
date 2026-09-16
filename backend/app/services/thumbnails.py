"""Miniaturas de las páginas de un PDF de origen.

Es lo que permite revisar un lote sin abrir los ficheros: se ve cada hoja y se
decide si el troceado es correcto. Se generan bajo demanda y se cachean en
disco, porque rasterizar una página cuesta bastante más que servirla.
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..config import Settings

logger = logging.getLogger(__name__)

# Suficiente para leer la cabecera de una factura al ampliarla, y pequeño para
# que una pantalla con 40 miniaturas no tarde en cargar.
THUMB_DPI = 60
ZOOM_DPI = 150


def _cache_path(settings: Settings, source_id: int, page_index: int, dpi: int) -> Path:
    return settings.storage_dir / "thumbs" / str(source_id) / f"{page_index}@{dpi}.jpg"


def render_page(
    settings: Settings,
    source_id: int,
    source_path: Path,
    page_index: int,
    zoom: bool = False,
) -> Path | None:
    """Devuelve la ruta de la miniatura, generándola si hace falta.

    Devuelve None si el entorno no puede rasterizar: es preferible una pantalla
    sin miniaturas a un error que impida revisar el lote.
    """
    dpi = ZOOM_DPI if zoom else THUMB_DPI
    cached = _cache_path(settings, source_id, page_index, dpi)
    if cached.exists():
        return cached

    try:
        from pdf2image import convert_from_path
    except ImportError:
        logger.warning("pdf2image no disponible: no habrá miniaturas")
        return None

    try:
        images = convert_from_path(
            str(source_path), dpi=dpi, first_page=page_index + 1, last_page=page_index + 1
        )
        if not images:
            return None
        cached.parent.mkdir(parents=True, exist_ok=True)
        images[0].convert("RGB").save(cached, "JPEG", quality=72, optimize=True)
        return cached
    except Exception as exc:  # noqa: BLE001 - una página ilegible no debe tumbar la vista
        logger.warning("No se ha podido rasterizar la página %s: %s", page_index + 1, exc)
        return None


def clear_source(settings: Settings, source_id: int) -> None:
    """Se llama al borrar un lote para no dejar las miniaturas colgadas."""
    folder = settings.storage_dir / "thumbs" / str(source_id)
    if not folder.exists():
        return
    for file in folder.glob("*.jpg"):
        file.unlink(missing_ok=True)
    try:
        folder.rmdir()
    except OSError:
        pass
