from __future__ import annotations

import io
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..config import Settings, get_settings
from ..db import SessionLocal, get_session
from ..enums import BatchStatus
from ..models import Batch, Document, SourceFile
from ..schemas import BatchDetail, BatchOut, DocumentOut
from ..services import pdf as pdf_service
from ..services.naming import sanitize_name
from ..services.pipeline import process_batch

router = APIRouter(prefix="/api/batches", tags=["lotes"])


def _run_batch(batch_id: int, settings: Settings) -> None:
    """Se ejecuta en segundo plano, con su propia sesión: la del request ya
    está cerrada cuando esto arranca."""
    session = SessionLocal()
    try:
        process_batch(session, batch_id, settings)
    finally:
        session.close()


@router.get("", response_model=list[BatchOut])
def list_batches(limit: int = 50, session: Session = Depends(get_session)) -> list[Batch]:
    query = (
        select(Batch)
        .options(selectinload(Batch.sources))
        .order_by(Batch.created_at.desc())
        .limit(min(limit, 200))
    )
    return list(session.execute(query).scalars().all())


@router.post("", response_model=BatchOut, status_code=status.HTTP_202_ACCEPTED)
async def create_batch(
    background: BackgroundTasks,
    files: list[UploadFile] = File(...),
    name: str | None = None,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> Batch:
    """Sube uno o varios PDF y arranca el proceso en segundo plano.

    Devuelve 202 inmediatamente: el estado se consulta en GET /api/batches/{id},
    de modo que cerrar el navegador no interrumpe el lote.
    """
    pdfs = [f for f in files if (f.filename or "").lower().endswith(".pdf")]
    if not pdfs:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Hay que subir al menos un PDF.")

    batch = Batch(
        name=name or f"Lote {datetime.now(timezone.utc):%Y-%m-%d %H:%M}",
        status=BatchStatus.PENDIENTE,
    )
    session.add(batch)
    session.flush()

    batch_dir = settings.uploads_dir / f"batch-{batch.id}"
    batch_dir.mkdir(parents=True, exist_ok=True)

    total_pages = 0
    for index, upload in enumerate(pdfs):
        data = await upload.read()
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"{upload.filename} supera el tamaño máximo permitido.",
            )

        # El nombre se sanea y se prefija con el índice: dos ficheros del mismo
        # nombre en la misma subida no deben pisarse.
        safe = sanitize_name(Path(upload.filename or f"documento-{index}").name)
        stored = batch_dir / f"{index:02d}_{safe}"
        stored.write_bytes(data)

        try:
            pages = pdf_service.page_count(stored)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"{upload.filename} no es un PDF legible: {exc}"
            ) from exc

        total_pages += pages
        session.add(
            SourceFile(
                batch_id=batch.id,
                filename=upload.filename or safe,
                stored_path=str(stored),
                page_count=pages,
            )
        )

    batch.pages_total = total_pages
    session.commit()
    session.refresh(batch)

    background.add_task(_run_batch, batch.id, settings)
    return batch


@router.get("/{batch_id}", response_model=BatchDetail)
def get_batch(batch_id: int, session: Session = Depends(get_session)) -> BatchDetail:
    batch = session.execute(
        select(Batch)
        .options(selectinload(Batch.sources), selectinload(Batch.documents).selectinload(Document.client))
        .where(Batch.id == batch_id)
    ).scalar_one_or_none()
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lote no encontrado.")

    documents = [
        DocumentOut(
            id=d.id,
            source_file_id=d.source_file_id,
            doc_type=d.doc_type,
            number=d.number,
            page_indices=d.page_indices,
            ambiguous=d.ambiguous,
            candidates=d.candidates,
            notes=d.notes,
            client_id=d.client_id,
            client_name=d.client.name if d.client else None,
        )
        for d in sorted(batch.documents, key=lambda d: (d.source_file_id, d.page_indices[0] if d.page_indices else 0))
    ]

    summary: dict[str, int] = {}
    for d in documents:
        summary[d.doc_type.value] = summary.get(d.doc_type.value, 0) + 1
    summary["sin_cliente"] = sum(1 for d in documents if d.client_id is None)
    summary["ambiguos"] = sum(1 for d in documents if d.ambiguous)

    return BatchDetail(
        **BatchOut.model_validate(batch).model_dump(),
        documents=documents,
        summary=summary,
    )


@router.get("/{batch_id}/download")
def download_batch(batch_id: int, session: Session = Depends(get_session)) -> StreamingResponse:
    """Devuelve el lote entero como ZIP, con la estructura de carpetas
    Facturas/<cliente> y Albaranes/<cliente>."""
    batch = session.get(Batch, batch_id)
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lote no encontrado.")
    if batch.status is not BatchStatus.COMPLETADO:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"El lote todavía está en estado '{batch.status.value}'."
        )

    documents = session.execute(
        select(Document).where(Document.batch_id == batch_id)
    ).scalars().all()

    buffer = io.BytesIO()
    root = Path(str(get_settings().documents_dir / f"batch-{batch_id}"))
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for document in documents:
            path = Path(document.stored_path)
            if path.exists():
                archive.write(path, arcname=str(path.relative_to(root)))
    buffer.seek(0)

    filename = f"{sanitize_name(batch.name)}.zip"
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
