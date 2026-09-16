"""`folder_for` y `filename_for` deciden dónde acaba cada PDF exportado, así que
un cambio aquí reorganiza el resultado entero de un lote."""

from types import SimpleNamespace

import pytest

from app.enums import DocumentType
from app.services.storage import PENDING_FOLDER, filename_for, folder_for


class TestFolderFor:
    def test_las_facturas_van_bajo_facturas(self):
        assert folder_for(DocumentType.FACTURA, "Aceros del Norte S.L.") == "Facturas/Aceros del Norte S.L"

    def test_los_albaranes_van_a_su_propia_rama(self):
        assert folder_for(DocumentType.ALBARAN, "Aceros del Norte S.L.") == "Albaranes/Aceros del Norte S.L"

    def test_sin_cliente_va_a_pendientes(self):
        assert folder_for(DocumentType.FACTURA, None) == f"Facturas/{PENDING_FOLDER}"
        assert folder_for(DocumentType.ALBARAN, None) == f"Albaranes/{PENDING_FOLDER}"

    def test_lo_desconocido_se_trata_como_factura(self):
        # Es la opción menos mala: se revisa en la carpeta del cliente en vez de
        # quedar escondido en una tercera rama que nadie mira.
        assert folder_for(DocumentType.DESCONOCIDO, "Uno").startswith("Facturas/")

    def test_el_nombre_del_cliente_se_sanea(self):
        assert folder_for(DocumentType.FACTURA, "Aceros / Metales: Norte") == "Facturas/Aceros - Metales- Norte"

    @pytest.mark.parametrize("nombre", ["..", ".", "   "])
    def test_un_nombre_imposible_no_rompe_la_ruta(self, nombre):
        carpeta = folder_for(DocumentType.FACTURA, nombre)
        assert carpeta == "Facturas/Sin nombre"


def _doc(pages, number=""):
    return SimpleNamespace(page_indices=pages, number=number)


class TestFilenameFor:
    source = SimpleNamespace(filename="facturas marzo.pdf")

    def test_lleva_la_primera_pagina_el_origen_y_el_numero(self):
        nombre = filename_for(_doc([0], "F-2026-0041"), self.source)
        assert nombre == "PAG_001_facturas marzo_F-2026-0041.pdf"

    def test_la_pagina_se_rellena_a_tres_digitos(self):
        assert filename_for(_doc([41], "X"), self.source).startswith("PAG_042_")

    def test_sin_numero_usa_S_N(self):
        assert filename_for(_doc([0]), self.source).endswith("_S-N.pdf")

    def test_el_numero_se_sanea(self):
        # Un número con barra sacaría el fichero de su carpeta.
        nombre = filename_for(_doc([0], "2026/0041"), self.source)
        assert "/" not in nombre
        assert nombre.endswith("_2026-0041.pdf")

    def test_usa_la_primera_pagina_del_grupo(self):
        assert filename_for(_doc([4, 5, 6], "F-1"), self.source).startswith("PAG_005_")

    def test_un_documento_sin_paginas_no_revienta(self):
        assert filename_for(_doc([], "F-1"), self.source).startswith("PAG_001_")

    def test_dos_documentos_del_mismo_cliente_no_colisionan(self):
        # El prefijo de página es lo que los distingue aunque compartan número.
        a = filename_for(_doc([0], "F-1"), self.source)
        b = filename_for(_doc([3], "F-1"), self.source)
        assert a != b
