import React, { useEffect, useState } from 'react';
import LocalWorkspace from './LocalWorkspace';
import ServerWorkspace from './ServerWorkspace';
import { getHealth } from './services/apiClient';

/**
 * Los dos espacios de trabajo resuelven problemas distintos:
 *
 * - `servidor`: varios Excel y varios PDF a la vez, separa facturas de
 *   albaranes y guarda el histórico. Es lo que se usa en el VPS.
 * - `local`: un solo PDF, con miniaturas para revisar, rotar, borrar y agrupar
 *   páginas a mano. Todo ocurre en el navegador y el fichero no sale del
 *   equipo. Sigue siendo la opción cuando hace falta ojo humano.
 */
type Mode = 'servidor' | 'local';

const STORAGE_KEY = 'pdfclasificar:mode';

const readStoredMode = (): Mode | null => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'servidor' || stored === 'local' ? stored : null;
  } catch {
    // Modo incógnito o cookies bloqueadas: se decide por disponibilidad.
    return null;
  }
};

const App: React.FC = () => {
  const [chosen, setChosen] = useState<Mode | null>(readStoredMode);
  // null mientras se comprueba; el selector avisa si el servidor no responde.
  const [apiUp, setApiUp] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then(h => { if (!cancelled) setApiUp(h.status === 'ok'); })
      .catch(() => { if (!cancelled) setApiUp(false); });
    return () => { cancelled = true; };
  }, []);

  // El modo se DERIVA, no se guarda por duplicado: si el usuario ya ha elegido
  // manda su elección; si no, manda lo que haya disponible, de forma que quien
  // abra el build sin backend aterrice en el modo local en vez de encontrarse
  // una pantalla que no funciona.
  const mode: Mode | null =
    chosen ?? (apiUp === null ? null : apiUp ? 'servidor' : 'local');

  const choose = (next: Mode) => {
    setChosen(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* no es crítico */ }
  };

  if (mode === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f1f5f9] text-slate-400">
        <i className="fas fa-circle-notch fa-spin text-2xl"></i>
      </div>
    );
  }

  const modeSwitch = (
    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
      <button
        onClick={() => choose('servidor')}
        disabled={apiUp === false}
        title={apiUp === false ? 'El servidor no responde' : 'Varios ficheros, facturas y albaranes, histórico'}
        className={`px-3 py-2 rounded-lg text-[8px] font-black uppercase tracking-widest transition-all disabled:opacity-30 ${mode === 'servidor' ? 'bg-white shadow-sm text-red-600' : 'text-slate-400 hover:text-slate-600'}`}
      >
        <i className="fas fa-server mr-1.5"></i>Servidor
      </button>
      <button
        onClick={() => choose('local')}
        title="Un PDF, con revisión visual página a página"
        className={`px-3 py-2 rounded-lg text-[8px] font-black uppercase tracking-widest transition-all ${mode === 'local' ? 'bg-white shadow-sm text-red-600' : 'text-slate-400 hover:text-slate-600'}`}
      >
        <i className="fas fa-laptop mr-1.5"></i>Local
      </button>
    </div>
  );

  return mode === 'servidor'
    ? <ServerWorkspace modeSwitch={modeSwitch} />
    : <LocalWorkspace modeSwitch={modeSwitch} />;
};

export default App;
