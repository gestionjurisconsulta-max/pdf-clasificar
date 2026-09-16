"""Agrupar las hojas que son continuación del documento anterior.

Port de `services/continuationService.ts`, con una regla añadida que allí no
tenía sentido: si el tipo de documento cambia (una factura seguida de un
albarán), nunca es continuación por mucho que la hoja no tenga identidad propia.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..enums import DocumentType
from .document_type import detect_document_type, normalize
from .invoice_number import DEFAULT_CIF_REGEX, DEFAULT_INVOICE_REGEX, extract_invoice_number
from .matching import canonical_form

# "Página 2 de 3", "Pág. 2/3", "Hoja 2 de 3".
_PAGE_MARKER = re.compile(r"(?:pag(?:ina)?|hoja)\.?\s*:?\s*(\d{1,3})\s*(?:de|/)\s*(\d{1,3})")

_CONTINUATION_WORDS = re.compile(
    r"continuacion|continua\s+en|viene\s+de\s+la\s+(?:pagina|hoja)|sigue\s+en\s+la"
)

# Por debajo de esto se da la página por vacía (escaneo en blanco, separador).
BLANK_THRESHOLD = 12


@dataclass
class PageIdentity:
    number: str = ""
    cifs: list[str] = field(default_factory=list)
    page_marker: int | None = None
    #: El total de "Pág. 2 DE 3". Saber cuántas hojas tiene el documento es lo
    #: que permite cerrarlo cuando llega a la última.
    page_total: int | None = None
    says_continuation: bool = False
    is_blank: bool = False
    doc_type: DocumentType = DocumentType.DESCONOCIDO


def _read_cifs(text: str, cif_pattern: str) -> list[str]:
    try:
        matches = re.finditer(cif_pattern, text or "", re.IGNORECASE)
    except re.error:
        return []

    seen: list[str] = []
    for match in matches:
        cif = canonical_form(match.group(1) if match.lastindex else match.group(0))
        # Un CIF/NIF español tiene exactamente 9 caracteres. Sin este filtro, un
        # número como "F-2026-0042" encaja en el patrón y se cuela como CIF.
        if len(cif) == 9 and cif not in seen:
            seen.append(cif)
    return seen


def read_page_identity(
    text: str,
    invoice_pattern: str = DEFAULT_INVOICE_REGEX,
    cif_pattern: str = DEFAULT_CIF_REGEX,
) -> PageIdentity:
    marker = _PAGE_MARKER.search(normalize(text))
    return PageIdentity(
        number=extract_invoice_number(text, invoice_pattern),
        cifs=_read_cifs(text, cif_pattern),
        page_marker=int(marker.group(1)) if marker else None,
        page_total=int(marker.group(2)) if marker else None,
        says_continuation=bool(_CONTINUATION_WORDS.search(normalize(text))),
        is_blank=len((text or "").strip()) < BLANK_THRESHOLD,
        doc_type=detect_document_type(text).doc_type,
    )


@dataclass
class Verdict:
    continuation: bool
    reason: str


def is_continuation(page: PageIdentity, current: PageIdentity | None) -> Verdict:
    if current is None:
        return Verdict(False, "es la primera página del lote")

    # Un albarán detrás de una factura abre documento nuevo aunque la hoja no
    # aporte número: son documentos de naturaleza distinta.
    if (
        page.doc_type is not DocumentType.DESCONOCIDO
        and current.doc_type is not DocumentType.DESCONOCIDO
        and page.doc_type is not current.doc_type
    ):
        return Verdict(False, f"cambia el tipo de documento a {page.doc_type.value}")

    # El documento anterior declaró cuántas hojas tenía y ya las tiene todas
    # ("Pág. 1 de 1", "Pág. 3 de 3"). Nada que venga después le pertenece.
    # Es la regla que protege de un OCR malo: se apoya en la hoja que SÍ se leyó
    # bien en vez de depender de que la siguiente se lea bien.
    if (
        current.page_marker is not None
        and current.page_total is not None
        and current.page_marker >= current.page_total
    ):
        return Verdict(
            False,
            f"el documento anterior ya estaba completo (pág. {current.page_marker}"
            f" de {current.page_total})",
        )

    if page.page_marker == 1:
        return Verdict(False, "la página dice ser la nº 1")
    if page.page_marker is not None and page.page_marker > 1:
        return Verdict(True, f"la página dice ser la nº {page.page_marker}")
    if page.says_continuation:
        return Verdict(True, "el texto la marca como continuación")
    if page.is_blank:
        return Verdict(True, "no tiene texto legible")

    if page.number:
        if page.number == current.number:
            return Verdict(True, f"repite el número {page.number}")
        return Verdict(False, f"trae otro número ({page.number})")

    nuevos = [c for c in page.cifs if c not in current.cifs]
    if nuevos:
        return Verdict(False, f"aparece un CIF nuevo ({', '.join(nuevos)})")

    return Verdict(
        True,
        "no tiene número y repite los CIF de la anterior"
        if page.cifs
        else "no tiene ni número ni CIF propios",
    )


@dataclass
class PageText:
    index: int
    text: str


@dataclass
class Group:
    indices: list[int]
    notes: list[str]
    doc_type: DocumentType
    number: str


def group_by_continuation(
    pages: list[PageText],
    invoice_pattern: str = DEFAULT_INVOICE_REGEX,
    cif_pattern: str = DEFAULT_CIF_REGEX,
) -> list[Group]:
    """Sólo une páginas FÍSICAMENTE CONTIGUAS: un hueco (una página borrada, o
    que ya pertenece a otro documento) rompe la cadena a propósito."""
    ordered = sorted(pages, key=lambda p: p.index)

    groups: list[Group] = []
    identities: list[PageIdentity] = []
    previous_index: int | None = None

    for page in ordered:
        identity = read_page_identity(page.text, invoice_pattern, cif_pattern)
        adjacent = previous_index is not None and page.index == previous_index + 1
        current = identities[-1] if identities else None

        verdict = (
            is_continuation(identity, current)
            if (current is not None and adjacent)
            else Verdict(False, "no va justo detrás de la página anterior")
        )

        if verdict.continuation and groups:
            group = groups[-1]
            group.indices.append(page.index)
            group.notes.append(
                f"Pág. {page.index + 1} se une al documento de la pág. "
                f"{group.indices[0] + 1}: {verdict.reason}."
            )
            if not group.number:
                group.number = identity.number
            if group.doc_type is DocumentType.DESCONOCIDO:
                group.doc_type = identity.doc_type
            # La identidad acumula: la hoja 3 sigue reconociéndose aunque sólo
            # repita un CIF que apareció por primera vez en la hoja 2.
            merged = identities[-1]
            identities[-1] = PageIdentity(
                number=merged.number or identity.number,
                cifs=merged.cifs + [c for c in identity.cifs if c not in merged.cifs],
                page_marker=identity.page_marker,
                page_total=identity.page_total,
                says_continuation=identity.says_continuation,
                is_blank=False,
                doc_type=merged.doc_type
                if merged.doc_type is not DocumentType.DESCONOCIDO
                else identity.doc_type,
            )
        else:
            groups.append(
                Group(
                    indices=[page.index],
                    notes=[],
                    doc_type=identity.doc_type,
                    number=identity.number,
                )
            )
            identities.append(identity)

        previous_index = page.index

    return groups
