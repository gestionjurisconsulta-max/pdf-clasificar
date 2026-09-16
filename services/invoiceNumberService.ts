/**
 * Patrón por defecto para localizar el número de factura en el texto de una
 * página. Es sobreescribible desde el JSON de memoria (`patterns.invoiceRegex`).
 *
 * Se aplica siempre con la bandera `i`. Las tres piezas son:
 *   1. Una palabra clave: FACTURA, ALBARÁN, FACT, INV...
 *   2. Un prefijo opcional de numeración que hay que SALTAR, no capturar:
 *      "Nº", "N.º", "No", "Num", "Número"... Este es el punto donde fallaba el
 *      patrón anterior, que devolvía "N" para "Factura Nº F-2024-001".
 *   3. El número en sí, que debe contener al menos un dígito. Exigirlo evita
 *      capturar palabras sueltas como en "Factura de compra".
 */
export const DEFAULT_INVOICE_REGEX =
  '(?:factura|albar[aá]n|fact|inv)[.:\\s]*(?:n[.\\u00ba\\u00b0o]*|n[uú]m(?:ero)?)?[.:\\s]*([A-Za-z0-9][A-Za-z0-9\\-/.]*[0-9][A-Za-z0-9\\-/.]*)';

/** CIF/NIF español. Se conserva tal cual estaba. */
export const DEFAULT_CIF_REGEX =
  '([ABCDEFGHJNPQRSUVW][0-9\\s\\.\\-]{7,8}[0-9A-J]|[0-9]{8}[A-Z])';

/**
 * Devuelve el número de factura encontrado, o '' si no hay ninguno.
 * Nunca lanza: un patrón inválido venido del JSON de memoria se trata como
 * "no encontrado" en vez de reventar el proceso a mitad de camino.
 */
export const extractInvoiceNumber = (text: string, pattern: string = DEFAULT_INVOICE_REGEX): string => {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    return '';
  }

  const match = text.match(regex);
  if (!match) return '';

  // Se prefiere el grupo de captura; si el patrón del usuario no tiene ninguno,
  // se usa la coincidencia completa.
  const raw = (match[1] ?? match[0]) ?? '';
  // Los puntos y guiones finales suelen ser el punto de la frase, no del número.
  return raw.replace(/[.\-/]+$/, '').trim();
};
