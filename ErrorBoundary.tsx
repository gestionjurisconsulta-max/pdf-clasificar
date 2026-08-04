import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Error no controlado en la aplicación:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#f1f5f9] p-8">
          <div className="max-w-lg w-full bg-white rounded-[2rem] shadow-xl border border-slate-100 p-10 text-center space-y-4">
            <div className="w-16 h-16 bg-red-50 text-red-600 rounded-2xl flex items-center justify-center text-2xl mx-auto">
              <i className="fas fa-triangle-exclamation"></i>
            </div>
            <h1 className="text-lg font-black uppercase tracking-tighter">Ha ocurrido un error inesperado</h1>
            <p className="text-sm text-slate-500">{this.state.error.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-8 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-red-600 transition-all"
            >
              Reiniciar aplicación
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
