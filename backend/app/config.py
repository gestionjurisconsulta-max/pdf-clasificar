from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuración del backend. Todo llega por variables de entorno, que es
    lo que docker-compose inyecta desde el fichero .env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://pdfclasificar:pdfclasificar@db:5432/pdfclasificar"

    # Dónde se guardan los PDF subidos y los documentos generados. En
    # docker-compose es un volumen, para que sobreviva a los reinicios.
    storage_dir: Path = Path("/data")

    # Orígenes permitidos para el navegador. En producción el frontend va
    # detrás del mismo nginx, así que no hace falta CORS; esto es para
    # desarrollo, cuando Vite sirve en otro puerto.
    cors_origins: list[str] = ["http://localhost:3010", "http://localhost:5173"]

    # Tope por fichero subido. Un PDF de facturación de un mes rara vez pasa
    # de 100 MB; sin límite, una subida cualquiera puede llenar el disco.
    max_upload_bytes: int = 200 * 1024 * 1024

    # Idioma de Tesseract para las páginas escaneadas.
    ocr_language: str = "spa"

    @property
    def uploads_dir(self) -> Path:
        return self.storage_dir / "uploads"

    @property
    def documents_dir(self) -> Path:
        return self.storage_dir / "documents"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    settings.documents_dir.mkdir(parents=True, exist_ok=True)
    return settings
