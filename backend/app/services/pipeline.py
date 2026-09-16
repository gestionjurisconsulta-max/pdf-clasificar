"""El proceso completo de un lote: leer, agrupar, clasificar y trocear.

Es el equivalente de lo que `processAndDivide` hacía en el navegador, pero
sobre varios PDF a la vez y guardando el resultado en la base de datos.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings
from ..enums import BatchStatus, DocumentType
from ..models import Batch, Client, Document, SourceFile
from . import pdf as pdf_service
from .continuation import PageText, group_by_continuation
from .matching import Company, find_matching_company
from .naming import sanitize_name

logger = logging.getLogger(__name__)

PENDING_FOLDER = "Pendiente de asignar"


def _load_companies(session: Session) -> list[Company]:
    rows = session.execute(select(Client)).scalars().all()
    return [Company(cif=c.cif, name=c.name, id=c.id) for c in rows]


def _folder_for(doc_type: DocumentType, client_name: str | None) -> str:
    """Los albaranes van a su propia rama para que no se mezclen con la
    facturación: era el motivo de separarlos."""
    base = "Albaranes" if doc_type is DocumentType.ALBARAN else "Facturas"
    return f"{base}/{sanitize_name(client_name) if client_name else PENDING_FOLDER}"


def process_batch(session: Session, batch_id: int, settings: Settings) -> None:
    batch = session.get(Batch, batch_id)
    if batch is None:
        logger.error("El lote %s ya no existe", batch_id)
        return

    batch.status = BatchStatus.PROCESANDO
    batch.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        companies = _load_companies(session)
        sources = session.execute(
            select(SourceFile).where(SourceFile.batch_id == batch_id).order_by(SourceFile.id)
        ).scalars().all()

        out_root = settings.documents_dir / f"batch-{batch_id}"

        for source in sources:
            source_path = Path(source.stored_path)
            texts = pdf_service.extract_text_per_page(source_path, settings.ocr_language)
            source.page_count = len(texts)
            session.commit()

            groups = group_by_continuation(
                [PageText(index=i, text=t) for i, t in enumerate(texts)]
            )

            for group in groups:
                joined = "\n".join(texts[i] for i in group.indices)
                match = find_matching_company(joined, companies)

                client_id = match.company.id if match.company else None
                client_name = match.company.name if match.company else None

                number = sanitize_name(group.number) if group.number else "S-N"
                folder = _folder_for(group.doc_type, client_name)
                stem = sanitize_name(Path(source.filename).stem)
                filename = f"PAG_{group.indices[0] + 1:03d}_{stem}_{number}.pdf"
                destination = out_root / folder / filename

                pdf_service.extract_pages(source_path, group.indices, destination)

                session.add(
                    Document(
                        batch_id=batch_id,
                        source_file_id=source.id,
                        client_id=client_id,
                        doc_type=group.doc_type,
                        number=group.number or "",
                        page_indices=group.indices,
                        ambiguous=match.ambiguous,
                        candidates=[c.name for c in match.candidates],
                        notes=group.notes,
                        stored_path=str(destination),
                    )
                )

                batch.pages_done += len(group.indices)
                session.commit()

        batch.status = BatchStatus.COMPLETADO
        batch.finished_at = datetime.now(timezone.utc)
        session.commit()

    except Exception as exc:  # noqa: BLE001 - el lote debe quedar marcado, no colgado
        logger.exception("El lote %s ha fallado", batch_id)
        session.rollback()
        failed = session.get(Batch, batch_id)
        if failed is not None:
            failed.status = BatchStatus.FALLIDO
            failed.error = str(exc)
            failed.finished_at = datetime.now(timezone.utc)
            session.commit()
