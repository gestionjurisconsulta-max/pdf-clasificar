"""Número de documento leído de la LÍNEA DE CABECERA, sin palabra clave.

Port de `detect_header_doc` de DivisorPDF. Es la señal que le faltaba a la
detección de continuaciones para separar dos facturas seguidas del mismo
cliente: `invoice_number.py` sólo encuentra el número si va pegado a la palabra
"Factura" o "Albarán", y muchísimos proveedores imprimen únicamente la línea

    <Nº DOCUMENTO>   <FECHA>   <CLIENTE>   <PÁG/TOTAL>

Sin número, la segunda factura no tenía forma de demostrar que era una cabecera
y se unía a la anterior.

De esa misma línea sale también la paginación suelta ("1/1", "2 / 2"), que es
la otra mitad del problema: `continuation.py` sólo reconocía la paginación si
venía con la palabra "Pág." o "Hoja", así que en estas facturas nunca se
disparaba la regla de "el documento anterior ya estaba completo".

No depende de conocer al proveedor: es deliberadamente genérico.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# Fecha de la cabecera. Se aceptan los tres separadores habituales y el año de
# dos cifras, que algunos proveedores siguen usando.
_RE_DATE = re.compile(r"\b\d{2}[/.\-]\d{2}[/.\-](?:\d{4}|\d{2})\b")

# Token con forma de número de documento: '262000663', '26 BAR262023454',
# '2026-0042', 'S19153'. SIN re.IGNORECASE a propósito: las letras de un número
# de documento van en mayúsculas, y permitir minúsculas hacía que cualquier
# palabra del texto entrase como candidata.
_RE_DOCNUM = re.compile(r"\b((?:\d{1,4}[\s_/-]?)?(?:[A-Z]{1,5}[\s_/-]?)?\d{4,12})\b")

# Paginación suelta al final de la línea de cabecera: '1/1', '2 / 2'.
_RE_HDR_PAGINA = re.compile(r"\b(\d{1,2})\s*/\s*(\d{1,2})\b")

# Etiqueta explícita, como respaldo cuando no hay línea de cabecera completa.
# El OCR destroza el 'º' de mil formas: N*, N?, Ne, N., No, N°...
_RE_DOC_LABEL = re.compile(
    r"N[eo.*?°]{0,2}\s*(?:de\s+)?"
    r"(?:Facturas?|Abono|Albaran(?:es)?|Documento|Nota\s+de\s+abono|Rectificativa)\b",
    re.IGNORECASE,
)

# Forma de un identificador fiscal español. Un CIF en la cabecera no es el
# número del documento, y sin este filtro se colaba como tal.
_RE_FISCAL_SHAPE = re.compile(
    r"[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z]"
)

# Cuánto texto se mira tras la etiqueta para encontrar su número.
_LABEL_WINDOW = 300

# Máximo de hojas que se admite en una paginación. Por encima de esto lo más
# probable es que sea una cantidad o una medida, no "pág. X de Y".
_MAX_PAGES = 30


def _unaccent(text: str) -> str:
    """Quita tildes CONSERVANDO las mayúsculas, que `_RE_DOCNUM` necesita.

    Se usa NFKD, no NFD, para que el 'º' de 'Nº' se descomponga en una 'o' y la
    etiqueta se reconozca igual que si el OCR hubiera leído 'No'.
    """
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def _norm_num(value: str) -> str:
    """Normaliza un número de documento: mayúsculas y sin separadores, para que
    'BAR 262023454' y 'BAR-262023454' sean el mismo número."""
    return re.sub(r"[\s_.\-/]", "", (value or "").upper())


def _looks_like_doc_number(token: str) -> bool:
    """Parece un número de documento, y no una fecha, un CIF ni un código corto."""
    normalized = _norm_num(token)
    if sum(c.isdigit() for c in normalized) < 5:
        return False
    if _RE_FISCAL_SHAPE.fullmatch(normalized):
        return False
    return not _RE_DATE.match(token)


@dataclass(frozen=True)
class HeaderDoc:
    """Lo que se ha podido leer de la línea de cabecera."""

    number: str = ""
    page: int | None = None
    total: int | None = None


def _read_pagination(tail: str) -> tuple[int | None, int | None]:
    match = _RE_HDR_PAGINA.search(tail)
    if not match:
        return None, None
    page, total = int(match.group(1)), int(match.group(2))
    if 1 <= page <= total <= _MAX_PAGES:
        return page, total
    return None, None


def read_header_doc(text: str) -> HeaderDoc:
    """Número de documento y paginación de la cabecera, o un `HeaderDoc` vacío.

    Dos páginas con número de cabecera distinto son documentos distintos; dos
    páginas con el mismo número son el mismo documento (una factura de varias
    hojas, o el original y su copia).
    """
    plain = _unaccent(text)

    candidates: list[HeaderDoc] = []
    for line in plain.splitlines():
        date = _RE_DATE.search(line)
        if not date:
            continue
        before = line[: date.start()].strip()
        if not before:
            # La fecha abre la línea: es una fecha suelta, no una cabecera.
            continue
        token = _RE_DOCNUM.match(before)
        if not token or not _looks_like_doc_number(token.group(1)):
            continue
        # Entre el número y la fecha sólo cabe ruido de OCR, no texto: si hay
        # palabras, la línea es prosa y el número es cualquier otra cosa.
        rest = before[token.end() :].strip()
        if len(rest) > 3 or any(c.isalnum() for c in rest):
            continue
        page, total = _read_pagination(line[date.end() :])
        candidates.append(HeaderDoc(_norm_num(token.group(1)), page, total))

    # Una cabecera aparece UNA vez. Varias líneas con esta forma y números
    # distintos son una tabla de detalle —el resumen de albaranes que algunas
    # facturas listan—, y tomar la primera por cabecera partía la factura en
    # dos. Si todas repiten el mismo número sí es la cabecera, impresa dos
    # veces (el original y su copia en la misma hoja).
    if candidates and len({c.number for c in candidates}) == 1:
        return candidates[0]

    label = _RE_DOC_LABEL.search(plain)
    if label:
        window = plain[label.end() : label.end() + _LABEL_WINDOW]
        for token in _RE_DOCNUM.finditer(window):
            if _looks_like_doc_number(token.group(1)):
                return HeaderDoc(_norm_num(token.group(1)))

    return HeaderDoc()
