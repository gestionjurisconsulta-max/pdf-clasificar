"""Correcciones manuales sobre los documentos ya detectados.

El troceado automático acierta la mayoría de las veces, pero no siempre: hace
falta poder decir "esta factura es de otro cliente", "esto es un albarán" o
"estas dos hojas no iban juntas". Cada cambio regenera el PDF afectado en la
carpeta que le corresponde.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_session
from ..enums import DocumentType
from ..models import Client, Document, SourceFile
from ..schemas import DocumentOut
from ..services import storage

router = APIRouter(prefix="/api/documents", tags=["documentos"])


class DocumentUpdate(BaseModel):
    """Campos opcionales: se aplica sólo lo que venga. `client_id: null` es una
    petición explícita de dejarlo pendiente, distinta de no tocar el campo."""

    client_id: int | None = Field(default=None)
    doc_type: DocumentType | None = None
    number: str | None = None
    # Sin esto no se podría distinguir "no toques el cliente" de "quítalo".
    clear_client: bool = False


class SplitRequest(BaseModel):
    """Índice de página (el del PDF de origen) por el que parte el documento.
    Esa página abre el documento nuevo."""

    at_page: int


def _to_out(document: Document) -> DocumentOut:
    return DocumentOut(
        id=document.id,
        source_file_id=document.source_file_id,
        doc_type=document.doc_type,
        number=document.number,
        page_indices=document.page_indices,
        ambiguous=document.ambiguous,
        candidates=document.candidates,
        notes=document.notes,
        client_id=document.client_id,
        client_name=document.client.name if document.client else None,
    )


def _get(session: Session, document_id: int) -> Document:
    document = session.get(Document, document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Documento no encontrado.")
    return document


def _client_name(session: Session, client_id: int | None) -> str | None:
    if client_id is None:
        return None
    client = session.get(Client, client_id)
    return client.name if client else None


@router.patch("/{document_id}", response_model=DocumentOut)
def update_document(
    document_id: int,
    update: DocumentUpdate,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> DocumentOut:
    document = _get(session, document_id)
    source = session.get(SourceFile, document.source_file_id)
    if source is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Falta el PDF de origen del documento.")

    if update.clear_client:
        document.client_id = None
    elif update.client_id is not None:
        if session.get(Client, update.client_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ese cliente no existe.")
        document.client_id = update.client_id

    if update.doc_type is not None:
        document.doc_type = update.doc_type
    if update.number is not None:
        document.number = update.number.strip()

    # Corregir a mano resuelve la duda: deja de estar marcado como ambiguo.
    if document.client_id is not None:
        document.ambiguous = False

    storage.write_document(document, source, _client_name(session, document.client_id), settings)
    session.commit()
    session.refresh(document)
    return _to_out(document)


@router.post("/{document_id}/split", response_model=list[DocumentOut])
def split_document(
    document_id: int,
    request: SplitRequest,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> list[DocumentOut]:
    """Parte un documento en dos. Útil cuando la detección unió dos facturas
    que no iban juntas."""
    document = _get(session, document_id)
    source = session.get(SourceFile, document.source_file_id)
    if source is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Falta el PDF de origen del documento.")

    pages = list(document.page_indices)
    if request.at_page not in pages:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Esa página no está en el documento.")
    position = pages.index(request.at_page)
    if position == 0:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "No se puede partir por la primera página: el documento quedaría vacío.",
        )

    head, tail = pages[:position], pages[position:]
    client_name = _client_name(session, document.client_id)

    document.page_indices = head
    # Las notas explicaban por qué se unieron páginas que ya no están juntas.
    document.notes = []
    storage.write_document(document, source, client_name, settings)

    # El documento nuevo hereda cliente y tipo: lo más probable es que sólo se
    # haya equivocado el corte, no la clasificación.
    nuevo = Document(
        batch_id=document.batch_id,
        source_file_id=document.source_file_id,
        client_id=document.client_id,
        doc_type=document.doc_type,
        number="",
        page_indices=tail,
        ambiguous=False,
        candidates=[],
        notes=[f"Separado a mano del documento de la pág. {head[0] + 1}."],
        stored_path="",
    )
    storage.write_document(nuevo, source, client_name, settings)
    session.add(nuevo)
    session.commit()
    session.refresh(document)
    session.refresh(nuevo)
    return [_to_out(document), _to_out(nuevo)]


@router.post("/{document_id}/merge-next", response_model=DocumentOut)
def merge_with_next(
    document_id: int,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> DocumentOut:
    """Absorbe el documento siguiente del mismo PDF. Útil cuando una hoja de
    continuación quedó suelta."""
    document = _get(session, document_id)
    source = session.get(SourceFile, document.source_file_id)
    if source is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Falta el PDF de origen del documento.")

    siblings = session.execute(
        select(Document).where(Document.source_file_id == document.source_file_id)
    ).scalars().all()

    def first_page(d: Document) -> int:
        return d.page_indices[0] if d.page_indices else 0

    ordered = sorted(siblings, key=first_page)
    index = next(i for i, d in enumerate(ordered) if d.id == document.id)
    if index + 1 >= len(ordered):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "No hay ningún documento después de este en el mismo PDF."
        )

    siguiente = ordered[index + 1]
    added = list(siguiente.page_indices)

    document.page_indices = sorted(set(document.page_indices) | set(added))
    document.notes = [
        *document.notes,
        f"Unido a mano con el documento de la pág. {added[0] + 1}.",
    ]

    storage.remove_file(siguiente.stored_path)
    session.delete(siguiente)
    session.flush()

    storage.write_document(document, source, _client_name(session, document.client_id), settings)
    session.commit()
    session.refresh(document)
    return _to_out(document)
