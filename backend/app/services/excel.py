"""Leer la lista de clientes de un Excel.

Port de `services/excelService.ts`. La detección de columnas es la parte más
frágil del sistema —cada programa de contabilidad exporta cabeceras distintas—,
así que mantiene el mismo orden de intentos: cabecera, contenido y, como último
recurso, una suposición que se delata sola porque no produce ningún cliente.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from typing import Any

from openpyxl import load_workbook

_CIF_REGEX = re.compile(r"[ABCDEFGHJNPQRSUVW0-9][0-9]{7}[0-9A-J]", re.IGNORECASE)
_NON_ALNUM = re.compile(r"[^A-Z0-9]", re.IGNORECASE)

Row = dict[str, Any]


@dataclass(frozen=True)
class ParsedClient:
    cif: str
    name: str


def _matches_cif_header(header: str) -> bool:
    h = header.lower().strip()
    return h in {"cif", "nif", "b"} or any(
        token in h for token in ("cif", "nif", "identif", "vat", "tax")
    )


def _matches_name_header(header: str) -> bool:
    h = header.lower().strip()
    return h == "a" or any(
        token in h
        for token in (
            "empresa", "nombre", "cliente", "razon", "razón",
            "social", "denominacion", "denominación", "proveedor", "titular",
        )
    )


def detect_columns(rows: list[Row]) -> tuple[str | None, str | None]:
    if not rows:
        return None, None

    keys = list(rows[0].keys())
    cif_key = next((k for k in keys if _matches_cif_header(str(k))), None)
    name_key = next((k for k in keys if _matches_name_header(str(k))), None)

    if cif_key is None:
        for key in keys:
            samples = [_NON_ALNUM.sub("", str(r.get(key, "") or "")) for r in rows[:10]]
            if any(len(v) >= 8 and _CIF_REGEX.search(v) for v in samples):
                cif_key = key
                break

    if cif_key is None and len(keys) >= 2:
        cif_key = keys[1]

    if name_key is None:
        name_key = next((k for k in keys if k != cif_key), keys[0] if keys else None)

    return cif_key, name_key


def parse_client_rows(rows: list[Row]) -> list[ParsedClient]:
    cif_key, name_key = detect_columns(rows)

    clients: list[ParsedClient] = []
    for row in rows:
        raw_cif = str(row.get(cif_key, "") or "").strip() if cif_key else ""
        cif = _NON_ALNUM.sub("", raw_cif).upper()
        name = str(row.get(name_key, "") or "").strip() if name_key else ""
        if cif and name:
            clients.append(ParsedClient(cif=cif, name=name))
    return clients


def _rows_from_xlsx(data: bytes) -> list[Row]:
    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        sheet = workbook[workbook.sheetnames[0]]
        iterator = sheet.iter_rows(values_only=True)
        header = next(iterator, None)
        if header is None:
            return []
        # Igual que SheetJS: las columnas sin cabecera se nombran por su letra.
        columns = [
            str(h).strip() if h not in (None, "") else chr(ord("A") + i)
            for i, h in enumerate(header)
        ]
        return [
            {columns[i]: ("" if v is None else v) for i, v in enumerate(values[: len(columns)])}
            for values in iterator
            if any(v not in (None, "") for v in values)
        ]
    finally:
        workbook.close()


def _rows_from_xls(data: bytes) -> list[Row]:
    import xlrd  # Import perezoso: sólo hace falta para los .xls antiguos.

    book = xlrd.open_workbook(file_contents=data)
    sheet = book.sheet_by_index(0)
    if sheet.nrows == 0:
        return []
    columns = [
        str(sheet.cell_value(0, c)).strip() or chr(ord("A") + c) for c in range(sheet.ncols)
    ]
    return [
        {columns[c]: sheet.cell_value(r, c) for c in range(sheet.ncols)}
        for r in range(1, sheet.nrows)
    ]


def _rows_from_csv(data: bytes) -> list[Row]:
    text = data.decode("utf-8-sig", errors="replace")
    # Los Excel españoles exportan CSV con punto y coma.
    dialect = csv.Sniffer().sniff(text[:2048], delimiters=";,\t") if text.strip() else csv.excel
    return list(csv.DictReader(io.StringIO(text), dialect=dialect))


def parse_clients(data: bytes, filename: str) -> list[ParsedClient]:
    """Lee la PRIMERA hoja del fichero y devuelve los clientes reconocidos."""
    lower = filename.lower()
    if lower.endswith(".csv"):
        rows = _rows_from_csv(data)
    elif lower.endswith(".xls"):
        rows = _rows_from_xls(data)
    else:
        rows = _rows_from_xlsx(data)
    return parse_client_rows(rows)
