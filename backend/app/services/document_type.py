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


# Un documento que ENCABEZA UNA LÍNEA declarando su propio número —
# "ALBARÁN: A6-004757", "FACTURA: M6-001364"— está diciendo lo que es, y eso
# manda sobre cualquier otra señal. Se exige que empiece la línea para no
# confundirlo con una referencia dentro del cuerpo ("según nuestro albarán
# A-3312") ni con el encabezado de la columna del cliente ("SOLICITANTE
# FACTURA A").
_SELF_TITLE = re.compile(
    r"^[^\S\n]*(factura|albaran)(?:es)?[^\S\n]*"
    r"(?:n[.ºo°]*[^\S\n]*)?"
    r"(?::|(?=[a-z0-9][a-z0-9\-/.]*\d))",
    re.MULTILINE,
)


def normalize(text: str) -> str:
    """Minúsculas y sin tildes: el OCR se come los acentos con frecuencia, así
    que 'ALBARÁN', 'albaran' y 'Albarán' tienen que ser la misma palabra.

    Se conservan los saltos de línea, porque saber que algo encabeza una línea
    es justo lo que distingue el título de una referencia de pasada.
    """
    lowered = (text or "").lower()
    decomposed = unicodedata.normalize("NFD", lowered)
    without_accents = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    # Espacios horizontales colapsados, saltos de línea intactos.
    return re.sub(r"[^\S\n]+", " ", without_accents)


@dataclass
class TypeVerdict:
    doc_type: DocumentType
    reason: str


def detect_document_type(text: str) -> TypeVerdict:
    normalized = normalize(text)
    if not normalized.strip():
        return TypeVerdict(DocumentType.DESCONOCIDO, "la página no tiene texto legible")

    header = normalized[:HEADER_CHARS]

    # 1. El documento declara su propio número al principio de una línea. Es la
    #    señal más fuerte que existe y gana a todo lo demás, incluidos los
    #    impuestos: hay proveedores que imprimen base imponible e IVA también en
    #    sus albaranes, y darle prioridad a eso los clasificaba como facturas.
    declarado = _SELF_TITLE.search(header)
    if declarado:
        tipo = DocumentType.ALBARAN if declarado.group(1) == "albaran" else DocumentType.FACTURA
        return TypeVerdict(tipo, f"la página se titula «{declarado.group(1)}»")

    albaran_in_header = _ALBARAN_TITLE.search(header)
    factura_in_header = _FACTURA_TITLE.search(header)
    fiscal = sum(1 for s in _FISCAL_SIGNALS if s.search(normalized))

    if albaran_in_header:
        # Sin título propio, "albarán" suelto puede ser una referencia dentro de
        # una factura ("según nuestro albarán A-3312"). Ahí sí manda que la
        # página liquide impuestos.
        if fiscal >= 2:
            return TypeVerdict(DocumentType.FACTURA, "menciona albarán pero liquida impuestos")
        # Si aparecen los dos, manda el que va ANTES: es el encabezado.
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
