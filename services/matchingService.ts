import { Company } from '../types';

export interface MatchResult {
  company: Company | null;
  ambiguous: boolean;
  candidates: Company[];
}

// Normaliza CIFs/texto de OCR corrigiendo confusiones típicas de escaneo:
// B<->8, G<->6, O<->0, I/L<->1, S<->5.
export const canonicalForm = (text: string): string => {
  return text.toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/B/g, '8').replace(/G/g, '6').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5');
};

const dedupeByCif = (companies: Company[]): Company[] => {
  const seen = new Set<string>();
  const result: Company[] = [];
  for (const c of companies) {
    const key = canonicalForm(c.cif);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  }
  return result;
};

// Busca qué empresa de la base de datos coincide con el texto de una página.
// Si más de una empresa distinta coincide, se marca como ambigua en vez de
// devolver la primera encontrada, para evitar asignar una factura al cliente
// equivocado por un CIF corto/parcial que también aparezca en otro CIF.
export const findMatchingCompany = (
  pageText: string,
  companies: Company[],
  learnedCifMappings: Record<string, string> = {}
): MatchResult => {
  const cleanFullText = canonicalForm(pageText);
  const digitsOnlyText = pageText.replace(/\D/g, '');

  const directCandidates = companies.filter((comp) => {
    const canonicalCif = canonicalForm(comp.cif);
    const numericCif = comp.cif.replace(/\D/g, '');
    const fuzzyHit = canonicalCif.length > 5 && cleanFullText.includes(canonicalCif);
    const digitHit = numericCif.length >= 7 && digitsOnlyText.includes(numericCif);
    return fuzzyHit || digitHit;
  });

  const uniqueDirect = dedupeByCif(directCandidates);
  if (uniqueDirect.length > 0) {
    return {
      company: uniqueDirect.length === 1 ? uniqueDirect[0] : null,
      ambiguous: uniqueDirect.length > 1,
      candidates: uniqueDirect
    };
  }

  const learnedCandidates = dedupeByCif(
    Object.entries(learnedCifMappings)
      .filter(([cif]) => cleanFullText.includes(canonicalForm(cif)) || digitsOnlyText.includes(cif.replace(/\D/g, '')))
      .map(([cif, name]) => ({ cif, name }))
  );

  if (learnedCandidates.length > 0) {
    return {
      company: learnedCandidates.length === 1 ? learnedCandidates[0] : null,
      ambiguous: learnedCandidates.length > 1,
      candidates: learnedCandidates
    };
  }

  return { company: null, ambiguous: false, candidates: [] };
};
