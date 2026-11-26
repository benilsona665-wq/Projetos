import React, { useCallback, useEffect, useState } from 'react';
import { Lock, ShieldCheck, Unlock, Wallet } from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  formatDatePT,
  formatDateTimePT,
  formatMoney,
  paymentMethodLabel,
  todayLocalISO,
} from '../lib/format';
import type {
  GeneralClosing,
  PaymentMethod,
  PharmacySettings,
  SellerClosing,
  User,
} from '../types';

interface ClosingsViewProps {
  user: User;
  settings: PharmacySettings;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

interface PreviewData {
  hasOpenRegister: boolean;
  openRegisterId: string | null;
  date: string;
  sellerId: string;
  shiftNumber: number;
  shiftLabel: string;
  openingBalance: number;
  openedAt: string | null;
  openingNotes: string;
  existingCountToday: number;
  closedTodayCount: number;
  maxAllowedPerDay: number;
  isPeriodClosed: boolean;
  closedPeriodRef: string | null;
  salesCount: number;
  salesByPayment: Record<PaymentMethod, number>;
  grossSalesTotal: number;
  returnsTotal: number;
  returnsCashTotal: number;
  cancellationsCount: number;
  cancellationsTotal: number;
  expectedCashSalesNet: number;
  expectedCash: number;
  expectedTotal: number;
}

export const ClosingsView: React.FC<ClosingsViewProps> = ({
  user,
  settings,
  onRefresh,
  onNotify,
}) => {
  const isAdmin = user.role === 'ADMIN';
  const cur = settings.currencySymbol || 'Kz';
  const today = todayLocalISO();

  const [tab, setTab] = useState<'SELLER' | 'GENERAL'>('SELLER');
  const [sellerClosings, setSellerClosings] = useState<SellerClosing[]>([]);
  const [generalClosings, setGeneralClosings] = useState<GeneralClosing[]>([]);

  // Own cash register state (open / close)
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [openingBalanceInput, setOpeningBalanceInput] = useState('0');
  const [openingNotesInput, setOpeningNotesInput] = useState('');
  const [countedCash, setCountedCash] = useState('0');
  const [closingNotes, setClosingNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // History filter for admin
  const [historyFilterSellerId, setHistoryFilterSellerId] = useState('');

  // General closing form
  const [genStart, setGenStart] = useState(today);
  const [genEnd, setGenEnd] = useState(today);
  const [genNotes, setGenNotes] = useState('');

  // Admin correction modal state
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [corrAction, setCorrAction] = useState<'CORRECAO' | 'REABERTURA'>('CORRECAO');
  const [corrReason, setCorrReason] = useState('');
  const [corrNewTotal, setCorrNewTotal] = useState('');

  const loadClosings = useCallback(async () => {
    const res = await apiFetch<{
      sellerClosings: SellerClosing[];
      generalClosings: GeneralClosing[];
    }>('/api/closings');
    setSellerClosings(res.sellerClosings);
    setGeneralClosings(res.generalClosings);
  }, []);

  const loadPreview = useCallback(async () => {
    const p = await apiFetch<PreviewData>('/api/closings/preview');
    setPreview(p);
    if (p.hasOpenRegister) {
      setCountedCash(String(Math.max(0, p.expectedCash)));
    }
  }, []);

  useEffect(() => {
    loadClosings().catch(() => {});
    loadPreview().catch(() => {});
  }, [loadClosings, loadPreview]);

  const expectedCash = preview?.hasOpenRegister ? preview.expectedCash : 0;
  const diffCash = Math.round((Number(countedCash || 0) - expectedCash) * 100) / 100;

  const handleOpenRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    const numericBalance = Number(openingBalanceInput || 0);
    if (!Number.isFinite(numericBalance) || numericBalance < 0) {
      onNotify('O valor inicial em caixa deve ser igual ou superior a zero.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch('/api/cash-register/open', {
        method: 'POST',
        body: JSON.stringify({
          openingBalance: numericBalance,
          openingNotes: openingNotesInput.trim(),
        }),
      });
      setOpeningBalanceInput('0');
      setOpeningNotesInput('');
      await Promise.all([loadClosings(), loadPreview(), onRefresh()]);
      onNotify('Caixa aberto com sucesso. Já pode registar vendas.');
    } catch (err: any) {
      onNotify(err?.message || 'Não foi possível abrir o caixa.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCloseRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    const numericCounted = Number(countedCash || 0);
    if (!Number.isFinite(numericCounted) || numericCounted < 0) {
      onNotify('O valor contado em caixa deve ser igual ou superior a zero.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch('/api/closings/seller', {
        method: 'POST',
        body: JSON.stringify({
          countedCash: numericCounted,
          notes: closingNotes.trim(),
        }),
      });
      setClosingNotes('');
      await Promise.all([loadClosings(), loadPreview(), onRefresh()]);
      onNotify('Caixa fechado com sucesso. Novas vendas ficam bloqueadas até abrir novo caixa.');
    } catch (err: any) {
      onNotify(err?.message || 'Não foi possível fechar o caixa.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateGeneralClosing = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch('/api/closings/general', {
        method: 'POST',
        body: JSON.stringify({
          startDate: genStart,
          endDate: genEnd,
          notes: genNotes,
        }),
      });
      setGenNotes('');
      await Promise.all([loadClosings(), loadPreview(), onRefresh()]);
      onNotify('Fecho geral do período concluído e bloqueado.');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao efetuar fecho geral.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCorrectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctingId) return;
    try {
      await apiFetch(`/api/closings/general/${correctingId}/correction`, {
        method: 'POST',
        body: JSON.stringify({
          action: corrAction,
          reason: corrReason,
          newTotalCounted: corrAction === 'CORRECAO' ? Number(corrNewTotal) : undefined,
        }),
      });
      setCorrectingId(null);
      setCorrReason('');
      setCorrNewTotal('');
      await Promise.all([loadClosings(), loadPreview(), onRefresh()]);
      onNotify('Correção autorizada registada no histórico do fecho geral.');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao registar correção.', 'error');
    }
  };

  const uniqueSellersInHistory = Array.from(
    new Map(sellerClosings.map((c) => [c.sellerId, c.sellerName])).entries()
  );
  const displayedSellerClosings = sellerClosings.filter((c) =>
    isAdmin && historyFilterSellerId ? c.sellerId === historyFilterSellerId : true
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
            Abertura, Fecho de Caixa e Fecho Geral
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Cada vendedor abre e fecha apenas o seu próprio caixa (até 2 turnos por dia). O Fecho Geral consolida o período.
          </p>
        </div>

        <div className="inline-flex p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setTab('SELLER')}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'SELLER'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Meu Caixa (Abertura e Fecho)
          </button>
          <button
            type="button"
            onClick={() => setTab('GENERAL')}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'GENERAL'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Fecho Geral ({generalClosings.length})
          </button>
        </div>
      </div>

      {tab === 'SELLER' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Open or Close OWN Cash Register */}
          <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            {preview?.hasOpenRegister ? (
              <>
                <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-green-700 dark:text-green-400" />
                    <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
                      Fechar caixa ({preview.shiftLabel})
                    </h2>
                  </div>
                  <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                    Caixa Aberto
                  </span>
                </div>

                <div className="p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg space-y-2 text-xs">
                  <div className="flex justify-between text-slate-700 dark:text-slate-300">
                    <span>Operador:</span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{user.fullName}</span>
                  </div>
                  <div className="flex justify-between text-slate-700 dark:text-slate-300">
                    <span>Abertura:</span>
                    <span className="font-mono">
                      {preview.openedAt ? formatDateTimePT(preview.openedAt) : formatDatePT(preview.date)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-700 dark:text-slate-300">
                    <span>Valor Inicial em Caixa:</span>
                    <span className="font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                      {formatMoney(preview.openingBalance, cur)}
                    </span>
                  </div>
                  {preview.openingNotes && (
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-800">
                      Obs. abertura: {preview.openingNotes}
                    </div>
                  )}

                  <div className="border-t border-slate-200 dark:border-slate-800 pt-2 space-y-1 font-mono tabular-nums">
                    <div className="flex justify-between text-slate-600 dark:text-slate-400">
                      <span className="font-sans">Faturas emitidas nesta sessão:</span>
                      <span>{preview.salesCount}</span>
                    </div>
                    {(Object.keys(preview.salesByPayment) as PaymentMethod[]).map((pm) => (
                      <div key={pm} className="flex justify-between text-slate-600 dark:text-slate-400">
                        <span className="font-sans">{paymentMethodLabel(pm)}:</span>
                        <span>{formatMoney(preview.salesByPayment[pm], cur)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between text-red-700 dark:text-red-400">
                      <span className="font-sans">
                        Devoluções ({preview.cancellationsCount} anul.):
                      </span>
                      <span>-{formatMoney(preview.returnsTotal, cur)}</span>
                    </div>
                  </div>
                </div>

                {preview.isPeriodClosed && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-300 font-medium">
                    Período fechado ({preview.closedPeriodRef}). Contacte o Administrador para reabrir antes de fechar este caixa.
                  </div>
                )}

                <form onSubmit={handleCloseRegister} className="space-y-3 text-xs">
                  <div className="p-3 bg-green-50/70 dark:bg-green-950/40 border border-green-200 dark:border-green-800 rounded-lg space-y-1 font-mono tabular-nums">
                    <div className="flex justify-between text-slate-700 dark:text-slate-200">
                      <span className="font-sans">Dinheiro Esperado em Caixa:</span>
                      <span className="font-semibold">{formatMoney(expectedCash, cur)}</span>
                    </div>
                    <div className="flex justify-between text-slate-600 dark:text-slate-400">
                      <span className="font-sans">Total Líquido (todas formas):</span>
                      <span>{formatMoney(preview.expectedTotal, cur)}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Valor Contado em Caixa ({cur}) *
                      </label>
                      <input
                        required
                        type="number"
                        min="0"
                        step="0.01"
                        value={countedCash}
                        onChange={(e) => setCountedCash(e.target.value)}
                        className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Diferença
                      </label>
                      <div
                        className={`min-h-[38px] px-3 py-2 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 rounded-lg font-mono font-semibold tabular-nums ${
                          diffCash < 0
                            ? 'text-red-700 dark:text-red-400'
                            : diffCash > 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-slate-800 dark:text-slate-200'
                        }`}
                      >
                        {diffCash > 0 ? `+${formatMoney(diffCash, cur)}` : formatMoney(diffCash, cur)}
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Observações de Fecho
                    </label>
                    <textarea
                      rows={2}
                      value={closingNotes}
                      onChange={(e) => setClosingNotes(e.target.value)}
                      placeholder="Justificação de diferenças ou notas do turno (opcional)..."
                      className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submitting || preview.isPeriodClosed}
                    className="w-full min-h-[42px] px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 disabled:opacity-50 text-white font-medium rounded-lg"
                  >
                    {submitting ? 'A fechar caixa...' : 'Fechar caixa'}
                  </button>
                </form>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <Unlock className="w-4 h-4 text-green-700 dark:text-green-400" />
                    <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
                      Abrir caixa
                    </h2>
                  </div>
                  <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    Sem caixa aberto
                  </span>
                </div>

                <div className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs space-y-1">
                  <div className="flex justify-between text-slate-700 dark:text-slate-300">
                    <span>Utilizador:</span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{user.fullName}</span>
                  </div>
                  <div className="flex justify-between text-slate-700 dark:text-slate-300">
                    <span>Data / Turno seguinte:</span>
                    <span className="font-mono">
                      {formatDatePT(preview?.date || today)} ·{' '}
                      {preview?.shiftLabel || '1º Turno (Manhã)'}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-700 dark:text-slate-300">
                    <span>Turnos registados hoje:</span>
                    <span className="font-mono tabular-nums">
                      {preview?.existingCountToday ?? 0} / {preview?.maxAllowedPerDay ?? 2}
                    </span>
                  </div>
                </div>

                {preview?.isPeriodClosed && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-300 font-medium">
                    O período ({preview.closedPeriodRef}) está fechado. Não é possível abrir novo caixa hoje.
                  </div>
                )}

                {preview && preview.existingCountToday >= preview.maxAllowedPerDay && (
                  <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 font-medium">
                    Limite diário atingido: já utilizou os {preview.maxAllowedPerDay} turnos/fechos permitidos para hoje.
                  </div>
                )}

                <form onSubmit={handleOpenRegister} className="space-y-3 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Valor Inicial em Caixa ({cur}) *
                    </label>
                    <input
                      required
                      type="number"
                      min="0"
                      step="0.01"
                      value={openingBalanceInput}
                      onChange={(e) => setOpeningBalanceInput(e.target.value)}
                      className="w-full min-h-[40px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono tabular-nums"
                    />
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Observações de Abertura (opcional)
                    </label>
                    <textarea
                      rows={2}
                      value={openingNotesInput}
                      onChange={(e) => setOpeningNotesInput(e.target.value)}
                      placeholder="Ex.: trocos iniciais conferidos..."
                      className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={
                      submitting ||
                      Boolean(preview?.isPeriodClosed) ||
                      Boolean(preview && preview.existingCountToday >= preview.maxAllowedPerDay)
                    }
                    className="w-full min-h-[42px] px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 disabled:opacity-50 text-white font-medium rounded-lg"
                  >
                    {submitting ? 'A abrir caixa...' : 'Abrir caixa'}
                  </button>
                </form>
              </>
            )}
          </div>

          {/* Right Column: Immutable Opening & Closing History */}
          <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
                Histórico de Aberturas e Fechos ({displayedSellerClosings.length})
              </h2>
              {isAdmin && uniqueSellersInHistory.length > 1 && (
                <select
                  value={historyFilterSellerId}
                  onChange={(e) => setHistoryFilterSellerId(e.target.value)}
                  className="min-h-[34px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 rounded-lg text-xs"
                >
                  <option value="">Todos os vendedores</option>
                  {uniqueSellersInHistory.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                    <th className="py-2.5 px-4 font-medium">Estado / Turno</th>
                    <th className="py-2.5 px-3 font-medium">Vendedor</th>
                    <th className="py-2.5 px-3 font-medium text-right">Inicial</th>
                    <th className="py-2.5 px-3 font-medium text-right">Esperado</th>
                    <th className="py-2.5 px-3 font-medium text-right">Contado</th>
                    <th className="py-2.5 px-3 font-medium text-right">Diferença</th>
                    <th className="py-2.5 px-4 font-medium">Registo / Obs.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {displayedSellerClosings.map((c) => {
                    const isOpen = c.status === 'ABERTO';
                    return (
                      <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 align-top">
                        <td className="py-2.5 px-4">
                          <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {formatDatePT(c.date)}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">{c.shiftLabel}</div>
                          <div
                            className={`text-[11px] font-semibold mt-0.5 ${
                              isOpen
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-slate-600 dark:text-slate-400'
                            }`}
                          >
                            {isOpen ? 'Caixa Aberto' : 'Fechado'}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100">
                          {c.sellerName}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {formatMoney(c.openingBalance, cur)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {isOpen ? 'Em curso' : formatMoney(c.expectedCash, cur)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {isOpen ? '—' : formatMoney(c.countedCash, cur)}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-mono tabular-nums font-semibold ${
                            isOpen
                              ? 'text-slate-400'
                              : c.difference < 0
                              ? 'text-red-700 dark:text-red-400'
                              : c.difference > 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {isOpen ? '—' : formatMoney(c.difference, cur)}
                        </td>
                        <td className="py-2.5 px-4 text-slate-600 dark:text-slate-400 max-w-[220px]">
                          <div className="text-[11px]">
                            Abertura: {formatDateTimePT(c.openedAt || c.createdAt)}
                          </div>
                          {!isOpen && (
                            <div className="text-[11px]">
                              Fecho: {formatDateTimePT(c.closedAt || c.createdAt)}
                            </div>
                          )}
                          {c.openingNotes && (
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate" title={c.openingNotes}>
                              Obs. ab.: {c.openingNotes}
                            </div>
                          )}
                          {c.notes && (
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate" title={c.notes}>
                              Obs. fecho: {c.notes}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {displayedSellerClosings.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500 dark:text-slate-400">
                        Nenhuma abertura ou fecho de caixa registado ainda.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* General Closing Tab */
        <div className="space-y-5">
          {isAdmin && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
                <ShieldCheck className="w-4 h-4 text-green-700 dark:text-green-400" />
                <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
                  Realizar Fecho Geral do Período (Administrador)
                </h2>
              </div>
              <form
                onSubmit={handleCreateGeneralClosing}
                className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end text-xs"
              >
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Data Inicial</label>
                  <input
                    type="date"
                    required
                    value={genStart}
                    onChange={(e) => setGenStart(e.target.value)}
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Data Final</label>
                  <input
                    type="date"
                    required
                    value={genEnd}
                    onChange={(e) => setGenEnd(e.target.value)}
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Observações</label>
                  <input
                    value={genNotes}
                    onChange={(e) => setGenNotes(e.target.value)}
                    placeholder="Notas do fecho..."
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="min-h-[38px] px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white font-medium rounded-lg flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <Lock className="w-3.5 h-3.5" />
                  Fechar Período
                </button>
              </form>
            </div>
          )}

          <div className="space-y-4">
            {generalClosings.map((gc) => (
              <div
                key={gc.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-sm text-slate-900 dark:text-slate-100">
                        {gc.referenceNumber}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span
                        className={`font-semibold ${
                          gc.status === 'FECHADO'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {gc.status === 'FECHADO' ? 'Período Fechado' : 'Período Reaberto'}
                      </span>
                    </div>
                    <div className="text-slate-600 dark:text-slate-400 mt-0.5">
                      {formatDatePT(gc.startDate)} a {formatDatePT(gc.endDate)} · Fechado por{' '}
                      {gc.closedByName} em {formatDateTimePT(gc.closedAt)}
                    </div>
                  </div>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        setCorrectingId(gc.id);
                        setCorrAction('CORRECAO');
                        setCorrNewTotal(String(gc.totalCountedCash));
                        setCorrReason('');
                      }}
                      className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 font-medium rounded-lg"
                    >
                      Correção / Reabertura Autorizada
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono tabular-nums">
                  <div>
                    <div className="font-sans text-slate-500 dark:text-slate-400">Vendas Totais</div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      {formatMoney(gc.totalSales, cur)}
                    </div>
                  </div>
                  <div>
                    <div className="font-sans text-slate-500 dark:text-slate-400">Devoluções ({gc.cancellationsCount} anul.)</div>
                    <div className="font-semibold text-red-700 dark:text-red-400">
                      -{formatMoney(gc.returnsTotal, cur)}
                    </div>
                  </div>
                  <div>
                    <div className="font-sans text-slate-500 dark:text-slate-400">Dinheiro Esperado</div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">{formatMoney(gc.totalExpectedCash, cur)}</div>
                  </div>
                  <div>
                    <div className="font-sans text-slate-500 dark:text-slate-400">Dinheiro Contado</div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">{formatMoney(gc.totalCountedCash, cur)}</div>
                  </div>
                  <div>
                    <div className="font-sans text-slate-500 dark:text-slate-400">Diferença</div>
                    <div
                      className={`font-semibold ${
                        gc.totalDifference < 0
                          ? 'text-red-700 dark:text-red-400'
                          : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {formatMoney(gc.totalDifference, cur)}
                    </div>
                  </div>
                </div>

                {gc.corrections.length > 0 && (
                  <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-1">
                    <p className="font-semibold text-slate-700 dark:text-slate-300">Histórico de Correções:</p>
                    {gc.corrections.map((cor) => (
                      <div key={cor.id} className="text-slate-600 dark:text-slate-400">
                        [{cor.action}] {cor.reason} — {cor.userName} ({formatDateTimePT(cor.timestamp)})
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {generalClosings.length === 0 && (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center text-sm text-slate-500 dark:text-slate-400">
                Nenhum fecho geral registado.
              </div>
            )}
          </div>

          {correctingId && (
            <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-2xl">
                <h3 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                  Correção Autorizada de Fecho Geral
                </h3>
                <form onSubmit={handleCorrectionSubmit} className="space-y-3 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Ação</label>
                    <select
                      value={corrAction}
                      onChange={(e) => setCorrAction(e.target.value as any)}
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                    >
                      <option value="CORRECAO">Corrigir Valor Contado</option>
                      <option value="REABERTURA">Reabrir Período</option>
                    </select>
                  </div>
                  {corrAction === 'CORRECAO' && (
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Novo Total Contado ({cur})
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        required
                        value={corrNewTotal}
                        onChange={(e) => setCorrNewTotal(e.target.value)}
                        className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Motivo da Correção (Obrigatório) *
                    </label>
                    <textarea
                      required
                      rows={2}
                      value={corrReason}
                      onChange={(e) => setCorrReason(e.target.value)}
                      className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setCorrectingId(null)}
                      className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white rounded-lg font-medium"
                    >
                      Confirmar Correção
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
