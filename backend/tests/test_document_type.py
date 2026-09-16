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


def test_un_albaran_mencionado_en_cabecera_con_impuestos_es_factura():
    # Membrete con "albarán" pero la página liquida IVA: es una factura.
    texto = "ALBARAN 3312 FACTURA\nBase imponible 100,00 IVA 21,00 TOTAL FACTURA 121,00"
    assert detect_document_type(texto).doc_type is DocumentType.FACTURA


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
