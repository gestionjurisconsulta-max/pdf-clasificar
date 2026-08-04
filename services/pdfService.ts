
import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import Tesseract from 'tesseract.js';

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

export const pdfPageToImage = async (fileOrDoc: File | pdfjs.PDFDocumentProxy, pageIndex: number): Promise<string> => {
  let pdf: pdfjs.PDFDocumentProxy;
  if (fileOrDoc instanceof File) {
    pdf = await loadPdfDocument(fileOrDoc);
  } else {
    pdf = fileOrDoc;
  }
  const page = await pdf.getPage(pageIndex + 1);
  
  const viewport = page.getViewport({ scale: 1.5 });
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

  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl;
};

export const extractTextLocally = async (fileOrDoc: File | pdfjs.PDFDocumentProxy, pageIndex: number): Promise<string> => {
  const pdf = fileOrDoc instanceof File ? await loadPdfDocument(fileOrDoc) : fileOrDoc;
  const page = await pdf.getPage(pageIndex + 1);
  const textContent = await page.getTextContent();
  let text = textContent.items.map((item: any) => item.str).join(' ');

  // Si no hay texto (es una imagen/escáner), aplicamos OCR real
  if (!text.trim() || text.length < 10) {
    const imageUri = await pdfPageToImage(pdf, pageIndex);
    const { data: { text: ocrText } } = await Tesseract.recognize(
      imageUri,
      'spa',
      { logger: m => console.log(m) }
    );
    text = ocrText;
  }
  
  return text;
};

export const createMergedPdf = async (originalPdfBuffer: ArrayBuffer, pages: { index: number; rotation: number }[]): Promise<Uint8Array> => {
  const sourcePdf = await PDFDocument.load(originalPdfBuffer);
  const newPdf = await PDFDocument.create();
  
  for (const p of pages) {
    const [copiedPage] = await newPdf.copyPages(sourcePdf, [p.index]);
    if (p.rotation) {
      copiedPage.setRotation(degrees(p.rotation));
    }
    newPdf.addPage(copiedPage);
  }
  
  return await newPdf.save();
};
