import { describe, expect, it } from 'vitest';
import { canonicalForm, findMatchingCompany } from './matchingService';
import { Company } from '../types';

describe('canonicalForm', () => {
  it('uppercases and strips non-alphanumeric characters', () => {
    expect(canonicalForm('b-12.345 678')).toBe('812345678');
  });

  it('applies OCR confusion substitutions (B/G/O/I/L/S)', () => {
    expect(canonicalForm('BGOILS')).toBe('860115');
  });
});

describe('findMatchingCompany', () => {
  const companies: Company[] = [
    { cif: 'B12345678', name: 'Empresa Uno' },
    { cif: 'A87654321', name: 'Empresa Dos' }
  ];

  it('matches via fuzzy canonical CIF present in the text', () => {
    const text = 'Factura emitida por B12345678 el 1 de enero';
    const result = findMatchingCompany(text, companies);
    expect(result.ambiguous).toBe(false);
    expect(result.company?.name).toBe('Empresa Uno');
  });

  it('matches via digits-only text even with OCR letter confusion', () => {
    // "8" instead of "B" at the start, as a scanner might misread it.
    const text = 'CIF: 812345678';
    const result = findMatchingCompany(text, companies);
    expect(result.company?.name).toBe('Empresa Uno');
  });

  it('returns no match when nothing lines up', () => {
    const result = findMatchingCompany('texto sin ningun cif reconocible', companies);
    expect(result.company).toBeNull();
    expect(result.ambiguous).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  it('flags ambiguity instead of picking the first match when two companies match the same text', () => {
    const clashingCompanies: Company[] = [
      { cif: 'B12345678', name: 'Empresa Uno' },
      { cif: 'S12345678', name: 'Empresa Clon' } // canonicalForm('S...') === canonicalForm('B...') → 8 vs 5, distinct actually
    ];
    // Build a text that contains both companies' digit sequences distinctly.
    const text = 'B12345678 y también S99999999 aparecen aquí';
    const twoDistinctCifs: Company[] = [
      { cif: 'B12345678', name: 'Empresa Uno' },
      { cif: 'S99999999', name: 'Empresa Otra' }
    ];
    const result = findMatchingCompany(text, twoDistinctCifs);
    expect(result.ambiguous).toBe(true);
    expect(result.company).toBeNull();
    expect(result.candidates.map(c => c.name).sort()).toEqual(['Empresa Otra', 'Empresa Uno']);
  });

  it('falls back to learned CIF mappings when no company in the database matches', () => {
    const result = findMatchingCompany('CIF aprendido: Z99999999', companies, { Z99999999: 'Empresa Aprendida' });
    expect(result.company).toEqual({ cif: 'Z99999999', name: 'Empresa Aprendida' });
  });

  it('flags ambiguity across learned mappings too', () => {
    const result = findMatchingCompany('Z11111111 y Z22222222', companies, {
      Z11111111: 'Aprendida Uno',
      Z22222222: 'Aprendida Dos'
    });
    expect(result.ambiguous).toBe(true);
    expect(result.company).toBeNull();
  });
});
