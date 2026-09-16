

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// Servidos por el plugin `pdfjs-assets` de vite.config.ts. Sin `wasmUrl` pdf.js
// no puede decodificar imágenes CCITT/JBIG2 y los PDF de escáner se renderizan
// en blanco sin lanzar ningún error.
const PDFJS_ASSETS = '/pdfjs-assets/';

// El worker se pide por ruta fija con extensión .js en vez de importarlo con
// `?url`: así no acaba en `dist/assets/*.mjs`, que los servidores estáticos que
// no conocen `.mjs` devuelven como `text/plain`. Chrome bloquea ese módulo,
// pdf.js activa el "fake worker" (que reimporta el mismo fichero y vuelve a
// fallar) y `getDocument()` se queda colgado para siempre sin lanzar error.
pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSETS}pdf.worker.min.js`;

export interface RenderOptions {
  scale?: number;
  /** 'image/jpeg' pesa ~10x menos que PNG: obligatorio para las miniaturas. */
  mimeType?: 'image/png' | 'image/jpeg';
  /** Sólo aplica a JPEG (0-1). */
  quality?: number;
}

export const loadPdfDocument = async (file: File): Promise<pdfjs.PDFDocumentProxy> => {
  const arrayBuffer = await file.arrayBuffer();
  return await pdfjs.getDocument({
    data: arrayBuffer,
    wasmUrl: `${PDFJS_ASSETS}wasm/`,
    cMapUrl: `${PDFJS_ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
    iccUrl: `${PDFJS_ASSETS}iccs/`,
  }).promise;
};

export const getPageCount = async (file: File): Promise<number> => {
  const pdf = await loadPdfDocument(file);
  return pdf.numPages;
};

export const pdfPageToImage = async (
  fileOrDoc: File | pdfjs.PDFDocumentProxy,
  pageIndex: number,
  options: RenderOptions = {}
): Promise<string> => {
  const { scale = 1.5, mimeType = 'image/png', quality = 0.75 } = options;

  let pdf: pdfjs.PDFDocumentProxy;
  if (fileOrDoc instanceof File) {
    pdf = await loadPdfDocument(fileOrDoc);
  } else {
    pdf = fileOrDoc;
  }
  const page = await pdf.getPage(pageIndex + 1);

  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) throw new Error("Canvas error");

  canvas.height = Math.floor(viewport.height);
  canvas.width = Math.floor(viewport.width);

  // Fondo blanco explícito
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  // intent 'print' en lugar del 'display' por defecto: con 'display' pdf.js
  // encadena el render con requestAnimationFrame, que el navegador NO dispara
  // en pestañas ocultas, así que el proceso se congelaba al cambiar de pestaña.
  // Con 'print' avanza con microtareas y sigue trabajando en segundo plano.
  await page.render({
    canvasContext: context,
    viewport: viewport,
    canvas: canvas,
    intent: 'print',
  }).promise;

  const dataUrl = canvas.toDataURL(mimeType, quality);

  // Libera el bitmap del canvas de inmediato: con PDFs de cientos de páginas,
  // dejarlo al criterio del GC dispara el uso de memoria de la pestaña.
  canvas.width = 0;
  canvas.height = 0;

  return dataUrl;
};

export const extractTextLocally = async (fileOrDoc: File | pdfjs.PDFDocumentProxy, pageIndex: number): Promise<string> => {
  const pdf = fileOrDoc instanceof File ? await loadPdfDocument(fileOrDoc) : fileOrDoc;
  const page = await pdf.getPage(pageIndex + 1);
  const textContent = await page.getTextContent();
  let text = textContent.items.map((item: any) => item.str).join(' ');

  // Si no hay texto (es una imagen/escáner), aplicamos OCR real.
  // Tesseract se importa aquí y no arriba: son ~900 KB que sólo hacen falta
  // con PDF escaneados, y así no lastran la carga inicial de la app.
  if (!text.trim() || text.length < 10) {
    const { default: Tesseract } = await import('tesseract.js');
    const imageUri = await pdfPageToImage(pdf, pageIndex);
    const { data: { text: ocrText } } = await Tesseract.recognize(
      imageUri,
      'spa',
      { logger: (m: unknown) => console.log(m) }
    );
    text = ocrText;
  }

  return text;
};
