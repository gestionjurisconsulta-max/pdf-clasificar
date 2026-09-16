"""Borrado de los datos de un trabajo.

La aplicación no guarda nada: la base es el andamio de un trabajo que empieza al
subir el Excel y termina al descargar el ZIP. Aquí está todo lo que hay que
quitar, para que no se olvide una pieza y queden ficheros sueltos en el disco
del VPS.
"""

from __future__ import annotations

import logging
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..models import Batch, Client, ClientImport, SourceFile

logger = logging.getLogger(__name__)


def _remove_tree(path: Path) -> None:
    try:
        shutil.rmtree(path, ignore_errors=True)
    except OSError as exc:  # noqa: PERF203 - un fallo al limpiar no debe propagarse
        logger.warning("No se ha podido borrar %s: %s", path, exc)


def purge_batch(session: Session, batch: Batch, settings: Settings) -> None:
    """Borra un lote entero: PDF subidos, documentos generados, miniaturas y
    filas. Las miniaturas se guardan por id de PDF de origen, así que hay que
    leerlos ANTES de borrar la fila o se quedan huérfanas en el disco."""
    source_ids = session.execute(
        select(SourceFile.id).where(SourceFile.batch_id == batch.id)
    ).scalars().all()

    _remove_tree(settings.uploads_dir / f"batch-{batch.id}")
    _remove_tree(settings.documents_dir / f"batch-{batch.id}")
    for source_id in source_ids:
        _remove_tree(settings.storage_dir / "thumbs" / str(source_id))

    # documents y source_files caen por ON DELETE CASCADE.
    session.delete(batch)


def purge_session(session: Session, session_id: str, settings: Settings) -> None:
    """Todo lo de una sesión: sus lotes y también su lista de clientes. Es lo
    que se ejecuta al descargar el ZIP."""
    batches = session.execute(
        select(Batch).where(Batch.session_id == session_id)
    ).scalars().all()
    for batch in batches:
        purge_batch(session, batch, settings)

    session.execute(delete(Client).where(Client.session_id == session_id))
    session.execute(delete(ClientImport).where(ClientImport.session_id == session_id))
    session.commit()
    logger.info("Sesión %s borrada (%s lotes)", session_id[:8], len(batches))


def purge_expired(session: Session, settings: Settings) -> int:
    """Barre los trabajos abandonados: quien sube un PDF y nunca descarga el ZIP
    dejaría ficheros en el disco para siempre. Se ejecuta al arrancar y cada vez
    que se crea un lote, para no tener que montar un planificador."""
    limit = datetime.now(timezone.utc) - timedelta(hours=settings.purge_after_hours)

    expired = session.execute(select(Batch).where(Batch.created_at < limit)).scalars().all()
    sessions = {batch.session_id for batch in expired}
    for batch in expired:
        purge_batch(session, batch, settings)

    # Los clientes de una sesión sólo se borran si no le queda ningún lote:
    # alguien puede haber subido el Excel y estar todavía preparando el PDF.
    for session_id in sessions:
        queda = session.execute(
            select(Batch.id).where(Batch.session_id == session_id).limit(1)
        ).scalar_one_or_none()
        if queda is None:
            session.execute(delete(Client).where(Client.session_id == session_id))
            session.execute(delete(ClientImport).where(ClientImport.session_id == session_id))

    # Una lista de clientes subida y nunca usada también caduca.
    huerfanos = session.execute(
        select(Client.session_id)
        .where(Client.created_at < limit)
        .group_by(Client.session_id)
    ).scalars().all()
    for session_id in huerfanos:
        tiene_lote = session.execute(
            select(Batch.id).where(Batch.session_id == session_id).limit(1)
        ).scalar_one_or_none()
        if tiene_lote is None:
            session.execute(delete(Client).where(Client.session_id == session_id))
            session.execute(delete(ClientImport).where(ClientImport.session_id == session_id))

    session.commit()
    if expired:
        logger.info("Barrido: %s lotes caducados", len(expired))
    return len(expired)
