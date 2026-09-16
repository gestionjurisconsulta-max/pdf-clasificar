import { describe, expect, it } from 'vitest';
import { sanitizeName } from './fileNameService';

describe('sanitizeName', () => {
  it('leaves a normal company name untouched', () => {
    expect(sanitizeName('Construcciones Pérez S.L')).toBe('Construcciones Pérez S.L');
  });

  it('replaces characters Windows rejects in a path', () => {
    expect(sanitizeName('Aceros / Metales: "Norte" <2024>')).toBe('Aceros - Metales- -Norte- -2024-');
  });

  it('strips trailing dots and spaces, which Windows silently drops', () => {
    expect(sanitizeName('Empresa S.L.  ')).toBe('Empresa S.L');
  });

  it('never produces "." or ".." as a folder name', () => {
    expect(sanitizeName('.')).toBe('Sin nombre');
    expect(sanitizeName('..')).toBe('Sin nombre');
  });

  it('falls back to a placeholder for empty or whitespace-only names', () => {
    expect(sanitizeName('')).toBe('Sin nombre');
    expect(sanitizeName('   ')).toBe('Sin nombre');
  });

  it('does not let an invoice number escape its folder via path traversal', () => {
    expect(sanitizeName('../../etc/passwd')).not.toContain('/');
    expect(sanitizeName('..\\..\\Windows')).not.toContain('\\');
  });
});
