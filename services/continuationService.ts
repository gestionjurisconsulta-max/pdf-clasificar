import { canonicalForm } from './matchingService';
import { declaresOwnTitle, readHeaderDoc } from './headerDocService';
import { DEFAULT_CIF_REGEX, DEFAULT_INVOICE_REGEX, extractInvoiceNumber } from './invoiceNumberService';

/**
 * Detecta qué páginas son continuación de la factura anterior, usando sólo el
 * texto que ya extrae el motor local. No sustituye a la agrupación manual: las
 * páginas que el usuario ya haya unido a mano no pasan por aquí.
 *
 * La idea es que una página que no aporta ninguna identidad propia —ni número
 * de factura, ni un CIF que no se hubiera visto ya— no puede ser una factura
 * por sí sola, así que pertenece a la anterior.
 */

/** "Página 2 de 3", "Pág. 2/3", "Hoja 2 de 3". */
const PAGE_MARKER = /(?:p[áa]g(?:ina)?|hoja)\.?\s*:?\s*(\d{1,3})\s*(?:de|\/)\s*(\d{1,3})/i;

/** Frases que anuncian explícitamente una continuación. */
const CONTINUATION_WORDS = /continuaci[óo]n|contin[úu]a\s+en|viene\s+de\s+la\s+(?:p[áa]gina|hoja)|sigue\s+en\s+la/i;

/** Por debajo de esto damos la página por vacía (escaneo en blanco, separador). */
const BLANK_THRESHOLD = 12;

export interface PageIdentity {
  invoiceNumber: string;
  /**
   * Número leído de la línea de cabecera, sin depender de que vaya pegado a la
   * palabra "Factura" (ver `headerDocService`). Es el canal que separa dos
   * facturas seguidas del mismo cliente cuando `invoiceNumber` sale vacío.
   */
  headerNumber: string;
  /** La página encabeza su propio título («ALBARÁN: A6-004757»). */
  titlesItself: boolean;
  /** CIF encontrados en la página, en forma canónica (tolerante a OCR). */
  cifs: string[];
  /** Número de hoja si la página lo dice explícitamente ("Página 2 de 3"). */
  pageMarker: number | null;
  /** El total de "Pág. 2 DE 3": permite cerrar el documento en su última hoja. */
  pageTotal: number | null;
  saysContinuation: boolean;
  isBlank: boolean;
}

const readCifs = (text: string, cifPattern: string): string[] => {
  try {
    const matches = [...text.matchAll(new RegExp(cifPattern, 'gi'))];
    return [...new Set(matches.map(m => canonicalForm(m[1] ?? m[0])))]
      // Un CIF/NIF español tiene exactamente 9 caracteres. Sin este filtro, un
      // número de factura como "F-2026-0042" encaja en el patrón y se cuela
      // como si fuera un CIF, rompiendo la comparación entre páginas.
      .filter(cif => cif.length === 9);
  } catch {
    // Patrón inválido venido del JSON de memoria.
    return [];
  }
};

export const readPageIdentity = (
  text: string,
  invoicePattern: string = DEFAULT_INVOICE_REGEX,
  cifPattern: string = DEFAULT_CIF_REGEX
): PageIdentity => {
  const marker = text.match(PAGE_MARKER);
  const header = readHeaderDoc(text);

  return {
    invoiceNumber: extractInvoiceNumber(text, invoicePattern),
    headerNumber: header.number,
    titlesItself: declaresOwnTitle(text),
    cifs: readCifs(text, cifPattern),
    // Si la página no escribe "Pág. X de Y" pero su cabecera trae un "1/1"
    // suelto, vale igual: es lo que permite cerrar el documento.
    pageMarker: marker ? Number(marker[1]) : header.page,
    pageTotal: marker ? Number(marker[2]) : header.total,
    saysContinuation: CONTINUATION_WORDS.test(text),
    isBlank: text.trim().length < BLANK_THRESHOLD
  };
};

export interface ContinuationVerdict {
  continuation: boolean;
  /** Explicación en español para el log de auditoría. */
  reason: string;
}

/**
 * ¿`page` continúa la factura cuya identidad acumulada es `current`?
 * `current` acumula los CIF de todas las páginas que ya lleva la factura.
 */
export const isContinuation = (page: PageIdentity, current: PageIdentity | null): ContinuationVerdict => {
  if (!current) {
    return { continuation: false, reason: 'es la primera página del lote' };
  }

  // El documento anterior declaró cuántas hojas tenía y ya las tiene todas
  // ("Pág. 1 de 1", "Pág. 3 de 3"). Nada que venga después le pertenece.
  // Es la regla que protege de un OCR malo: se apoya en la hoja que SÍ se leyó
  // bien, en vez de depender de que la siguiente se lea bien.
  if (
    current.pageMarker !== null &&
    current.pageTotal !== null &&
    current.pageMarker >= current.pageTotal
  ) {
    return {
      continuation: false,
      reason: `el documento anterior ya estaba completo (pág. ${current.pageMarker} de ${current.pageTotal})`
    };
  }

  if (page.pageMarker === 1) {
    return { continuation: false, reason: 'la página dice ser la nº 1' };
  }
  if (page.pageMarker !== null && page.pageMarker > 1) {
    return { continuation: true, reason: `la página dice ser la nº ${page.pageMarker}` };
  }
  if (page.saysContinuation) {
    return { continuation: true, reason: 'el texto la marca como continuación' };
  }
  if (page.isBlank) {
    return { continuation: true, reason: 'no tiene texto legible' };
  }

  // Repetir el número del documento en curso es la señal de continuación más
  // fuerte que hay, y va antes que cualquier corte: una hoja que reimprime la
  // cabecera de su factura sigue siendo la misma factura.
  if (page.invoiceNumber && page.invoiceNumber === current.invoiceNumber) {
    return { continuation: true, reason: `repite el número de factura ${page.invoiceNumber}` };
  }

  // Número de la línea de cabecera. Que la página tenga uno significa que ha
  // impreso una cabecera de documento: si no es la del documento en curso, abre
  // uno nuevo. Es la regla genérica, la que funciona con un proveedor que no se
  // haya visto nunca.
  if (page.headerNumber) {
    return page.headerNumber === current.headerNumber
      ? { continuation: true, reason: `repite el nº de cabecera ${page.headerNumber}` }
      : { continuation: false, reason: `su cabecera abre otro documento (nº ${page.headerNumber})` };
  }

  if (page.invoiceNumber) {
    return { continuation: false, reason: `trae otro número de factura (${page.invoiceNumber})` };
  }

  // Se titula a sí misma y no repite el número del documento en curso (que ya
  // se ha comprobado arriba): es la primera hoja de otro documento.
  if (page.titlesItself) {
    return { continuation: false, reason: 'encabeza su propio título de documento' };
  }

  // Sin número propio. Si aporta algún CIF que la factura en curso no tenía,
  // es una factura nueva: lo más probable es que sea otro cliente.
  const nuevos = page.cifs.filter(c => !current.cifs.includes(c));
  if (nuevos.length > 0) {
    return { continuation: false, reason: `aparece un CIF nuevo (${nuevos.join(', ')})` };
  }

  return {
    continuation: true,
    reason: page.cifs.length > 0
      ? 'no tiene número de factura y repite los CIF de la anterior'
      : 'no tiene ni número de factura ni CIF propios'
  };
};

export interface PageText {
  index: number;
  text: string;
}

export interface ContinuationGroup {
  /** Índices de página, en orden. El primero abre la factura. */
  indices: number[];
  /** Una línea por página añadida, para el log. */
  notes: string[];
}

/**
 * Agrupa las páginas en facturas. Sólo une páginas FÍSICAMENTE CONTIGUAS: si
 * el usuario ha borrado una página intermedia, o hay un hueco porque esa página
 * ya está en un grupo manual, no se salta el hueco.
 */
export const groupByContinuation = (
  pages: PageText[],
  invoicePattern: string = DEFAULT_INVOICE_REGEX,
  cifPattern: string = DEFAULT_CIF_REGEX
): ContinuationGroup[] => {
  const ordered = [...pages].sort((a, b) => a.index - b.index);

  // La identidad acumulada vive en la factura que se está construyendo, no en
  // una variable aparte: así la hoja 3 sigue reconociéndose aunque sólo repita
  // un CIF que apareció por primera vez en la hoja 2.
  const building: (ContinuationGroup & { identity: PageIdentity })[] = [];
  let previousIndex: number | null = null;

  for (const page of ordered) {
    const identity = readPageIdentity(page.text, invoicePattern, cifPattern);
    const open = building.length > 0 ? building[building.length - 1] : null;
    const adjacent = previousIndex !== null && page.index === previousIndex + 1;

    const verdict = open && adjacent
      ? isContinuation(identity, open.identity)
      : { continuation: false, reason: 'no va justo detrás de la página anterior' };

    if (open && verdict.continuation) {
      open.indices.push(page.index);
      open.notes.push(`Pág. ${page.index + 1} se une a la factura de la pág. ${open.indices[0] + 1}: ${verdict.reason}.`);
      open.identity = {
        invoiceNumber: open.identity.invoiceNumber || identity.invoiceNumber,
        headerNumber: open.identity.headerNumber || identity.headerNumber,
        titlesItself: open.identity.titlesItself,
        cifs: [...new Set([...open.identity.cifs, ...identity.cifs])],
        pageMarker: identity.pageMarker,
        pageTotal: identity.pageTotal,
        saysContinuation: identity.saysContinuation,
        isBlank: false
      };
    } else {
      building.push({ indices: [page.index], notes: [], identity });
    }

    previousIndex = page.index;
  }

  return building.map(({ indices, notes }) => ({ indices, notes }));
};
