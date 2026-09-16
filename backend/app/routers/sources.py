"""Las páginas de los PDF originales: miniaturas para poder revisar un lote."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_session
from sqlalchemy import select

from ..models import Batch, SourceFile
from ..services import thumbnails
from ..session import current as current_session

router = APIRouter(prefix="/api/sources", tags=["páginas"])


@router.get("/{source_id}/pages/{page_index}/image")
def page_image(
    source_id: int,
    page_index: int,
    request: Request,
    zoom: bool = False,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> Response:
    # También acotado a la sesión: las miniaturas son el contenido de las
    # facturas de alguien.
    source = session.execute(
        select(SourceFile)
        .join(Batch, Batch.id == SourceFile.batch_id)
        .where(SourceFile.id == source_id, Batch.session_id == current_session(request))
    ).scalar_one_or_none()
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
