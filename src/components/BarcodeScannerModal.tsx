import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { AlertTriangle, Camera, CameraOff, ScanBarcode, X } from 'lucide-react';
import { normalizeBarcode } from '../lib/barcode';

interface BarcodeScannerModalProps {
  title?: string;
  subtitle?: string;
  onDetected: (barcode: string) => void;
  onClose: () => void;
}

type NativeBarcodeDetectorCtor = {
  new (options?: { formats?: string[] }): {
    detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
  };
  getSupportedFormats?: () => Promise<string[]>;
};

const TARGET_NATIVE_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
];

const TARGET_ZXING_FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
];

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  title = 'Ler Código de Barras pela Câmara',
  subtitle = 'Aponte a câmara para o código de barras da embalagem (EAN-13, EAN-8, UPC ou Code-128).',
  onDetected,
  onClose,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const timerRef = useRef<number | null>(null);
  const handledRef = useRef(false);

  const [phase, setPhase] = useState<'CONFIRM' | 'STARTING' | 'SCANNING' | 'ERROR'>('CONFIRM');
  const [errorMsg, setErrorMsg] = useState('');
  const [engineLabel, setEngineLabel] = useState('');

  const stopCameraResources = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch {
        // ignore stop errors
      }
      controlsRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      stopCameraResources();
    };
  }, [stopCameraResources]);

  const handleClose = () => {
    stopCameraResources();
    onClose();
  };

  const handleStopScanning = () => {
    stopCameraResources();
    setPhase('CONFIRM');
    setEngineLabel('');
  };

  const emitFoundBarcode = useCallback(
    (rawValue: string) => {
      if (handledRef.current) return;
      const clean = normalizeBarcode(rawValue);
      if (!clean) return;
      handledRef.current = true;
      stopCameraResources();
      onDetected(clean);
    },
    [onDetected, stopCameraResources]
  );

  const startScanning = async () => {
    setErrorMsg('');
    handledRef.current = false;

    if (typeof window === 'undefined' || !navigator?.mediaDevices?.getUserMedia) {
      setPhase('ERROR');
      setErrorMsg(
        'Este navegador ou contexto não permite acesso à câmara (exija HTTPS ou use um navegador compatível). A pesquisa manual e o leitor USB continuam disponíveis normalmente.'
      );
      return;
    }

    setPhase('STARTING');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      setPhase('SCANNING');

      // Wait a tick for the <video> element to mount
      await new Promise((r) => setTimeout(r, 60));
      const video = videoRef.current;
      if (!video) {
        stopCameraResources();
        setPhase('ERROR');
        setErrorMsg('Não foi possível inicializar a pré-visualização de vídeo.');
        return;
      }

      // Check native BarcodeDetector support first
      const DetectorCtor = (window as unknown as { BarcodeDetector?: NativeBarcodeDetectorCtor })
        .BarcodeDetector;

      let canUseNative = false;
      let activeNativeFormats = TARGET_NATIVE_FORMATS;
      if (DetectorCtor) {
        try {
          if (typeof DetectorCtor.getSupportedFormats === 'function') {
            const supported = await DetectorCtor.getSupportedFormats();
            const matching = TARGET_NATIVE_FORMATS.filter((f) => supported.includes(f));
            if (matching.length > 0) {
              activeNativeFormats = matching;
              canUseNative = true;
            }
          } else {
            canUseNative = true;
          }
        } catch {
          canUseNative = false;
        }
      }

      if (canUseNative && DetectorCtor) {
        video.srcObject = stream;
        await video.play();
        const detector = new DetectorCtor({ formats: activeNativeFormats });
        setEngineLabel('Deteção nativa do dispositivo');
        timerRef.current = window.setInterval(async () => {
          if (handledRef.current || !videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const results = await detector.detect(videoRef.current);
            if (results && results.length > 0) {
              const value = results.find((r) => r.rawValue)?.rawValue;
              if (value) emitFoundBarcode(value);
            }
          } catch {
            // ignore transient frame read errors
          }
        }, 160);
        return;
      }

      // Cross-browser fallback via @zxing/browser
      const hints = new Map<DecodeHintType, unknown>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, TARGET_ZXING_FORMATS);
      hints.set(DecodeHintType.TRY_HARDER, true);

      const reader = new BrowserMultiFormatReader(hints, {
        delayBetweenScanAttempts: 180,
        delayBetweenScanSuccess: 400,
      });
      setEngineLabel('Leitor ótico multi-formato (EAN / UPC / Code-128)');
      const controls = await reader.decodeFromStream(stream, video, (result) => {
        if (result) {
          emitFoundBarcode(result.getText());
        }
      });
      controlsRef.current = controls;
    } catch (err: any) {
      stopCameraResources();
      setPhase('ERROR');
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setErrorMsg(
          'Permissão de câmara recusada. Para ler pela câmara, autorize o acesso nas definições do navegador, ou feche esta janela e utilize a pesquisa manual ou leitor USB.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setErrorMsg(
          'Nenhuma câmara foi detetada neste equipamento. Pode continuar a usar a pesquisa manual ou um leitor de códigos USB.'
        );
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setErrorMsg(
          'A câmara está a ser utilizada por outra aplicação ou não pôde ser aberta. Feche outras aplicações que usem a câmara ou utilize o leitor USB.'
        );
      } else {
        setErrorMsg(
          err?.message ||
            'Não foi possível iniciar a câmara neste dispositivo. A pesquisa manual e o leitor USB continuam disponíveis.'
        );
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-green-50 dark:bg-green-950/60 border border-green-200 dark:border-green-800 flex items-center justify-center text-green-700 dark:text-green-400 shrink-0">
              <ScanBarcode className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100 truncate">
                {title}
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                A leitura apenas localiza ou preenche o produto.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 rounded-lg"
            aria-label="Fechar leitor"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {phase === 'CONFIRM' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2 text-xs text-slate-700 dark:text-slate-300">
                <p className="font-semibold text-slate-900 dark:text-slate-100">
                  Pedido de permissão para aceder à câmara
                </p>
                <p>{subtitle}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Formatos suportados: EAN-13, EAN-8, UPC-A, UPC-E, Code-128, Code-39 e ITF. A câmara só será ligada após a sua confirmação e será desligada automaticamente assim que o código for lido ou ao clicar em Parar Leitura.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={startScanning}
                  className="flex-1 min-h-[44px] px-4 py-2.5 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-2"
                >
                  <Camera className="w-4 h-4" />
                  Permitir Câmara e Iniciar Leitura
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="min-h-[44px] px-4 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium rounded-lg"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {(phase === 'STARTING' || phase === 'SCANNING') && (
            <div className="space-y-3">
              <div className="relative aspect-[4/3] w-full bg-slate-950 rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  autoPlay
                  className="w-full h-full object-cover"
                />
                {/* Aiming guide overlay */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="w-3/4 h-24 border-2 border-emerald-400/90 rounded-lg shadow-[0_0_0_9999px_rgba(2,6,23,0.35)]" />
                </div>
                {phase === 'STARTING' && (
                  <div className="absolute inset-0 bg-slate-950/80 flex items-center justify-center text-xs text-slate-200">
                    A solicitar acesso à câmara...
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span>Alinhe o código de barras dentro da moldura verde.</span>
                {engineLabel && <span className="truncate max-w-[170px]">{engineLabel}</span>}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleStopScanning}
                  className="flex-1 min-h-[42px] px-3 py-2 bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-950 text-red-800 dark:text-red-200 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                >
                  <CameraOff className="w-4 h-4" />
                  Parar Leitura
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="min-h-[42px] px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium rounded-lg"
                >
                  Fechar
                </button>
              </div>
            </div>
          )}

          {phase === 'ERROR' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 flex items-start gap-3 text-xs text-amber-950 dark:text-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold">Leitura por câmara indisponível</p>
                  <p>{errorMsg}</p>
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={startScanning}
                  className="min-h-[40px] px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-medium rounded-lg"
                >
                  Tentar Novamente
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="min-h-[40px] px-4 py-2 bg-green-700 hover:bg-green-800 text-white text-xs font-medium rounded-lg"
                >
                  Continuar sem Câmara
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
