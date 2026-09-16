"""Las páginas de los PDF originales: miniaturas para poder revisar un lote."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_session
from ..models import SourceFile
from ..services import thumbnails

router = APIRouter(prefix="/api/sources", tags=["páginas"])


@router.get("/{source_id}/pages/{page_index}/image")
def page_image(
    source_id: int,
    page_index: int,
    zoom: bool = False,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> Response:
    source = session.get(SourceFile, source_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PDF de origen no encontrado.")
    if not 0 <= page_index < source.page_count:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Esa página no existe en el PDF.")

    image = thumbnails.render_page(
        settings, source_id, Path(source.stored_path), page_index, zoom=zoom
    )
    if image is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "No se ha podido generar la miniatura de esta página.",
        )

    return FileResponse(
        image,
        media_type="image/jpeg",
        # Una página de un PDF ya subido no cambia nunca: se puede cachear sin
        # miedo, y así revisar un lote grande no repite el trabajo.
        headers={"Cache-Control": "public, max-age=604800, immutable"},
    )
