import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { detectColumns, parseCompaniesFromBuffer, parseCompanyRows } from './excelService';

const sheetToBuffer = (rows: (string | number)[][]): Uint8Array => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Clientes');
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
};

describe('detectColumns', () => {
  it('finds the columns by header name', () => {
    const rows = [{ 'Razón Social': 'Empresa Uno', 'N.I.F.': 'B12345678', Ciudad: 'Madrid' }];
    expect(detectColumns(rows)).toEqual({ cifKey: 'N.I.F.', nameKey: 'Razón Social' });
  });

  it('falls back to inspecting the content when no header looks like a CIF', () => {
    const rows = [
      { Col1: 'Empresa Uno', Col2: 'Madrid', Col3: 'B12345678' },
      { Col1: 'Empresa Dos', Col2: 'Sevilla', Col3: 'A87654321' }
    ];
    expect(detectColumns(rows).cifKey).toBe('Col3');
  });

  it('does not mistake a plain number column for a CIF column', () => {
    const rows = [
      { Cliente: 'Empresa Uno', Importe: '1234', CIF: 'B12345678' },
      { Cliente: 'Empresa Dos', Importe: '5678', CIF: 'A87654321' }
    ];
    expect(detectColumns(rows).cifKey).toBe('CIF');
  });

  it('returns nothing for an empty sheet instead of throwing', () => {
    expect(detectColumns([])).toEqual({});
  });

  it('never picks the same column for both CIF and name', () => {
    const rows = [{ NIF: 'B12345678', Ciudad: 'Madrid' }];
    const { cifKey, nameKey } = detectColumns(rows);
    expect(cifKey).toBe('NIF');
    expect(nameKey).not.toBe(cifKey);
  });
});

describe('parseCompanyRows', () => {
  it('strips punctuation and uppercases the CIF', () => {
    const rows = [{ Cliente: '  Empresa Uno  ', CIF: ' b-12.345.678 ' }];
    expect(parseCompanyRows(rows)).toEqual([{ cif: 'B12345678', name: 'Empresa Uno' }]);
  });

  it('drops rows missing the CIF or the name instead of inventing empty folders', () => {
    const rows = [
      { Cliente: 'Empresa Uno', CIF: 'B12345678' },
      { Cliente: '', CIF: 'A87654321' },
      { Cliente: 'Empresa Sin CIF', CIF: '' }
    ];
    expect(parseCompanyRows(rows).map(c => c.name)).toEqual(['Empresa Uno']);
  });

  it('keeps every row when several clients share a name', () => {
    const rows = [
      { Cliente: 'Grupo X', CIF: 'B12345678' },
      { Cliente: 'Grupo X', CIF: 'A87654321' }
    ];
    expect(parseCompanyRows(rows)).toHaveLength(2);
  });
});

describe('parseCompaniesFromBuffer', () => {
  it('reads a real xlsx file', () => {
    const buffer = sheetToBuffer([
      ['Cliente', 'CIF'],
      ['Empresa Uno', 'B12345678'],
      ['Empresa Dos', 'A87654321']
    ]);
    expect(parseCompaniesFromBuffer(buffer)).toEqual([
      { cif: 'B12345678', name: 'Empresa Uno' },
      { cif: 'A87654321', name: 'Empresa Dos' }
    ]);
  });

  it('returns an empty list for a sheet with only headers', () => {
    expect(parseCompaniesFromBuffer(sheetToBuffer([['Cliente', 'CIF']]))).toEqual([]);
  });
});
