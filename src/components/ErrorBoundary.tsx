import React from 'react';
import { AlertTriangle, LogOut, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onResetSession?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Erro inesperado ao apresentar o painel.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Erro de renderização na interface Âncora SMS:', error, info);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, message: '' });
  };

  private handleBackToLogin = () => {
    this.setState({ hasError: false, message: '' });
    if (this.props.onResetSession) {
      this.props.onResetSession();
    } else {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 rounded-xl p-6 space-y-4 shadow-lg">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h1 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                  Não foi possível apresentar o ecrã do Âncora SMS
                </h1>
                <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400">
                  Ocorreu uma falha ao carregar a interface após a autenticação. Os seus dados no servidor não foram afetados.
                </p>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs font-mono text-red-700 dark:text-red-300 break-words">
              Causa: {this.state.message}
            </div>

            <div className="flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                onClick={this.handleRetry}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-green-700 hover:bg-green-800 text-white text-xs font-medium inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Tentar novamente
              </button>
              <button
                type="button"
                onClick={this.handleBackToLogin}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-medium inline-flex items-center gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                Voltar ao início de sessão
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
