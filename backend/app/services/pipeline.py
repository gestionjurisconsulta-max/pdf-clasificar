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
from . import storage
from .continuation import PageText, group_by_continuation
from .matching import Company, find_matching_company

logger = logging.getLogger(__name__)


def _load_companies(session: Session) -> list[Company]:
    rows = session.execute(select(Client)).scalars().all()
    return [Company(cif=c.cif, name=c.name, id=c.id) for c in rows]


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

        for source in sources:
            source_path = Path(source.stored_path)

            # El progreso se cuenta por página LEÍDA, no por documento escrito:
            # en un PDF escaneado el OCR se lleva casi todo el tiempo, y contar
            # sólo al final dejaba la barra a cero durante minutos.
            def pagina_leida(_index: int, batch=batch) -> None:
                batch.pages_done += 1
                session.commit()

            texts = pdf_service.extract_text_per_page(
                source_path, settings.ocr_language, on_page=pagina_leida
            )
            source.page_count = len(texts)
            session.commit()

            groups = group_by_continuation(
                [PageText(index=i, text=t) for i, t in enumerate(texts)]
            )

            for group in groups:
                joined = "\n".join(texts[i] for i in group.indices)
                match = find_matching_company(joined, companies)

                document = Document(
                    batch_id=batch_id,
                    source_file_id=source.id,
                    client_id=match.company.id if match.company else None,
                    doc_type=group.doc_type,
                    number=group.number or "",
                    page_indices=group.indices,
                    ambiguous=match.ambiguous,
                    candidates=[c.name for c in match.candidates],
                    notes=group.notes,
                    stored_path="",
                )
                storage.write_document(
                    document, source, match.company.name if match.company else None, settings
                )
                session.add(document)

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
