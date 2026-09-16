import React, { useCallback, useEffect, useState } from 'react';
import {
  ACTIVE_STATUSES,
  ApiError,
  type ApiClientRecord,
  type ApiDocument,
  type BatchDetail,
  type ImportResult,
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

const POLL_MS = 2000;

/**
 * Estimación del tiempo que queda, a partir del ritmo real. Con un PDF
 * escaneado de cientos de páginas la espera son minutos, y sin una cifra no hay
 * forma de saber si el proceso avanza o se ha atascado.
 *
 * No devuelve nada hasta tener unas cuantas páginas: con dos o tres, la
 * estimación oscila tanto que engaña más de lo que ayuda.
 */
const tiempoRestante = (batch: BatchDetail): string | null => {
  if (!batch.started_at || batch.pages_done < 5) return null;
  const transcurrido = Date.now() - new Date(batch.started_at).getTime();
  if (transcurrido <= 0) return null;

  const segundos = Math.round(
    (transcurrido / batch.pages_done) * (batch.pages_total - batch.pages_done) / 1000
  );
  if (segundos < 60) return 'menos de un minuto';
  const minutos = Math.round(segundos / 60);
  return minutos === 1 ? '1 minuto' : `${minutos} minutos`;
};

const errorMessage = (err: unknown): string =>
  err instanceof ApiError || err instanceof Error ? err.message : String(err);

/**
 * El trabajo es de un solo uso: empieza al subir el Excel y termina al
 * descargar el ZIP, momento en el que el servidor borra todo. No hay histórico
 * porque no hay nada que guardar.
 */
type Paso = 'clientes' | 'documento' | 'procesando' | 'revision' | 'terminado';

const ServerWorkspace: React.FC<ServerWorkspaceProps> = ({ modeSwitch }) => {
  const [error, setError] = useState<string | null>(null);

  const [clients, setClients] = useState<ApiClientRecord[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const [batchId, setBatchId] = useState<number | null>(null);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyDoc, setBusyDoc] = useState<number | null>(null);
  const [zoom, setZoom] = useState<{ sourceId: number; pageIndex: number } | null>(null);
  const [descargado, setDescargado] = useState(false);
  // Se calcula al recibir cada sondeo, no en el render: Date.now() ahí dentro
  // haría el render impuro.
  const [restante, setRestante] = useState<string | null>(null);

  const refreshClients = useCallback(async () => {
    try {
      setClients(await listClients());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  // Al abrir, se recupera el trabajo en curso si lo hay: quien recargue la
  // página a mitad de un lote no debe perderlo.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [misClientes, misLotes] = await Promise.all([listClients(), listBatches()]);
        if (cancelled) return;
        setClients(misClientes);
        if (misLotes.length > 0) setBatchId(misLotes[0].id);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Sondea mientras el lote siga trabajando. `cancelled` descarta la respuesta
  // en vuelo si el lote cambia o se desmonta.
  useEffect(() => {
    if (batchId === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const data = await getBatch(batchId);
        if (cancelled) return;
        setDetail(data);
        setRestante(tiempoRestante(data));
        setError(null);
        if (ACTIVE_STATUSES.includes(data.status)) timer = setTimeout(tick, POLL_MS);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    };

    void tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [batchId]);

  const paso: Paso = ((): Paso => {
    if (descargado) return 'terminado';
    if (detail?.status === 'completado' || detail?.status === 'fallido') return 'revision';
    if (batchId !== null) return 'procesando';
    if (clients.length > 0) return 'documento';
    return 'clientes';
  })();

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    setImporting(true);
    setImportResult(null);
    try {
      setImportResult(await importClients(files));
      await refreshClients();
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
      const batch = await createBatch(files);
      setDetail(null);
      setBatchId(batch.id);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  /**
   * Toda corrección relee el lote entero en vez de parchear el documento en
   * memoria: partir y unir cambian cuántos documentos hay, y el resumen
   * (pendientes, ambiguos) depende del conjunto.
   */
  const applyCorrection = async (documentId: number, action: () => Promise<unknown>) => {
    if (batchId === null) return;
    setBusyDoc(documentId);
    try {
      await action();
      setDetail(await getBatch(batchId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyDoc(null);
    }
  };

  const canMergeNext = (doc: ApiDocument): boolean => {
    if (!detail) return false;
    const hermanos = detail.documents.filter(d => d.source_file_id === doc.source_file_id);
    return hermanos[hermanos.length - 1]?.id !== doc.id;
  };

  const empezarDeNuevo = () => {
    setBatchId(null);
    setDetail(null);
    setClients([]);
    setImportResult(null);
    setDescargado(false);
    setZoom(null);
  };

  const pendientes = detail?.documents.filter(d => d.client_id === null).length ?? 0;
  const progreso = detail && detail.pages_total > 0
    ? Math.round((detail.pages_done / detail.pages_total) * 100)
    : 0;


  const pasos: { id: Paso; titulo: string }[] = [
    { id: 'clientes', titulo: '1. Clientes' },
    { id: 'documento', titulo: '2. Documentos' },
    { id: 'revision', titulo: '3. Revisar y descargar' }
  ];
  const indiceActual = paso === 'procesando' ? 1 : paso === 'terminado' ? 2
    : pasos.findIndex(p => p.id === paso);

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
        <div className="flex gap-2 items-center">
          {(clients.length > 0 || batchId !== null) && (
            <button
              onClick={empezarDeNuevo}
              className="px-4 py-2 bg-slate-50 border rounded-xl text-[9px] font-black uppercase hover:bg-white transition-all"
            >
              Empezar de nuevo
            </button>
          )}
          {modeSwitch}
        </div>
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

      {/* Los pasos, para que se vea dónde se está y qué falta. */}
      <div className="px-6 pt-4 shrink-0 flex flex-wrap items-center gap-2">
        {pasos.map((p, i) => (
          <React.Fragment key={p.id}>
            {i > 0 && <i className="fas fa-chevron-right text-[8px] text-slate-300"></i>}
            <span className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${
              i === indiceActual ? 'bg-white shadow-md text-red-600'
              : i < indiceActual ? 'text-green-600' : 'text-slate-300'
            }`}>
              {i < indiceActual && <i className="fas fa-check mr-2"></i>}
              {p.titulo}
            </span>
          </React.Fragment>
        ))}
      </div>

      <main className="flex-1 overflow-y-auto p-6 custom-scrollbar">
        <div className="max-w-5xl mx-auto space-y-6">

          <p className="text-[10px] font-bold text-slate-400 bg-white border border-slate-100 rounded-2xl px-5 py-4 leading-relaxed">
            <i className="fas fa-circle-info mr-2 text-slate-300"></i>
            Nada se guarda. Lo que subas vive sólo durante este trabajo y se borra
            del servidor en cuanto descargues el ZIP. Si lo dejas a medias, se
            borra solo al cabo de unas horas.
          </p>

          {paso === 'terminado' ? (
            <div className="bg-white p-12 rounded-[2.5rem] shadow-xl border border-slate-100 text-center space-y-5">
              <div className="w-16 h-16 bg-green-50 text-green-500 rounded-2xl flex items-center justify-center text-3xl mx-auto">
                <i className="fas fa-check-double"></i>
              </div>
              <h2 className="text-xl font-black uppercase tracking-tighter">Trabajo terminado</h2>
              <p className="text-[11px] font-bold text-slate-400 leading-relaxed max-w-md mx-auto">
                El ZIP está en tu carpeta de descargas y el servidor ya no conserva
                nada: ni los PDF, ni los documentos generados, ni la lista de clientes.
              </p>
              <button
                onClick={empezarDeNuevo}
                className="px-8 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-[9px] hover:bg-red-600 transition-all shadow-lg"
              >
                Clasificar otro lote
              </button>
            </div>
          ) : (
            <>
              {/* --- Paso 1: clientes ------------------------------------ */}
              <div className={`bg-white p-8 rounded-[2rem] shadow-sm border transition-all ${paso === 'clientes' ? 'border-red-200' : 'border-slate-100'}`}>
                <div className="flex flex-wrap justify-between items-baseline gap-2 mb-4">
                  <h2 className="text-lg font-black uppercase tracking-tighter">1. Clientes</h2>
                  {clients.length > 0 && (
                    <span className="text-[10px] font-black uppercase tracking-widest text-green-700">
                      <i className="fas fa-check-circle mr-2"></i>{clients.length} cargados
                    </span>
                  )}
                </div>

                {batchId === null && (
                  <label className={`block w-full py-8 border-2 border-dashed rounded-[1.5rem] cursor-pointer text-center transition-all ${importing ? 'opacity-40 pointer-events-none' : 'border-slate-100 hover:bg-indigo-50'}`}>
                    <i className={`fas ${importing ? 'fa-circle-notch fa-spin' : 'fa-file-excel'} text-2xl text-indigo-400`}></i>
                    <span className="block mt-3 text-[11px] font-black text-slate-400 uppercase">
                      {importing ? 'Importando...' : clients.length > 0 ? 'Añadir más Excel' : 'Subir uno o varios Excel'}
                    </span>
                    <input type="file" multiple accept=".xlsx,.xlsm,.xls,.csv" onChange={handleImport} className="hidden" />
                  </label>
                )}

                {importResult && (
                  <div className="space-y-2 pt-4">
                    {importResult.files.map(f => (
                      <div
                        key={f.filename}
                        className={`p-3 rounded-xl text-[10px] font-bold flex flex-wrap items-center gap-x-4 gap-y-1 ${f.error ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}
                      >
                        <span className="font-black">{f.filename}</span>
                        {f.error ? <span>{f.error}</span> : (
                          <>
                            <span>{f.rows_read} filas</span>
                            <span>{f.created} nuevos</span>
                            <span>{f.updated} actualizados</span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* --- Paso 2: documentos ---------------------------------- */}
              {clients.length > 0 && (
                <div className={`bg-white p-8 rounded-[2rem] shadow-sm border transition-all ${paso === 'documento' ? 'border-red-200' : 'border-slate-100'}`}>
                  <h2 className="text-lg font-black uppercase tracking-tighter mb-4">2. Documentos</h2>
                  {batchId === null ? (
                    <label className={`block w-full py-8 border-2 border-dashed rounded-[1.5rem] cursor-pointer text-center transition-all ${uploading ? 'opacity-40 pointer-events-none' : 'border-slate-100 hover:bg-red-50'}`}>
                      <i className={`fas ${uploading ? 'fa-circle-notch fa-spin' : 'fa-file-pdf'} text-2xl text-red-400`}></i>
                      <span className="block mt-3 text-[11px] font-black text-slate-400 uppercase">
                        {uploading ? 'Subiendo...' : 'Subir uno o varios PDF'}
                      </span>
                      <input type="file" multiple accept="application/pdf" onChange={handleUpload} className="hidden" />
                    </label>
                  ) : (
                    <p className="text-[11px] font-bold text-slate-400">
                      {detail?.sources.map(s => s.filename).join(' · ') || '...'}
                      <span className="text-slate-300"> · {detail?.pages_total ?? 0} páginas</span>
                    </p>
                  )}
                </div>
              )}

              {/* --- Procesando ------------------------------------------ */}
              {paso === 'procesando' && (
                <div className="bg-white p-8 rounded-[2rem] shadow-sm border border-slate-100 space-y-3">
                  <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-slate-500">
                    <span><i className="fas fa-circle-notch fa-spin text-red-600 mr-3"></i>Clasificando...</span>
                    <span className="text-slate-400">
                      {detail?.pages_done ?? 0} / {detail?.pages_total ?? 0} páginas
                      {progreso > 0 && <span className="ml-2 text-slate-300">({progreso}%)</span>}
                    </span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="bg-red-600 h-full rounded-full transition-all duration-500" style={{ width: `${progreso}%` }}></div>
                  </div>
                  <p className="text-[9px] font-bold text-slate-300 leading-relaxed">
                    {restante
                      ? `Quedan unos ${restante}. `
                      : 'Un PDF escaneado tarda bastante más, porque hay que pasarle OCR página a página. '}
                    Puedes cerrar la pestaña: el servidor sigue trabajando y al volver
                    lo encuentras donde lo dejaste.
                  </p>
                </div>
              )}

              {/* --- Paso 3: revisión y descarga ------------------------- */}
              {paso === 'revision' && detail && (
                <>
                  {detail.status === 'fallido' ? (
                    <div className="bg-red-50 border-2 border-red-200 p-6 rounded-[2rem] space-y-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-red-600">El lote ha fallado</p>
                      <p className="text-[11px] font-bold text-red-700 leading-relaxed">{detail.error}</p>
                      <button
                        onClick={empezarDeNuevo}
                        className="mt-2 px-6 py-3 bg-red-600 text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-slate-900 transition-all"
                      >
                        Empezar de nuevo
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 space-y-4">
                        <h2 className="text-lg font-black uppercase tracking-tighter">3. Revisar y descargar</h2>

                        <div className="flex flex-wrap items-center gap-3">
                          {Object.entries(detail.summary).map(([key, value]) => (
                            <span key={key} className="text-[9px] font-black uppercase tracking-widest px-3 py-2 rounded-xl bg-slate-50 border border-slate-100 text-slate-600">
                              {key.replace('_', ' ')}: <span className="text-slate-900">{value}</span>
                            </span>
                          ))}
                        </div>

                        {pendientes > 0 && (
                          <p className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-100 rounded-xl p-4 leading-relaxed">
                            <i className="fas fa-triangle-exclamation mr-2"></i>
                            Hay {pendientes} documento{pendientes > 1 ? 's' : ''} sin cliente.
                            Si descargas ahora, {pendientes > 1 ? 'irán' : 'irá'} a la carpeta
                            «Pendiente de asignar». Puedes asignarlos abajo antes de descargar.
                          </p>
                        )}

                        <div className="flex flex-wrap items-center gap-4 pt-1">
                          <a
                            href={batchDownloadUrl(detail.id)}
                            onClick={() => setDescargado(true)}
                            className="px-8 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-[9px] hover:bg-green-600 transition-all shadow-lg flex items-center gap-3"
                          >
                            <i className="fas fa-file-zipper text-base"></i> Descargar ZIP y terminar
                          </a>
                          <p className="text-[9px] font-bold text-slate-400 leading-relaxed flex-1 min-w-[200px]">
                            Al descargar, el servidor borra todo. Revisa antes lo que haga falta.
                          </p>
                        </div>
                      </div>

                      {detail.documents.length > 0 && (
                        <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 space-y-2">
                          <div className="flex flex-wrap justify-between items-baseline gap-2 mb-3">
                            <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                              {detail.documents.length} documentos
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
                              onUpdate={(id, update) => void applyCorrection(id, () => updateDocument(id, update))}
                              onSplit={(id, atPage) => void applyCorrection(id, () => splitDocument(id, atPage))}
                              onMergeNext={id => void applyCorrection(id, () => mergeNextDocument(id))}
                              onZoom={(sourceId, pageIndex) => setZoom({ sourceId, pageIndex })}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
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
