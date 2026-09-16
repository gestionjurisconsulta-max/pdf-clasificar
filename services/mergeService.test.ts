import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { createMergedPdf, loadSourcePdf } from './mergeService';

/** PDF de `count` páginas, cada una con un tamaño distinto para poder
 *  identificarlas después por su anchura. */
const buildSourcePdf = async (count: number, rotations: number[] = []): Promise<ArrayBuffer> => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([100 + i, 200]);
    if (rotations[i]) page.setRotation(degrees(rotations[i]));
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const widthsOf = async (bytes: Uint8Array): Promise<number[]> => {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map(p => Math.round(p.getWidth()));
};

const rotationsOf = async (bytes: Uint8Array): Promise<number[]> => {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map(p => p.getRotation().angle);
};

describe('createMergedPdf', () => {
  it('extracts only the requested pages, in the requested order', async () => {
    const source = await loadSourcePdf(await buildSourcePdf(5));
    const merged = await createMergedPdf(source, [
      { index: 3, rotation: 0 },
      { index: 0, rotation: 0 }
    ]);
    expect(await widthsOf(merged)).toEqual([103, 100]);
  });

  it('produces a single-page PDF for a one-page invoice', async () => {
    const source = await loadSourcePdf(await buildSourcePdf(3));
    const merged = await createMergedPdf(source, [{ index: 1, rotation: 0 }]);
    expect(await widthsOf(merged)).toEqual([101]);
  });

  it('applies the rotation the user chose', async () => {
    const source = await loadSourcePdf(await buildSourcePdf(2));
    const merged = await createMergedPdf(source, [
      { index: 0, rotation: 90 },
      { index: 1, rotation: 0 }
    ]);
    expect(await rotationsOf(merged)).toEqual([90, 0]);
  });

  it('adds the user rotation to the page rotation the PDF already had', async () => {
    // Una página escaneada en horizontal ya trae /Rotate 90. Si el usuario la
    // gira otros 90, el resultado son 180: reemplazarla perdería la original.
    const source = await loadSourcePdf(await buildSourcePdf(1, [90]));
    const merged = await createMergedPdf(source, [{ index: 0, rotation: 90 }]);
    expect(await rotationsOf(merged)).toEqual([180]);
  });

  it('keeps the original rotation when the user did not rotate', async () => {
    const source = await loadSourcePdf(await buildSourcePdf(1, [270]));
    const merged = await createMergedPdf(source, [{ index: 0, rotation: 0 }]);
    expect(await rotationsOf(merged)).toEqual([270]);
  });

  it('wraps past 360 degrees', async () => {
    const source = await loadSourcePdf(await buildSourcePdf(1, [270]));
    const merged = await createMergedPdf(source, [{ index: 0, rotation: 180 }]);
    expect(await rotationsOf(merged)).toEqual([90]);
  });

  it('can reuse one parsed source for many invoices', async () => {
    // Es justamente lo que hace el bucle de exportación: parsear el PDF una vez
    // y sacar de él decenas de facturas.
    const source = await loadSourcePdf(await buildSourcePdf(4));
    const first = await createMergedPdf(source, [{ index: 0, rotation: 0 }]);
    const second = await createMergedPdf(source, [{ index: 2, rotation: 0 }]);
    const third = await createMergedPdf(source, [{ index: 1, rotation: 0 }, { index: 3, rotation: 0 }]);

    expect(await widthsOf(first)).toEqual([100]);
    expect(await widthsOf(second)).toEqual([102]);
    expect(await widthsOf(third)).toEqual([101, 103]);
  });
});
