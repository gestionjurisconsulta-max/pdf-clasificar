"""Dónde vive cada documento generado y cómo se escribe.

Lo usan tanto el proceso inicial de un lote como las correcciones manuales: si
alguien cambia el cliente o el tipo de un documento, el PDF tiene que moverse a
la carpeta que le corresponde, y eso debe decidirse en un único sitio.
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..config import Settings
from ..enums import DocumentType
from ..models import Document, SourceFile
from . import pdf as pdf_service
from .naming import sanitize_name

logger = logging.getLogger(__name__)

PENDING_FOLDER = "Pendiente de asignar"


def batch_root(settings: Settings, batch_id: int) -> Path:
    return settings.documents_dir / f"batch-{batch_id}"


def folder_for(doc_type: DocumentType, client_name: str | None) -> str:
    """Los albaranes van a su propia rama para que no se mezclen con la
    facturación: era el motivo de separarlos."""
    base = "Albaranes" if doc_type is DocumentType.ALBARAN else "Facturas"
    return f"{base}/{sanitize_name(client_name) if client_name else PENDING_FOLDER}"


def filename_for(document: Document, source: SourceFile) -> str:
    first_page = document.page_indices[0] if document.page_indices else 0
    number = sanitize_name(document.number) if document.number else "S-N"
    stem = sanitize_name(Path(source.filename).stem)
    return f"PAG_{first_page + 1:03d}_{stem}_{number}.pdf"


def remove_file(path: str | None) -> None:
    """Borra el PDF anterior al mover o rehacer un documento. Que el fichero ya
    no esté no es un error: el objetivo es que no quede."""
    if not path:
        return
    try:
        target = Path(path)
        target.unlink(missing_ok=True)
        # Si era el último documento de ese cliente, la carpeta se queda vacía.
        # rmdir sólo borra directorios vacíos, así que nunca se lleva nada por
        # delante; falla con OSError si aún hay ficheros, y eso es lo correcto.
        try:
            target.parent.rmdir()
        except OSError:
            pass
    except OSError as exc:
        logger.warning("No se ha podido borrar %s: %s", path, exc)


def write_document(
    document: Document,
    source: SourceFile,
    client_name: str | None,
    settings: Settings,
) -> Path:
    """(Re)genera el PDF de un documento en la carpeta que le toca y devuelve la
    ruta. Si ya había un fichero en otro sitio, lo borra: sin esto, corregir el
    cliente de una factura dejaba una copia huérfana en la carpeta anterior y el
    ZIP salía con el documento duplicado."""
    previous = document.stored_path

    destination = (
        batch_root(settings, document.batch_id)
        / folder_for(document.doc_type, client_name)
        / filename_for(document, source)
    )

    pdf_service.extract_pages(Path(source.stored_path), document.page_indices, destination)
    document.stored_path = str(destination)

    if previous and previous != str(destination):
        remove_file(previous)

    return destination
