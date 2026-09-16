import logging

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .config import get_settings
from .db import engine
from .routers import batches, clients

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

settings = get_settings()

app = FastAPI(
    title="PdfClasificar API",
    description="Clasificación de facturas y albaranes por cliente.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

health = APIRouter(tags=["salud"])


@health.get("/api/health")
def health_check() -> dict[str, str]:
    """Comprueba también la base de datos: un backend que responde pero no
    llega a Postgres no está sano, y el healthcheck de compose debe verlo."""
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        return {"status": "degraded", "database": f"error: {exc}"}
    return {"status": "ok", "database": "ok"}


app.include_router(health)
app.include_router(clients.router)
app.include_router(batches.router)
