import { describe, expect, it } from 'vitest';
import { groupByContinuation, isContinuation, readPageIdentity } from './continuationService';

const cabecera = (cliente: string, numero: string) =>
  `SUMINISTROS GARCIA SL CIF: B11111111 FACTURA Factura Nº ${numero} CLIENTE ${cliente}`;

describe('readPageIdentity', () => {
  it('lee el número, los CIF y el marcador de página', () => {
    const id = readPageIdentity('Factura Nº F-2026-0042 CIF: B11111111 CLIENTE CIF: A87654321 Página 1 de 2');
    expect(id.invoiceNumber).toBe('F-2026-0042');
    expect(id.cifs).toHaveLength(2);
    expect(id.pageMarker).toBe(1);
    expect(id.isBlank).toBe(false);
  });

  it('marca como vacía una página de escaneo sin texto', () => {
    expect(readPageIdentity('   .  ').isBlank).toBe(true);
  });

  it('detecta la palabra continuación', () => {
    expect(readPageIdentity('sigue en la página siguiente ...').saysContinuation).toBe(true);
  });

  it('no toma el total de la factura como número', () => {
    expect(readPageIdentity('Filtro aceite 297,60 TOTAL FACTURA 2.777,60').invoiceNumber).toBe('');
  });
});

describe('isContinuation', () => {
  const actual = readPageIdentity(cabecera('TRANSPORTES SUR SA CIF: A87654321', 'F-2026-0042'));

  it('nunca continúa si no hay factura en curso', () => {
    expect(isContinuation(readPageIdentity('lo que sea'), null).continuation).toBe(false);
  });

  it('continúa una página sin número ni CIF propios', () => {
    const v = isContinuation(readPageIdentity('Filtro aceite 24 12,40 297,60'), actual);
    expect(v.continuation).toBe(true);
  });

  it('continúa si la página se declara "Página 2 de 2"', () => {
    expect(isContinuation(readPageIdentity('Página 2 de 2'), actual).continuation).toBe(true);
  });

  it('NO continúa si la página se declara "Página 1 de 3"', () => {
    expect(isContinuation(readPageIdentity('Página 1 de 3 Factura Nº X-9'), actual).continuation).toBe(false);
  });

  it('continúa si repite el mismo número de factura en la cabecera', () => {
    const v = isContinuation(readPageIdentity('Factura Nº F-2026-0042 continuación de detalle'), actual);
    expect(v.continuation).toBe(true);
  });

  it('NO continúa si trae otro número de factura', () => {
    const v = isContinuation(readPageIdentity(cabecera('OTRO CLIENTE CIF: A55555555', 'F-2026-0043')), actual);
    expect(v.continuation).toBe(false);
    expect(v.reason).toContain('otro número');
  });

  it('NO continúa si aparece un CIF de cliente que no estaba', () => {
    // Misma cabecera de emisor, sin número legible, pero otro cliente.
    const v = isContinuation(readPageIdentity('CIF: B11111111 CLIENTE INDUSTRIAS LOPEZ CIF: A55555555'), actual);
    expect(v.continuation).toBe(false);
    expect(v.reason).toContain('CIF nuevo');
  });

  it('continúa si sólo repite los CIF que la factura ya tenía', () => {
    const v = isContinuation(readPageIdentity('CIF: B11111111 CIF: A87654321 detalle de lineas'), actual);
    expect(v.continuation).toBe(true);
  });

  it('continúa una página en blanco', () => {
    expect(isContinuation(readPageIdentity(''), actual).continuation).toBe(true);
  });
});

describe('groupByContinuation', () => {
  it('une una factura de dos hojas y deja las demás sueltas', () => {
    const grupos = groupByContinuation([
      { index: 0, text: cabecera('ACEROS CIF: B12345678', 'F-2026-0041') },
      { index: 1, text: cabecera('TRANSPORTES CIF: A87654321', 'F-2026-0042') },
      { index: 2, text: 'Página 2 de 2 Filtro aceite TOTAL FACTURA 2.777,60' },
      { index: 3, text: cabecera('ACEROS CIF: B12345678', 'F-2026-0043') }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0], [1, 2], [3]]);
    expect(grupos[1].notes[0]).toContain('Pág. 3 se une a la factura de la pág. 2');
  });

  it('encadena una factura de tres hojas', () => {
    const grupos = groupByContinuation([
      { index: 0, text: cabecera('ACEROS CIF: B12345678', 'F-1') },
      { index: 1, text: 'lineas de detalle sin identidad propia' },
      { index: 2, text: 'mas lineas de detalle y el total' }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0, 1, 2]]);
  });

  it('no salta huecos: una página borrada rompe la cadena', () => {
    // La página 1 (índice 1) se ha borrado en el organizador.
    const grupos = groupByContinuation([
      { index: 0, text: cabecera('ACEROS CIF: B12345678', 'F-1') },
      { index: 2, text: 'lineas de detalle sin identidad propia' }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0], [2]]);
  });

  it('nunca convierte la primera página del lote en continuación', () => {
    const grupos = groupByContinuation([
      { index: 0, text: 'lineas sueltas sin cabecera' },
      { index: 1, text: cabecera('ACEROS CIF: B12345678', 'F-1') }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0], [1]]);
  });

  it('dos facturas seguidas del mismo cliente no se fusionan', () => {
    const grupos = groupByContinuation([
      { index: 0, text: cabecera('ACEROS CIF: B12345678', 'F-2026-0041') },
      { index: 1, text: cabecera('ACEROS CIF: B12345678', 'F-2026-0042') }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0], [1]]);
  });

  it('devuelve una lista vacía si no hay páginas', () => {
    expect(groupByContinuation([])).toEqual([]);
  });

  it('acumula los CIF: la hoja 3 sigue unida aunque repita el CIF de la hoja 2', () => {
    const grupos = groupByContinuation([
      { index: 0, text: cabecera('TRANSPORTES CIF: A87654321', 'F-9') },
      { index: 1, text: 'CIF: A87654321 continuación de lineas' },
      { index: 2, text: 'CIF: A87654321 mas lineas' }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0, 1, 2]]);
  });
});

describe('documentos que se declaran completos', () => {
  // Caso real: un albarán de una hoja ("Pág. 1 de 1") seguido de la factura de
  // OTRO cliente. Si el OCR de la segunda hoja falla, sin esta regla la hoja
  // parecería "sin identidad propia" y se pegaría al albarán anterior.
  const ALBARAN_COMPLETO = 'RUIBAL LOSADA CIF A59191197\nALBARAN: A6-004757 FECHA: 10/08/2026 Pag. 1 de 1\nLA CASA ALIMENT SL NIF: B67825950';

  it('no admite más hojas tras un "Pág. 1 de 1"', () => {
    const grupos = groupByContinuation([
      { index: 0, text: ALBARAN_COMPLETO },
      { index: 1, text: 'hoja cuyo OCR no ha dejado nada reconocible aqui' }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0], [1]]);
  });

  it('tampoco si la hoja siguiente sale completamente ilegible', () => {
    const grupos = groupByContinuation([
      { index: 0, text: ALBARAN_COMPLETO },
      { index: 1, text: '' }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0], [1]]);
  });

  it('pero un "Pág. 1 de 2" sí espera su segunda hoja', () => {
    const grupos = groupByContinuation([
      { index: 0, text: 'ALBARAN: A6-004664 FECHA: 05/08/2026 Pag. 1 de 2\nGOURMET ARRAY SL' },
      { index: 1, text: 'lineas de detalle sin identidad propia' }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0, 1]]);
  });

  it('y se cierra al llegar a su última hoja', () => {
    const grupos = groupByContinuation([
      { index: 0, text: 'ALBARAN: A6-004664 Pag. 1 de 2\nGOURMET ARRAY SL' },
      { index: 1, text: 'Pag. 2 de 2 detalle y total' },
      { index: 2, text: 'hoja ilegible que ya no le pertenece' }
    ]);
    expect(grupos.map(g => g.indices)).toEqual([[0, 1], [2]]);
  });
});
