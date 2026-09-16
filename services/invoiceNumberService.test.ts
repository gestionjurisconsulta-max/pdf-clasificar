import { describe, expect, it } from 'vitest';
import { DEFAULT_INVOICE_REGEX, extractInvoiceNumber } from './invoiceNumberService';

describe('extractInvoiceNumber', () => {
  it.each([
    ['Factura Nº F-2024-001 de fecha 3 de enero', 'F-2024-001'],
    ['FACTURA N.º 2024/0001', '2024/0001'],
    ['FACTURA Numero F-2024-001', 'F-2024-001'],
    ['Factura número A-100', 'A-100'],
    ['Factura: 12345', '12345'],
    ['FACTURA No 8871', '8871'],
    ['ALBARÁN 556', '556'],
    ['ALBARAN 556', '556'],
    ['Fact. 2024-88', '2024-88'],
    ['INV 77012', '77012']
  ])('extracts the number from %j', (text, expected) => {
    expect(extractInvoiceNumber(text)).toBe(expected);
  });

  it('does not capture the numbering prefix itself', () => {
    // El patrón anterior devolvía "N" aquí, y todos los PDF salían con el
    // mismo nombre de fichero.
    expect(extractInvoiceNumber('Factura Nº F-2024-001')).not.toBe('N');
  });

  it('ignores keyword matches that are not followed by a number', () => {
    expect(extractInvoiceNumber('Factura de compra del cliente habitual')).toBe('');
  });

  it('skips a keyword without a number and finds a later one', () => {
    expect(extractInvoiceNumber('Factura de compra. Factura Nº 4321')).toBe('4321');
  });

  it('returns an empty string when there is nothing to find', () => {
    expect(extractInvoiceNumber('Documento sin referencia alguna')).toBe('');
  });

  it('trims trailing punctuation that belongs to the sentence', () => {
    expect(extractInvoiceNumber('Factura Nº 2024-10.')).toBe('2024-10');
  });

  it('honours a custom pattern from the learning file', () => {
    expect(extractInvoiceNumber('REF//778899//', 'REF//(\\d+)//')).toBe('778899');
  });

  it('returns an empty string for an invalid custom pattern instead of throwing', () => {
    expect(() => extractInvoiceNumber('Factura Nº 1', '([unclosed')).not.toThrow();
    expect(extractInvoiceNumber('Factura Nº 1', '([unclosed')).toBe('');
  });

  it('exposes a default pattern that compiles', () => {
    expect(() => new RegExp(DEFAULT_INVOICE_REGEX, 'i')).not.toThrow();
  });
});
