"""Nombres de carpeta y de fichero seguros.

Port de `services/fileNameService.ts`. Los ficheros se generan en Linux pero se
descargan y se abren en Windows, así que se aplican las reglas de Windows, que
son las más restrictivas.
"""

from __future__ import annotations

import re

_INVALID = re.compile(r'[/\\?%*:|"<>]')
_TRAILING = re.compile(r"^\.+|[.\s]+$")


def sanitize_name(name: str) -> str:
    cleaned = _TRAILING.sub("", _INVALID.sub("-", name or "").strip())
    return cleaned or "Sin nombre"
