from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_session
from ..models import Client, ClientImport
from ..schemas import ClientOut, ImportFileResult, ImportResult
from ..services.excel import parse_clients
from ..services.matching import canonical_form

router = APIRouter(prefix="/api/clients", tags=["clientes"])

ALLOWED_SUFFIXES = (".xlsx", ".xlsm", ".xls", ".csv")


@router.get("", response_model=list[ClientOut])
def list_clients(
    search: str | None = None,
    limit: int = 500,
    session: Session = Depends(get_session),
) -> list[Client]:
    query = select(Client).order_by(Client.name)
    if search:
        pattern = f"%{search.lower()}%"
        query = query.where(
            func.lower(Client.name).like(pattern) | func.lower(Client.cif).like(pattern)
        )
    return list(session.execute(query.limit(min(limit, 2000))).scalars().all())


@router.post("/import", response_model=ImportResult, status_code=status.HTTP_201_CREATED)
async def import_clients(
    files: list[UploadFile] = File(...),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ImportResult:
    """Sube uno o varios Excel y los fusiona en la lista de clientes.

    Los clientes se identifican por el CIF en forma canónica, así que subir
    otra vez el mismo fichero, o un fichero que solapa con otro, actualiza en
    vez de duplicar.
    """
    if not files:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No se ha subido ningún fichero.")

    results: list[ImportFileResult] = []

    for upload in files:
        filename = upload.filename or "sin-nombre"
        if not filename.lower().endswith(ALLOWED_SUFFIXES):
            results.append(
                ImportFileResult(
                    filename=filename,
                    rows_read=0,
                    created=0,
                    updated=0,
                    error=f"Formato no admitido. Se aceptan: {', '.join(ALLOWED_SUFFIXES)}.",
                )
            )
            continue

        data = await upload.read()
        if len(data) > settings.max_upload_bytes:
            results.append(
                ImportFileResult(
                    filename=filename, rows_read=0, created=0, updated=0,
                    error="El fichero supera el tamaño máximo permitido.",
                )
            )
            continue

        try:
            parsed = parse_clients(data, filename)
        except Exception as exc:  # noqa: BLE001 - un Excel corrupto no debe tumbar el resto
            results.append(
                ImportFileResult(
                    filename=filename, rows_read=0, created=0, updated=0,
                    error=f"No se ha podido leer: {exc}",
                )
            )
            continue

        created = updated = 0
        for row in parsed:
            key = canonical_form(row.cif)
            if not key:
                continue
            existing = session.execute(
                select(Client).where(Client.cif_canonical == key)
            ).scalar_one_or_none()
            if existing is None:
                session.add(Client(cif_canonical=key, cif=row.cif, name=row.name))
                created += 1
            elif existing.name != row.name or existing.cif != row.cif:
                existing.name = row.name
                existing.cif = row.cif
                updated += 1
            # El mismo CIF dentro del mismo fichero sólo cuenta una vez.
            session.flush()

        session.add(
            ClientImport(
                filename=filename,
                rows_read=len(parsed),
                clients_created=created,
                clients_updated=updated,
            )
        )
        session.commit()

        results.append(
            ImportFileResult(
                filename=filename, rows_read=len(parsed), created=created, updated=updated
            )
        )

    total = session.execute(select(func.count()).select_from(Client)).scalar_one()
    return ImportResult(files=results, total_clients=total)
