from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .enums import BatchStatus, DocumentType


class Base(DeclarativeBase):
    pass


class Client(Base):
    """Cliente receptor de las facturas. Se identifica por el CIF en forma
    canónica (tolerante a confusiones de OCR: B/8, G/6, O/0, I-L/1, S/5), que es
    lo que permite fusionar varios Excel sin duplicar clientes."""

    __tablename__ = "clients"

    id: Mapped[int] = mapped_column(primary_key=True)
    cif_canonical: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    cif: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    documents: Mapped[list[Document]] = relationship(back_populates="client")


class ClientImport(Base):
    """Cada Excel de clientes subido. Se guarda el recuento para que se vea qué
    aportó cada fichero cuando se suben varios."""

    __tablename__ = "client_imports"

    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(255))
    rows_read: Mapped[int] = mapped_column(Integer, default=0)
    clients_created: Mapped[int] = mapped_column(Integer, default=0)
    clients_updated: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Batch(Base):
    """Un lote de proceso: uno o varios PDF subidos a la vez."""

    __tablename__ = "batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[BatchStatus] = mapped_column(
        Enum(BatchStatus, name="batch_status", values_callable=lambda e: [m.value for m in e]),
        default=BatchStatus.PENDIENTE,
        index=True,
    )
    pages_total: Mapped[int] = mapped_column(Integer, default=0)
    pages_done: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    sources: Mapped[list[SourceFile]] = relationship(
        back_populates="batch", cascade="all, delete-orphan"
    )
    documents: Mapped[list[Document]] = relationship(
        back_populates="batch", cascade="all, delete-orphan"
    )


class SourceFile(Base):
    """Cada PDF original de un lote."""

    __tablename__ = "source_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    stored_path: Mapped[str] = mapped_column(String(512))
    page_count: Mapped[int] = mapped_column(Integer, default=0)

    batch: Mapped[Batch] = relationship(back_populates="sources")


class Document(Base):
    """Un documento detectado dentro de un PDF: una factura o un albarán, con
    sus páginas ya agrupadas."""

    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id", ondelete="CASCADE"), index=True)
    source_file_id: Mapped[int] = mapped_column(ForeignKey("source_files.id", ondelete="CASCADE"))
    client_id: Mapped[int | None] = mapped_column(
        ForeignKey("clients.id", ondelete="SET NULL"), nullable=True, index=True
    )

    doc_type: Mapped[DocumentType] = mapped_column(
        Enum(DocumentType, name="document_type", values_callable=lambda e: [m.value for m in e]),
        default=DocumentType.DESCONOCIDO,
        index=True,
    )
    number: Mapped[str] = mapped_column(String(128), default="")
    # Índices 0-based dentro del PDF de origen, en orden.
    page_indices: Mapped[list[int]] = mapped_column(JSONB, default=list)
    # Cuando más de un cliente encaja no se elige: se deja pendiente y se
    # guardan los candidatos para que alguien decida.
    ambiguous: Mapped[bool] = mapped_column(default=False)
    candidates: Mapped[list[str]] = mapped_column(JSONB, default=list)
    # Por qué se unieron las páginas, una línea por página añadida.
    notes: Mapped[list[str]] = mapped_column(JSONB, default=list)
    stored_path: Mapped[str] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    batch: Mapped[Batch] = relationship(back_populates="documents")
    client: Mapped[Client | None] = relationship(back_populates="documents")


Index("ix_documents_batch_type", Document.batch_id, Document.doc_type)
