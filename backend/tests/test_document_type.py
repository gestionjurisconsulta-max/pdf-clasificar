from app.enums import DocumentType
from app.services.document_type import detect_document_type

FACTURA = """
SUMINISTROS GARCIA SL
CIF: B11111111
FACTURA
Factura Nº F-2026-0041
CLIENTE: ACEROS DEL NORTE S.L.  CIF: B12345678
Tubo acero 40mm  120  3,50  420,00
Base imponible 420,00   IVA 21% 88,20   TOTAL FACTURA 508,20
"""

ALBARAN = """
SUMINISTROS GARCIA SL
CIF: B11111111
ALBARÁN DE ENTREGA Nº A-3312
CLIENTE: ACEROS DEL NORTE S.L.  CIF: B12345678
Tubo acero 40mm  120 unidades
Bultos: 4        Transportista: SEUR
Recibí conforme: ____________________
"""


def test_detecta_una_factura():
    assert detect_document_type(FACTURA).doc_type is DocumentType.FACTURA


def test_detecta_un_albaran():
    assert detect_document_type(ALBARAN).doc_type is DocumentType.ALBARAN


def test_tolera_la_falta_de_tildes_del_ocr():
    # El OCR se come los acentos con frecuencia.
    assert detect_document_type(ALBARAN.replace("ALBARÁN", "ALBARAN")).doc_type is DocumentType.ALBARAN


def test_una_factura_que_cita_su_albaran_sigue_siendo_factura():
    # El caso que hace fracasar el simple recuento de palabras: la factura
    # menciona el albarán de origen en el cuerpo.
    texto = FACTURA.replace("Tubo acero", "Según nuestro albarán A-3312\nTubo acero")
    assert detect_document_type(texto).doc_type is DocumentType.FACTURA


def test_una_mencion_suelta_a_un_albaran_con_impuestos_es_factura():
    # Sin título propio: "albarán" aparece de pasada y la página liquida IVA.
    texto = "Ref. albaran 3312 del pedido\nBase imponible 100,00 IVA 21,00 TOTAL FACTURA 121,00"
    assert detect_document_type(texto).doc_type is DocumentType.FACTURA


# --- Casos tomados de documentos reales de un proveedor ---------------------
# Sus albaranes imprimen base imponible e IVA igual que sus facturas, así que
# lo único que los distingue es el título con el que se encabezan. Dar
# prioridad a los impuestos los clasificaba a todos como facturas.

ALBARAN_REAL = """RUIBAL LOSADA, S.A.
RDA INDUSTRIA 30 BARBERA
08210 - CIF A59191197
ALBARAN: A6-004757 FECHA: 10/08/2026 Pag. 1 de 1
SOLICITANTE FACTURA A
LA CASA ALIMENT S.L
NIF: B67825950
Base imponible 420,00 IVA 21% 88,20 TOTAL 508,20
"""

FACTURA_REAL = """RUIBAL LOSADA, S.A.
RDA INDUSTRIA 30 BARBERA
08210 - CIF A59191197
FACTURA: M6-001364 FECHA: 31/08/2026
SOLICITANTE FACTURA A
LA CASA ALIMENT S.L
NIF: B67825950
Base imponible 420,00 IVA 21% 88,20 TOTAL FACTURA 508,20
"""


def test_un_albaran_que_liquida_impuestos_sigue_siendo_albaran():
    assert detect_document_type(ALBARAN_REAL).doc_type is DocumentType.ALBARAN


def test_la_factura_del_mismo_proveedor_es_factura():
    assert detect_document_type(FACTURA_REAL).doc_type is DocumentType.FACTURA


def test_la_columna_del_cliente_no_se_confunde_con_el_titulo():
    # "SOLICITANTE FACTURA A" encabeza la columna del destinatario: no debe
    # contar como que la página se titule "factura".
    assert detect_document_type(ALBARAN_REAL).doc_type is DocumentType.ALBARAN


def test_tolera_que_el_ocr_pierda_la_tilde_del_titulo():
    con_tilde = ALBARAN_REAL.replace("ALBARAN", "ALBARÁN")
    assert detect_document_type(con_tilde).doc_type is DocumentType.ALBARAN


def test_manda_el_titulo_que_aparece_antes():
    assert detect_document_type("ALBARAN A-1 ... factura asociada F-9").doc_type is DocumentType.ALBARAN
    assert detect_document_type("FACTURA F-9 ... albaran asociado A-1").doc_type is DocumentType.FACTURA


def test_pagina_vacia_es_desconocida():
    verdict = detect_document_type("   ")
    assert verdict.doc_type is DocumentType.DESCONOCIDO
    assert "no tiene texto legible" in verdict.reason


def test_sin_titulo_decide_por_senales():
    solo_entrega = "Bultos: 3 Transportista: MRW Recibi conforme firma del cliente"
    assert detect_document_type(solo_entrega).doc_type is DocumentType.ALBARAN

    solo_fiscal = "Base imponible 100,00 IVA 21,00 cuota 21,00 IRPF 15,00"
    assert detect_document_type(solo_fiscal).doc_type is DocumentType.FACTURA


def test_texto_neutro_es_desconocido():
    assert detect_document_type("Listado de referencias y cantidades").doc_type is DocumentType.DESCONOCIDO
