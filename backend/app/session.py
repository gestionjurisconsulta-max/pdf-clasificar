"""Sesión anónima.

No hay inicio de sesión: cada navegador recibe un identificador aleatorio en una
cookie y todo lo que sube queda atado a él. No identifica a nadie, sólo separa
un trabajo de otro, que es justo lo que hace falta cuando varias personas del
mismo despacho manejan listas de clientes distintas.
"""

from __future__ import annotations

import re
import secrets

from fastapi import Request

COOKIE_NAME = "pdfc_sesion"
# Un mes. Sólo determina cuánto dura la cookie en el navegador; los datos del
# servidor se borran mucho antes (al descargar el ZIP o con el barrido).
COOKIE_MAX_AGE = 30 * 24 * 3600

_VALID = re.compile(r"^[0-9a-f]{32}$")


def new_session_id() -> str:
    return secrets.token_hex(16)


def is_valid(value: str | None) -> bool:
    """Sólo se acepta lo que hemos emitido nosotros. Sin esto, cualquiera podría
    poner a mano la cookie de otro (o un valor con SQL dentro) y llevarse sus
    datos."""
    return bool(value and _VALID.match(value))


def current(request: Request) -> str:
    """Identificador de la petición en curso. Lo deja el middleware."""
    session_id: str = request.state.session_id
    return session_id
