"""La cabecera como fuente del número de documento.

Es la señal que separa dos facturas seguidas del mismo cliente cuando ninguna
escribe su número junto a la palabra "Factura". Los casos están tomados de los
de DivisorPDF, de donde viene el port.
"""

import pytest

from app.services.header_doc import read_header_doc


class TestLineaDeCabecera:
    def test_lee_el_numero_y_la_paginacion_de_la_linea(self):
        header = read_header_doc(
            "DISTRIBUCIONES NORTE SL\n"
            "N DOCUMENTO   FECHA        CLIENTE              PAG\n"
            "262000663     04/09/2026   LA CASA ALIMENT SL   1/1\n"
        )
        assert header.number == "262000663"
        assert (header.page, header.total) == (1, 1)

    def test_lee_un_numero_con_letras(self):
        assert read_header_doc("26 BAR262023454 04/09/2026 CLIENTE 1/2").number == "26BAR262023454"

    def test_sin_paginacion_en_la_linea(self):
        header = read_header_doc("262000663 04/09/2026 LA CASA ALIMENT SL")
        assert header.number == "262000663"
        assert (header.page, header.total) == (None, None)

    @pytest.mark.parametrize(
        "texto",
        [
            # La fecha abre la línea: es una fecha suelta, no una cabecera.
            "04/09/2026 fecha de emision",
            # Entre el número y la fecha hay texto: la línea es prosa.
            "Entregado el pedido 262000663 el dia 04/09/2026",
            # Código demasiado corto para ser un número de documento.
            "3312 15/08/2026 entrega de mercancia",
            # Un CIF tiene la misma forma, pero no es el número del documento.
            "B67825950 04/09/2026 cliente",
            # Sin fecha no hay línea de cabecera que valer.
            "262000663 LA CASA ALIMENT SL",
        ],
    )
    def test_no_confunde_otras_lineas_con_la_cabecera(self, texto):
        assert read_header_doc(texto).number == ""

    def test_ignora_una_paginacion_imposible(self):
        # "99/99" no es "pág. X de Y": es cualquier otra cosa de la línea.
        header = read_header_doc("262000663 04/09/2026 CLIENTE 99/99")
        assert header.number == "262000663"
        assert (header.page, header.total) == (None, None)

    def test_normaliza_los_separadores(self):
        # El mismo número impreso de dos maneras tiene que compararse igual.
        assert read_header_doc("FR-2026-00042 04/09/2026 CLIENTE").number == \
            read_header_doc("FR 2026 00042 05/09/2026 CLIENTE").number


class TestEtiqueta:
    """Respaldo cuando no hay una línea de cabecera completa."""

    @pytest.mark.parametrize(
        "texto,esperado",
        [
            ("Nº de Factura 262000664 importe", "262000664"),
            ("No Albaran 262000664", "262000664"),
            ("N° Documento 262000664", "262000664"),
            # El OCR se come el ordinal y deja ruido.
            ("N* Factura 262000664", "262000664"),
        ],
    )
    def test_lee_el_numero_tras_la_etiqueta(self, texto, esperado):
        assert read_header_doc(texto).number == esperado

    def test_sin_etiqueta_ni_cabecera_no_devuelve_nada(self):
        assert read_header_doc("Filtro aceite 24 12,40 297,60").number == ""

    def test_texto_vacio(self):
        assert read_header_doc("").number == ""


class TestTablaDeDetalle:
    """Una cabecera aparece una vez; una tabla, varias.

    Algunas facturas listan los albaranes que resumen, y esas líneas tienen la
    misma forma que una cabecera (número, fecha, texto). Tomar la primera por
    cabecera partía la factura en dos.
    """

    TABLA = """Albaranes incluidos en esta factura
262000111    01/09/2026   Filtro aceite        24
262000222    02/09/2026   Aceite hidraulico    12
Base imponible 297,60  IVA 21% 62,50  TOTAL 360,10"""

    def test_varias_lineas_con_numeros_distintos_no_son_cabecera(self):
        assert read_header_doc(self.TABLA).number == ""

    def test_la_cabecera_impresa_dos_veces_sigue_valiendo(self):
        # El original y su copia en la misma hoja: mismo número, es cabecera.
        doble = """262000663   04/09/2026   LA CASA ALIMENT SL   1/1
lineas de detalle
262000663   04/09/2026   LA CASA ALIMENT SL   1/1"""
        assert read_header_doc(doble).number == "262000663"

    def test_una_sola_linea_sigue_siendo_cabecera(self):
        assert read_header_doc("262000663   04/09/2026   LA CASA ALIMENT SL").number == "262000663"
