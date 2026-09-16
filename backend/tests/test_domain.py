"""Los puertos de la lógica que ya existía en TypeScript deben comportarse
igual: estos tests son los mismos casos que services/*.test.ts."""

import pytest

from app.enums import DocumentType
from app.services.continuation import PageText, group_by_continuation
from app.services.excel import detect_columns, parse_client_rows
from app.services.invoice_number import extract_invoice_number
from app.services.matching import Company, canonical_form, find_matching_company
from app.services.naming import sanitize_name


class TestCanonicalForm:
    def test_normaliza_y_quita_simbolos(self):
        assert canonical_form("b-12.345 678") == "812345678"

    def test_aplica_las_confusiones_de_ocr(self):
        assert canonical_form("BGOILS") == "860115"


class TestMatching:
    companies = [
        Company(cif="B12345678", name="Empresa Uno"),
        Company(cif="A87654321", name="Empresa Dos"),
    ]

    def test_encuentra_por_cif_en_el_texto(self):
        result = find_matching_company("Factura emitida a B12345678", self.companies)
        assert result.ambiguous is False
        assert result.company.name == "Empresa Uno"

    def test_encuentra_pese_a_la_confusion_b_8(self):
        result = find_matching_company("CIF: 812345678", self.companies)
        assert result.company.name == "Empresa Uno"

    def test_sin_coincidencia(self):
        result = find_matching_company("texto sin ningun cif", self.companies)
        assert result.company is None
        assert result.ambiguous is False

    def test_marca_ambiguo_en_vez_de_elegir_el_primero(self):
        result = find_matching_company("B12345678 y tambien A87654321", self.companies)
        assert result.ambiguous is True
        assert result.company is None
        assert sorted(c.name for c in result.candidates) == ["Empresa Dos", "Empresa Uno"]


class TestInvoiceNumber:
    @pytest.mark.parametrize(
        "texto,esperado",
        [
            ("Factura Nº F-2026-0041 de fecha 3 de enero", "F-2026-0041"),
            ("FACTURA N.º 2026/0001", "2026/0001"),
            ("Factura número A-100", "A-100"),
            ("Factura: 12345", "12345"),
            ("ALBARÁN 556", "556"),
            ("ALBARAN A-3312", "A-3312"),
        ],
    )
    def test_extrae_el_numero(self, texto, esperado):
        assert extract_invoice_number(texto) == esperado

    def test_no_captura_el_prefijo_de_numeracion(self):
        assert extract_invoice_number("Factura Nº F-2026-0041") != "N"

    @pytest.mark.parametrize(
        "texto",
        ["TOTAL FACTURA 2.777,60", "Base imponible FACTURA 1.200,00", "Importe factura 450,00"],
    )
    def test_no_confunde_importes_con_numeros(self, texto):
        assert extract_invoice_number(texto) == ""

    def test_encuentra_el_numero_aunque_haya_totales(self):
        assert extract_invoice_number("Factura Nº F-42 ... TOTAL FACTURA 2.777,60") == "F-42"

    def test_patron_invalido_no_revienta(self):
        assert extract_invoice_number("Factura Nº 1", "([sin cerrar") == ""


class TestSanitizeName:
    def test_sustituye_lo_que_windows_rechaza(self):
        assert sanitize_name('Aceros / Metales: "Norte"') == "Aceros - Metales- -Norte-"

    def test_quita_el_punto_final(self):
        assert sanitize_name("Empresa S.L.  ") == "Empresa S.L"

    def test_nunca_produce_punto_o_dos_puntos(self):
        assert sanitize_name(".") == "Sin nombre"
        assert sanitize_name("..") == "Sin nombre"

    def test_no_permite_escapar_de_la_carpeta(self):
        assert "/" not in sanitize_name("../../etc/passwd")
        assert "\\" not in sanitize_name("..\\..\\Windows")


class TestExcel:
    def test_detecta_columnas_por_cabecera(self):
        rows = [{"Razón Social": "Empresa Uno", "N.I.F.": "B12345678", "Ciudad": "Madrid"}]
        assert detect_columns(rows) == ("N.I.F.", "Razón Social")

    def test_detecta_por_contenido_si_no_hay_cabecera_util(self):
        rows = [
            {"Col1": "Empresa Uno", "Col2": "Madrid", "Col3": "B12345678"},
            {"Col1": "Empresa Dos", "Col2": "Sevilla", "Col3": "A87654321"},
        ]
        assert detect_columns(rows)[0] == "Col3"

    def test_no_confunde_una_columna_de_importes_con_cif(self):
        rows = [{"Cliente": "Uno", "Importe": "1234", "CIF": "B12345678"}]
        assert detect_columns(rows)[0] == "CIF"

    def test_limpia_el_cif_y_descarta_filas_incompletas(self):
        rows = [
            {"Cliente": " Empresa Uno ", "CIF": " b-12.345.678 "},
            {"Cliente": "", "CIF": "A87654321"},
            {"Cliente": "Sin CIF", "CIF": ""},
        ]
        parsed = parse_client_rows(rows)
        assert len(parsed) == 1
        assert parsed[0].cif == "B12345678"
        assert parsed[0].name == "Empresa Uno"


CABECERA = "SUMINISTROS GARCIA SL CIF: B11111111 FACTURA Factura Nº {n} CLIENTE {c}"


class TestContinuation:
    def test_une_una_factura_de_dos_hojas(self):
        grupos = group_by_continuation([
            PageText(0, CABECERA.format(n="F-41", c="ACEROS CIF: B12345678")),
            PageText(1, CABECERA.format(n="F-42", c="TRANSPORTES CIF: A87654321")),
            PageText(2, "Pagina 2 de 2 Filtro aceite TOTAL FACTURA 2.777,60"),
            PageText(3, CABECERA.format(n="F-43", c="ACEROS CIF: B12345678")),
        ])
        assert [g.indices for g in grupos] == [[0], [1, 2], [3]]

    def test_encadena_tres_hojas(self):
        grupos = group_by_continuation([
            PageText(0, CABECERA.format(n="F-1", c="ACEROS CIF: B12345678")),
            PageText(1, "lineas de detalle sin identidad propia"),
            PageText(2, "mas lineas de detalle y el total"),
        ])
        assert [g.indices for g in grupos] == [[0, 1, 2]]

    def test_no_salta_huecos(self):
        grupos = group_by_continuation([
            PageText(0, CABECERA.format(n="F-1", c="ACEROS CIF: B12345678")),
            PageText(2, "lineas de detalle sin identidad propia"),
        ])
        assert [g.indices for g in grupos] == [[0], [2]]

    def test_dos_facturas_del_mismo_cliente_no_se_fusionan(self):
        grupos = group_by_continuation([
            PageText(0, CABECERA.format(n="F-41", c="ACEROS CIF: B12345678")),
            PageText(1, CABECERA.format(n="F-42", c="ACEROS CIF: B12345678")),
        ])
        assert [g.indices for g in grupos] == [[0], [1]]

    def test_un_albaran_detras_de_una_factura_abre_documento_nuevo(self):
        # Regla que no existía en el frontend: aunque el albarán no traiga
        # número propio, cambiar de tipo rompe la cadena.
        grupos = group_by_continuation([
            PageText(0, CABECERA.format(n="F-41", c="ACEROS CIF: B12345678")),
            PageText(1, "ALBARAN DE ENTREGA bultos 3 transportista MRW recibi conforme"),
        ])
        assert [g.indices for g in grupos] == [[0], [1]]
        assert grupos[0].doc_type is DocumentType.FACTURA
        assert grupos[1].doc_type is DocumentType.ALBARAN

    def test_el_grupo_conserva_tipo_y_numero_de_la_primera_hoja(self):
        grupos = group_by_continuation([
            PageText(0, CABECERA.format(n="F-77", c="ACEROS CIF: B12345678")),
            PageText(1, "Pagina 2 de 2 detalle"),
        ])
        assert grupos[0].number == "F-77"
        assert grupos[0].doc_type is DocumentType.FACTURA

    def test_lista_vacia(self):
        assert group_by_continuation([]) == []


class TestDocumentosCompletos:
    """Caso real: un albarán de una hoja ("Pág. 1 de 1") seguido de la factura
    de OTRO cliente. Sin esta regla, si el OCR de la segunda hoja falla, la hoja
    parece "sin identidad propia" y se pega al albarán anterior."""

    ALBARAN_COMPLETO = (
        "RUIBAL LOSADA CIF A59191197\n"
        "ALBARAN: A6-004757 FECHA: 10/08/2026 Pag. 1 de 1\n"
        "LA CASA ALIMENT SL NIF: B67825950"
    )

    def test_no_admite_mas_hojas_tras_un_pagina_1_de_1(self):
        grupos = group_by_continuation([
            PageText(0, self.ALBARAN_COMPLETO),
            PageText(1, "hoja cuyo ocr no ha dejado nada reconocible aqui"),
        ])
        assert [g.indices for g in grupos] == [[0], [1]]

    def test_tampoco_si_la_hoja_siguiente_sale_ilegible(self):
        grupos = group_by_continuation([
            PageText(0, self.ALBARAN_COMPLETO),
            PageText(1, ""),
        ])
        assert [g.indices for g in grupos] == [[0], [1]]

    def test_un_pagina_1_de_2_si_espera_su_segunda_hoja(self):
        grupos = group_by_continuation([
            PageText(0, "ALBARAN: A6-004664 FECHA: 05/08/2026 Pag. 1 de 2\nGOURMET ARRAY SL"),
            PageText(1, "lineas de detalle sin identidad propia"),
        ])
        assert [g.indices for g in grupos] == [[0, 1]]

    def test_se_cierra_al_llegar_a_su_ultima_hoja(self):
        grupos = group_by_continuation([
            PageText(0, "ALBARAN: A6-004664 Pag. 1 de 2\nGOURMET ARRAY SL"),
            PageText(1, "Pag. 2 de 2 detalle y total"),
            PageText(2, "hoja ilegible que ya no le pertenece"),
        ])
        assert [g.indices for g in grupos] == [[0, 1], [2]]
