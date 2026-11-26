import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ClipboardCheck,
  FileText,
  Lock,
  Package,
  PackagePlus,
  ShoppingCart,
  Unlock,
  Wallet,
} from 'lucide-react';
import {
  formatDatePT,
  formatDateTimePT,
  formatMoney,
  getProductAlerts,
  isInvoiceSaleType,
  todayLocalISO,
} from '../lib/format';
import type {
  AuditLogEntry,
  CashRegisterStatusPayload,
  PharmacySettings,
  PharmacologicalClass,
  Product,
  Sale,
  SaleReturn,
  SellerClosing,
  User,
} from '../types';

export type NavSection =
  | 'dashboard'
  | 'pos'
  | 'proformas'
  | 'products'
  | 'suppliers'
  | 'customers'
  | 'returns'
  | 'inventory'
  | 'reports'
  | 'closings'
  | 'settings';

interface DashboardViewProps {
  user: User;
  settings: PharmacySettings;
  products: Product[];
  classes: PharmacologicalClass[];
  sales: Sale[];
  returns: SaleReturn[];
  closings: SellerClosing[];
  cashRegisterStatus?: CashRegisterStatusPayload | null;
  auditLogs: AuditLogEntry[];
  onNavigate: (section: NavSection) => void;
  onOpenPurchaseEntry?: () => void;
  onOpenCashRegister?: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  user,
  settings,
  products,
  classes,
  sales,
  returns,
  closings,
  cashRegisterStatus,
  auditLogs,
  onNavigate,
  onOpenPurchaseEntry,
  onOpenCashRegister,
}) => {
  const cur = settings.currencySymbol || 'Kz';
  const today = todayLocalISO();

  const todayInvoices = sales.filter((s) => isInvoiceSaleType(s.type) && s.date === today);
  const todaySalesTotal = todayInvoices.reduce((acc, s) => acc + s.totalAmount, 0);
  const todayReturnsTotal = returns
    .filter((r) => r.date === today)
    .reduce((acc, r) => acc + r.totalRefund, 0);
  const openProformas = sales.filter((s) => s.type === 'PROFORMA' && s.status === 'PROFORMA');

  const activeProducts = products.filter((p) => p.active);
  const alertList = activeProducts
    .map((p) => ({ product: p, alerts: getProductAlerts(p, settings.expiryWarningDays) }))
    .filter((x) => x.alerts.isOut || x.alerts.isLow || x.alerts.isExpired || x.alerts.isExpiringSoon);

  const outCount = alertList.filter((x) => x.alerts.isOut).length;
  const lowCount = alertList.filter((x) => x.alerts.isLow).length;
  const expiringCount = alertList.filter(
    (x) => x.alerts.isExpired || x.alerts.isExpiringSoon
  ).length;

  const myClosingsToday = closings.filter(
    (c) => c.date === today && c.sellerId === user.id && (c.status || 'FECHADO') === 'FECHADO'
  );
  const openRegister = cashRegisterStatus?.openRegister || null;
  const canOpenAnotherRegister =
    !openRegister &&
    !cashRegisterStatus?.isPeriodClosed &&
    (cashRegisterStatus?.closedTodayCount ?? myClosingsToday.length) <
      (cashRegisterStatus?.maxAllowedPerDay ?? 2);
  const classMap = new Map(classes.map((c) => [c.id, c.name]));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
            Painel Principal
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            {settings.pharmacyName} · Stock Management System — Bem-vindo, {user.fullName} · {formatDatePT(today)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {user.role === 'ADMIN' && onOpenPurchaseEntry && (
            <button
              type="button"
              onClick={onOpenPurchaseEntry}
              className="min-h-[42px] px-4 py-2 bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap shadow-sm"
            >
              <PackagePlus className="w-4 h-4" />
              Registar compra / Entrada de stock
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('pos')}
            className="min-h-[42px] px-4 py-2 bg-green-800 hover:bg-green-900 dark:bg-green-700 dark:hover:bg-green-600 text-white text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
          >
            <ShoppingCart className="w-4 h-4" />
            Nova Venda / Proforma
          </button>
          {openRegister ? (
            <button
              type="button"
              onClick={() => onNavigate('closings')}
              className="min-h-[42px] px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
            >
              <Lock className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Fechar caixa ({openRegister.shiftLabel})
            </button>
          ) : canOpenAnotherRegister ? (
            <button
              type="button"
              onClick={() => (onOpenCashRegister ? onOpenCashRegister() : onNavigate('closings'))}
              className="min-h-[42px] px-4 py-2 bg-white dark:bg-slate-900 border border-green-700 dark:border-green-500 hover:bg-green-50 dark:hover:bg-green-950/40 text-green-800 dark:text-green-300 text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
            >
              <Unlock className="w-4 h-4" />
              Abrir caixa ({myClosingsToday.length}/2)
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('closings')}
              className="min-h-[42px] px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
            >
              <Wallet className="w-4 h-4" />
              Caixa e Fechos ({myClosingsToday.length}/2)
            </button>
          )}
        </div>
      </div>

      {/* Cash Register Status Banner */}
      {cashRegisterStatus && (
        <div
          className={`rounded-xl border p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 ${
            openRegister
              ? 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800'
              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'
          }`}
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              {openRegister ? (
                <Unlock className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
              ) : (
                <Lock className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0" />
              )}
              <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
                {openRegister
                  ? `Caixa Aberto — ${openRegister.shiftLabel}`
                  : cashRegisterStatus.isPeriodClosed
                  ? 'Período de Hoje Encerrado'
                  : cashRegisterStatus.closedTodayCount >= cashRegisterStatus.maxAllowedPerDay
                  ? 'Limite Diário de Fechos Atingido'
                  : 'Caixa da Sessão Fechado'}
              </h2>
            </div>

            {openRegister ? (
              <p className="text-xs text-slate-700 dark:text-slate-300 tabular-nums">
                Aberto em {formatDateTimePT(openRegister.openedAt || openRegister.createdAt)} · Valor inicial:{' '}
                <strong className="font-mono">{formatMoney(openRegister.openingBalance, cur)}</strong> · Esperado em caixa:{' '}
                <strong className="font-mono text-emerald-800 dark:text-emerald-300">
                  {formatMoney(openRegister.expectedCash, cur)}
                </strong>{' '}
                · Vendas no turno: <strong className="font-mono">{openRegister.salesCount}</strong>
              </p>
            ) : cashRegisterStatus.isPeriodClosed ? (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                O período de hoje foi encerrado pelo Fecho Geral ({cashRegisterStatus.closedPeriodRef}).
              </p>
            ) : cashRegisterStatus.closedTodayCount >= cashRegisterStatus.maxAllowedPerDay ? (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Já realizou {cashRegisterStatus.closedTodayCount}/{cashRegisterStatus.maxAllowedPerDay} aberturas e fechos hoje.
              </p>
            ) : (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {user.role === 'SELLER'
                  ? 'Ainda não tem um caixa aberto nesta sessão. Abra o caixa para poder concluir vendas faturadas e registar devoluções.'
                  : 'Não tem caixa pessoal aberto neste momento. Pode abrir um caixa para registar movimentos de balcão em seu nome.'}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {openRegister ? (
              <button
                type="button"
                onClick={() => onNavigate('closings')}
                className="min-h-[38px] px-4 py-2 bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 dark:hover:bg-slate-700 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5"
              >
                <Lock className="w-3.5 h-3.5" />
                Fechar caixa
              </button>
            ) : (
              <>
                {canOpenAnotherRegister && (
                  <button
                    type="button"
                    onClick={() => (onOpenCashRegister ? onOpenCashRegister() : onNavigate('closings'))}
                    className="min-h-[38px] px-4 py-2 bg-green-700 hover:bg-green-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5"
                  >
                    <Unlock className="w-3.5 h-3.5" />
                    Abrir caixa
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onNavigate('closings')}
                  className="min-h-[38px] px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-medium rounded-lg"
                >
                  Ver Histórico
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Vendas Faturadas Hoje</p>
          <p className="text-2xl font-mono font-semibold text-slate-900 dark:text-slate-100 mt-2">
            {formatMoney(todaySalesTotal, cur)}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
            {todayInvoices.length} fatura(s) · Devoluções: {formatMoney(todayReturnsTotal, cur)}
          </p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Proformas em Aberto</p>
          <p className="text-2xl font-mono font-semibold text-slate-900 dark:text-slate-100 mt-2">
            {openProformas.length}
          </p>
          <button
            type="button"
            onClick={() => onNavigate('proformas')}
            className="text-xs font-medium text-green-700 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 mt-2 inline-flex items-center gap-1"
          >
            Consultar proformas <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Alertas de Stock</p>
          <p className="text-2xl font-mono font-semibold text-slate-900 dark:text-slate-100 mt-2">
            {outCount + lowCount}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
            <span className="text-red-700 dark:text-red-400 font-medium">{outCount} sem stock</span> ·{' '}
            <span className="text-amber-700 dark:text-amber-400 font-medium">{lowCount} stock baixo</span>
          </p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Validades a Vigiar</p>
          <p className="text-2xl font-mono font-semibold text-slate-900 dark:text-slate-100 mt-2">
            {expiringCount}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
            Prazo até {settings.expiryWarningDays} dias ou expirados
          </p>
        </div>
      </div>

      {/* Main grid: Alerts + Quick Actions / Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Alerts Table */}
        <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
                Produtos em Alerta (Stock e Validade)
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('products')}
              className="text-xs font-medium text-green-700 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 whitespace-nowrap"
            >
              Ver catálogo
            </button>
          </div>

          {alertList.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
              Todos os produtos ativos estão com stock adequado e validade regular.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                    <th className="py-2.5 px-4 font-medium">Produto</th>
                    <th className="py-2.5 px-3 font-medium text-right">Stock / Mín.</th>
                    <th className="py-2.5 px-3 font-medium">Validade</th>
                    <th className="py-2.5 px-4 font-medium">Situação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {alertList.slice(0, 7).map(({ product, alerts }) => (
                    <tr key={product.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-slate-900 dark:text-slate-100">{product.name}</div>
                        <div className="text-slate-500 dark:text-slate-400">
                          {product.code} · {classMap.get(product.classId) || 'Geral'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-slate-900 dark:text-slate-200">
                        {product.stock} / {product.minStock}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-600 dark:text-slate-400">
                        {formatDatePT(product.expiryDate)}
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="space-y-0.5">
                          {alerts.isOut && (
                            <div className="text-red-700 dark:text-red-400 font-medium">Sem stock</div>
                          )}
                          {alerts.isLow && (
                            <div className="text-amber-700 dark:text-amber-400 font-medium">Stock baixo</div>
                          )}
                          {alerts.isExpired && (
                            <div className="text-red-700 dark:text-red-400 font-medium">Expirado</div>
                          )}
                          {alerts.isExpiringSoon && (
                            <div className="text-amber-700 dark:text-amber-400 font-medium">Validade próxima</div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Shortcuts & Recent Audit */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
              Acessos Rápidos
            </h2>
            <div className="grid grid-cols-2 gap-2.5">
              {user.role === 'ADMIN' && onOpenPurchaseEntry && (
                <button
                  type="button"
                  onClick={onOpenPurchaseEntry}
                  className="col-span-2 p-3 text-left border border-green-300 dark:border-green-800 bg-green-50/70 dark:bg-green-950/40 hover:border-green-700 dark:hover:border-green-500 hover:bg-green-50 dark:hover:bg-green-950/60 rounded-lg transition-colors flex items-center justify-between gap-3"
                >
                  <div>
                    <div className="text-xs font-semibold text-green-900 dark:text-green-200 flex items-center gap-1.5">
                      <PackagePlus className="w-4 h-4 text-green-700 dark:text-green-400" />
                      Registar compra / Entrada de stock
                    </div>
                    <div className="text-[11px] text-green-800/80 dark:text-green-300/80 mt-0.5">
                      Aumentar stock através de compra com fornecedor, lote e validade
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-green-700 dark:text-green-400 shrink-0" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onNavigate('products')}
                className="p-3 text-left border border-slate-200 dark:border-slate-800 hover:border-green-700 dark:hover:border-green-500 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors"
              >
                <Package className="w-4 h-4 text-green-700 dark:text-green-400 mb-1.5" />
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">Produtos e Stock</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">{activeProducts.length} ativos</div>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('inventory')}
                className="p-3 text-left border border-slate-200 dark:border-slate-800 hover:border-green-700 dark:hover:border-green-500 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors"
              >
                <ClipboardCheck className="w-4 h-4 text-green-700 dark:text-green-400 mb-1.5" />
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">Inventário</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Contagem e ajustes</div>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('reports')}
                className="p-3 text-left border border-slate-200 dark:border-slate-800 hover:border-green-700 dark:hover:border-green-500 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors"
              >
                <FileText className="w-4 h-4 text-green-700 dark:text-green-400 mb-1.5" />
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">Relatórios</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">PDF, Excel e impressão</div>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('returns')}
                className="p-3 text-left border border-slate-200 dark:border-slate-800 hover:border-green-700 dark:hover:border-green-500 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors"
              >
                <AlertTriangle className="w-4 h-4 text-green-700 dark:text-green-400 mb-1.5" />
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">Devoluções</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Notas e anulações</div>
              </button>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
                Últimos Registos
              </h2>
              {user.role === 'ADMIN' && (
                <button
                  type="button"
                  onClick={() => onNavigate('settings')}
                  className="text-xs font-medium text-green-700 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300"
                >
                  Ver auditoria
                </button>
              )}
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {auditLogs.slice(0, 5).map((log) => (
                <div key={log.id} className="px-5 py-3 text-xs space-y-0.5">
                  <div className="font-medium text-slate-900 dark:text-slate-100">{log.description}</div>
                  <div className="text-slate-500 dark:text-slate-400">
                    {log.userName} · {formatDateTimePT(log.timestamp)}
                  </div>
                </div>
              ))}
              {auditLogs.length === 0 && (
                <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                  Sem operações registadas recentemente.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
