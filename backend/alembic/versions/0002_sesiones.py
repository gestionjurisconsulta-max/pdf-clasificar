"""Aísla los datos por sesión anónima y los hace efímeros.

La aplicación no tiene inicio de sesión, pero tampoco puede tener una base
común: dos personas del mismo despacho manejan listas de clientes distintas, y
sin aislamiento la segunda vería los clientes de la primera y podría descargarse
su ZIP cambiando el número en la URL.

Cada navegador recibe un identificador anónimo y todo lo que sube queda atado a
él. Como los datos se borran al descargar el ZIP, no hay nada que migrar de las
filas anteriores: se vacían las tablas.

Revision ID: 0002_sesiones
Revises: 0001_initial
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002_sesiones"
down_revision = "0001_initial"
branch_labels = None
depends_on = None

SESSION_LEN = 64


def upgrade() -> None:
    # Los datos son efímeros por diseño: lo que hubiera de antes no pertenece a
    # ninguna sesión y no habría forma de asignárselo a nadie.
    op.execute("TRUNCATE TABLE documents, source_files, batches, clients, client_imports CASCADE")

    for table in ("clients", "batches", "client_imports"):
        op.add_column(table, sa.Column("session_id", sa.String(SESSION_LEN), nullable=False))
        op.create_index(f"ix_{table}_session_id", table, ["session_id"])

    # El CIF pasa a ser único DENTRO de cada sesión, no en toda la base: dos
    # personas pueden tener el mismo cliente en sus respectivas listas.
    op.drop_index("ix_clients_cif_canonical", table_name="clients")
    op.create_index(
        "ix_clients_session_cif", "clients", ["session_id", "cif_canonical"], unique=True
    )
    op.create_index("ix_clients_cif_canonical", "clients", ["cif_canonical"])

    # Para poder barrer las sesiones abandonadas sin escanear la tabla entera.
    op.create_index("ix_batches_created_at", "batches", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_batches_created_at", table_name="batches")
    op.drop_index("ix_clients_cif_canonical", table_name="clients")
    op.drop_index("ix_clients_session_cif", table_name="clients")
    op.create_index("ix_clients_cif_canonical", "clients", ["cif_canonical"], unique=True)

    for table in ("clients", "batches", "client_imports"):
        op.drop_index(f"ix_{table}_session_id", table_name=table)
        op.drop_column(table, "session_id")
