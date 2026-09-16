import React, { useCallback, useEffect, useState } from 'react';
import {
  ACTIVE_STATUSES,
  ApiError,
  type ApiClientRecord,
  type ApiDocument,
  type Batch,
  type BatchDetail,
  type ImportResult,
  type DocumentType,
  batchDownloadUrl,
  createBatch,
  getBatch,
  importClients,
  listBatches,
  listClients,
  mergeNextDocument,
  pageImageUrl,
  splitDocument,
  updateDocument
} from './services/apiClient';
import { APP_VERSION } from './constants';
import DocumentCard from './components/DocumentCard';

interface ServerWorkspaceProps {
  modeSwitch?: React.ReactNode;
}

type Tab = 'clientes' | 'lotes';

const POLL_MS = 2000;

const errorMessage = (err: unknown): string =>
  err instanceof ApiError || err instanceof Error ? err.message : String(err);

const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const STATUS_STYLE: Record<Batch['status'], string> = {
  pendiente: 'bg-slate-100 text-slate-500',
  procesando: 'bg-amber-50 text-amber-700 border border-amber-200',
  completado: 'bg-green-50 text-green-700 border border-green-200',
  fallido: 'bg-red-50 text-red-700 border border-red-200'
};

const ServerWorkspace: React.FC<ServerWorkspaceProps> = ({ modeSwitch }) => {
  const [tab, setTab] = useState<Tab>('clientes');
  const [error, setError] = useState<string | null>(null);

  const [clients, setClients] = useState<ApiClientRecord[]>([]);
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [uploading, setUploading] = useState(false);
  const [batchName, setBatchName] = useState('');
  // Documento sobre el que hay una corrección en vuelo: bloquea su tarjeta para
  // que dos clics seguidos no se pisen.
  const [busyDoc, setBusyDoc] = useState<number | null>(null);
  const [zoom, setZoom] = useState<{ sourceId: number; pageIndex: number } | null>(null);

  const refreshClients = useCallback(async (term: string) => {
    try {
      setClients(await listClients(term));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const refreshBatches = useCallback(async () => {
    try {
      setBatches(await listBatches());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  // Carga inicial de los lotes. Los clientes los trae el efecto de búsqueda,
  // que también se dispara en el primer render con el filtro vacío.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await listBatches();
        if (!cancelled) setBatches(data);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Búsqueda con retardo: sin esto se dispara una petición por cada tecla.
  useEffect(() => {
    const timer = setTimeout(() => { void refreshClients(search); }, 300);
    return () => clearTimeout(timer);
  }, [search, refreshClients]);

  // Mientras el lote seleccionado siga trabajando, se refresca solo. Al cambiar
  // de lote o desmontar, `cancelled` descarta la respuesta que ya venía en
  // camino y se cancela el siguiente sondeo: sin esto, el detalle de un lote
  // podía sobrescribir al del lote que el usuario acaba de elegir.
  useEffect(() => {
    if (selectedId === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const data = await getBatch(selectedId);
        if (cancelled) return;
        setDetail(data);
        setError(null);
        if (ACTIVE_STATUSES.includes(data.status)) {
          timer = setTimeout(tick, POLL_MS);
        } else {
          // Al terminar, la lista de lotes también ha cambiado de estado.
          void refreshBatches();
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    };

    void tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selectedId, refreshBatches]);

  // Se limpia el detalle al cambiar de lote para no enseñar el del anterior
  // mientras llega el nuevo.
  const selectBatch = (id: number) => {
    setSelectedId(id);
    setDetail(null);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    setImporting(true);
    setImportResult(null);
    try {
      const result = await importClients(files);
      setImportResult(result);
      await refreshClients(search);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    setUploading(true);
    try {
      const batch = await createBatch(files, batchName);
      setBatchName('');
      setTab('lotes');
      await refreshBatches();
      selectBatch(batch.id);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  /**
   * Toda corrección acaba releyendo el lote entero en vez de parchear el
   * documento en memoria: partir y unir cambian cuántos documentos hay, y el
   * resumen (pendientes, ambiguos) depende del conjunto. Un lote son unas
   * decenas de documentos, así que releerlo es barato y no deja la pantalla
   * desincronizada del servidor.
   */
  const applyCorrection = async (documentId: number, action: () => Promise<unknown>) => {
    if (selectedId === null) return;
    setBusyDoc(documentId);
    try {
      await action();
      setDetail(await getBatch(selectedId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyDoc(null);
    }
  };

  const handleUpdateDoc = (
    id: number,
    update: { client_id?: number; doc_type?: DocumentType; clear_client?: boolean }
  ) => void applyCorrection(id, () => updateDocument(id, update));

  const handleSplit = (id: number, atPage: number) =>
    void applyCorrection(id, () => splitDocument(id, atPage));

  const handleMergeNext = (id: number) =>
    void applyCorrection(id, () => mergeNextDocument(id));

  const progress = detail && detail.pages_total > 0
    ? Math.round((detail.pages_done / detail.pages_total) * 100)
    : 0;

  // Sólo se puede unir con el siguiente si hay otro documento después dentro
  // del MISMO PDF de origen.
  const canMergeNext = (doc: ApiDocument): boolean => {
    if (!detail) return false;
    const hermanos = detail.documents.filter(d => d.source_file_id === doc.source_file_id);
    return hermanos[hermanos.length - 1]?.id !== doc.id;
  };

  return (
    <div className="min-h-screen bg-[#f1f5f9] flex flex-col h-screen overflow-hidden text-slate-900">
      <header className="bg-white border-b px-6 py-3 flex flex-col sm:flex-row justify-between items-center z-50 shadow-sm shrink-0 gap-3">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-slate-900 rounded-xl flex items-center justify-center text-white shadow-lg rotate-2">
            <i className="fas fa-server text-lg"></i>
          </div>
          <div>
            <h1 className="text-lg font-black tracking-tighter uppercase leading-none">
              Pdf<span className="text-red-600">Clasificar</span>
            </h1>
            <p className="text-[8px] text-slate-400 font-black uppercase tracking-widest mt-0.5">
              v{APP_VERSION} · Servidor
            </p>
          </div>
        </div>
        <div className="flex gap-2 items-center">{modeSwitch}</div>
      </header>

      {error && (
        <div className="bg-red-50 border-b-2 border-red-200 px-6 py-3 flex items-center gap-3 shrink-0">
          <i className="fas fa-triangle-exclamation text-red-600"></i>
          <p className="text-[11px] font-bold text-red-700 flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-700">
            <i className="fas fa-times"></i>
          </button>
        </div>
      )}

      <div className="px-6 pt-4 shrink-0">
        <div className="inline-flex gap-1 bg-slate-200/70 p-1.5 rounded-2xl">
          {(['clientes', 'lotes'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-6 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${tab === t ? 'bg-white shadow-md text-red-600' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {t === 'clientes' ? `Clientes (${clients.length})` : `Lotes (${batches.length})`}
            </button>
          ))}
        </div>
      </div>

      <main className="flex-1 overflow-y-auto p-6 custom-scrollbar">
        {tab === 'clientes' && (
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="bg-white p-8 rounded-[2rem] shadow-sm border border-slate-100 space-y-4">
              <h2 className="text-lg font-black uppercase tracking-tighter">Base de clientes</h2>
              <p className="text-[11px] font-bold text-slate-400 leading-relaxed">
                Puedes subir varios Excel a la vez. Se fusionan por el CIF, así que un
                cliente que aparezca en dos ficheros no se duplica: se actualiza.
              </p>
              <label className={`block w-full py-8 border-2 border-dashed rounded-[1.5rem] cursor-pointer text-center transition-all ${importing ? 'opacity-40 pointer-events-none' : 'border-slate-100 hover:bg-indigo-50'}`}>
                <i className={`fas ${importing ? 'fa-circle-notch fa-spin' : 'fa-file-excel'} text-2xl text-indigo-400`}></i>
                <span className="block mt-3 text-[11px] font-black text-slate-400 uppercase">
                  {importing ? 'Importando...' : 'Subir uno o varios Excel'}
                </span>
                <input type="file" multiple accept=".xlsx,.xlsm,.xls,.csv" onChange={handleImport} className="hidden" />
              </label>

              {importResult && (
                <div className="space-y-2 pt-2">
                  {importResult.files.map(f => (
                    <div
                      key={f.filename}
                      className={`p-4 rounded-2xl text-[10px] font-bold flex flex-wrap items-center gap-x-4 gap-y-1 ${f.error ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}
                    >
                      <span className="font-black">{f.filename}</span>
                      {f.error ? <span>{f.error}</span> : (
                        <>
                          <span>{f.rows_read} filas leídas</span>
                          <span>{f.created} nuevos</span>
                          <span>{f.updated} actualizados</span>
                        </>
                      )}
                    </div>
                  ))}
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 pt-1">
                    Total en la base: {importResult.total_clients} clientes
                  </p>
                </div>
              )}
            </div>

            <div className="bg-white p-8 rounded-[2rem] shadow-sm border border-slate-100 space-y-4">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar por nombre o CIF..."
                className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-bold text-sm focus:border-red-500 outline-none"
              />
              {clients.length === 0 ? (
                <p className="text-[11px] font-bold text-slate-300 text-center py-8 uppercase tracking-widest">
                  {search ? 'Ningún cliente coincide' : 'Todavía no hay clientes: sube un Excel'}
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {clients.map(c => (
                    <div key={c.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <p className="text-[11px] font-black truncate" title={c.name}>{c.name}</p>
                      <p className="text-[10px] font-bold text-slate-400 font-mono">{c.cif}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'lotes' && (
          <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
            <div className="space-y-4">
              <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 space-y-3">
                <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Nuevo lote</h2>
                <input
                  type="text"
                  value={batchName}
                  onChange={e => setBatchName(e.target.value)}
                  placeholder="Nombre (opcional)"
                  className="w-full p-3 bg-slate-50 border-2 border-slate-100 rounded-xl font-bold text-[11px] focus:border-red-500 outline-none"
                />
                <label className={`block w-full py-6 border-2 border-dashed rounded-[1.5rem] cursor-pointer text-center transition-all ${uploading || clients.length === 0 ? 'opacity-40 pointer-events-none' : 'border-slate-100 hover:bg-red-50'}`}>
                  <i className={`fas ${uploading ? 'fa-circle-notch fa-spin' : 'fa-file-pdf'} text-xl text-red-400`}></i>
                  <span className="block mt-2 text-[10px] font-black text-slate-400 uppercase">
                    {uploading ? 'Subiendo...' : 'Subir uno o varios PDF'}
                  </span>
                  <input type="file" multiple accept="application/pdf" onChange={handleUpload} className="hidden" />
                </label>
                {clients.length === 0 && (
                  <p className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-100 rounded-xl p-3 leading-relaxed">
                    Sube primero el Excel de clientes: sin él, todo acabaría en pendientes.
                  </p>
                )}
              </div>

              <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 space-y-2">
                <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Histórico</h2>
                {batches.length === 0 && (
                  <p className="text-[10px] font-bold text-slate-300 text-center py-4 uppercase">Sin lotes todavía</p>
                )}
                {batches.map(b => (
                  <button
                    key={b.id}
                    onClick={() => selectBatch(b.id)}
                    className={`w-full text-left p-4 rounded-2xl border-2 transition-all ${selectedId === b.id ? 'border-red-500 bg-red-50/40' : 'border-transparent bg-slate-50 hover:border-slate-200'}`}
                  >
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-[10px] font-black truncate">{b.name}</span>
                      <span className={`text-[8px] font-black uppercase px-2 py-1 rounded-full shrink-0 ${STATUS_STYLE[b.status]}`}>
                        {b.status}
                      </span>
                    </div>
                    <p className="text-[9px] font-bold text-slate-400 mt-1">
                      {b.sources.length} PDF · {b.pages_total} págs · {formatDate(b.created_at)}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              {!detail ? (
                <div className="bg-white p-12 rounded-[2rem] shadow-sm border border-slate-100 text-center">
                  <i className="fas fa-arrow-left text-slate-200 text-2xl"></i>
                  <p className="text-[11px] font-black text-slate-300 uppercase tracking-widest mt-4">
                    Elige un lote para ver el detalle
                  </p>
                </div>
              ) : (
                <>
                  <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 space-y-4">
                    <div className="flex flex-wrap justify-between items-center gap-3">
                      <div>
                        <h2 className="text-lg font-black uppercase tracking-tighter">{detail.name}</h2>
                        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                          {detail.sources.map(s => s.filename).join(' · ')}
                        </p>
                      </div>
                      <span className={`text-[9px] font-black uppercase px-4 py-2 rounded-full ${STATUS_STYLE[detail.status]}`}>
                        {ACTIVE_STATUSES.includes(detail.status) && <i className="fas fa-circle-notch fa-spin mr-2"></i>}
                        {detail.status}
                      </span>
                    </div>

                    {ACTIVE_STATUSES.includes(detail.status) && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-[9px] font-black uppercase tracking-widest text-slate-400">
                          <span>Procesando</span>
                          <span>{detail.pages_done} / {detail.pages_total} páginas</span>
                        </div>
                        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className="bg-red-600 h-full rounded-full transition-all duration-500" style={{ width: `${progress}%` }}></div>
                        </div>
                      </div>
                    )}

                    {detail.status === 'fallido' && (
                      <div className="bg-red-50 border-2 border-red-100 p-4 rounded-2xl">
                        <p className="text-[10px] font-black uppercase tracking-widest text-red-600 mb-1">El lote ha fallado</p>
                        <p className="text-[11px] font-bold text-red-700 leading-relaxed">{detail.error}</p>
                      </div>
                    )}

                    {detail.status === 'completado' && (
                      <div className="flex flex-wrap items-center gap-3 pt-1">
                        {Object.entries(detail.summary).map(([key, value]) => (
                          <span key={key} className="text-[9px] font-black uppercase tracking-widest px-3 py-2 rounded-xl bg-slate-50 border border-slate-100 text-slate-600">
                            {key.replace('_', ' ')}: <span className="text-slate-900">{value}</span>
                          </span>
                        ))}
                        <a
                          href={batchDownloadUrl(detail.id)}
                          className="ml-auto px-6 py-3 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-[9px] hover:bg-green-600 transition-all shadow-lg flex items-center gap-3"
                        >
                          <i className="fas fa-file-zipper"></i> Descargar ZIP
                        </a>
                      </div>
                    )}
                  </div>

                  {detail.documents.length > 0 && (
                    <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 space-y-2">
                      <div className="flex flex-wrap justify-between items-baseline gap-2 mb-3">
                        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                          {detail.documents.length} documentos detectados
                        </h3>
                        <p className="text-[9px] font-bold text-slate-400">
                          Pulsa el número de páginas para verlas y corregir el troceado.
                        </p>
                      </div>
                      {detail.documents.map(doc => (
                        <DocumentCard
                          key={doc.id}
                          document={doc}
                          clients={clients}
                          canMergeNext={canMergeNext(doc)}
                          busy={busyDoc === doc.id}
                          onUpdate={handleUpdateDoc}
                          onSplit={handleSplit}
                          onMergeNext={handleMergeNext}
                          onZoom={(sourceId, pageIndex) => setZoom({ sourceId, pageIndex })}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {zoom && (
        <div
          className="fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setZoom(null)}
        >
          <div className="relative max-h-full" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setZoom(null)}
              className="absolute -top-3 -right-3 w-9 h-9 bg-white rounded-full shadow-xl text-slate-400 hover:text-red-600 z-10"
            >
              <i className="fas fa-times"></i>
            </button>
            {/* El backend rasteriza a más resolución cuando se pide con zoom. */}
            <img
              src={pageImageUrl(zoom.sourceId, zoom.pageIndex, true)}
              alt={`Página ${zoom.pageIndex + 1}`}
              className="max-h-[92vh] w-auto rounded-xl shadow-2xl bg-white"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ServerWorkspace;
