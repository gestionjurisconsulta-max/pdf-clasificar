import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from . import session as session_mod
from .config import get_settings
from .db import SessionLocal, engine
from .routers import batches, clients, documents, sources
from .services.cleanup import purge_expired

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Barrido al arrancar: si el contenedor se reinició a mitad de un trabajo,
    # los ficheros de ese trabajo ya no le sirven a nadie.
    db = SessionLocal()
    try:
        purge_expired(db, settings)
    except Exception:  # noqa: BLE001 - que no impida arrancar
        logger.exception("El barrido inicial ha fallado")
    finally:
        db.close()
    yield


app = FastAPI(
    title="PdfClasificar API",
    description="Clasificación de facturas y albaranes por cliente. Los datos son efímeros.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    # Las peticiones llevan la cookie de sesión. En producción todo va por el
    # mismo origen (nginx), así que esto sólo aplica al desarrollo.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def sesion_anonima(request: Request, call_next):
    """Asegura que cada navegador tiene su identificador antes de tocar nada.

    Va en un middleware y no en una dependencia porque varios endpoints
    devuelven respuestas propias (el ZIP, las miniaturas), y en ese caso FastAPI
    no aplica las cabeceras de la `Response` inyectada: la cookie se perdería y
    el navegador empezaría de cero en cada descarga.
    """
    cookie = request.cookies.get(session_mod.COOKIE_NAME)
    emitir = None
    if not session_mod.is_valid(cookie):
        cookie = emitir = session_mod.new_session_id()

    request.state.session_id = cookie
    response = await call_next(request)

    if emitir:
        response.set_cookie(
            session_mod.COOKIE_NAME,
            emitir,
            max_age=session_mod.COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
            path="/",
        )
    return response


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
app.include_router(documents.router)
app.include_router(sources.router)
