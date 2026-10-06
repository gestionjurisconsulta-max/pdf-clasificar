/**
 * Número de documento leído de la LÍNEA DE CABECERA, sin palabra clave.
 *
 * Port de `backend/app/services/header_doc.py`, que a su vez viene de
 * `detect_header_doc` de DivisorPDF. Es la señal que le faltaba a la detección
 * de continuaciones para separar dos facturas seguidas del mismo cliente:
 * `invoiceNumberService` sólo encuentra el número si va pegado a la palabra
 * "Factura" o "Albarán", y muchísimos proveedores imprimen únicamente la línea
 *
 *     <Nº DOCUMENTO>   <FECHA>   <CLIENTE>   <PÁG/TOTAL>
 *
 * Sin número, la segunda factura no tenía forma de demostrar que era una
 * cabecera y se unía a la anterior.
 *
 * De esa misma línea sale también la paginación suelta ("1/1", "2 / 2"), que es
 * la otra mitad del problema: `continuationService` sólo reconocía la
 * paginación si venía con la palabra "Pág." o "Hoja", así que en estas facturas
 * nunca se disparaba la regla de "el documento anterior ya estaba completo".
 *
 * No depende de conocer al proveedor: es deliberadamente genérico.
 */

/** Fecha de la cabecera, con los tres separadores habituales y año de dos cifras. */
const RE_DATE = /\b\d{2}[/.-]\d{2}[/.-](?:\d{4}|\d{2})\b/;
const RE_DATE_AT_START = /^\d{2}[/.-]\d{2}[/.-](?:\d{4}|\d{2})\b/;

/**
 * Token con forma de número de documento: '262000663', '26 BAR262023454',
 * '2026-0042'. SIN la bandera `i` a propósito: las letras de un número de
 * documento van en mayúsculas, y permitir minúsculas hacía que cualquier
 * palabra del texto entrase como candidata.
 */
const RE_DOCNUM_AT_START = /^((?:\d{1,4}[\s_/-]?)?(?:[A-Z]{1,5}[\s_/-]?)?\d{4,12})\b/;
const RE_DOCNUM_GLOBAL = /\b((?:\d{1,4}[\s_/-]?)?(?:[A-Z]{1,5}[\s_/-]?)?\d{4,12})\b/g;

/** Paginación suelta al final de la línea de cabecera: '1/1', '2 / 2'. */
const RE_HDR_PAGINA = /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/;

/**
 * Etiqueta explícita, como respaldo cuando no hay línea de cabecera completa.
 * El OCR destroza el 'º' de mil formas: N*, N?, Ne, N., No, N°... El texto se
 * normaliza antes a NFKD, así que el 'º' ya se ha convertido en una 'o'.
 */
const RE_DOC_LABEL = /N[eo.*?°]{0,2}\s*(?:de\s+)?(?:Facturas?|Abono|Albaran(?:es)?|Documento|Nota\s+de\s+abono|Rectificativa)\b/i;

/**
 * Forma de un identificador fiscal español. Un CIF en la cabecera no es el
 * número del documento, y sin este filtro se colaba como tal.
 */
const RE_FISCAL_SHAPE = /^(?:[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/;

/** Cuánto texto se mira tras la etiqueta para encontrar su número. */
const LABEL_WINDOW = 300;

/**
 * Máximo de hojas que se admite en una paginación. Por encima de esto lo más
 * probable es que sea una cantidad o una medida, no "pág. X de Y".
 */
const MAX_PAGES = 30;

/**
 * Quita tildes CONSERVANDO las mayúsculas, que `RE_DOCNUM` necesita.
 * Se usa NFKD, no NFD, para que el 'º' de 'Nº' se descomponga en una 'o' y la
 * etiqueta se reconozca igual que si el OCR hubiera leído 'No'.
 */
const unaccent = (text: string): string =>
  (text ?? '').normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * Normaliza un número de documento: mayúsculas y sin separadores, para que
 * 'BAR 262023454' y 'BAR-262023454' sean el mismo número.
 */
export const normalizeDocNumber = (value: string): string =>
  (value ?? '').toUpperCase().replace(/[\s_.\-/]/g, '');

/** Parece un número de documento, y no una fecha, un CIF ni un código corto. */
const looksLikeDocNumber = (token: string): boolean => {
  const normalized = normalizeDocNumber(token);
  const digits = (normalized.match(/\d/g) ?? []).length;
  if (digits < 5) return false;
  if (RE_FISCAL_SHAPE.test(normalized)) return false;
  return !RE_DATE_AT_START.test(token);
};

/** Lo que se ha podido leer de la línea de cabecera. */
export interface HeaderDoc {
  number: string;
  page: number | null;
  total: number | null;
}

const readPagination = (tail: string): { page: number | null; total: number | null } => {
  const match = tail.match(RE_HDR_PAGINA);
  if (!match) return { page: null, total: null };
  const page = Number(match[1]);
  const total = Number(match[2]);
  return page >= 1 && page <= total && total <= MAX_PAGES
    ? { page, total }
    : { page: null, total: null };
};

/**
 * Número de documento y paginación de la cabecera, o un `HeaderDoc` vacío.
 *
 * Dos páginas con número de cabecera distinto son documentos distintos; dos
 * páginas con el mismo número son el mismo documento (una factura de varias
 * hojas, o el original y su copia).
 */
export const readHeaderDoc = (text: string): HeaderDoc => {
  const plain = unaccent(text ?? '');

  const candidates: HeaderDoc[] = [];
  for (const line of plain.split('\n')) {
    const date = line.match(RE_DATE);
    if (!date || date.index === undefined) continue;

    const before = line.slice(0, date.index).trim();
    // La fecha abre la línea: es una fecha suelta, no una cabecera.
    if (!before) continue;

    const token = before.match(RE_DOCNUM_AT_START);
    if (!token || !looksLikeDocNumber(token[1])) continue;

    // Entre el número y la fecha sólo cabe ruido de OCR, no texto: si hay
    // palabras, la línea es prosa y el número es cualquier otra cosa.
    const rest = before.slice(token[0].length).trim();
    if (rest.length > 3 || /[\p{L}\p{N}]/u.test(rest)) continue;

    const { page, total } = readPagination(line.slice(date.index + date[0].length));
    candidates.push({ number: normalizeDocNumber(token[1]), page, total });
  }

  // Una cabecera aparece UNA vez. Varias líneas con esta forma y números
  // distintos son una tabla de detalle —el resumen de albaranes que algunas
  // facturas listan—, y tomar la primera por cabecera partía la factura en dos.
  // Si todas repiten el mismo número sí es la cabecera, impresa dos veces (el
  // original y su copia en la misma hoja).
  if (candidates.length > 0 && new Set(candidates.map(c => c.number)).size === 1) {
    return candidates[0];
  }

  const label = plain.match(RE_DOC_LABEL);
  if (label && label.index !== undefined) {
    const from = label.index + label[0].length;
    const window = plain.slice(from, from + LABEL_WINDOW);
    for (const token of window.matchAll(RE_DOCNUM_GLOBAL)) {
      if (looksLikeDocNumber(token[1])) {
        return { number: normalizeDocNumber(token[1]), page: null, total: null };
      }
    }
  }

  return { number: '', page: null, total: null };
};

/**
 * ¿La página se titula a sí misma al principio de una línea («ALBARÁN:
 * A6-004757», «FACTURA Nº M6-001364»)?
 *
 * Lo usa `continuationService` como señal de corte: una hoja que encabeza su
 * propio título no es el detalle de la anterior. En el backend esto vive en
 * `document_type.py`, porque allí comparte el patrón con la clasificación entre
 * factura y albarán; aquí esa clasificación no existe, así que vive con lo
 * demás que se lee de la cabecera.
 *
 * Se exige que empiece la línea para no confundirlo con una referencia dentro
 * del cuerpo ("según nuestro albarán A-3312").
 */
const SELF_TITLE = /^[^\S\n]*(factura|albaran)(?:es)?[^\S\n]*(?:n[.ºo°]*[^\S\n]*)?(?::|(?=[a-z0-9][a-z0-9\-/.]*\d))/m;

/** Cuánto texto se considera cabecera. Mismo valor que `document_type.py`. */
const HEADER_CHARS = 400;

/** Minúsculas y sin tildes, conservando los saltos de línea. */
const normalizeForTitle = (text: string): string =>
  (text ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\S\n]+/g, ' ');

export const declaresOwnTitle = (text: string): boolean =>
  SELF_TITLE.test(normalizeForTitle(text).slice(0, HEADER_CHARS));
