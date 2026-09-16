import { PDFDocument, degrees } from 'pdf-lib';

export interface PageSelection {
  /** Índice 0-based de la página en el PDF original. */
  index: number;
  /** Grados en sentido horario: 0, 90, 180 o 270. */
  rotation: number;
}

// El PDF de origen se parsea una sola vez y se reutiliza para todas las
// facturas: hacerlo dentro del bucle convertía la exportación en O(n²) y con
// unos cientos de bloques tardaba minutos.
export const loadSourcePdf = async (originalPdfBuffer: ArrayBuffer): Promise<PDFDocument> => {
  return await PDFDocument.load(originalPdfBuffer);
};

/** Extrae las páginas indicadas del PDF de origen, en ese orden, a un PDF nuevo. */
export const createMergedPdf = async (sourcePdf: PDFDocument, pages: PageSelection[]): Promise<Uint8Array> => {
  const newPdf = await PDFDocument.create();

  const copiedPages = await newPdf.copyPages(sourcePdf, pages.map(p => p.index));
  copiedPages.forEach((copiedPage, i) => {
    const rotation = pages[i].rotation;
    if (rotation) {
      // setRotation reemplaza la rotación original de la página; se suma para
      // no perder la que ya traía el PDF escaneado.
      copiedPage.setRotation(degrees((copiedPage.getRotation().angle + rotation) % 360));
    }
    newPdf.addPage(copiedPage);
  });

  return await newPdf.save();
};
