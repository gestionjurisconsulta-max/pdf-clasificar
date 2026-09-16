// Sanea nombres de carpeta/archivo: quita caracteres inválidos en Windows/URL
// y recorta puntos/espacios en los extremos (evita nombres como ".", ".." o
// con espacios finales, que Windows trata de forma especial o rechaza).
export const sanitizeName = (name: string): string => {
  const cleaned = name.replace(/[/\\?%*:|"<>]/g, '-').trim().replace(/^\.+|[.\s]+$/g, '');
  return cleaned || 'Sin nombre';
};
