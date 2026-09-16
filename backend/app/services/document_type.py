"""Distinguir una factura de un albarán.

No existe en el frontend: es la funcionalidad nueva. El criterio principal es
la CABECERA, porque es donde va el título del documento. Una factura menciona
muy a menudo el albarán que la origina ("según nuestro albarán 4471"), así que
contar palabras en todo el texto se equivoca justo en el caso más común.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from ..enums import DocumentType

# Cuánto texto se considera "cabecera". Suficiente para el membrete, el título
# y el número; no tanto como para tragarse las líneas de detalle.
HEADER_CHARS = 400

_ALBARAN_TITLE = re.compile(r"\balbaran(?:es)?\b|\bnota de entrega\b|\bdelivery note\b|\bremito\b")
_FACTURA_TITLE = re.compile(r"\bfactura(?:s)?\b|\bfactura simplificada\b|\binvoice\b")

# Señales de que hay liquidación de impuestos: sólo aparecen en facturas.
# Un albarán lista mercancía, no cuadra IVA ni retenciones.
_FISCAL_SIGNALS = (
    re.compile(r"\bbase imponible\b"),
    re.compile(r"\b(?:i\.?v\.?a\.?|impuesto sobre el valor)\b"),
    re.compile(r"\birpf\b|\bretencion\b"),
    re.compile(r"\bcuota\b"),
    re.compile(r"\btotal factura\b"),
)

# Señales propias del albarán.
_DELIVERY_SIGNALS = (
    re.compile(r"\balbaran\b"),
    re.compile(r"\bnota de entrega\b"),
    re.compile(r"\brecibi conforme\b|\brecibido conforme\b"),
    re.compile(r"\bbultos\b"),
    re.compile(r"\btransportista\b"),
    re.compile(r"\bfirma del cliente\b"),
)


def normalize(text: str) -> str:
    """Minúsculas y sin tildes: el OCR se come los acentos con frecuencia, así
    que 'ALBARÁN', 'albaran' y 'Albarán' tienen que ser la misma palabra."""
    lowered = (text or "").lower()
    decomposed = unicodedata.normalize("NFD", lowered)
    without_accents = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", without_accents)


@dataclass
class TypeVerdict:
    doc_type: DocumentType
    reason: str


def detect_document_type(text: str) -> TypeVerdict:
    normalized = normalize(text)
    if not normalized.strip():
        return TypeVerdict(DocumentType.DESCONOCIDO, "la página no tiene texto legible")

    header = normalized[:HEADER_CHARS]

    albaran_in_header = _ALBARAN_TITLE.search(header)
    factura_in_header = _FACTURA_TITLE.search(header)
    fiscal = sum(1 for s in _FISCAL_SIGNALS if s.search(normalized))

    if albaran_in_header:
        # Liquidar impuestos pesa más que el título: un albarán lista mercancía,
        # no calcula base imponible ni IVA. Si la página los calcula, es una
        # factura que arrastra el número de albarán en el membrete.
        if fiscal >= 2:
            return TypeVerdict(DocumentType.FACTURA, "menciona albarán pero liquida impuestos")
        # Si aparecen los dos títulos, manda el que va ANTES: es el encabezado.
        if factura_in_header and factura_in_header.start() < albaran_in_header.start():
            return TypeVerdict(DocumentType.FACTURA, "el título de la cabecera es factura")
        return TypeVerdict(DocumentType.ALBARAN, "la cabecera dice albarán")

    if factura_in_header:
        return TypeVerdict(DocumentType.FACTURA, "la cabecera dice factura")

    # Sin título reconocible: se decide por acumulación de señales.
    delivery = sum(1 for s in _DELIVERY_SIGNALS if s.search(normalized))

    if fiscal > delivery and fiscal > 0:
        return TypeVerdict(DocumentType.FACTURA, f"{fiscal} señales fiscales")
    if delivery > fiscal and delivery > 0:
        return TypeVerdict(DocumentType.ALBARAN, f"{delivery} señales de entrega")

    return TypeVerdict(DocumentType.DESCONOCIDO, "sin título ni señales claras")
