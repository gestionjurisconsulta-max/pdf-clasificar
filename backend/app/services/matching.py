"""Emparejar una página con el cliente al que pertenece.

Port de `services/matchingService.ts`. Mantiene el mismo comportamiento, y en
particular la decisión más importante: cuando encajan varios clientes NO se
elige el primero, se marca como ambiguo. En facturación, una factura en la
carpeta equivocada cuesta más que una en la bandeja de pendientes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Confusiones típicas de un escáner. Se aplica la misma tabla a los dos lados
# de la comparación, así que B12345678 y 812345678 acaban siendo iguales.
_OCR_CONFUSIONS = str.maketrans({"B": "8", "G": "6", "O": "0", "I": "1", "L": "1", "S": "5"})
_NON_ALNUM = re.compile(r"[^A-Z0-9]")
_NON_DIGIT = re.compile(r"\D")


def canonical_form(text: str) -> str:
    """Normaliza un CIF o un texto para poder compararlos pese al OCR."""
    return _NON_ALNUM.sub("", (text or "").upper()).translate(_OCR_CONFUSIONS)


@dataclass(frozen=True)
class Company:
    cif: str
    name: str
    id: int | None = None


@dataclass
class MatchResult:
    company: Company | None = None
    ambiguous: bool = False
    candidates: list[Company] = field(default_factory=list)


def _dedupe_by_cif(companies: list[Company]) -> list[Company]:
    seen: set[str] = set()
    result: list[Company] = []
    for company in companies:
        key = canonical_form(company.cif)
        if key not in seen:
            seen.add(key)
            result.append(company)
    return result


def find_matching_company(
    page_text: str,
    companies: list[Company],
    learned_cif_mappings: dict[str, str] | None = None,
) -> MatchResult:
    learned_cif_mappings = learned_cif_mappings or {}

    clean_full_text = canonical_form(page_text)
    digits_only_text = _NON_DIGIT.sub("", page_text or "")

    direct: list[Company] = []
    for company in companies:
        canonical_cif = canonical_form(company.cif)
        numeric_cif = _NON_DIGIT.sub("", company.cif)
        # El mínimo de longitud evita que un CIF corto o mal leído encaje
        # dentro del CIF de otro cliente.
        fuzzy_hit = len(canonical_cif) > 5 and canonical_cif in clean_full_text
        digit_hit = len(numeric_cif) >= 7 and numeric_cif in digits_only_text
        if fuzzy_hit or digit_hit:
            direct.append(company)

    unique_direct = _dedupe_by_cif(direct)
    if unique_direct:
        return MatchResult(
            company=unique_direct[0] if len(unique_direct) == 1 else None,
            ambiguous=len(unique_direct) > 1,
            candidates=unique_direct,
        )

    learned = _dedupe_by_cif(
        [
            Company(cif=cif, name=name)
            for cif, name in learned_cif_mappings.items()
            if canonical_form(cif) in clean_full_text
            or _NON_DIGIT.sub("", cif) in digits_only_text
        ]
    )
    if learned:
        return MatchResult(
            company=learned[0] if len(learned) == 1 else None,
            ambiguous=len(learned) > 1,
            candidates=learned,
        )

    return MatchResult()
