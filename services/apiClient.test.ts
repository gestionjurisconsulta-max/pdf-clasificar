import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  batchDownloadUrl,
  createBatch,
  getBatch,
  importClients,
  listClients
} from './apiClient';

const mockFetch = (impl: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('listClients', () => {
  it('pide la lista sin filtro', async () => {
    const fetchSpy = mockFetch(() => json([{ id: 1, cif: 'B12345678', name: 'Uno', created_at: '' }]));
    const clients = await listClients();
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/clients');
    expect(clients).toHaveLength(1);
  });

  it('escapa el texto de búsqueda', async () => {
    const fetchSpy = mockFetch(() => json([]));
    await listClients('  aceros & co  ');
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/clients?search=aceros%20%26%20co');
  });

  it('no manda el parámetro si la búsqueda está vacía', async () => {
    const fetchSpy = mockFetch(() => json([]));
    await listClients('   ');
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/clients');
  });
});

describe('importClients', () => {
  it('manda todos los ficheros en el mismo campo "files"', async () => {
    const fetchSpy = mockFetch(() => json({ files: [], total_clients: 0 }));
    await importClients([
      new File(['a'], 'uno.xlsx'),
      new File(['b'], 'dos.xlsx')
    ]);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/clients/import');
    expect(init.method).toBe('POST');
    const names = (init.body as FormData).getAll('files').map(f => (f as File).name);
    expect(names).toEqual(['uno.xlsx', 'dos.xlsx']);
  });
});

describe('createBatch', () => {
  it('manda los PDF y el nombre del lote', async () => {
    const fetchSpy = mockFetch(() => json({ id: 7 }, 202));
    await createBatch([new File(['x'], 'lote.pdf')], 'Marzo 2026');
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/batches?name=Marzo%202026');
  });

  it('omite el nombre si no se da', async () => {
    const fetchSpy = mockFetch(() => json({ id: 7 }, 202));
    await createBatch([new File(['x'], 'lote.pdf')]);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/batches');
  });
});

describe('manejo de errores', () => {
  it('usa el mensaje "detail" que devuelve FastAPI', async () => {
    mockFetch(() => json({ detail: 'Hay que subir al menos un PDF.' }, 400));
    await expect(getBatch(1)).rejects.toThrow('Hay que subir al menos un PDF.');
  });

  it('entiende los errores de validación, que vienen como lista', async () => {
    mockFetch(() => json({ detail: [{ msg: 'campo obligatorio' }] }, 422));
    await expect(getBatch(1)).rejects.toThrow('campo obligatorio');
  });

  it('cae a un mensaje con el código si la respuesta no es JSON', async () => {
    mockFetch(() => new Response('<html>502</html>', { status: 502 }));
    await expect(getBatch(1)).rejects.toThrow('El servidor ha respondido 502.');
  });

  it('distingue el servidor caído de un error del servidor', async () => {
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    await expect(getBatch(1)).rejects.toThrow('No se ha podido contactar con el servidor');
  });

  it('conserva el código de estado en el error', async () => {
    mockFetch(() => json({ detail: 'no existe' }, 404));
    await expect(getBatch(9)).rejects.toMatchObject({ status: 404 });
    await expect(getBatch(9)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('batchDownloadUrl', () => {
  it('apunta al endpoint de descarga del lote', () => {
    expect(batchDownloadUrl(12)).toBe('/api/batches/12/download');
  });
});
