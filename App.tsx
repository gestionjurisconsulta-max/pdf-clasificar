
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { parseExcelDatabase } from './services/excelService';
import { getPageCount, pdfPageToImage, extractTextLocally, createMergedPdf, loadPdfDocument } from './services/pdfService';
import { analyzeInvoicePage } from './services/geminiService';
import { canonicalForm, findMatchingCompany } from './services/matchingService';
import { Company, InvoicePageData, ProcessedInvoice, ProcessingStep, LearningData } from './types';
import JSZip from 'jszip';

const PENDING_FOLDER = "Pendiente de asignar";

// Sanea nombres de carpeta/archivo: quita caracteres inválidos en Windows/URL
// y recorta puntos/espacios en los extremos (evita nombres como ".", ".." o
// con espacios finales, que Windows trata de forma especial o rechaza).
const sanitizeName = (name: string): string => {
  const cleaned = name.replace(/[/\\?%*:|"<>]/g, '-').trim().replace(/^\.+|[\.\s]+$/g, '');
  return cleaned || 'Sin nombre';
};

// Convierte un cuelgue silencioso en un error visible.
const withTimeout = <T,>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
};

const App: React.FC = () => {
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [learningFile, setLearningFile] = useState<File | null>(null);
  const [dirHandle, setDirHandle] = useState<any | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [learning, setLearning] = useState<LearningData>({ 
    cifMappings: {}, 
    patterns: { 
      invoiceRegex: '(?:Factura|Nº|Num|ALBARÁN|ALBARAN|FACT|INV|Fact\\.)[:\\s]*([A-Z0-9\\-/\\.]+)', 
      cifRegex: '([ABCDEFGHJNPQRSUVW][0-9\\s\\.\\-]{7,8}[0-9A-J]|[0-9]{8}[A-Z])' 
    } 
  });

  const [step, setStep] = useState<ProcessingStep>(ProcessingStep.IDLE);
  const [pages, setPages] = useState<(InvoicePageData & { thumb: string; index: number })[]>([]);
  const [useAI, setUseAI] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [detailedLogs, setDetailedLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [isGeneratingThumbs, setIsGeneratingThumbs] = useState(false);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const [finalZipUrl, setFinalZipUrl] = useState<string | null>(null);
  const [companyStatus, setCompanyStatus] = useState<Record<string, boolean>>({});
  
  const [zoomPage, setZoomPage] = useState<{ thumb: string; index: number; rotation: number } | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showLogs, setShowLogs] = useState(true);
  const [showFolders, setShowFolders] = useState(true);

  const stopProcessingRef = useRef(false);
  const stopProcessing = useCallback(() => { stopProcessingRef.current = true; }, []);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const addLog = useCallback((msg: string, detail: boolean = false) => {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${msg}`;
    if (!detail) { setLogs(prev => [...prev.slice(-200), formatted]); }
    setDetailedLogs(prev => [...prev, formatted]);
  }, []);

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const db = await parseExcelDatabase(file);
      setCompanies(db);
      setExcelFile(file);
      addLog(`Base de datos cargada: ${db.length} empresas encontradas.`);
    }
  };

  const handleLearningUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        setLearning(prev => ({ ...prev, ...data }));
        setLearningFile(file);
        addLog(`Memoria de aprendizaje cargada.`);
      } catch (err) { addLog("Error cargando el archivo JSON."); }
    }
  };

  const downloadLearningData = () => {
    const blob = new Blob([JSON.stringify(learning, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `aprendizaje_facturas.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const downloadDetailedLogs = () => {
    const blob = new Blob([detailedLogs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `log_completo_v13.txt`;
    a.click(); URL.revokeObjectURL(url);
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPdfFile(file);
      setStep(ProcessingStep.PREVIEW);
      setIsGeneratingThumbs(true);
      setThumbError(null);
      setPages([]);
      addLog("Generando miniaturas del PDF...");
      try {
        // Si el worker de pdf.js no se puede cargar (p.ej. un servidor estático
        // que devuelve el .mjs como text/plain), getDocument() no resuelve ni
        // rechaza nunca. Sin este límite la pantalla se quedaría en blanco.
        const pdfDoc = await withTimeout(
          loadPdfDocument(file),
          60000,
          "El motor PDF no responde. Suele deberse a que el servidor no sirve el worker de pdf.js con el tipo MIME correcto: abre la app con 'npm run dev' o 'npm run preview'."
        );
        const count = pdfDoc.numPages;
        setProgress({ current: 0, total: count });
        const newPages: any[] = [];
        for (let i = 0; i < count; i++) {
          const thumb = await pdfPageToImage(pdfDoc, i);
          newPages.push({ index: i, thumb, rotation: 0, manualReference: '', invoiceNumber: '', cif: '', isContinuation: false });
          if (i % 5 === 0 || i === count - 1) setPages([...newPages]);
          setProgress(p => ({ ...p, current: i + 1 }));
        }
        setIsGeneratingThumbs(false);
        addLog(`${count} páginas listas.`);
      } catch (err: any) {
        const msg = err?.message || String(err);
        addLog(`Error al generar miniaturas: ${msg}`);
        setThumbError(msg);
        setIsGeneratingThumbs(false);
      }
    }
  };

  const enableAI = () => {
    if (useAI) return;
    const confirmed = window.confirm(
      "Al activar el motor AI GEMINI, la imagen de cada página analizada se enviará a los servidores de Google (API Gemini) para su procesamiento.\n\n¿Confirmas que puedes enviar estos documentos a un tercero?"
    );
    if (confirmed) {
      setUseAI(true);
      addLog("Motor cambiado a AI GEMINI. Las páginas se enviarán a Google para su análisis.");
    }
  };

  const rotatePage = (idx: number) => setPages(prev => prev.map(p => p.index === idx ? { ...p, rotation: ((p.rotation || 0) + 90) % 360 } : p));
  const deletePage = (idx: number) => {
    setPages(prev => prev.filter(p => p.index !== idx));
    addLog(`Página #${idx + 1} eliminada.`);
  };
  const deleteSelectedPages = () => {
    const selectedCount = pages.filter(p => p.isSelected).length;
    if (selectedCount === 0) return;
    setPages(prev => prev.filter(p => !p.isSelected));
    addLog(`${selectedCount} páginas eliminadas.`);
  };
  const toggleSelect = (idx: number) => setPages(prev => prev.map(p => p.index === idx ? { ...p, isSelected: !p.isSelected } : p));
  const updateManualReference = (idx: number, val: string) => setPages(prev => prev.map(p => p.index === idx ? { ...p, manualReference: val } : p));
  
  const groupSelected = () => {
    const selected = pages.filter(p => p.isSelected);
    if (selected.length < 2) return;
    const gId = `grupo-${Date.now()}`;
    setPages(prev => prev.map(p => p.isSelected ? { ...p, groupId: gId, isSelected: false } : p));
    addLog(`Vinculadas ${selected.length} páginas.`);
  };

  const ungroupAll = () => setPages(prev => prev.map(p => ({ ...p, groupId: '', manualReference: '' })));
  const selectDirectory = async () => { try { const handle = await (window as any).showDirectoryPicker(); setDirHandle(handle); addLog(`Carpeta conectada: ${handle.name}`); } catch { addLog("Guardado directo desactivado."); } };

  const processAndDivide = async () => {
    if (!pdfFile || companies.length === 0) return alert("Sube el Excel primero.");
    stopProcessingRef.current = false;
    setStep(ProcessingStep.PROCESSING);
    setLogs([]);
    setDetailedLogs([]);
    addLog("--- INICIANDO PROCESO v13.0 ULTRA PRECISION ---");
    
    const pdfBuffer = await pdfFile.arrayBuffer();
    const pdfDoc = await loadPdfDocument(pdfFile);
    const processedIndices = new Set<number>();
    const batches: any[][] = [];

    const uniqueGroups = Array.from(new Set(pages.filter(p => p.groupId).map(p => p.groupId)));
    uniqueGroups.forEach(gid => {
      const group = pages.filter(p => p.groupId === gid).sort((a, b) => a.index - b.index);
      batches.push(group);
      group.forEach(p => processedIndices.add(p.index));
    });

    const uniqueRefs = Array.from(new Set(pages.filter(p => !processedIndices.has(p.index) && p.manualReference?.trim()).map(p => p.manualReference?.trim())));
    uniqueRefs.forEach(ref => {
      const group = pages.filter(p => !processedIndices.has(p.index) && p.manualReference?.trim() === ref).sort((a, b) => a.index - b.index);
      if (group.length) { batches.push(group); group.forEach(p => processedIndices.add(p.index)); }
    });

    pages.filter(p => !processedIndices.has(p.index)).forEach(p => { batches.push([p]); processedIndices.add(p.index); });

    setProgress({ current: 0, total: batches.length });
    const results: ProcessedInvoice[] = [];
    const status: Record<string, boolean> = {};
    companies.forEach(c => status[c.name] = false);

    for (let i = 0; i < batches.length; i++) {
      if (stopProcessingRef.current) break;
      const batch = batches[i];
      const firstPage = batch[0];
      let matchedCompany: Company | null = null;
      let invoiceNumber = "";
      let matchInfo = "BUSCANDO...";

      // Log inicial temporal
      addLog(`Analizando Bloque ${i + 1}/${batches.length} (Pág: ${firstPage.index + 1})... ${matchInfo}`);
      
      try {
        if (useAI) {
          const aiData = await analyzeInvoicePage(firstPage.thumb);
          matchedCompany = companies.find(c => canonicalForm(c.cif) === canonicalForm(aiData.cif)) || null;
          invoiceNumber = aiData.invoiceNumber;
          addLog(`>>> AI Detectó CIF: ${aiData.cif} | Factura: ${aiData.invoiceNumber}`, true);
        } else {
          const text = await extractTextLocally(pdfDoc, firstPage.index);

          addLog(`TEXTO EXTRAÍDO PÁG ${firstPage.index + 1}:`, true);
          addLog(text.substring(0, 500) + "...", true);

          const { company, ambiguous, candidates } = findMatchingCompany(text, companies, learning.cifMappings);
          if (ambiguous) {
            addLog(`>>> AMBIGUO: coinciden varias empresas (${candidates.map(c => c.name).join(', ')}). Se deja como pendiente.`, true);
          } else if (company) {
            addLog(`>>> MATCH ENCONTRADO: ${company.name} (CIF: ${company.cif})`, true);
          }
          matchedCompany = company;

          const invMatch = text.match(new RegExp(learning.patterns.invoiceRegex, 'i'));
          invoiceNumber = invMatch ? (invMatch[1] || invMatch[0]) : "";
        }
      } catch (e: any) { addLog(`Error en análisis: ${e.message}`); }

      const companyName = matchedCompany ? matchedCompany.name : PENDING_FOLDER;
      const finalInvNum = firstPage.manualReference?.trim() || invoiceNumber || "S-N";
      
      // Actualizar el log principal con el resultado
      matchInfo = matchedCompany ? `MATCH ENCONTRADO: ${matchedCompany.name} (CIF: ${matchedCompany.cif})` : "SIN COINCIDENCIA (Pendiente)";
      setLogs(prev => {
        const last = prev[prev.length - 1];
        if (last && last.includes(`Bloque ${i + 1}/`)) {
          const updated = last.replace("BUSCANDO...", matchInfo);
          return [...prev.slice(0, -1), updated];
        }
        return prev;
      });

      status[companyName] = true;
      results.push({
        invoiceNumber: finalInvNum,
        companyName,
        cif: matchedCompany?.cif || "",
        pages: batch.map(p => ({ index: p.index, rotation: p.rotation || 0 }))
      });
      setProgress(p => ({ ...p, current: i + 1 }));
    }

    setCompanyStatus(status);
    addLog("Guardando archivos finales...");
    const zip = dirHandle ? null : new JSZip();

    for (const comp of companies) {
      const fn = sanitizeName(comp.name);
      if (dirHandle) await dirHandle.getDirectoryHandle(fn, { create: true });
      else zip?.folder(fn);
    }
    if (dirHandle) await dirHandle.getDirectoryHandle(PENDING_FOLDER, { create: true });
    else zip?.folder(PENDING_FOLDER);

    for (const inv of results) {
      const bytes = await createMergedPdf(pdfBuffer, inv.pages);
      const folderName = sanitizeName(inv.companyName);
      const safeInv = sanitizeName(inv.invoiceNumber);
      const fileName = `PAG_${String(inv.pages[0].index + 1).padStart(3, '0')}_Fact_${safeInv}.pdf`;
      
      if (dirHandle) {
        const folder = await dirHandle.getDirectoryHandle(folderName, { create: true });
        const file = await folder.getFileHandle(fileName, { create: true });
        const writer = await file.createWritable();
        await writer.write(bytes);
        await writer.close();
      } else {
        zip?.folder(folderName)?.file(fileName, bytes);
      }
    }

    if (zip) setFinalZipUrl(URL.createObjectURL(await zip.generateAsync({ type: 'blob' })));
    setStep(ProcessingStep.COMPLETED);
    addLog("--- PROCESO FINALIZADO CON ÉXITO ---");
  };

  const closeZoom = () => { setZoomPage(null); setZoomLevel(1); };

  return (
    <div className="min-h-screen bg-[#f1f5f9] flex flex-col h-screen overflow-hidden text-slate-900">
      
      {/* VISOR ZOOM - RESPONSIVO */}
      {zoomPage && (
        <div className="fixed inset-0 z-[100] bg-slate-950/90 flex items-center justify-center p-2 md:p-6 backdrop-blur-md" onClick={closeZoom}>
          <div className="bg-white rounded-[2rem] flex flex-col md:flex-row w-full max-w-7xl h-full md:h-[94vh] overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex-1 bg-slate-200 relative flex flex-col overflow-hidden">
              <div className="bg-white/90 border-b p-3 flex justify-between items-center z-10 shrink-0">
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Hoja Original</span>
                <div className="flex items-center gap-2 bg-white p-1 rounded-xl border">
                  <button onClick={() => setZoomLevel(prev => Math.max(0.5, prev - 0.25))} className="w-8 h-8 hover:bg-slate-50 rounded-lg transition-all"><i className="fas fa-minus text-xs"></i></button>
                  <div className="px-2 font-black text-[10px] text-slate-500">{Math.round(zoomLevel * 100)}%</div>
                  <button onClick={() => setZoomLevel(prev => Math.min(4, prev + 0.25))} className="w-8 h-8 hover:bg-slate-50 rounded-lg transition-all"><i className="fas fa-plus text-xs"></i></button>
                </div>
              </div>
              <div className="flex-1 overflow-auto custom-scrollbar-pro bg-[#94a3b8] flex items-center justify-center p-4">
                <div className="transition-transform duration-300 shadow-2xl bg-white origin-center" style={{ transform: `rotate(${zoomPage.rotation}deg) scale(${zoomLevel})` }}>
                  <img src={zoomPage.thumb.startsWith('data:') ? zoomPage.thumb : `data:image/png;base64,${zoomPage.thumb}`} className="max-w-none w-[500px] md:w-[800px]" alt="Zoom View" />
                </div>
              </div>
            </div>
            <div className="w-full md:w-[320px] p-6 bg-white border-l flex flex-col gap-6 shrink-0 overflow-y-auto">
              <div className="flex justify-between items-start">
                <h3 className="text-xl font-black tracking-tighter">Página {zoomPage.index + 1}</h3>
                <button onClick={closeZoom} className="text-slate-300 hover:text-red-500"><i className="fas fa-times"></i></button>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">ID Manual</label>
                <input 
                  type="text" 
                  value={pages.find(p => p.index === zoomPage.index)?.manualReference || ''} 
                  onChange={(e) => updateManualReference(zoomPage.index, e.target.value)}
                  className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-bold focus:border-red-500 outline-none text-base"
                />
              </div>
              <button onClick={() => rotatePage(zoomPage.index)} className="w-full py-4 bg-slate-100 rounded-2xl font-black text-[10px] uppercase hover:bg-red-50 hover:text-red-600 transition-all flex items-center justify-center gap-3">
                <i className="fas fa-redo"></i> Rotar 90°
              </button>
              <button onClick={() => { deletePage(zoomPage.index); closeZoom(); }} className="w-full py-4 bg-red-50 border border-red-200 text-red-600 rounded-2xl font-black text-[10px] uppercase hover:bg-red-600 hover:text-white transition-all flex items-center justify-center gap-3">
                <i className="fas fa-trash-can"></i> Eliminar página
              </button>
              <button onClick={closeZoom} className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-[10px] mt-auto hover:bg-red-600 shadow-lg">Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* CABECERA */}
      <header className="bg-white border-b px-6 py-3 flex flex-col sm:flex-row justify-between items-center z-50 shadow-sm shrink-0 gap-3">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center text-white shadow-lg rotate-2"><i className="fas fa-microchip text-xl"></i></div>
          <div>
            <h1 className="text-lg font-black tracking-tighter uppercase leading-none">Pdf<span className="text-red-600">Clasificar</span></h1>
            <p className="text-[8px] text-slate-400 font-black uppercase tracking-widest mt-0.5">v13.0 Digital Integrity</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={downloadLearningData} className="px-4 py-2 bg-indigo-50 text-indigo-600 rounded-xl text-[9px] font-black uppercase hover:bg-indigo-100 transition-all">Memoria</button>
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-slate-50 border rounded-xl text-[9px] font-black uppercase hover:bg-white transition-all">Reiniciar</button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        
        <button 
          onClick={() => setShowSidebar(!showSidebar)} 
          className="absolute right-6 top-6 z-[60] w-10 h-10 bg-white border border-slate-200 rounded-xl shadow-xl flex items-center justify-center text-slate-400 hover:text-red-600 transition-all"
        >
          <i className={`fas ${showSidebar ? 'fa-indent' : 'fa-outdent'}`}></i>
        </button>

        <main className="flex-1 overflow-y-auto p-4 md:p-8 bg-[#f1f5f9] custom-scrollbar">
          
          {step === ProcessingStep.IDLE && (
            <div className="h-full flex flex-col md:flex-row items-center justify-center gap-6 max-w-5xl mx-auto py-10">
              <div className="flex-1 w-full bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100 text-center transition-all hover:scale-[1.01]">
                <div className="w-16 h-16 bg-indigo-50 text-indigo-500 rounded-2xl flex items-center justify-center text-2xl mb-6 mx-auto"><i className="fas fa-table-list"></i></div>
                <h3 className="text-xl font-black mb-4 uppercase tracking-tighter">1. Clientes</h3>
                <label className="block w-full py-8 border-2 border-dashed border-slate-100 rounded-[2rem] cursor-pointer hover:bg-indigo-50 transition-all">
                  <span className="text-[11px] font-black text-slate-400 uppercase">{excelFile ? excelFile.name : "Subir Excel"}</span>
                  <input type="file" accept=".xlsx,.xls" onChange={handleExcelUpload} className="hidden" />
                </label>
              </div>
              <div className="flex-1 w-full bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100 text-center transition-all hover:scale-[1.01]">
                <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center text-2xl mb-6 mx-auto"><i className="fas fa-file-pdf"></i></div>
                <h3 className="text-xl font-black mb-4 uppercase tracking-tighter">2. Documento</h3>
                <label className="block w-full py-8 border-2 border-dashed border-slate-100 rounded-[2rem] cursor-pointer bg-white hover:bg-red-50 transition-all">
                  <span className="text-[11px] font-black text-slate-400 uppercase">{pdfFile ? pdfFile.name : "Subir PDF"}</span>
                  <input type="file" accept="application/pdf" onChange={handlePdfUpload} className="hidden" />
                </label>
              </div>
            </div>
          )}

          {step === ProcessingStep.PREVIEW && (
            <div className="space-y-6 pb-20">
              <div className="flex flex-col md:flex-row justify-between items-center bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 gap-4">
                 <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-red-50 text-red-600 rounded-xl flex items-center justify-center"><i className="fas fa-boxes"></i></div>
                    <h2 className="text-lg font-black uppercase tracking-tighter">Organizador de Hojas</h2>
                    <div className="flex gap-2">
                     <button onClick={groupSelected} className="px-6 py-3 bg-red-600 text-white rounded-xl text-[10px] font-black uppercase hover:bg-red-700 shadow-lg">Unir</button>
                     {pages.some(p => p.isSelected) && (
                       <button onClick={deleteSelectedPages} className="px-5 py-3 bg-red-50 text-red-600 border border-red-200 rounded-xl text-[10px] font-black uppercase hover:bg-red-600 hover:text-white transition-all shadow-sm flex items-center gap-2">
                         <i className="fas fa-trash-can"></i> Eliminar ({pages.filter(p => p.isSelected).length})
                       </button>
                     )}
                     <button onClick={ungroupAll} className="px-5 py-3 bg-slate-100 text-slate-400 rounded-xl text-[10px] font-black uppercase">Limpiar</button>
                  </div>
                 </div>
              </div>
              {isGeneratingThumbs && (
                <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 space-y-3">
                  <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest text-slate-500">
                    <span className="flex items-center gap-3"><i className="fas fa-circle-notch fa-spin text-red-600"></i> Generando miniaturas...</span>
                    <span className="text-slate-400">{progress.current} / {progress.total || '?'}</span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="bg-red-600 h-full rounded-full transition-all duration-300" style={{ width: `${(progress.current / (progress.total || 1)) * 100}%` }}></div>
                  </div>
                </div>
              )}

              {thumbError && (
                <div className="bg-red-50 border-2 border-red-100 p-6 rounded-[2rem] flex items-start gap-4">
                  <i className="fas fa-triangle-exclamation text-red-600 text-lg mt-0.5"></i>
                  <div className="space-y-1">
                    <p className="text-[10px] font-black uppercase tracking-widest text-red-600">No se pudo leer el PDF</p>
                    <p className="text-[11px] font-bold text-red-700 leading-relaxed">{thumbError}</p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 gap-4 animate-in fade-in duration-500">
                {pages.map((p) => (
                  <div key={p.index} className={`relative group bg-white rounded-[1.5rem] shadow-sm border-2 transition-all ${p.groupId ? 'border-red-500 ring-4 ring-red-50' : p.isSelected ? 'border-red-600' : 'border-white hover:border-slate-200'}`}>
                    <input type="checkbox" checked={p.isSelected} onChange={() => toggleSelect(p.index)} className="absolute top-3 left-3 z-30 w-5 h-5 accent-red-600 rounded-full cursor-pointer" />
                    <div className="absolute top-3 right-3 z-30 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                       <button onClick={(e) => { e.stopPropagation(); deletePage(p.index); }} title="Eliminar página" className="w-8 h-8 bg-white text-red-500 hover:bg-red-600 hover:text-white rounded-lg shadow-xl flex items-center justify-center transition-all"><i className="fas fa-trash-can text-xs"></i></button>
                       <button onClick={() => setZoomPage({ thumb: p.thumb, index: p.index, rotation: p.rotation || 0 })} title="Ver miniatura" className="w-8 h-8 bg-white text-red-600 rounded-lg shadow-xl flex items-center justify-center hover:bg-red-600 hover:text-white transition-all"><i className="fas fa-eye text-xs"></i></button>
                       <button onClick={() => rotatePage(p.index)} title="Rotar 90°" className="w-8 h-8 bg-white text-slate-400 rounded-lg shadow-xl flex items-center justify-center hover:text-red-600 transition-all"><i className="fas fa-rotate text-xs"></i></button>
                    </div>
                    <div className="aspect-[3/4] p-2 bg-slate-50 flex items-center justify-center overflow-hidden rounded-t-[1.2rem] cursor-pointer" onClick={() => toggleSelect(p.index)}>
                      <img src={p.thumb.startsWith('data:') ? p.thumb : `data:image/png;base64,${p.thumb}`} style={{ transform: `rotate(${p.rotation}deg)` }} className="w-full h-full object-contain" />
                    </div>
                    <div className="p-3 border-t border-slate-50 bg-white rounded-b-[1.5rem]">
                      <div className="flex justify-between items-center text-[8px] font-black uppercase text-slate-400 mb-1">
                         <span>#{p.index + 1}</span>
                         {p.groupId && <span className="text-red-600">VINC.</span>}
                      </div>
                      <input 
                        type="text" placeholder="ID..." 
                        value={p.manualReference || ''} 
                        onChange={(e) => updateManualReference(p.index, e.target.value)}
                        className="w-full text-[10px] font-black p-2 bg-slate-50 rounded-xl border border-transparent focus:bg-white focus:border-red-500 outline-none"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(step === ProcessingStep.PROCESSING || step === ProcessingStep.COMPLETED) && (
            <div className="min-h-full flex flex-col gap-6 pb-10 max-w-6xl mx-auto animate-in fade-in duration-700 overflow-y-auto custom-scrollbar-pro">
              
              <div className={`w-full bg-[#0f172a] rounded-[2.5rem] shadow-xl overflow-hidden border border-slate-800 flex flex-col transition-all duration-700 shrink-0 ${showLogs ? 'h-[500px]' : 'h-16'}`}>
                <div className="px-6 py-4 bg-slate-800/40 border-b border-slate-800 flex justify-between items-center shrink-0 cursor-pointer" onClick={() => setShowLogs(!showLogs)}>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-3"><i className={`fas ${showLogs ? 'fa-chevron-down' : 'fa-chevron-right'} text-green-500`}></i> Auditoría v13.0 Digital Integrity</span>
                  {showLogs && <button onClick={(e) => { e.stopPropagation(); downloadDetailedLogs(); }} className="text-[8px] bg-slate-700 text-white px-4 py-1 rounded-full uppercase">Log Detallado</button>}
                </div>
                {showLogs && (
                  <div ref={logsContainerRef} className="flex-1 p-6 font-mono text-[10px] overflow-y-auto space-y-2 text-slate-300 custom-scrollbar-pro leading-relaxed">
                    {logs.map((l, i) => (
                      <div key={i} className="flex gap-4 border-b border-slate-800/10 pb-1 hover:bg-slate-800/20 px-2 rounded group transition-all">
                        <span className="text-slate-600 font-bold w-10 shrink-0">[{i+1}]</span>
                        <span className={l.includes('MATCH ENCONTRADO') ? 'text-green-400 font-black' : l.includes('SIN COINCIDENCIA') ? 'text-red-400' : ''}>{l}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="px-8 py-4 bg-slate-900 border-t border-slate-800 shrink-0">
                   <div className="flex justify-between items-center mb-3 text-[10px] font-black uppercase text-white tracking-widest">
                      <span>{step === ProcessingStep.COMPLETED ? "PROCESO FINALIZADO" : "TRABAJANDO..."}</span>
                      <span className="text-slate-500">{progress.current} / {progress.total} Documentos</span>
                   </div>
                   <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden p-0.5 border border-slate-700">
                      <div className="bg-red-600 h-full rounded-full transition-all duration-500 shadow-[0_0_15px_rgba(220,38,38,0.5)]" style={{ width: `${(progress.current / (progress.total || 1)) * 100}%` }}></div>
                   </div>
                </div>
              </div>

              {step === ProcessingStep.COMPLETED && (
                <div className="w-full flex flex-col lg:flex-row gap-6 shrink-0 pb-10">
                   <div className="flex-[0.4] bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100 flex flex-col items-center justify-center gap-6 text-center">
                      <div className="w-16 h-16 bg-green-50 text-green-500 rounded-2xl flex items-center justify-center text-3xl shadow-inner"><i className="fas fa-check-double"></i></div>
                      {finalZipUrl && (
                        <a href={finalZipUrl} download="Facturas_Clasificadas_v13.zip" className="px-8 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-[9px] hover:bg-green-600 transition-all shadow-xl flex items-center gap-4 group">
                          <i className="fas fa-file-zipper text-lg"></i> DESCARGAR ZIP FINAL
                        </a>
                      )}
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-loose">Protección B/5/S Activada.</p>
                   </div>
                   <div className={`flex-1 bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100 flex flex-col transition-all duration-500 ${showFolders ? 'max-h-[400px]' : 'h-20'}`}>
                      <h3 className="text-[10px] font-black text-slate-600 uppercase tracking-widest text-center mb-6 flex items-center justify-center gap-4 cursor-pointer" onClick={() => setShowFolders(!showFolders)}>
                        <i className={`fas ${showFolders ? 'fa-folder-open' : 'fa-folder'} text-red-600`}></i> Estado de Carpetas
                      </h3>
                      {showFolders && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 overflow-y-auto px-4 custom-scrollbar-pro pb-4">
                           {companies.concat({ cif: 'PEND', name: PENDING_FOLDER }).map(c => (
                             <div key={c.cif} className={`p-4 rounded-2xl border-2 flex items-center gap-4 transition-all ${companyStatus[c.name] ? 'bg-green-50 border-green-100 text-green-700 shadow-sm' : 'bg-slate-50 border-slate-100 text-slate-300 opacity-40 grayscale'}`}>
                                <i className={`fas ${companyStatus[c.name] ? 'fa-folder-check text-green-600' : 'fa-folder-minus'} text-base`}></i>
                                <span className="text-[9px] font-black uppercase truncate">{c.name}</span>
                             </div>
                           ))}
                        </div>
                      )}
                   </div>
                </div>
              )}
            </div>
          )}
        </main>

        {/* SIDEBAR COMPACTO */}
        <aside className={`${showSidebar ? 'w-[320px] md:w-[380px]' : 'w-0 opacity-0 pointer-events-none'} bg-white border-l flex flex-col shrink-0 z-40 shadow-2xl transition-all duration-500 ease-in-out relative overflow-hidden`}>
          <div className="flex flex-col h-full">
            <div className="flex-1 overflow-y-auto p-6 custom-scrollbar space-y-6">
              <div className="space-y-2">
                <h2 className="text-xl font-black tracking-tighter uppercase leading-none">Ajustes del<br/><span className="text-red-600">Sistema</span></h2>
                <div className="h-1.5 w-10 bg-red-600 rounded-full"></div>
              </div>
              
              <div className="space-y-3">
                <h3 className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">Motor</h3>
                <div className="grid grid-cols-2 gap-2 bg-slate-100 p-1.5 rounded-2xl">
                  <button onClick={() => setUseAI(false)} className={`py-3 rounded-xl text-[8px] font-black uppercase transition-all ${!useAI ? 'bg-white shadow-md text-red-600' : 'text-slate-400'}`}>OCR LOCAL</button>
                  <button onClick={enableAI} className={`py-3 rounded-xl text-[8px] font-black uppercase transition-all ${useAI ? 'bg-white shadow-md text-red-600' : 'text-slate-400'}`}>AI GEMINI</button>
                </div>
                {useAI && (
                  <p className="text-[8px] font-bold text-amber-600 bg-amber-50 border border-amber-100 rounded-xl p-3 leading-relaxed">
                    <i className="fas fa-triangle-exclamation mr-1"></i>
                    Modo IA activo: la imagen de cada página se envía a la API de Google Gemini para su análisis.
                  </p>
                )}
              </div>

              <div className="space-y-3">
                <h3 className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">Carpeta Destino</h3>
                <button onClick={selectDirectory} className={`w-full py-6 border-2 border-dashed rounded-[1.5rem] flex flex-col items-center gap-3 transition-all ${dirHandle ? 'bg-green-50 border-green-200 text-green-700' : 'border-slate-100 text-slate-300 hover:bg-slate-50'}`}>
                   <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg shadow-lg transition-all ${dirHandle ? 'bg-green-500 text-white' : 'bg-white text-slate-200'}`}>
                     <i className={`fas ${dirHandle ? 'fa-check-circle' : 'fa-folder-plus'}`}></i>
                   </div>
                   <span className="text-[9px] font-black uppercase text-center px-4 leading-tight">
                     {dirHandle ? `DESTINO: ${dirHandle.name}` : "Vincular Carpeta Local"}
                   </span>
                </button>
              </div>

              <div className="space-y-3">
                <h3 className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">Unión Manual</h3>
                <button disabled={step !== ProcessingStep.PREVIEW || isGeneratingThumbs} onClick={groupSelected} className="w-full py-4 bg-white border-2 border-slate-50 rounded-2xl text-[9px] font-black uppercase hover:border-red-500 hover:text-red-600 transition-all flex items-center justify-center gap-4 disabled:opacity-20 shadow-sm">
                   <i className="fas fa-layer-group"></i> Unir por Referencia
                </button>
                <p className="text-[8px] font-bold text-slate-300 text-center uppercase tracking-widest px-2">Escribe el mismo ID en las hojas para agrupar</p>
              </div>
            </div>

            {/* PANEL DE BOTÓN COMPACTO */}
            <div className="p-5 border-t bg-slate-50/80 backdrop-blur-sm shrink-0">
              {step === ProcessingStep.PROCESSING && (
                <button onClick={stopProcessing} className="w-full py-3 bg-red-100 text-red-600 rounded-xl font-black uppercase text-[8px] hover:bg-red-200 transition-all mb-3 tracking-widest border border-red-200">
                  <i className="fas fa-stop mr-2"></i> Detener
                </button>
              )}
              
              <button 
                onClick={processAndDivide} 
                disabled={step !== ProcessingStep.PREVIEW || isGeneratingThumbs} 
                className="w-full py-4 bg-red-600 text-white rounded-[1.5rem] font-black uppercase tracking-[0.2em] text-xs shadow-xl hover:bg-slate-900 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-20 flex items-center justify-center gap-4 border-b-4 border-red-800"
              >
                 INICIAR DIVISIÓN <i className="fas fa-bolt text-sm"></i>
              </button>
            </div>
          </div>
        </aside>
      </div>

      <footer className="bg-white border-t px-6 py-3 flex justify-between items-center text-[8px] font-black text-slate-400 uppercase tracking-widest shrink-0">
         <div className="flex items-center gap-4">
            <span className="text-green-500 flex items-center gap-2"><i className="fas fa-circle text-[3px] animate-pulse"></i> v13 ENGINE ACTIVE</span>
            <span className="hidden md:inline text-slate-200">|</span>
            <span className="hidden md:inline text-slate-600">Inverse Search Logic B=8, G=6, S=5 (Digit Match Enabled)</span>
         </div>
         <div className="flex gap-4">
            <span className="bg-slate-50 px-2 py-1 rounded text-slate-500">{companies.length} CLIENTES</span>
            <span className="bg-red-50 px-2 py-1 rounded text-red-600">{pages.length} HOJAS</span>
         </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 10px; }
        .custom-scrollbar-pro::-webkit-scrollbar { width: 8px; height: 8px; }
        .custom-scrollbar-pro::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 10px; }
        .custom-scrollbar-pro::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; border: 2px solid #f1f5f9; }
        .custom-scrollbar-pro::-webkit-scrollbar-thumb:hover { background: #ef4444; }
      `}</style>
    </div>
  );
};

export default App;
