from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from .enums import BatchStatus, DocumentType


class ClientOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    cif: str
    name: str
    created_at: datetime


class ImportFileResult(BaseModel):
    filename: str
    rows_read: int
    created: int
    updated: int
    error: str | None = None


class ImportResult(BaseModel):
    files: list[ImportFileResult]
    total_clients: int


class SourceFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    filename: str
    page_count: int


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    doc_type: DocumentType
    number: str
    page_indices: list[int]
    ambiguous: bool
    candidates: list[str]
    notes: list[str]
    client_id: int | None
    client_name: str | None = None


class BatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    status: BatchStatus
    pages_total: int
    pages_done: int
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    sources: list[SourceFileOut] = []


class BatchDetail(BatchOut):
    documents: list[DocumentOut] = []
    summary: dict[str, int] = {}
