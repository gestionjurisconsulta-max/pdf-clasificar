#!/bin/sh
set -e

# Las migraciones se aplican al arrancar: así desplegar en el VPS es un
# `docker compose up -d --build` y nada más. Alembic es idempotente, de modo
# que reiniciar el contenedor no hace nada si el esquema ya está al día.
echo "Aplicando migraciones..."
alembic upgrade head

exec "$@"
