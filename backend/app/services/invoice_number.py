"""Extraer el número de factura o de albarán del texto de una página.

Port de `services/invoiceNumberService.ts`, incluida la parte que descarta los
importes: sin ella, "TOTAL FACTURA 2.777,60" producía ficheros llamados
"Fact_2.777".
"""

from __future__ import annotations

import re

# 1. Palabra clave. 2. Prefijo de numeración que hay que SALTAR ("Nº", "N.º",
# "Núm", "Número"): capturarlo devolvía "N" para "Factura Nº F-2026-0001".
# 3. El número, que debe contener al menos un dígito para no tragarse palabras
# sueltas como en "Factura de compra".
DEFAULT_INVOICE_REGEX = (
    r"(?:factura|albar[aá]n|albaran|fact|inv)[.:\s]*"
    r"(?:n[.ºo°]*|n[uú]m(?:ero)?)?[.:\s]*"
    r"([A-Za-z0-9][A-Za-z0-9\-/.]*[0-9][A-Za-z0-9\-/.]*)"
)

DEFAULT_CIF_REGEX = r"([ABCDEFGHJNPQRSUVW][0-9\s.\-]{7,8}[0-9A-J]|[0-9]{8}[A-Z])"

_AMOUNT_CONTEXT = re.compile(
    r"(total|base|importe|subtotal|suma|iva|irpf|descuento|a pagar)[^a-z0-9]{0,15}$",
    re.IGNORECASE,
)
_LOOKS_LIKE_DECIMALS = re.compile(r"^,\d")
_TRAILING_PUNCT = re.compile(r"[.\-/]+$")


def extract_invoice_number(text: str, pattern: str = DEFAULT_INVOICE_REGEX) -> str:
    """Devuelve el número encontrado, o '' si no hay ninguno.

    Nunca lanza: un patrón inválido se trata como "no encontrado" en vez de
    reventar el proceso a mitad de un lote.
    """
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error:
        return ""

    for match in regex.finditer(text or ""):
        raw = match.group(1) if match.lastindex else match.group(0)
        raw = _TRAILING_PUNCT.sub("", (raw or "").strip())
        if not raw:
            continue

        # ¿Es en realidad un importe? "2.777,60"
        if _LOOKS_LIKE_DECIMALS.match(text[match.end() : match.end() + 3]):
            continue
        # ¿Va precedido de una palabra de totales?
        if _AMOUNT_CONTEXT.search(text[max(0, match.start() - 20) : match.start()]):
            continue

        return raw

    return ""
