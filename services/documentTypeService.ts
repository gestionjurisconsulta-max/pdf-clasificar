/**
 * Distinguir una factura de un albarán. Port de
 * `backend/app/services/document_type.py`.
 *
 * El criterio principal es la CABECERA, porque es donde va el título del
 * documento. Una factura menciona muy a menudo el albarán que la origina
 * («según nuestro albarán 4471»), así que contar palabras en todo el texto se
 * equivoca justo en el caso más común.
 */

import type { DocumentType } from '../types';

/** Cuánto texto se considera «cabecera»: membrete, título y número, sin las
 * líneas de detalle. Mismo valor que `document_type.py`. */
const HEADER_CHARS = 400;

const ALBARAN_TITLE = /\balbaran(?:es)?\b|\bnota de entrega\b|\bdelivery note\b|\bremito\b/;
const FACTURA_TITLE = /\bfactura(?:s)?\b|\bfactura simplificada\b|\binvoice\b/;

// Señales de que hay liquidación de impuestos: sólo aparecen en facturas. Un
// albarán lista mercancía, no cuadra IVA ni retenciones.
const FISCAL_SIGNALS = [
  /\bbase imponible\b/,
  /\b(?:i\.?v\.?a\.?|impuesto sobre el valor)\b/,
  /\birpf\b|\bretencion\b/,
  /\bcuota\b/,
  /\btotal factura\b/
];

// Señales propias del albarán.
const DELIVERY_SIGNALS = [
  /\balbaran\b/,
  /\bnota de entrega\b/,
  /\brecibi conforme\b|\brecibido conforme\b/,
  /\bbultos\b/,
  /\btransportista\b/,
  /\bfirma del cliente\b/
];

/**
 * Un documento que ENCABEZA UNA LÍNEA declarando su propio número —«ALBARÁN:
 * A6-004757», «FACTURA: M6-001364»— está diciendo lo que es, y eso manda sobre
 * cualquier otra señal. Se exige que empiece la línea para no confundirlo con
 * una referencia dentro del cuerpo («según nuestro albarán A-3312») ni con el
 * encabezado de la columna del cliente («SOLICITANTE FACTURA A»).
 */
const SELF_TITLE =
  /^[^\S\n]*(factura|albaran)(?:es)?[^\S\n]*(?:n[.ºo°]*[^\S\n]*)?(?::|(?=[a-z0-9][a-z0-9\-/.]*\d))/m;

/**
 * Minúsculas y sin tildes: el OCR se come los acentos, así que «ALBARÁN»,
 * «albaran» y «Albarán» tienen que ser la misma palabra. Se conservan los
 * saltos de línea, porque saber que algo encabeza una línea es justo lo que
 * distingue el título de una referencia de pasada.
 */
export const normalize = (text: string): string =>
  (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\S\n]+/g, ' ');

export interface TypeVerdict {
  docType: DocumentType;
  /** Explicación en español para el log de auditoría. */
  reason: string;
}

export const detectDocumentType = (text: string): TypeVerdict => {
  const normalized = normalize(text);
  if (!normalized.trim()) {
    return { docType: 'desconocido', reason: 'la página no tiene texto legible' };
  }

  const header = normalized.slice(0, HEADER_CHARS);

  // 1. El documento declara su propio número al principio de una línea. Es la
  //    señal más fuerte que existe y gana a todo lo demás, incluidos los
  //    impuestos: hay proveedores que imprimen base imponible e IVA también en
  //    sus albaranes, y darle prioridad a eso los clasificaba como facturas.
  const declarado = header.match(SELF_TITLE);
  if (declarado) {
    const tipo: DocumentType = declarado[1] === 'albaran' ? 'albaran' : 'factura';
    return { docType: tipo, reason: `la página se titula «${declarado[1]}»` };
  }

  const albaranInHeader = header.match(ALBARAN_TITLE);
  const facturaInHeader = header.match(FACTURA_TITLE);
  const fiscal = FISCAL_SIGNALS.filter(s => s.test(normalized)).length;

  if (albaranInHeader) {
    // Sin título propio, «albarán» suelto puede ser una referencia dentro de una
    // factura («según nuestro albarán A-3312»). Ahí sí manda que la página
    // liquide impuestos.
    if (fiscal >= 2) {
      return { docType: 'factura', reason: 'menciona albarán pero liquida impuestos' };
    }
    // Si aparecen los dos, manda el que va ANTES: es el encabezado.
    if (facturaInHeader && (facturaInHeader.index ?? 0) < (albaranInHeader.index ?? 0)) {
      return { docType: 'factura', reason: 'el título de la cabecera es factura' };
    }
    return { docType: 'albaran', reason: 'la cabecera dice albarán' };
  }

  if (facturaInHeader) {
    return { docType: 'factura', reason: 'la cabecera dice factura' };
  }

  // Sin título reconocible: se decide por acumulación de señales.
  const delivery = DELIVERY_SIGNALS.filter(s => s.test(normalized)).length;

  if (fiscal > delivery && fiscal > 0) {
    return { docType: 'factura', reason: `${fiscal} señales fiscales` };
  }
  if (delivery > fiscal && delivery > 0) {
    return { docType: 'albaran', reason: `${delivery} señales de entrega` };
  }

  return { docType: 'desconocido', reason: 'sin título ni señales claras' };
};
