import React, { useState } from 'react';
import {
  type ApiClientRecord,
  type ApiDocument,
  type DocumentType,
  pageImageUrl
} from '../services/apiClient';

interface DocumentCardProps {
  document: ApiDocument;
  clients: ApiClientRecord[];
  /** Si hay otro documento después en el mismo PDF, se puede unir con él. */
  canMergeNext: boolean;
  busy: boolean;
  onUpdate: (id: number, update: { client_id?: number; doc_type?: DocumentType; clear_client?: boolean }) => void;
  onSplit: (id: number, atPage: number) => void;
  onMergeNext: (id: number) => void;
  onZoom: (sourceId: number, pageIndex: number) => void;
}

const TYPE_STYLE: Record<DocumentType, string> = {
  factura: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  albaran: 'bg-teal-50 text-teal-700 border-teal-200',
  desconocido: 'bg-slate-100 text-slate-500 border-slate-200'
};

const DocumentCard: React.FC<DocumentCardProps> = ({
  document, clients, canMergeNext, busy, onUpdate, onSplit, onMergeNext, onZoom
}) => {
  const [showPages, setShowPages] = useState(false);

  const sinCliente = document.client_id === null;

  return (
    <div className={`rounded-2xl border-2 p-4 space-y-3 transition-all ${sinCliente ? 'bg-amber-50/40 border-amber-200' : 'bg-slate-50 border-slate-100'} ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={document.doc_type}
          onChange={e => onUpdate(document.id, { doc_type: e.target.value as DocumentType })}
          className={`text-[9px] font-black uppercase px-2 py-1.5 rounded-lg border-2 outline-none cursor-pointer ${TYPE_STYLE[document.doc_type]}`}
        >
          <option value="factura">Factura</option>
          <option value="albaran">Albarán</option>
          <option value="desconocido">Sin tipo</option>
        </select>

        <span className="text-[11px] font-black font-mono">{document.number || 'S-N'}</span>

        <button
          onClick={() => setShowPages(v => !v)}
          className="text-[9px] font-bold text-slate-500 hover:text-red-600 underline decoration-dotted"
        >
          {document.page_indices.length} pág. ({document.page_indices.map(i => i + 1).join(', ')})
        </button>

        <select
          value={document.client_id ?? ''}
          onChange={e => {
            const value = e.target.value;
            onUpdate(document.id, value === ''
              ? { clear_client: true }
              : { client_id: Number(value) });
          }}
          className={`ml-auto text-[10px] font-black px-3 py-2 rounded-lg border-2 outline-none cursor-pointer max-w-[240px] ${sinCliente ? 'bg-amber-50 border-amber-300 text-amber-800' : 'bg-white border-slate-200 text-green-700'}`}
        >
          <option value="">— Pendiente de asignar —</option>
          {clients.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {document.ambiguous && (
        <p className="text-[9px] font-bold text-amber-700">
          <i className="fas fa-circle-question mr-1"></i>
          Coinciden varios clientes ({document.candidates.join(' / ')}). Elige uno arriba.
        </p>
      )}

      {document.notes.map((n, i) => (
        <p key={i} className="text-[9px] font-bold text-slate-400">{n}</p>
      ))}

      {showPages && (
        <div className="pt-2 space-y-3">
          <div className="flex flex-wrap gap-3">
            {document.page_indices.map((pageIndex, position) => (
              <div key={pageIndex} className="space-y-1">
                <button
                  onClick={() => onZoom(document.source_file_id, pageIndex)}
                  title="Ver la página a tamaño completo"
                  className="block w-[110px] aspect-[3/4] bg-white rounded-xl border-2 border-slate-200 overflow-hidden hover:border-red-500 transition-all"
                >
                  <img
                    src={pageImageUrl(document.source_file_id, pageIndex)}
                    alt={`Página ${pageIndex + 1}`}
                    loading="lazy"
                    className="w-full h-full object-contain"
                  />
                </button>
                <div className="flex items-center justify-between px-1">
                  <span className="text-[8px] font-black text-slate-400">#{pageIndex + 1}</span>
                  {/* Partir por la primera página dejaría el documento vacío. */}
                  {position > 0 && (
                    <button
                      onClick={() => onSplit(document.id, pageIndex)}
                      title="Separar: esta página abre un documento nuevo"
                      className="text-[8px] font-black uppercase text-slate-400 hover:text-red-600"
                    >
                      <i className="fas fa-scissors mr-1"></i>Partir
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {canMergeNext && (
            <button
              onClick={() => onMergeNext(document.id)}
              className="text-[9px] font-black uppercase tracking-widest px-4 py-2 rounded-xl bg-white border-2 border-slate-200 text-slate-500 hover:border-red-500 hover:text-red-600 transition-all"
            >
              <i className="fas fa-link mr-2"></i>Unir con el documento siguiente
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default DocumentCard;
