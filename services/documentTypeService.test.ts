import { describe, expect, it } from 'vitest';
import { detectDocumentType } from './documentTypeService';

const FACTURA = `
SUMINISTROS GARCIA SL
CIF: B11111111
FACTURA
Factura Nº F-2026-0041
CLIENTE: ACEROS DEL NORTE S.L.  CIF: B12345678
Tubo acero 40mm  120  3,50  420,00
Base imponible 420,00   IVA 21% 88,20   TOTAL FACTURA 508,20
`;

const ALBARAN = `
SUMINISTROS GARCIA SL
CIF: B11111111
ALBARÁN DE ENTREGA Nº A-3312
CLIENTE: ACEROS DEL NORTE S.L.  CIF: B12345678
Tubo acero 40mm  120 unidades
Bultos: 4        Transportista: SEUR
Recibí conforme: ____________________
`;

// Proveedor real: sus albaranes imprimen base imponible e IVA igual que las
// facturas, así que lo único que los distingue es el título de la cabecera.
const ALBARAN_REAL = `RUIBAL LOSADA, S.A.
RDA INDUSTRIA 30 BARBERA
08210 - CIF A59191197
ALBARAN: A6-004757 FECHA: 10/08/2026 Pag. 1 de 1
SOLICITANTE FACTURA A
LA CASA ALIMENT S.L
NIF: B67825950
Base imponible 420,00 IVA 21% 88,20 TOTAL 508,20
`;

const FACTURA_REAL = `RUIBAL LOSADA, S.A.
RDA INDUSTRIA 30 BARBERA
08210 - CIF A59191197
FACTURA: M6-001364 FECHA: 31/08/2026
SOLICITANTE FACTURA A
LA CASA ALIMENT S.L
NIF: B67825950
Base imponible 420,00 IVA 21% 88,20 TOTAL FACTURA 508,20
`;

describe('detectDocumentType', () => {
  it('detecta una factura', () => {
    expect(detectDocumentType(FACTURA).docType).toBe('factura');
  });

  it('detecta un albarán', () => {
    expect(detectDocumentType(ALBARAN).docType).toBe('albaran');
  });

  it('tolera la falta de tildes del OCR', () => {
    expect(detectDocumentType(ALBARAN.replace('ALBARÁN', 'ALBARAN')).docType).toBe('albaran');
  });

  it('una factura que cita su albarán sigue siendo factura', () => {
    const texto = FACTURA.replace('Tubo acero', 'Según nuestro albarán A-3312\nTubo acero');
    expect(detectDocumentType(texto).docType).toBe('factura');
  });

  it('una mención suelta a un albarán con impuestos es factura', () => {
    const texto = 'Ref. albaran 3312 del pedido\nBase imponible 100,00 IVA 21,00 TOTAL FACTURA 121,00';
    expect(detectDocumentType(texto).docType).toBe('factura');
  });

  it('un albarán que liquida impuestos sigue siendo albarán (título manda)', () => {
    expect(detectDocumentType(ALBARAN_REAL).docType).toBe('albaran');
  });

  it('la factura del mismo proveedor es factura', () => {
    expect(detectDocumentType(FACTURA_REAL).docType).toBe('factura');
  });

  it('"SOLICITANTE FACTURA A" (columna del cliente) no se confunde con el título', () => {
    expect(detectDocumentType(ALBARAN_REAL).docType).toBe('albaran');
  });

  it('tolera que el OCR pierda la tilde del título', () => {
    expect(detectDocumentType(ALBARAN_REAL.replace('ALBARAN', 'ALBARÁN')).docType).toBe('albaran');
  });

  it('manda el título que aparece antes', () => {
    expect(detectDocumentType('ALBARAN A-1 ... factura asociada F-9').docType).toBe('albaran');
    expect(detectDocumentType('FACTURA F-9 ... albaran asociado A-1').docType).toBe('factura');
  });

  it('una página vacía es desconocida', () => {
    const v = detectDocumentType('   ');
    expect(v.docType).toBe('desconocido');
    expect(v.reason).toContain('no tiene texto legible');
  });

  it('sin título decide por señales', () => {
    expect(detectDocumentType('Bultos: 3 Transportista: MRW Recibi conforme firma del cliente').docType)
      .toBe('albaran');
    expect(detectDocumentType('Base imponible 100,00 IVA 21,00 cuota 21,00 IRPF 15,00').docType)
      .toBe('factura');
  });

  it('un texto neutro es desconocido', () => {
    expect(detectDocumentType('Listado de referencias y cantidades').docType).toBe('desconocido');
  });
});
