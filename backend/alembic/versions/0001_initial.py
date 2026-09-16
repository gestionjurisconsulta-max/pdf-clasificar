"""Esquema inicial: clientes, importaciones, lotes, ficheros y documentos.

Revision ID: 0001_initial
Revises:
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

DOCUMENT_TYPE_VALUES = ("factura", "albaran", "desconocido")
BATCH_STATUS_VALUES = ("pendiente", "procesando", "completado", "fallido")

# create_type=False: el tipo se crea una sola vez, explícitamente, más abajo.
# Sin esto, `create_table` vuelve a emitir CREATE TYPE y la migración muere con
# "type already exists".
document_type = postgresql.ENUM(*DOCUMENT_TYPE_VALUES, name="document_type", create_type=False)
batch_status = postgresql.ENUM(*BATCH_STATUS_VALUES, name="batch_status", create_type=False)


def upgrade() -> None:
    bind = op.get_bind()
    postgresql.ENUM(*DOCUMENT_TYPE_VALUES, name="document_type").create(bind, checkfirst=True)
    postgresql.ENUM(*BATCH_STATUS_VALUES, name="batch_status").create(bind, checkfirst=True)

    op.create_table(
        "clients",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("cif_canonical", sa.String(32), nullable=False),
        sa.Column("cif", sa.String(32), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_clients_cif_canonical", "clients", ["cif_canonical"], unique=True)

    op.create_table(
        "client_imports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("rows_read", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("clients_created", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("clients_updated", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "batches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("status", batch_status, nullable=False, server_default="pendiente"),
        sa.Column("pages_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pages_done", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_batches_status", "batches", ["status"])

    op.create_table(
        "source_files",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("batch_id", sa.Integer(), sa.ForeignKey("batches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("stored_path", sa.String(512), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_source_files_batch_id", "source_files", ["batch_id"])

    op.create_table(
        "documents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("batch_id", sa.Integer(), sa.ForeignKey("batches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_file_id", sa.Integer(), sa.ForeignKey("source_files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="SET NULL"), nullable=True),
        sa.Column("doc_type", document_type, nullable=False, server_default="desconocido"),
        sa.Column("number", sa.String(128), nullable=False, server_default=""),
        sa.Column("page_indices", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("ambiguous", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("candidates", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("notes", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("stored_path", sa.String(512), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_documents_batch_id", "documents", ["batch_id"])
    op.create_index("ix_documents_client_id", "documents", ["client_id"])
    op.create_index("ix_documents_doc_type", "documents", ["doc_type"])
    op.create_index("ix_documents_batch_type", "documents", ["batch_id", "doc_type"])


def downgrade() -> None:
    op.drop_table("documents")
    op.drop_table("source_files")
    op.drop_table("batches")
    op.drop_table("client_imports")
    op.drop_index("ix_clients_cif_canonical", table_name="clients")
    op.drop_table("clients")

    bind = op.get_bind()
    postgresql.ENUM(name="batch_status").drop(bind, checkfirst=True)
    postgresql.ENUM(name="document_type").drop(bind, checkfirst=True)
