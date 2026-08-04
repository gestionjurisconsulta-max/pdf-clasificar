
import * as XLSX from 'xlsx';
import { Company } from '../types';

export const parseExcelDatabase = async (file: File): Promise<Company[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' }) as any[];

        if (!jsonData || jsonData.length === 0) {
          resolve([]);
          return;
        }

        const keys = Object.keys(jsonData[0]);
        
        // 1. Detectar columna CIF por nombres de cabecera
        let cifKey = keys.find(k => {
          const kl = k.toLowerCase().trim();
          return kl === 'cif' || kl === 'nif' || kl.includes('cif') || kl.includes('nif') || kl.includes('identif') || kl.includes('vat') || kl.includes('tax') || kl === 'b';
        });
        
        // 2. Detectar columna Nombre por nombres de cabecera
        let nameKey = keys.find(k => {
          const kl = k.toLowerCase().trim();
          return kl.includes('empresa') || kl.includes('nombre') || kl.includes('cliente') || kl.includes('razon') || kl.includes('social') || kl.includes('denominacion') || kl.includes('proveedor') || kl.includes('titular') || kl === 'a';
        });

        // 3. Fallback por inspección de contenido (CIF regex)
        const cifRegex = /[ABCDEFGHJNPQRSUVW0-9][0-9]{7}[0-9A-J]/i;
        if (!cifKey) {
          for (const key of keys) {
            const sampleValues = jsonData.slice(0, 10).map(r => String(r[key]).replace(/[^A-Z0-9]/gi, ''));
            if (sampleValues.some(v => cifRegex.test(v) && v.length >= 8)) {
              cifKey = key;
              break;
            }
          }
        }

        if (!cifKey && keys.length >= 2) cifKey = keys[1];
        if (!nameKey) nameKey = keys.find(k => k !== cifKey) || keys[0];

        const companies: Company[] = jsonData.map((row: any) => {
          const rawCif = cifKey ? String(row[cifKey]).trim() : '';
          const cleanCif = rawCif.replace(/[^A-Z0-9]/gi, '').toUpperCase();
          const cleanName = nameKey ? String(row[nameKey]).trim() : '';
          
          if (cleanCif && cleanName) {
            return { cif: cleanCif, name: cleanName };
          }
          return null;
        }).filter((c): c is Company => c !== null);

        resolve(companies);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
};
