import React, { useState } from 'react';
import { Download, Share, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
  className?: string;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  compact = false,
  className = '',
}) => {
  const { canInstall, isInstalled, isIOS, promptInstall } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (canInstall) {
      const accepted = await promptInstall();
      if (!accepted) {
        setShowGuide(true);
      }
      return;
    }
    setShowGuide(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-green-700/40 dark:border-green-500/40 bg-green-50 dark:bg-green-950/60 hover:bg-green-100 dark:hover:bg-green-900/60 text-green-800 dark:text-green-300 font-medium transition-colors whitespace-nowrap shrink-0 ${
          compact ? 'px-2.5 py-1.5 text-xs min-h-[36px]' : 'px-3 py-2 text-xs min-h-[40px]'
        } ${className}`}
        title="Instalar Âncora SMS no dispositivo"
      >
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span>Instalar App</span>
      </button>

      {showGuide && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-green-700 dark:text-green-400 shrink-0" />
                <h3 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                  Instalar Âncora SMS no Dispositivo
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 rounded-lg"
                aria-label="Fechar instruções"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <div className="space-y-2 text-xs sm:text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                <p>No Safari (iPhone ou iPad):</p>
                <ol className="list-decimal pl-5 space-y-1.5">
                  <li>
                    Toque no botão <span className="font-semibold text-slate-900 dark:text-white inline-flex items-center gap-1"><Share className="w-3.5 h-3.5" /> Partilhar</span> na barra do Safari.
                  </li>
                  <li>
                    Deslize para baixo e selecione <span className="font-semibold text-slate-900 dark:text-white">Adicionar ao Ecrã Principal</span>.
                  </li>
                  <li>
                    Confirme em <span className="font-semibold text-slate-900 dark:text-white">Adicionar</span> para abrir como aplicação independente.
                  </li>
                </ol>
              </div>
            ) : (
              <div className="space-y-2.5 text-xs sm:text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                <p>
                  Para instalar a aplicação no dispositivo, abra o endereço HTTPS publicado diretamente no navegador (fora de janelas incorporadas):
                </p>
                <ul className="list-disc pl-5 space-y-1.5">
                  <li>
                    <span className="font-semibold text-slate-900 dark:text-white">Telemóvel (Android Chrome):</span> abra o endereço HTTPS da aplicação no Chrome, toque no menu (⋮) e selecione <span className="font-semibold">Instalar aplicação</span> ou <span className="font-semibold">Adicionar ao ecrã inicial</span>.
                  </li>
                  <li>
                    <span className="font-semibold text-slate-900 dark:text-white">Computador (Chrome / Edge):</span> clique no ícone de instalação na barra de endereços ou aceda ao menu do navegador &gt; <span className="font-semibold">Instalar Âncora SMS</span>.
                  </li>
                </ul>
              </div>
            )}

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="min-h-[40px] px-4 py-2 bg-green-700 hover:bg-green-800 text-white text-xs font-medium rounded-lg"
              >
                Compreendido
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="no-print sticky top-0 z-50 w-full bg-amber-600 text-white px-4 py-1.5 text-xs font-medium flex items-center justify-center gap-2 text-center"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>
        Sem ligação à internet — Vendas, compras, devoluções e alterações de stock estão bloqueadas até restabelecer a ligação.
      </span>
    </div>
  );
};
