/**
 * Cliente de la API de Python.
 *
 * Las rutas son relativas: en producción nginx sirve la SPA y hace de proxy de
 * `/api`, y en desarrollo lo hace Vite (ver `server.proxy` en vite.config.ts).
 * Así no hay ninguna URL de servidor escrita en el código ni en el build.
 */

export type DocumentType = 'factura' | 'albaran' | 'desconocido';
export type BatchStatus = 'pendiente' | 'procesando' | 'completado' | 'fallido';

/** Estados en los que todavía queda trabajo por hacer en el servidor. */
export const ACTIVE_STATUSES: readonly BatchStatus[] = ['pendiente', 'procesando'];

export interface ApiClientRecord {
  id: number;
  cif: string;
  name: string;
  created_at: string;
}

export interface ImportFileResult {
  filename: string;
  rows_read: number;
  created: number;
  updated: number;
  error: string | null;
}

export interface ImportResult {
  files: ImportFileResult[];
  total_clients: number;
}

export interface SourceFile {
  id: number;
  filename: string;
  page_count: number;
}

export interface ApiDocument {
  id: number;
  /** PDF del que salió: hace falta para pedir las miniaturas de sus páginas. */
  source_file_id: number;
  doc_type: DocumentType;
  number: string;
  page_indices: number[];
  ambiguous: boolean;
  candidates: string[];
  notes: string[];
  client_id: number | null;
  client_name: string | null;
}

export interface Batch {
  id: number;
  name: string;
  status: BatchStatus;
  pages_total: number;
  pages_done: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  sources: SourceFile[];
}

export interface BatchDetail extends Batch {
  documents: ApiDocument[];
  summary: Record<string, number>;
}

export interface Health {
  status: string;
  database: string;
}

/** Error con el mensaje que devuelve la API, no un "500" pelado. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

const readErrorMessage = async (response: Response): Promise<string> => {
  // FastAPI devuelve {"detail": "..."} y, en los errores de validación, una
  // lista de objetos. Se intenta sacar algo legible de ambos.
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const first = detail[0];
      if (typeof first?.msg === 'string') return first.msg;
    }
  } catch {
    // Respuesta sin JSON (un 502 de nginx, por ejemplo).
  }
  return `El servidor ha respondido ${response.status}.`;
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    // fetch sólo rechaza cuando no se llega al servidor; un 500 resuelve.
    throw new ApiError('No se ha podido contactar con el servidor. ¿Está levantado?', 0);
  }

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }
  return response.json() as Promise<T>;
};

export const getHealth = (): Promise<Health> => request<Health>('/api/health');

export const listClients = (search = ''): Promise<ApiClientRecord[]> => {
  const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  return request<ApiClientRecord[]>(`/api/clients${query}`);
};

export const importClients = (files: File[]): Promise<ImportResult> => {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  return request<ImportResult>('/api/clients/import', { method: 'POST', body });
};

export const listBatches = (): Promise<Batch[]> => request<Batch[]>('/api/batches');

export const createBatch = (files: File[], name?: string): Promise<Batch> => {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  const query = name?.trim() ? `?name=${encodeURIComponent(name.trim())}` : '';
  return request<Batch>(`/api/batches${query}`, { method: 'POST', body });
};

export const getBatch = (id: number): Promise<BatchDetail> =>
  request<BatchDetail>(`/api/batches/${id}`);

/** El navegador descarga el ZIP directamente de esta URL. */
export const batchDownloadUrl = (id: number): string => `/api/batches/${id}/download`;

/** La imagen de una página del PDF original. La sirve el backend y la cachea
 *  el navegador: una página ya subida no cambia nunca. */
export const pageImageUrl = (sourceId: number, pageIndex: number, zoom = false): string =>
  `/api/sources/${sourceId}/pages/${pageIndex}/image${zoom ? '?zoom=true' : ''}`;

export interface DocumentUpdate {
  client_id?: number;
  doc_type?: DocumentType;
  number?: string;
  /** Dejar el documento sin cliente. Es distinto de no tocar el campo. */
  clear_client?: boolean;
}

export const updateDocument = (id: number, update: DocumentUpdate): Promise<ApiDocument> =>
  request<ApiDocument>(`/api/documents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update)
  });

/** Parte el documento en dos: `atPage` (índice en el PDF original) abre el nuevo. */
export const splitDocument = (id: number, atPage: number): Promise<ApiDocument[]> =>
  request<ApiDocument[]>(`/api/documents/${id}/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ at_page: atPage })
  });

/** Absorbe el documento siguiente del mismo PDF. */
export const mergeNextDocument = (id: number): Promise<ApiDocument> =>
  request<ApiDocument>(`/api/documents/${id}/merge-next`, { method: 'POST' });
