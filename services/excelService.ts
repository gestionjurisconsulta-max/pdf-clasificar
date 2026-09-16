
import * as XLSX from 'xlsx';
import { Company } from '../types';

type Row = Record<string, unknown>;

const CIF_REGEX = /[ABCDEFGHJNPQRSUVW0-9][0-9]{7}[0-9A-J]/i;

const matchesCifHeader = (header: string): boolean => {
  const h = header.toLowerCase().trim();
  return h === 'cif' || h === 'nif' || h === 'b'
    || h.includes('cif') || h.includes('nif')
    || h.includes('identif') || h.includes('vat') || h.includes('tax');
};

const matchesNameHeader = (header: string): boolean => {
  const h = header.toLowerCase().trim();
  return h === 'a'
    || h.includes('empresa') || h.includes('nombre') || h.includes('cliente')
    || h.includes('razon') || h.includes('social') || h.includes('denominacion')
    || h.includes('proveedor') || h.includes('titular');
};

/**
 * Decide qué columnas contienen el CIF y el nombre, en este orden:
 *   1. Por el nombre de la cabecera.
 *   2. Si no hay cabecera reconocible, inspeccionando el contenido de las 10
 *      primeras filas en busca de algo con forma de CIF.
 *   3. Como último recurso, la segunda columna para el CIF y la primera que no
 *      sea esa para el nombre. Es una suposición a ciegas: si falla, no se
 *      producirá ninguna empresa y la UI avisa de que no se ha reconocido nada.
 */
export const detectColumns = (rows: Row[]): { cifKey?: string; nameKey?: string } => {
  if (rows.length === 0) return {};
  const keys = Object.keys(rows[0]);

  let cifKey = keys.find(matchesCifHeader);
  const nameKey = keys.find(matchesNameHeader);

  if (!cifKey) {
    for (const key of keys) {
      const sampleValues = rows.slice(0, 10).map(r => String(r[key] ?? '').replace(/[^A-Z0-9]/gi, ''));
      if (sampleValues.some(v => v.length >= 8 && CIF_REGEX.test(v))) {
        cifKey = key;
        break;
      }
    }
  }

  if (!cifKey && keys.length >= 2) cifKey = keys[1];

  return {
    cifKey,
    nameKey: nameKey ?? keys.find(k => k !== cifKey) ?? keys[0]
  };
};

/** Filas ya normalizadas -> empresas. Descarta las que no tengan CIF y nombre. */
export const parseCompanyRows = (rows: Row[]): Company[] => {
  const { cifKey, nameKey } = detectColumns(rows);

  return rows.map((row): Company | null => {
    const rawCif = cifKey ? String(row[cifKey] ?? '').trim() : '';
    const cleanCif = rawCif.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const cleanName = nameKey ? String(row[nameKey] ?? '').trim() : '';

    if (cleanCif && cleanName) {
      return { cif: cleanCif, name: cleanName };
    }
    return null;
  }).filter((c): c is Company => c !== null);
};

/** Lee la PRIMERA hoja del libro. Separado de `parseExcelDatabase` para poder
 *  testear la heurística de columnas sin depender del DOM. */
export const parseCompaniesFromBuffer = (data: Uint8Array): Company[] => {
  const workbook = XLSX.read(data, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Row>(worksheet, { defval: '' });

  return parseCompanyRows(rows);
};

export const parseExcelDatabase = async (file: File): Promise<Company[]> => {
  return parseCompaniesFromBuffer(new Uint8Array(await file.arrayBuffer()));
};
