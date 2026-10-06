import { describe, expect, it } from 'vitest';
import { declaresOwnTitle, readHeaderDoc } from './headerDocService';

/**
 * Los mismos casos que `backend/tests/test_header_doc.py`: si cambia el
 * criterio en un lado, el otro tiene que seguir dando lo mismo.
 */

describe('readHeaderDoc: la línea de cabecera', () => {
  it('lee el número y la paginación de la línea', () => {
    const header = readHeaderDoc(
      'DISTRIBUCIONES NORTE SL\n' +
      'N DOCUMENTO   FECHA        CLIENTE              PAG\n' +
      '262000663     04/09/2026   LA CASA ALIMENT SL   1/1\n'
    );
    expect(header.number).toBe('262000663');
    expect([header.page, header.total]).toEqual([1, 1]);
  });

  it('lee un número con letras', () => {
    expect(readHeaderDoc('26 BAR262023454 04/09/2026 CLIENTE 1/2').number).toBe('26BAR262023454');
  });

  it('sin paginación en la línea', () => {
    const header = readHeaderDoc('262000663 04/09/2026 LA CASA ALIMENT SL');
    expect(header.number).toBe('262000663');
    expect([header.page, header.total]).toEqual([null, null]);
  });

  it.each([
    // La fecha abre la línea: es una fecha suelta, no una cabecera.
    '04/09/2026 fecha de emision',
    // Entre el número y la fecha hay texto: la línea es prosa.
    'Entregado el pedido 262000663 el dia 04/09/2026',
    // Código demasiado corto para ser un número de documento.
    '3312 15/08/2026 entrega de mercancia',
    // Un CIF tiene la misma forma, pero no es el número del documento.
    'B67825950 04/09/2026 cliente',
    // Sin fecha no hay línea de cabecera que valga.
    '262000663 LA CASA ALIMENT SL'
  ])('no confunde otras líneas con la cabecera: %s', texto => {
    expect(readHeaderDoc(texto).number).toBe('');
  });

  it('ignora una paginación imposible', () => {
    // "99/99" no es "pág. X de Y": es cualquier otra cosa de la línea.
    const header = readHeaderDoc('262000663 04/09/2026 CLIENTE 99/99');
    expect(header.number).toBe('262000663');
    expect([header.page, header.total]).toEqual([null, null]);
  });

  it('normaliza los separadores', () => {
    // El mismo número impreso de dos maneras tiene que compararse igual.
    expect(readHeaderDoc('FR-2026-00042 04/09/2026 CLIENTE').number)
      .toBe(readHeaderDoc('FR 2026 00042 05/09/2026 CLIENTE').number);
  });
});

describe('readHeaderDoc: la etiqueta, como respaldo', () => {
  it.each([
    ['Nº de Factura 262000664 importe', '262000664'],
    ['No Albaran 262000664', '262000664'],
    ['N° Documento 262000664', '262000664'],
    // El OCR se come el ordinal y deja ruido.
    ['N* Factura 262000664', '262000664']
  ])('lee el número tras la etiqueta: %s', (texto, esperado) => {
    expect(readHeaderDoc(texto).number).toBe(esperado);
  });

  it('sin etiqueta ni cabecera no devuelve nada', () => {
    expect(readHeaderDoc('Filtro aceite 24 12,40 297,60').number).toBe('');
  });

  it('texto vacío', () => {
    expect(readHeaderDoc('').number).toBe('');
  });
});

/**
 * Una cabecera aparece una vez; una tabla, varias. Algunas facturas listan los
 * albaranes que resumen, y esas líneas tienen la misma forma que una cabecera
 * (número, fecha, texto). Tomar la primera por cabecera partía la factura.
 */
describe('readHeaderDoc: tabla de detalle frente a cabecera', () => {
  it('varias líneas con números distintos no son cabecera', () => {
    const tabla = [
      'Albaranes incluidos en esta factura',
      '262000111    01/09/2026   Filtro aceite        24',
      '262000222    02/09/2026   Aceite hidraulico    12',
      'Base imponible 297,60  IVA 21% 62,50  TOTAL 360,10'
    ].join('\n');
    expect(readHeaderDoc(tabla).number).toBe('');
  });

  it('la cabecera impresa dos veces sigue valiendo', () => {
    // El original y su copia en la misma hoja: mismo número, es cabecera.
    const doble = [
      '262000663   04/09/2026   LA CASA ALIMENT SL   1/1',
      'lineas de detalle',
      '262000663   04/09/2026   LA CASA ALIMENT SL   1/1'
    ].join('\n');
    expect(readHeaderDoc(doble).number).toBe('262000663');
  });

  it('una sola línea sigue siendo cabecera', () => {
    expect(readHeaderDoc('262000663   04/09/2026   LA CASA ALIMENT SL').number).toBe('262000663');
  });
});

describe('declaresOwnTitle', () => {
  it.each([
    'ALBARÁN: A6-004757 FECHA: 10/08/2026',
    'FACTURA Nº M6-001364',
    'Factura: 2026-0042'
  ])('reconoce una página que se titula a sí misma: %s', texto => {
    expect(declaresOwnTitle(texto)).toBe(true);
  });

  it('no confunde una referencia dentro del cuerpo', () => {
    expect(declaresOwnTitle('Se adjunta el material segun nuestro albaran A-3312')).toBe(false);
  });

  it('no se dispara con una página de detalle', () => {
    expect(declaresOwnTitle('Filtro aceite 24 12,40 297,60')).toBe(false);
  });
});
