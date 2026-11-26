import React, { useMemo, useState } from 'react';
import { Check, ClipboardCheck, ShieldAlert, X } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { apiFetch } from '../lib/api';
import { formatDateTimePT, formatMoney } from '../lib/format';
import type {
  InventoryScope,
  InventorySession,
  PharmacySettings,
  PharmacologicalClass,
  Product,
  User,
} from '../types';

interface InventoryViewProps {
  user: User;
  settings: PharmacySettings;
  products: Product[];
  classes: PharmacologicalClass[];
  inventories: InventorySession[];
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const InventoryView: React.FC<InventoryViewProps> = ({
  user,
  settings,
  products,
  classes,
  inventories,
  onRefresh,
  onNotify,
}) => {
  const isAdmin = user.role === 'ADMIN';
  const isOnline = useOnlineStatus();
  const canCount = isAdmin || user.permissions.canStartInventoryCount;
  const cur = settings.currencySymbol || 'Kz';

  const [tab, setTab] = useState<'COUNT' | 'HISTORY'>('COUNT');
  const [scope, setScope] = useState<InventoryScope>('ALL');
  const [scopeFilter, setScopeFilter] = useState('');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const classMap = useMemo(() => new Map(classes.map((c) => [c.id, c.name])), [classes]);
  const locations = useMemo(
    () => Array.from(new Set(products.map((p) => p.location).filter(Boolean))).sort(),
    [products]
  );

  const scopedProducts = useMemo(() => {
    return products.filter((p) => {
      if (!p.active) return false;
      if (scope === 'CLASS' && scopeFilter && p.classId !== scopeFilter) return false;
      if (scope === 'LOCATION' && scopeFilter && p.location !== scopeFilter) return false;
      return true;
    });
  }, [products, scope, scopeFilter]);

  const previewRows = useMemo(() => {
    return scopedProducts.map((p) => {
      const raw = counts[p.id];
      const counted = raw === undefined || raw === '' ? p.stock : Math.max(0, Math.floor(Number(raw)));
      const diff = counted - p.stock;
      return {
        product: p,
        counted,
        diff,
      };
    });
  }, [scopedProducts, counts]);

  const discrepancyCount = previewRows.filter((r) => r.diff !== 0).length;

  const handleSubmitCount = async (approveImmediately: boolean) => {
    if (scopedProducts.length === 0) {
      onNotify('Não existem produtos no âmbito selecionado.', 'error');
      return;
    }
    if (discrepancyCount > 0 && !reason.trim()) {
      onNotify('Indique o motivo das diferenças encontradas antes de submeter.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const scopeLabel =
        scope === 'CLASS'
          ? classMap.get(scopeFilter) || 'Todas as classes'
          : scope === 'LOCATION'
          ? scopeFilter || 'Todas as localizações'
          : 'Todos os produtos';

      await apiFetch('/api/inventories', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          scopeFilter: scopeLabel,
          reason: reason.trim(),
          notes: notes.trim(),
          approveImmediately,
          items: previewRows.map((r) => ({
            productId: r.product.id,
            countedQty: r.counted,
            notes: itemNotes[r.product.id] || '',
          })),
        }),
      });
      setCounts({});
      setItemNotes({});
      setReason('');
      setNotes('');
      await onRefresh();
      onNotify(
        approveImmediately
          ? 'Inventário registado e stock ajustado com sucesso.'
          : 'Contagem registada e enviada para aprovação do Administrador.'
      );
      setTab('HISTORY');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao registar inventário.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApprove = async (id: string) => {
    try {
      await apiFetch(`/api/inventories/${id}/approve`, { method: 'POST' });
      await onRefresh();
      onNotify('Ajustes de inventário aprovados e aplicados ao stock.');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao aprovar inventário.', 'error');
    }
  };

  const handleReject = async (id: string) => {
    try {
      await apiFetch(`/api/inventories/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Rejeitado durante conferência do administrador' }),
      });
      await onRefresh();
      onNotify('Contagem rejeitada sem alterar o stock.');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao rejeitar inventário.', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
            Inventário e Ajustes de Stock
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Confronto entre stock do sistema e contagem física. Ajustes efetivos exigem autorização do Administrador.
          </p>
        </div>

        <div className="inline-flex p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setTab('COUNT')}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'COUNT'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Nova Contagem
          </button>
          <button
            type="button"
            onClick={() => setTab('HISTORY')}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'HISTORY'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Histórico de Inventários ({inventories.length})
          </button>
        </div>
      </div>

      {tab === 'COUNT' ? (
        !canCount ? (
          <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>Não tem permissão para iniciar contagens de inventário.</span>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Step 1: Scope selection */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  1. Âmbito do Inventário
                </label>
                <select
                  value={scope}
                  onChange={(e) => {
                    const next = e.target.value as InventoryScope;
                    setScope(next);
                    if (next === 'CLASS') setScopeFilter(classes[0]?.id || '');
                    else if (next === 'LOCATION') setScopeFilter(locations[0] || '');
                    else setScopeFilter('');
                  }}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
                >
                  <option value="ALL">Todos os produtos ativos</option>
                  <option value="CLASS">Por classe farmacológica</option>
                  <option value="LOCATION">Por localização / prateleira</option>
                </select>
              </div>

              {scope === 'CLASS' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Selecionar Classe
                  </label>
                  <select
                    value={scopeFilter}
                    onChange={(e) => setScopeFilter(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
                  >
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {scope === 'LOCATION' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Selecionar Localização
                  </label>
                  <select
                    value={scopeFilter}
                    onChange={(e) => setScopeFilter(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
                  >
                    {locations.map((loc) => (
                      <option key={loc} value={loc}>
                        {loc}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="text-xs text-slate-600 dark:text-slate-400 sm:text-right">
                Produtos no âmbito: <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{scopedProducts.length}</span> ·{' '}
                Divergências: <span className="font-mono font-semibold text-amber-700 dark:text-amber-400">{discrepancyCount}</span>
              </div>
            </div>

            {/* Steps 2-5: Comparison table */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                      <th className="py-3 px-4 font-medium">Produto / Localização</th>
                      <th className="py-3 px-3 font-medium text-right">Stock Sistema</th>
                      <th className="py-3 px-3 font-medium text-right">Qtd Física Contada</th>
                      <th className="py-3 px-3 font-medium text-right">Diferença</th>
                      <th className="py-3 px-4 font-medium">Observação do item</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {previewRows.map(({ product, counted, diff }) => (
                      <tr key={product.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-slate-900 dark:text-slate-100">{product.name}</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            <span className="font-mono">{product.code}</span> · {product.location} ·{' '}
                            {classMap.get(product.classId) || 'Geral'}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-medium text-slate-900 dark:text-slate-200">
                          {product.stock}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <input
                            type="number"
                            min="0"
                            value={counts[product.id] ?? String(product.stock)}
                            onChange={(e) =>
                              setCounts((prev) => ({ ...prev, [product.id]: e.target.value }))
                            }
                            className="w-20 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded font-mono text-right"
                          />
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-semibold">
                          {diff === 0 && <span className="text-slate-500 dark:text-slate-400">0 (Certo)</span>}
                          {diff < 0 && <span className="text-red-700 dark:text-red-400">{diff} (Falta)</span>}
                          {diff > 0 && <span className="text-emerald-700 dark:text-emerald-400">+{diff} (Sobra)</span>}
                        </td>
                        <td className="py-2.5 px-4">
                          <input
                            value={itemNotes[product.id] || ''}
                            onChange={(e) =>
                              setItemNotes((prev) => ({ ...prev, [product.id]: e.target.value }))
                            }
                            placeholder="Opcional..."
                            className="w-full min-w-[140px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded text-xs"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Steps 6-7: Reason & Confirm */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Motivo das Diferenças {discrepancyCount > 0 ? '*' : '(opcional)'}
                  </label>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="ex.: Quebra, erro de lançamento, expiração..."
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Observações Gerais</label>
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Notas adicionais da contagem..."
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                  />
                </div>
              </div>

              {!isOnline && (
                <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-xs font-medium text-amber-900 dark:text-amber-200">
                  Sem ligação à internet: alterações de stock por inventário estão bloqueadas no modo offline.
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  disabled={submitting || !isOnline}
                  onClick={() => handleSubmitCount(false)}
                  className="px-4 py-2.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 text-slate-800 dark:text-slate-200 font-medium rounded-lg flex items-center gap-1.5"
                >
                  <ClipboardCheck className="w-4 h-4" />
                  Submeter para Aprovação
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    disabled={submitting || !isOnline}
                    onClick={() => handleSubmitCount(true)}
                    className="px-4 py-2.5 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 disabled:opacity-50 text-white font-medium rounded-lg flex items-center gap-1.5"
                  >
                    <Check className="w-4 h-4" />
                    Confirmar e Aplicar Ajustes
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      ) : (
        /* Inventory History */
        <div className="space-y-4">
          {inventories.map((inv) => (
            <div
              key={inv.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden text-xs"
            >
              <div className="px-5 py-4 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm text-slate-900 dark:text-slate-100">
                      {inv.referenceNumber}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">·</span>
                    <span
                      className={`font-semibold ${
                        inv.status === 'APROVADO'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : inv.status === 'REJEITADO'
                          ? 'text-red-700 dark:text-red-400'
                          : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {inv.status === 'APROVADO'
                        ? 'Aprovado e Aplicado'
                        : inv.status === 'REJEITADO'
                        ? 'Rejeitado'
                        : 'Aguarda Aprovação do Administrador'}
                    </span>
                  </div>
                  <div className="text-slate-600 dark:text-slate-400">
                    Contado por {inv.countedByName} em {formatDateTimePT(inv.countedAt)} · Âmbito:{' '}
                    {inv.scopeFilter || inv.scope}
                  </div>
                  {inv.reason && (
                    <div className="text-slate-700 dark:text-slate-300">
                      <span className="font-medium">Motivo:</span> {inv.reason}
                    </div>
                  )}
                  {inv.approvedByName && (
                    <div className="text-slate-500 dark:text-slate-400">
                      Processado por {inv.approvedByName} em {formatDateTimePT(inv.approvedAt)}
                    </div>
                  )}
                </div>

                {isAdmin && inv.status === 'PENDENTE_APROVACAO' && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!isOnline}
                      onClick={() => handleReject(inv.id)}
                      className="px-3 py-2 bg-white dark:bg-slate-900 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 rounded-lg font-medium flex items-center gap-1"
                    >
                      <X className="w-3.5 h-3.5" /> Rejeitar
                    </button>
                    <button
                      type="button"
                      disabled={!isOnline}
                      onClick={() => handleApprove(inv.id)}
                      className="px-3 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-1"
                    >
                      <Check className="w-3.5 h-3.5" /> Aprovar Ajustes
                    </button>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                      <th className="py-2 px-4 font-medium">Produto</th>
                      <th className="py-2 px-3 font-medium text-right">Antes</th>
                      <th className="py-2 px-3 font-medium text-right">Contado</th>
                      <th className="py-2 px-3 font-medium text-right">Depois</th>
                      <th className="py-2 px-3 font-medium text-right">Diferença</th>
                      <th className="py-2 px-4 font-medium text-right">Impacto Custo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {inv.items.map((it) => (
                      <tr key={it.productId}>
                        <td className="py-2 px-4">
                          <span className="font-medium text-slate-900 dark:text-slate-100">{it.productName}</span>{' '}
                          <span className="font-mono text-slate-500 dark:text-slate-400">({it.productCode})</span>
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-slate-700 dark:text-slate-300">{it.beforeQty}</td>
                        <td className="py-2 px-3 text-right font-mono text-slate-700 dark:text-slate-300">{it.countedQty}</td>
                        <td className="py-2 px-3 text-right font-mono font-semibold text-slate-900 dark:text-slate-100">{it.afterQty}</td>
                        <td
                          className={`py-2 px-3 text-right font-mono font-semibold ${
                            it.difference < 0
                              ? 'text-red-700 dark:text-red-400'
                              : it.difference > 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {it.difference > 0 ? `+${it.difference}` : it.difference}
                        </td>
                        <td className="py-2 px-4 text-right font-mono text-slate-700 dark:text-slate-300">
                          {formatMoney(it.differenceValue, cur)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {inventories.length === 0 && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center text-sm text-slate-500 dark:text-slate-400">
              Nenhum inventário registado até ao momento.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
