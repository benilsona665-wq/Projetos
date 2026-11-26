import React, { useMemo, useState } from 'react';
import { CheckCircle2, FileCheck2, Lock, Printer, RotateCcw, Search, ShieldAlert, Unlock, X } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { ApiError, apiFetch } from '../lib/api';
import {
  buyerAckMethodLabel,
  fiscalStatusLabel,
  formatDatePT,
  formatDateTimePT,
  formatMoney,
  isInvoiceSaleType,
  saleStatusLabel,
  taxCodeLabel,
} from '../lib/format';
import type {
  BuyerAckMethod,
  CashRegisterStatusPayload,
  PharmacySettings,
  ReturnCondition,
  ReturnType,
  Sale,
  SaleReturn,
  User,
} from '../types';
import type { PrintableDocPayload } from './PrintableDocumentModal';

interface ReturnsViewProps {
  user: User;
  settings: PharmacySettings;
  sales: Sale[];
  returns: SaleReturn[];
  cashRegisterStatus?: CashRegisterStatusPayload | null;
  onOpenCashRegister?: () => void;
  onOpenVatSettings?: () => void;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onPrintDoc: (payload: PrintableDocPayload) => void;
}

export const ReturnsView: React.FC<ReturnsViewProps> = ({
  user,
  settings,
  sales,
  returns,
  cashRegisterStatus,
  onOpenCashRegister,
  onOpenVatSettings,
  onRefresh,
  onNotify,
  onPrintDoc,
}) => {
  const cur = settings.currencySymbol || 'Kz';
  const isOnline = useOnlineStatus();
  const isAdmin = user.role === 'ADMIN';
  const canReturn = isAdmin || user.permissions.canProcessReturns;
  const canCancel = isAdmin || user.permissions.canCancelSales;
  const registerBlocked = Boolean(
    cashRegisterStatus?.requiresOpenRegisterToSell && !cashRegisterStatus?.openRegister
  );
  const canOpenAnotherRegister =
    !cashRegisterStatus?.openRegister &&
    !cashRegisterStatus?.isPeriodClosed &&
    (cashRegisterStatus?.closedTodayCount ?? 0) < (cashRegisterStatus?.maxAllowedPerDay ?? 2);

  const [saleQuery, setSaleQuery] = useState('');
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [operationType, setOperationType] = useState<ReturnType>('DEVOLUCAO');
  const [reason, setReason] = useState('');
  const [lineStates, setLineStates] = useState<
    Record<string, { quantity: number; condition: ReturnCondition }>
  >({});
  const [ackConfirmed, setAckConfirmed] = useState(false);
  const [ackMethod, setAckMethod] = useState<BuyerAckMethod>('ASSINATURA_NIF');
  const [ackReference, setAckReference] = useState('');
  const [ackNotes, setAckNotes] = useState('');

  // Modal for recording buyer acknowledgement after issuance
  const [ackModalReturn, setAckModalReturn] = useState<SaleReturn | null>(null);
  const [modalAckConfirmed, setModalAckConfirmed] = useState(true);
  const [modalAckMethod, setModalAckMethod] = useState<BuyerAckMethod>('ASSINATURA_NIF');
  const [modalAckReference, setModalAckReference] = useState('');
  const [modalAckNotes, setModalAckNotes] = useState('');

  const [submitting, setSubmitting] = useState(false);

  const vatGlobalBlockedReason = useMemo(() => {
    const missingIssuer: string[] = [];
    if (!settings.nif?.trim()) missingIssuer.push('NIF');
    if (!(settings.legalName || settings.pharmacyName)?.trim()) missingIssuer.push('Denominação Legal');
    if (!settings.address?.trim()) missingIssuer.push('Sede/Endereço');
    if (missingIssuer.length > 0) {
      return `Dados fiscais da farmácia incompletos (${missingIssuer.join(', ')}). A emissão de Notas de Crédito (NC) está bloqueada até preenchimento nas Configurações.`;
    }
    if (!settings.vatRegime || settings.vatRegime === 'NAO_CONFIGURADO') {
      return 'Regime de IVA ainda não confirmado (NAO_CONFIGURADO). A emissão de Notas de Crédito (NC) por devolução ou anulação está bloqueada até confirmação do contabilista.';
    }
    return null;
  }, [settings]);

  const selectedSaleTaxBlockedReason = useMemo(() => {
    if (!selectedSale) return null;
    const unconfigured = selectedSale.items.filter((it) => !it.taxCode || it.taxCode === 'NAO_CONFIGURADO');
    if (unconfigured.length > 0) {
      return `A fatura original possui ${unconfigured.length} artigo(s) sem código de IVA configurado (${unconfigured.map((i) => i.productName).join(', ')}).`;
    }
    return null;
  }, [selectedSale]);

  const fiscalBlockedReason = vatGlobalBlockedReason || selectedSaleTaxBlockedReason;

  const returnPreview = useMemo(() => {
    if (!selectedSale) return { baseTotal: 0, taxTotal: 0, refundTotal: 0 };
    const rMoney = (n: number) => Math.round(n * 100) / 100;
    const priorForSale = returns.filter((r) => r.originalSaleId === selectedSale.id);
    let baseTotal = 0;
    let taxTotal = 0;
    let refundTotal = 0;

    for (const item of selectedSale.items) {
      const remaining = item.quantity - (item.returnedQuantity || 0);
      const st = lineStates[item.productId] || { quantity: 0, condition: 'APT' };
      const qty = operationType === 'ANULACAO' ? remaining : st.quantity;
      if (qty <= 0 || remaining <= 0) continue;

      let prevRefund = 0;
      let prevTax = 0;
      for (const pr of priorForSale) {
        for (const pri of pr.items) {
          if (pri.productId === item.productId) {
            prevRefund = rMoney(prevRefund + Number(pri.refundAmount || 0));
            prevTax = rMoney(prevTax + Number(pri.taxAmount || 0));
          }
        }
      }
      const origTotal = rMoney(item.subtotal);
      const origTax = rMoney(item.taxAmount ?? 0);
      const ratio = qty / Math.max(1, item.quantity);

      const lineRefund =
        qty === remaining ? rMoney(Math.max(0, origTotal - prevRefund)) : rMoney(origTotal * ratio);
      const lineTax =
        origTax <= 0
          ? 0
          : qty === remaining
          ? rMoney(Math.max(0, origTax - prevTax))
          : rMoney(origTax * ratio);
      const lineBase = rMoney(lineRefund - lineTax);

      baseTotal = rMoney(baseTotal + lineBase);
      taxTotal = rMoney(taxTotal + lineTax);
      refundTotal = rMoney(refundTotal + lineRefund);
    }

    return { baseTotal, taxTotal, refundTotal };
  }, [selectedSale, returns, lineStates, operationType]);

  const eligibleSales = useMemo(() => {
    const q = saleQuery.trim().toLowerCase();
    return sales
      .filter((s) => isInvoiceSaleType(s.type))
      .filter((s) => {
        if (!q) return true;
        return `${s.documentNumber} ${s.customerName} ${s.sellerName}`.toLowerCase().includes(q);
      });
  }, [sales, saleQuery]);

  const selectSaleForReturn = (sale: Sale) => {
    setSelectedSale(sale);
    const hasPartial = sale.items.some((i) => (i.returnedQuantity || 0) > 0);
    setOperationType(canReturn ? 'DEVOLUCAO' : 'ANULACAO');
    setReason('');
    const init: Record<string, { quantity: number; condition: ReturnCondition }> = {};
    for (const item of sale.items) {
      const remaining = item.quantity - (item.returnedQuantity || 0);
      init[item.productId] = {
        quantity: hasPartial || !canCancel ? 0 : remaining,
        condition: 'APT',
      };
    }
    setLineStates(init);
  };

  const handleSubmitReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSale) return;
    if (registerBlocked) {
      onNotify('O caixa desta sessão está fechado. Abra o caixa antes de registar devoluções.', 'error');
      return;
    }
    if (fiscalBlockedReason) {
      onNotify(fiscalBlockedReason, 'error');
      return;
    }
    if (!reason.trim()) {
      onNotify('Indique o motivo da devolução ou anulação.', 'error');
      return;
    }

    const itemsPayload = selectedSale.items
      .map((item) => {
        const remaining = item.quantity - (item.returnedQuantity || 0);
        const st = lineStates[item.productId] || { quantity: 0, condition: 'APT' };
        const qty = operationType === 'ANULACAO' ? remaining : st.quantity;
        return {
          productId: item.productId,
          quantity: qty,
          condition: st.condition,
        };
      })
      .filter((i) => i.quantity > 0);

    if (itemsPayload.length === 0) {
      onNotify('Selecione pelo menos 1 unidade para devolver ou anular.', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const created = await apiFetch<SaleReturn>('/api/returns', {
        method: 'POST',
        body: JSON.stringify({
          originalSaleId: selectedSale.id,
          type: operationType,
          rectificationNature: operationType === 'ANULACAO' ? 'ANULACAO' : 'RECTIFICACAO',
          reason: reason.trim(),
          items: itemsPayload,
          buyerAcknowledgement: {
            confirmed: ackConfirmed,
            method: ackConfirmed ? ackMethod : 'NAO_REGISTADA',
            reference: ackReference.trim(),
            notes: ackNotes.trim(),
          },
        }),
      });
      setSelectedSale(null);
      setReason('');
      setAckConfirmed(false);
      setAckReference('');
      setAckNotes('');
      await onRefresh();
      onNotify(
        `${operationType === 'ANULACAO' ? 'Nota de Crédito (Anulação)' : 'Nota de Crédito (Rectificação)'} ${created.documentNumber} emitida com sucesso.`
      );
      onPrintDoc({ kind: 'RETURN', doc: created });
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'CASH_REGISTER_CLOSED') {
        onNotify(err.message, 'error');
        await onRefresh();
        return;
      }
      onNotify(err?.message || 'Erro ao registar operação.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const openAckModal = (r: SaleReturn) => {
    setAckModalReturn(r);
    setModalAckConfirmed(r.buyerAcknowledgement?.confirmed ?? true);
    setModalAckMethod(
      r.buyerAcknowledgement?.method && r.buyerAcknowledgement.method !== 'NAO_REGISTADA'
        ? r.buyerAcknowledgement.method
        : 'ASSINATURA_NIF'
    );
    setModalAckReference(r.buyerAcknowledgement?.reference || '');
    setModalAckNotes(r.buyerAcknowledgement?.notes || '');
  };

  const handleSaveAckModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ackModalReturn) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/returns/${ackModalReturn.id}/buyer-acknowledgement`, {
        method: 'PATCH',
        body: JSON.stringify({
          confirmed: modalAckConfirmed,
          method: modalAckConfirmed ? modalAckMethod : 'NAO_REGISTADA',
          reference: modalAckReference.trim(),
          notes: modalAckNotes.trim(),
        }),
      });
      setAckModalReturn(null);
      await onRefresh();
      onNotify('Prova de conhecimento do adquirente registada no histórico.');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao registar prova do adquirente.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
          Devoluções e Anulações
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
          Localize a fatura original, escolha o destino do stock (apto para venda ou quarentena) e emita o documento associado.
        </p>
      </div>

      {!canReturn && !canCancel && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>
            O seu perfil atual não tem permissão para registar devoluções ou anulações. Apenas pode consultar o histórico.
          </span>
        </div>
      )}

      {vatGlobalBlockedReason && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-xs text-red-900 dark:text-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{vatGlobalBlockedReason}</span>
          </div>
          {isAdmin && onOpenVatSettings && (
            <button
              type="button"
              onClick={onOpenVatSettings}
              className="px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-800 text-white font-medium text-xs whitespace-nowrap self-start sm:self-auto"
            >
              Configurar Regime de IVA
            </button>
          )}
        </div>
      )}

      {registerBlocked && (canReturn || canCancel) && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2 font-medium">
            <Lock className="w-4 h-4 shrink-0" />
            <span>
              Caixa fechado nesta sessão. Abra o caixa para poder registar devoluções ou anulações associadas ao seu turno.
            </span>
          </div>
          {canOpenAnotherRegister && onOpenCashRegister && (
            <button
              type="button"
              onClick={onOpenCashRegister}
              className="min-h-[36px] px-3 py-1.5 bg-green-700 hover:bg-green-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5 self-start sm:self-auto"
            >
              <Unlock className="w-3.5 h-3.5" />
              Abrir caixa
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Step 1: Select original invoice */}
        <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-2">
            <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
              1. Localizar Fatura Original
            </h2>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={saleQuery}
                onChange={(e) => setSaleQuery(e.target.value)}
                placeholder="Nº da fatura, cliente ou vendedor..."
                className="w-full min-h-[40px] pl-9 pr-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[420px] overflow-y-auto">
            {eligibleSales.map((s) => {
              const isLocked = s.status === 'ANULADA' || s.status === 'DEVOLVIDA';
              const isSelected = selectedSale?.id === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={isLocked || (!canReturn && !canCancel)}
                  onClick={() => selectSaleForReturn(s)}
                  className={`w-full text-left p-3.5 transition-colors flex items-center justify-between gap-3 ${
                    isSelected
                      ? 'bg-green-50 dark:bg-green-950/60'
                      : isLocked
                      ? 'bg-slate-50 dark:bg-slate-800/40 opacity-60 cursor-not-allowed'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div>
                    <div className="text-xs font-mono font-semibold text-slate-900 dark:text-slate-100">
                      {s.documentNumber} · {formatDatePT(s.date)}
                    </div>
                    <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">{s.customerName}</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {saleStatusLabel(s.status)} · {s.sellerName}
                    </div>
                  </div>
                  <div className="text-right font-mono text-xs font-semibold text-slate-900 dark:text-slate-100 shrink-0">
                    {formatMoney(s.totalAmount, cur)}
                  </div>
                </button>
              );
            })}
            {eligibleSales.length === 0 && (
              <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                Nenhuma fatura encontrada.
              </div>
            )}
          </div>
        </div>

        {/* Step 2: Process return/cancellation */}
        <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100 border-b border-slate-200 dark:border-slate-800 pb-3">
            2. Registar Devolução ou Anulação
          </h2>

          {!selectedSale ? (
            <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
              Selecione uma fatura emitida à esquerda para iniciar a devolução ou anulação.
            </div>
          ) : (
            <form onSubmit={handleSubmitReturn} className="space-y-4 text-xs">
              <div className="p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg flex flex-wrap justify-between gap-2">
                <div>
                  <span className="text-slate-500 dark:text-slate-400">Fatura: </span>
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {selectedSale.documentNumber}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400"> · Cliente: </span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">{selectedSale.customerName}</span>
                </div>
                <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                  Original: {formatMoney(selectedSale.totalAmount, cur)}
                </div>
              </div>

              <div className="flex gap-2">
                {canReturn && (
                  <button
                    type="button"
                    onClick={() => setOperationType('DEVOLUCAO')}
                    className={`flex-1 py-2 px-3 rounded-lg border font-medium ${
                      operationType === 'DEVOLUCAO'
                        ? 'bg-green-700 border-green-700 text-white'
                        : 'bg-white dark:bg-slate-950 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    Nota de Crédito («Rectificação»)
                  </button>
                )}
                {canCancel && (
                  <button
                    type="button"
                    disabled={selectedSale.items.some((i) => (i.returnedQuantity || 0) > 0)}
                    onClick={() => setOperationType('ANULACAO')}
                    className={`flex-1 py-2 px-3 rounded-lg border font-medium disabled:opacity-40 ${
                      operationType === 'ANULACAO'
                        ? 'bg-red-700 border-red-700 text-white'
                        : 'bg-white dark:bg-slate-950 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    Nota de Crédito («Anulação» Total)
                  </button>
                )}
              </div>
              {operationType === 'ANULACAO' && (
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300">
                  Nos termos do Art. 8.º do DP 71/25 e da especificação AGT, a anulação fiscal é emitida como <strong>Nota de Crédito (NC)</strong> referenciando a fatura original (a referência interna <span className="font-mono">AN</span> é mantida apenas para rastreio interno).
                </div>
              )}
              {selectedSaleTaxBlockedReason && (
                <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-[11px] text-red-800 dark:text-red-200">
                  {selectedSaleTaxBlockedReason}
                </div>
              )}

              <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                      <th className="py-2.5 px-3 font-medium">Produto</th>
                      <th className="py-2.5 px-2 font-medium">IVA</th>
                      <th className="py-2.5 px-2 font-medium text-right">Disp. Dev.</th>
                      <th className="py-2.5 px-2 font-medium text-right">Qtd a Devolver</th>
                      <th className="py-2.5 px-3 font-medium">Estado do Produto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {selectedSale.items.map((item) => {
                      const remaining = item.quantity - (item.returnedQuantity || 0);
                      const st = lineStates[item.productId] || { quantity: 0, condition: 'APT' };
                      return (
                        <tr key={item.productId}>
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-slate-900 dark:text-slate-100">{item.productName}</div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                              Vendido: {item.quantity} · Já devolvido: {item.returnedQuantity || 0}
                            </div>
                          </td>
                          <td className="py-2.5 px-2 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                            {taxCodeLabel(item.taxCode, item.taxRate)}
                          </td>
                          <td className="py-2.5 px-2 text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {remaining}
                          </td>
                          <td className="py-2.5 px-2 text-right">
                            <input
                              type="number"
                              min="0"
                              max={remaining}
                              disabled={operationType === 'ANULACAO' || remaining <= 0}
                              value={operationType === 'ANULACAO' ? remaining : st.quantity}
                              onChange={(e) =>
                                setLineStates((prev) => ({
                                  ...prev,
                                  [item.productId]: {
                                    ...st,
                                    quantity: Math.min(
                                      remaining,
                                      Math.max(0, Math.floor(Number(e.target.value) || 0))
                                    ),
                                  },
                                }))
                              }
                              className="w-16 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded font-mono text-right disabled:bg-slate-100 dark:disabled:bg-slate-800/60"
                            />
                          </td>
                          <td className="py-2.5 px-3">
                            <select
                              disabled={remaining <= 0}
                              value={st.condition}
                              onChange={(e) =>
                                setLineStates((prev) => ({
                                  ...prev,
                                  [item.productId]: {
                                    ...st,
                                    condition: e.target.value as ReturnCondition,
                                  },
                                }))
                              }
                              className="w-full min-h-[34px] px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded text-xs"
                            >
                              <option value="APT">Apto para venda (volta ao stock)</option>
                              <option value="QUARANTINE">Não vendável / Quarentena</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <div>
                  <span className="text-slate-500 dark:text-slate-400">Base Tributável a Reverter: </span>
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {formatMoney(returnPreview.baseTotal, cur)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-slate-400">IVA a Creditar: </span>
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {formatMoney(returnPreview.taxTotal, cur)}
                  </span>
                </div>
                <div className="sm:text-right">
                  <span className="text-slate-500 dark:text-slate-400">Total Nota de Crédito: </span>
                  <span className="font-mono font-bold text-red-700 dark:text-red-400">
                    {formatMoney(returnPreview.refundTotal, cur)}
                  </span>
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Motivo da {operationType === 'ANULACAO' ? 'Anulação' : 'Rectificação / Devolução'} *
                </label>
                <textarea
                  required
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Descreva o motivo (obrigatório para auditoria e Art. 8.º DP 71/25)..."
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                />
              </div>

              <div className="p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg space-y-2.5">
                <label className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-200">
                  <input
                    type="checkbox"
                    checked={ackConfirmed}
                    onChange={(e) => setAckConfirmed(e.target.checked)}
                  />
                  <span>Prova de Conhecimento do Adquirente obtida no ato (Art. 8.º DP 71/25)</span>
                </label>
                {ackConfirmed ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                    <div>
                      <label className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1">Meio de Prova *</label>
                      <select
                        value={ackMethod}
                        onChange={(e) => setAckMethod(e.target.value as BuyerAckMethod)}
                        className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded text-xs"
                      >
                        <option value="ASSINATURA_NIF">Assinatura + NIF no Documento</option>
                        <option value="CARIMBO_EMPRESA">Carimbo e Rubrica do Adquirente</option>
                        <option value="EMAIL">Correio Electrónico</option>
                        <option value="CARTA">Carta / Protocolo</option>
                        <option value="OUTRO">Outro Meio Documentado</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1">Referência / Nº Protocolo</label>
                      <input
                        value={ackReference}
                        onChange={(e) => setAckReference(e.target.value)}
                        placeholder="ex.: Assinado ao balcão / Ref. e-mail"
                        className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded text-xs"
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Pode emitir o documento agora e registar a prova de conhecimento do adquirente posteriormente na lista abaixo.
                  </p>
                )}
              </div>

              {!isOnline && (
                <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-xs font-medium text-amber-900 dark:text-amber-200">
                  Sem ligação à internet: devoluções e anulações estão bloqueadas no modo offline.
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedSale(null)}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting || !isOnline || registerBlocked || Boolean(fiscalBlockedReason)}
                  className="px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-1.5"
                >
                  <RotateCcw className="w-4 h-4" />
                  {submitting
                    ? 'A processar...'
                    : operationType === 'ANULACAO'
                    ? 'Emitir NC de Anulação'
                    : 'Confirmar Devolução (NC)'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Audit History of Returns */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
            Histórico de Devoluções e Anulações ({returns.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                <th className="py-3 px-4 font-medium">Documento / Natureza</th>
                <th className="py-3 px-3 font-medium">Fatura Original</th>
                <th className="py-3 px-3 font-medium">Data / Operador</th>
                <th className="py-3 px-3 font-medium">Artigos e Destino</th>
                <th className="py-3 px-3 font-medium">Motivo & Prova Adquirente</th>
                <th className="py-3 px-3 font-medium text-right">Valor</th>
                <th className="py-3 px-4 font-medium text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {returns.map((r) => {
                const ackOk = Boolean(r.buyerAcknowledgement?.confirmed);
                return (
                  <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="py-3 px-4 font-mono">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{r.documentNumber}</div>
                      {r.internalCancellationRef && (
                        <div className="text-[10px] text-slate-500 dark:text-slate-400">
                          Ref. interna: {r.internalCancellationRef}
                        </div>
                      )}
                      <div className={r.type === 'ANULACAO' ? 'text-red-700 dark:text-red-400 font-semibold' : 'text-amber-700 dark:text-amber-400 font-semibold'}>
                        «{r.rectificationNature || (r.type === 'ANULACAO' ? 'ANULAÇÃO' : 'RECTIFICAÇÃO')}»
                      </div>
                      <div className="text-[10px] font-sans text-slate-500 dark:text-slate-400">
                        {fiscalStatusLabel(r.fiscalValidationStatus)}
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono text-slate-700 dark:text-slate-300">{r.originalDocumentNumber}</td>
                    <td className="py-3 px-3 text-slate-700 dark:text-slate-300">
                      <div>{formatDateTimePT(r.createdAt)}</div>
                      <div className="text-slate-500 dark:text-slate-400">{r.userName}</div>
                    </td>
                    <td className="py-3 px-3 text-slate-700 dark:text-slate-300">
                      {r.items.map((it, idx) => (
                        <div key={idx}>
                          {it.quantity}x {it.productName} —{' '}
                          <span className={it.condition === 'APT' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
                            {it.condition === 'APT' ? 'Stock vendável' : 'Quarentena'}
                          </span>
                        </div>
                      ))}
                    </td>
                    <td className="py-3 px-3 text-slate-700 dark:text-slate-300 max-w-xs space-y-1">
                      <div>{r.reason}</div>
                      <div className="text-[11px]">
                        {ackOk ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Prova: {buyerAckMethodLabel(r.buyerAcknowledgement?.method)}
                            {r.buyerAcknowledgement?.reference ? ` (${r.buyerAcknowledgement.reference})` : ''}
                          </span>
                        ) : (
                          <span className="text-amber-700 dark:text-amber-400 font-medium">
                            Prova do adquirente pendente
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                      {formatMoney(r.totalRefund, cur)}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openAckModal(r)}
                          className="p-2 text-slate-600 dark:text-slate-400 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                          title="Registar / atualizar prova de conhecimento do adquirente"
                        >
                          <FileCheck2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onPrintDoc({ kind: 'RETURN', doc: r })}
                          className="p-2 text-slate-600 dark:text-slate-400 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                          title="Imprimir / PDF"
                        >
                          <Printer className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {returns.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500 dark:text-slate-400">
                    Nenhuma devolução ou anulação registada.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {ackModalReturn && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-2xl text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                Prova do Adquirente — {ackModalReturn.documentNumber}
              </h3>
              <button
                type="button"
                onClick={() => setAckModalReturn(null)}
                className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveAckModal} className="space-y-3">
              <p className="text-slate-600 dark:text-slate-400">
                Nos termos do Art. 8.º do Decreto Presidencial n.º 71/25, a dedução ou anulação deve possuir prova de que o adquirente tomou conhecimento da retificação/anulação.
              </p>
              <label className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={modalAckConfirmed}
                  onChange={(e) => setModalAckConfirmed(e.target.checked)}
                />
                <span>Confirmar receção / conhecimento pelo adquirente</span>
              </label>
              {modalAckConfirmed && (
                <>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Meio de Prova *</label>
                    <select
                      value={modalAckMethod}
                      onChange={(e) => setModalAckMethod(e.target.value as BuyerAckMethod)}
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
                    >
                      <option value="ASSINATURA_NIF">Assinatura + NIF no Documento</option>
                      <option value="CARIMBO_EMPRESA">Carimbo e Rubrica do Adquirente</option>
                      <option value="EMAIL">Correio Electrónico</option>
                      <option value="CARTA">Carta / Protocolo</option>
                      <option value="OUTRO">Outro Meio Documentado</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Referência / Protocolo</label>
                    <input
                      value={modalAckReference}
                      onChange={(e) => setModalAckReference(e.target.value)}
                      placeholder="ex.: E-mail enviado em ..., Protocolo nº..."
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Observações</label>
                    <textarea
                      rows={2}
                      value={modalAckNotes}
                      onChange={(e) => setModalAckNotes(e.target.value)}
                      className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
                    />
                  </div>
                </>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAckModalReturn(null)}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-green-700 hover:bg-green-800 text-white rounded-lg font-medium"
                >
                  {submitting ? 'A guardar...' : 'Guardar Prova'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
