import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Camera,
  Edit2,
  FileSpreadsheet,
  PackagePlus,
  Plus,
  Printer,
  ScanBarcode,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { apiFetch } from '../lib/api';
import { findProductByBarcodeOrCode, normalizeBarcode } from '../lib/barcode';
import {
  calculateLineVat,
  exportToExcel,
  formatDatePT,
  formatMoney,
  resolveEffectiveProductTax,
  roundMoney,
  taxCodeLabel,
  todayLocalISO,
} from '../lib/format';
import type {
  PharmacySettings,
  Product,
  Purchase,
  Supplier,
  TaxBreakdownEntry,
  TaxCode,
  User,
} from '../types';
import { BarcodeScannerModal } from './BarcodeScannerModal';
import type { PrintableDocPayload } from './PrintableDocumentModal';

interface PurchaseFormRow {
  productId: string;
  quantity: number;
  unitCost: number;
  batch: string;
  expiryDate: string;
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode: string;
  taxExemptionReason: string;
  priceIncludesTax?: boolean;
}

interface SuppliersPurchasesViewProps {
  user: User;
  settings: PharmacySettings;
  suppliers: Supplier[];
  products: Product[];
  purchases: Purchase[];
  openPurchaseSignal?: { key: number; productId?: string } | null;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onPrintDoc: (payload: PrintableDocPayload) => void;
}

export const SuppliersPurchasesView: React.FC<SuppliersPurchasesViewProps> = ({
  user,
  settings,
  suppliers,
  products,
  purchases,
  openPurchaseSignal,
  onRefresh,
  onNotify,
  onPrintDoc,
}) => {
  const isAdmin = user.role === 'ADMIN';
  const isOnline = useOnlineStatus();
  const cur = settings.currencySymbol || 'Kz';

  const [tab, setTab] = useState<'PURCHASES' | 'SUPPLIERS'>('PURCHASES');

  // Supplier modal
  const [showSupModal, setShowSupModal] = useState(false);
  const [editingSup, setEditingSup] = useState<Supplier | null>(null);
  const [supForm, setSupForm] = useState({
    name: '',
    nif: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
  });

  // Purchase form modal
  const [showPurModal, setShowPurModal] = useState(false);
  const [purSupplierId, setPurSupplierId] = useState('');
  const [purDocNum, setPurDocNum] = useState('');
  const [purDocDate, setPurDocDate] = useState(todayLocalISO());
  const [purNotes, setPurNotes] = useState('');
  const [purPricesIncludeTax, setPurPricesIncludeTax] = useState<boolean>(Boolean(settings.pricesIncludeTax));
  const [purItems, setPurItems] = useState<PurchaseFormRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [purBarcodeQuery, setPurBarcodeQuery] = useState('');
  const [purBarcodeFeedback, setPurBarcodeFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [showPurScanner, setShowPurScanner] = useState(false);
  const purchaseSubmitLockRef = useRef(false);
  const purchaseRequestIdRef = useRef('');
  const purBarcodeInputRef = useRef<HTMLInputElement | null>(null);

  const searchablePurchaseProducts = useMemo(() => {
    const q = purBarcodeQuery.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.activeIngredient.toLowerCase().includes(q) ||
          p.code.toLowerCase().includes(q) ||
          (p.barcode || '').toLowerCase().includes(q) ||
          p.batch.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [products, purBarcodeQuery]);

  const createRequestId = () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const openSupplierModal = (s?: Supplier) => {
    if (s) {
      setEditingSup(s);
      setSupForm({
        name: s.name,
        nif: s.nif,
        phone: s.phone,
        email: s.email,
        address: s.address,
        notes: s.notes,
      });
    } else {
      setEditingSup(null);
      setSupForm({ name: '', nif: '', phone: '', email: '', address: '', notes: '' });
    }
    setShowSupModal(true);
  };

  const handleSaveSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingSup) {
        await apiFetch(`/api/suppliers/${editingSup.id}`, {
          method: 'PUT',
          body: JSON.stringify(supForm),
        });
        onNotify('Fornecedor atualizado.');
      } else {
        await apiFetch('/api/suppliers', {
          method: 'POST',
          body: JSON.stringify(supForm),
        });
        onNotify('Fornecedor registado com sucesso.');
      }
      setShowSupModal(false);
      await onRefresh();
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao guardar fornecedor.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const buildPurchaseRow = (prod: Product, quantity = 1, docDate = purDocDate): PurchaseFormRow => {
    const eff = resolveEffectiveProductTax(prod, settings, prod.batch || '', docDate);
    return {
      productId: prod.id,
      quantity,
      unitCost: prod.purchasePrice,
      batch: prod.batch || '',
      expiryDate: prod.expiryDate || '',
      taxCode: eff.taxCode,
      taxRate: eff.taxRate,
      taxExemptionCode: eff.taxExemptionCode,
      taxExemptionReason: eff.taxExemptionReason,
      priceIncludesTax: eff.priceIncludesTax,
    };
  };

  const openNewPurchase = (preselectedProductId?: string) => {
    const today = todayLocalISO();
    setTab('PURCHASES');
    setPurSupplierId(suppliers[0]?.id || '');
    setPurDocNum('');
    setPurDocDate(today);
    setPurNotes('');
    setPurPricesIncludeTax(Boolean(settings.pricesIncludeTax));
    setPurBarcodeQuery('');
    setPurBarcodeFeedback(null);
    purchaseRequestIdRef.current = createRequestId();
    purchaseSubmitLockRef.current = false;
    const targetProd =
      (preselectedProductId && products.find((p) => p.id === preselectedProductId)) || products[0];
    setPurItems(targetProd ? [buildPurchaseRow(targetProd, 10, today)] : []);
    setShowPurModal(true);
  };

  useEffect(() => {
    if (!openPurchaseSignal || !isAdmin) return;
    openNewPurchase(openPurchaseSignal.productId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPurchaseSignal?.key]);

  const addPurchaseRow = () => {
    const firstProd = products[0];
    if (!firstProd) return;
    setPurItems((prev) => [...prev, buildPurchaseRow(firstProd, 1, purDocDate)]);
  };

  const selectProductForPurchase = (match: Product, sourceLabel: string) => {
    setPurItems((prev) => {
      const idx = prev.findIndex((it) => it.productId === match.id);
      if (idx >= 0) {
        return prev.map((it, i) => (i === idx ? { ...it, quantity: it.quantity + 1 } : it));
      }
      return [...prev, buildPurchaseRow(match, 1, purDocDate)];
    });
    setPurBarcodeQuery('');
    setPurBarcodeFeedback({
      type: 'success',
      message: `${sourceLabel}: "${match.name}" (${match.barcode || match.code}) adicionado à entrada de stock.`,
    });
    purBarcodeInputRef.current?.focus();
  };

  const handlePurchaseBarcodeLookup = (rawCode: string, source: 'USB' | 'CAMERA' = 'USB') => {
    const clean = normalizeBarcode(rawCode);
    if (!clean) return;
    const match = findProductByBarcodeOrCode(products, clean);
    if (!match) {
      if (source === 'USB' && searchablePurchaseProducts.length > 0) {
        setPurBarcodeFeedback({
          type: 'success',
          message: `A mostrar ${searchablePurchaseProducts.length} produto(s) compatíveis por nome/pesquisa abaixo. Clique para selecionar ou leia um código de barras exato.`,
        });
        return;
      }
      const msg = `Código "${clean}" não encontrado no catálogo. Nenhuma compra foi criada nem o stock foi alterado; cadastre o produto em Produtos e Classes se for um novo artigo.`;
      setPurBarcodeFeedback({ type: 'error', message: msg });
      onNotify(msg, 'error');
      return;
    }

    selectProductForPurchase(
      match,
      source === 'CAMERA' ? 'Leitura por câmara' : 'Produto selecionado'
    );
  };

  const handleSavePurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (purchaseSubmitLockRef.current || saving) {
      return;
    }
    if (!purSupplierId) {
      onNotify('Selecione ou registe um fornecedor antes de confirmar a compra.', 'error');
      return;
    }
    if (purItems.length === 0) {
      onNotify('Adicione pelo menos um produto à compra.', 'error');
      return;
    }
    purchaseSubmitLockRef.current = true;
    setSaving(true);
    try {
      await apiFetch('/api/purchases', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: purSupplierId,
          documentNumber: purDocNum,
          documentDate: purDocDate,
          notes: purNotes,
          pricesIncludeTax: purPricesIncludeTax,
          items: purItems.map((it) => ({
            ...it,
            taxType: 'IVA',
            taxRate: it.taxCode === 'ISE' ? 0 : it.taxCode === 'NAO_CONFIGURADO' ? null : it.taxRate,
          })),
          requestId: purchaseRequestIdRef.current,
        }),
      });
      setShowPurModal(false);
      onNotify('Compra confirmada e stock atualizado automaticamente.');
      await onRefresh();
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao registar compra.', 'error');
    } finally {
      purchaseSubmitLockRef.current = false;
      setSaving(false);
    }
  };

  const handleExportPurchases = () => {
    exportToExcel('historico_compras.xlsx', [
      {
        name: 'Compras',
        rows: purchases.map((p) => {
          const baseTotal =
            p.subtotal !== undefined
              ? p.subtotal
              : roundMoney(p.items.reduce((acc, i) => acc + (i.taxableBase ?? i.subtotal), 0));
          const taxTotal =
            p.taxTotal !== undefined
              ? p.taxTotal
              : roundMoney(p.items.reduce((acc, i) => acc + (i.taxAmount ?? 0), 0));
          return {
            RefInterna: p.internalNumber,
            DocFornecedor: p.documentNumber,
            Data: formatDatePT(p.documentDate),
            Fornecedor: p.supplierName,
            Artigos: p.items
              .map(
                (i) =>
                  `${i.quantity}x ${i.productName} [${taxCodeLabel(i.taxCode, i.taxRate)}]`
              )
              .join('; '),
            BaseTributavel: baseTotal,
            ValorIVA: taxTotal,
            TotalComIVA: p.totalAmount,
            Responsavel: p.userName,
          };
        }),
      },
    ]);
  };

  const purchaseVatSummary = useMemo(() => {
    let baseTotal = 0;
    let taxTotal = 0;
    let grandTotal = 0;
    const groups = new Map<string, TaxBreakdownEntry>();

    const lineCalcs = purItems.map((row) => {
      const calc = calculateLineVat(row.quantity, row.unitCost, 0, row, purPricesIncludeTax);
      baseTotal = roundMoney(baseTotal + calc.taxableBase);
      taxTotal = roundMoney(taxTotal + calc.taxAmount);
      grandTotal = roundMoney(grandTotal + calc.subtotal);

      const effRate =
        row.taxCode === 'NAO_CONFIGURADO' ? null : row.taxCode === 'ISE' ? 0 : row.taxRate ?? null;
      const key = `${row.taxCode}|${effRate ?? 'NULL'}|${row.taxExemptionCode || ''}|${
        row.taxExemptionReason || ''
      }`;
      if (!groups.has(key)) {
        groups.set(key, {
          taxCode: row.taxCode,
          taxRate: effRate,
          taxExemptionCode: row.taxExemptionCode || '',
          taxExemptionReason: row.taxExemptionReason || '',
          taxableBase: 0,
          taxAmount: 0,
          total: 0,
          itemsCount: 0,
        });
      }
      const g = groups.get(key)!;
      g.taxableBase = roundMoney(g.taxableBase + calc.taxableBase);
      g.taxAmount = roundMoney(g.taxAmount + calc.taxAmount);
      g.total = roundMoney(g.taxableBase + g.taxAmount);
      g.itemsCount += 1;
      return calc;
    });

    return {
      lineCalcs,
      baseTotal,
      taxTotal,
      grandTotal,
      taxBreakdown: Array.from(groups.values()),
    };
  }, [purItems, purPricesIncludeTax]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
            Fornecedores e Compras
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Entradas de stock por compra, lotes, validades e cadastro de fornecedores.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {tab === 'PURCHASES' && (
            <>
              <button
                type="button"
                onClick={handleExportPurchases}
                className="min-h-[42px] px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
              >
                <FileSpreadsheet className="w-4 h-4" />
                Exportar Excel
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => openNewPurchase()}
                  className="min-h-[42px] px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
                >
                  <PackagePlus className="w-4 h-4" />
                  Registar compra / Entrada de stock
                </button>
              )}
            </>
          )}

          {tab === 'SUPPLIERS' && isAdmin && (
            <button
              type="button"
              onClick={() => openSupplierModal()}
              className="min-h-[42px] px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              Novo Fornecedor
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="inline-flex p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg">
        <button
          type="button"
          onClick={() => setTab('PURCHASES')}
          className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
            tab === 'PURCHASES'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          Histórico de Compras ({purchases.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('SUPPLIERS')}
          className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
            tab === 'SUPPLIERS'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          Fornecedores ({suppliers.length})
        </button>
      </div>

      {tab === 'PURCHASES' ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                  <th className="py-3 px-4 font-medium">Ref. / Doc. Fornecedor</th>
                  <th className="py-3 px-3 font-medium">Data</th>
                  <th className="py-3 px-3 font-medium">Fornecedor</th>
                  <th className="py-3 px-3 font-medium">Produtos</th>
                  <th className="py-3 px-3 font-medium text-right">Base / IVA</th>
                  <th className="py-3 px-3 font-medium text-right">Total c/ IVA</th>
                  <th className="py-3 px-3 font-medium">Responsável</th>
                  <th className="py-3 px-4 font-medium text-right">Imprimir</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {purchases.map((pur) => {
                  const baseVal =
                    pur.subtotal !== undefined
                      ? pur.subtotal
                      : roundMoney(pur.items.reduce((acc, i) => acc + (i.taxableBase ?? i.subtotal), 0));
                  const taxVal =
                    pur.taxTotal !== undefined
                      ? pur.taxTotal
                      : roundMoney(pur.items.reduce((acc, i) => acc + (i.taxAmount ?? 0), 0));
                  return (
                    <tr key={pur.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-3 px-4 font-mono">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{pur.internalNumber}</div>
                        <div className="text-slate-500 dark:text-slate-400">{pur.documentNumber}</div>
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-700 dark:text-slate-300">
                        {formatDatePT(pur.documentDate)}
                      </td>
                      <td className="py-3 px-3 font-medium text-slate-900 dark:text-slate-100">{pur.supplierName}</td>
                      <td className="py-3 px-3 text-slate-700 dark:text-slate-300">
                        <div>{pur.items.map((i) => `${i.quantity}x ${i.productName}`).join(', ')}</div>
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                          {pur.items
                            .map((i) => taxCodeLabel(i.taxCode, i.taxRate))
                            .filter((v, idx, arr) => arr.indexOf(v) === idx)
                            .join(' · ')}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-slate-600 dark:text-slate-300">
                        <div>Base: {formatMoney(baseVal, cur)}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          IVA: {formatMoney(taxVal, cur)}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                        {formatMoney(pur.totalAmount, cur)}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">{pur.userName}</td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => onPrintDoc({ kind: 'PURCHASE', doc: pur })}
                          className="p-2 text-slate-600 dark:text-slate-400 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                          title="Imprimir / PDF"
                        >
                          <Printer className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {purchases.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-slate-500 dark:text-slate-400">
                      Nenhuma compra registada.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {suppliers.map((sup) => (
            <div
              key={sup.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex items-start justify-between gap-4"
            >
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-green-700 dark:text-green-400 shrink-0" />
                  <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">{sup.name}</h3>
                </div>
                <p className="text-slate-600 dark:text-slate-400 font-mono">NIF: {sup.nif || 'Não informado'}</p>
                <p className="text-slate-600 dark:text-slate-400">
                  {sup.phone || '—'} · {sup.email || '—'}
                </p>
                <p className="text-slate-600 dark:text-slate-400">{sup.address || 'Sem endereço registado'}</p>
                {sup.notes && <p className="text-slate-500 dark:text-slate-400 pt-1">{sup.notes}</p>}
              </div>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => openSupplierModal(sup)}
                  className="p-2 text-slate-600 dark:text-slate-400 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg shrink-0"
                  title="Editar fornecedor"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Supplier Modal */}
      {showSupModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100">
                {editingSup ? 'Editar Fornecedor' : 'Novo Fornecedor'}
              </h2>
              <button
                type="button"
                onClick={() => setShowSupModal(false)}
                className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveSupplier} className="space-y-3 text-sm">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Nome *</label>
                <input
                  required
                  value={supForm.name}
                  onChange={(e) => setSupForm({ ...supForm, name: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">NIF</label>
                  <input
                    value={supForm.nif}
                    onChange={(e) => setSupForm({ ...supForm, nif: e.target.value })}
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Contactos / Tel.</label>
                  <input
                    value={supForm.phone}
                    onChange={(e) => setSupForm({ ...supForm, phone: e.target.value })}
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Email</label>
                <input
                  type="email"
                  value={supForm.email}
                  onChange={(e) => setSupForm({ ...supForm, email: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Endereço</label>
                <input
                  value={supForm.address}
                  onChange={(e) => setSupForm({ ...supForm, address: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Observações</label>
                <textarea
                  rows={2}
                  value={supForm.notes}
                  onChange={(e) => setSupForm({ ...supForm, notes: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowSupModal(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-sm font-medium text-white bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 rounded-lg"
                >
                  {saving ? 'A guardar...' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New Purchase Modal */}
      {showPurModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5 my-8 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100">
                  Registar compra / Entrada de stock
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Ao confirmar a compra, o stock aumenta automaticamente. Responsável: <span className="font-medium text-slate-800 dark:text-slate-200">{user.fullName}</span>.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPurModal(false)}
                className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {suppliers.length === 0 && (
              <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>Ainda não existe nenhum fornecedor registado. Registe um fornecedor antes de dar entrada de stock.</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowPurModal(false);
                    setTab('SUPPLIERS');
                    openSupplierModal();
                  }}
                  className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white font-medium rounded-md whitespace-nowrap"
                >
                  Novo Fornecedor
                </button>
              </div>
            )}

            {products.length === 0 && (
              <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Não existem produtos cadastrados. Cadastre primeiro o produto em Produtos e Classes.</span>
              </div>
            )}

            <form onSubmit={handleSavePurchase} className="space-y-4 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Fornecedor *
                  </label>
                  <select
                    required
                    value={purSupplierId}
                    onChange={(e) => setPurSupplierId(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                  >
                    {suppliers.length === 0 && <option value="">Sem fornecedores registados</option>}
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Nº Documento Fornecedor *
                  </label>
                  <input
                    required
                    value={purDocNum}
                    onChange={(e) => setPurDocNum(e.target.value)}
                    placeholder="ex.: FAT-2026-102"
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Data do Documento *
                  </label>
                  <input
                    required
                    type="date"
                    value={purDocDate}
                    onChange={(e) => setPurDocDate(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-lg text-xs">
                <label className="flex items-center gap-2 text-slate-800 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={purPricesIncludeTax}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setPurPricesIncludeTax(next);
                      setPurItems((prev) => prev.map((it) => ({ ...it, priceIncludesTax: next })));
                    }}
                    className="w-4 h-4 rounded accent-green-700"
                  />
                  <span>Os custos unitários indicados na fatura do fornecedor já incluem IVA</span>
                </label>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  Cada linha herda o enquadramento do produto (pode ajustar por fatura do fornecedor)
                </span>
              </div>

              <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                <div className="bg-slate-50 dark:bg-slate-800/70 px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Itens da Compra</span>
                    <button
                      type="button"
                      onClick={addPurchaseRow}
                      className="text-xs font-medium text-green-700 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" /> Adicionar linha
                    </button>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        ref={purBarcodeInputRef}
                        type="text"
                        value={purBarcodeQuery}
                        onChange={(e) => {
                          setPurBarcodeQuery(e.target.value);
                          if (purBarcodeFeedback) setPurBarcodeFeedback(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            if (purBarcodeQuery.trim()) {
                              handlePurchaseBarcodeLookup(purBarcodeQuery, 'USB');
                            }
                          }
                        }}
                        placeholder="Pesquisar produto por nome ou ler código de barras (USB + Enter)..."
                        className="w-full min-h-[38px] pl-9 pr-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-xs"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={!purBarcodeQuery.trim()}
                        onClick={() => handlePurchaseBarcodeLookup(purBarcodeQuery, 'USB')}
                        className="min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 text-slate-800 dark:text-slate-200 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <ScanBarcode className="w-3.5 h-3.5 text-green-700 dark:text-green-400" />
                        Ler Código
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowPurScanner(true)}
                        className="min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Camera className="w-3.5 h-3.5 text-green-700 dark:text-green-400" />
                        Ler Câmara
                      </button>
                    </div>
                  </div>
                  {purBarcodeQuery.trim() && searchablePurchaseProducts.length > 0 && (
                    <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-200 dark:divide-slate-800 max-h-44 overflow-y-auto">
                      {searchablePurchaseProducts.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => selectProductForPurchase(p, 'Pesquisa manual')}
                          className="w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-900 flex items-center justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                              {p.name}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate">
                              {p.code}
                              {p.barcode ? ` · Barras: ${p.barcode}` : ''}
                              {` · Stock: ${p.stock}`}
                            </div>
                          </div>
                          <span className="text-[11px] font-medium text-green-700 dark:text-green-400 shrink-0">
                            + Selecionar
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {purBarcodeFeedback && (
                    <div
                      role={purBarcodeFeedback.type === 'error' ? 'alert' : 'status'}
                      className={`px-3 py-2 rounded-lg border text-xs flex items-center justify-between gap-2 ${
                        purBarcodeFeedback.type === 'error'
                          ? 'bg-red-50 dark:bg-red-950/60 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
                          : 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                      }`}
                    >
                      <span>{purBarcodeFeedback.message}</span>
                      <button
                        type="button"
                        onClick={() => setPurBarcodeFeedback(null)}
                        className="p-0.5 opacity-70 hover:opacity-100"
                        aria-label="Fechar aviso"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="divide-y divide-slate-200 dark:divide-slate-800 p-3 space-y-3">
                  {purItems.map((row, idx) => {
                    const lineCalc = purchaseVatSummary.lineCalcs[idx] || {
                      taxableBase: 0,
                      taxAmount: 0,
                      subtotal: 0,
                    };
                    const activeRules = (settings.taxRules || []).filter((r) => r.active);
                    return (
                      <div key={idx} className="space-y-2 pt-3 first:pt-0">
                        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                          <div className="sm:col-span-4">
                            <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Produto</label>
                            <select
                              value={row.productId}
                              onChange={(e) => {
                                const prod = products.find((p) => p.id === e.target.value);
                                setPurItems((prev) =>
                                  prev.map((it, i) => {
                                    if (i !== idx || !prod) return it;
                                    const rebuilt = buildPurchaseRow(prod, it.quantity, purDocDate);
                                    return {
                                      ...rebuilt,
                                      priceIncludesTax:
                                        prod.priceIncludesTax !== undefined && prod.priceIncludesTax !== null
                                          ? prod.priceIncludesTax
                                          : purPricesIncludeTax,
                                    };
                                  })
                                );
                              }}
                              className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs"
                            >
                              {products.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.code}
                                  {p.barcode ? ` [${p.barcode}]` : ''} — {p.name} (Stock atual: {p.stock})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="sm:col-span-2">
                            <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Qtd</label>
                            <input
                              type="number"
                              min="1"
                              required
                              value={row.quantity}
                              onChange={(e) =>
                                setPurItems((prev) =>
                                  prev.map((it, i) =>
                                    i === idx ? { ...it, quantity: Math.max(1, Number(e.target.value)) } : it
                                  )
                                )
                              }
                              className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs font-mono"
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                              Custo Unit. ({row.priceIncludesTax ? 'c/ IVA' : 's/ IVA'})
                            </label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              required
                              value={row.unitCost}
                              onChange={(e) =>
                                setPurItems((prev) =>
                                  prev.map((it, i) =>
                                    i === idx ? { ...it, unitCost: Math.max(0, Number(e.target.value)) } : it
                                  )
                                )
                              }
                              className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs font-mono"
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Lote</label>
                            <input
                              value={row.batch}
                              onChange={(e) => {
                                const nextBatch = e.target.value;
                                const prod = products.find((p) => p.id === row.productId);
                                setPurItems((prev) =>
                                  prev.map((it, i) => {
                                    if (i !== idx) return it;
                                    if (prod) {
                                      const eff = resolveEffectiveProductTax(prod, settings, nextBatch, purDocDate);
                                      if (eff.batchMatched) {
                                        return {
                                          ...it,
                                          batch: nextBatch,
                                          taxCode: eff.taxCode,
                                          taxRate: eff.taxRate,
                                          taxExemptionCode: eff.taxExemptionCode,
                                          taxExemptionReason: eff.taxExemptionReason,
                                          priceIncludesTax: eff.priceIncludesTax,
                                        };
                                      }
                                    }
                                    return { ...it, batch: nextBatch };
                                  })
                                );
                              }}
                              className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs font-mono"
                            />
                          </div>
                          <div className="sm:col-span-2 flex items-center gap-1">
                            <div className="flex-1">
                              <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Validade</label>
                              <input
                                type="date"
                                value={row.expiryDate}
                                onChange={(e) =>
                                  setPurItems((prev) =>
                                    prev.map((it, i) =>
                                      i === idx ? { ...it, expiryDate: e.target.value } : it
                                    )
                                  )
                                }
                                className="w-full min-h-[38px] px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs font-mono"
                              />
                            </div>
                            {purItems.length > 1 && (
                              <button
                                type="button"
                                onClick={() => setPurItems((prev) => prev.filter((_, i) => i !== idx))}
                                className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg mt-4"
                                aria-label="Remover linha"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Line VAT Controls */}
                        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center bg-slate-50 dark:bg-slate-950/70 px-2.5 py-2 rounded-lg text-[11px]">
                          {activeRules.length > 0 && (
                            <div className="sm:col-span-3">
                              <select
                                value=""
                                onChange={(e) => {
                                  const r = activeRules.find((rule) => rule.id === e.target.value);
                                  if (!r) return;
                                  setPurItems((prev) =>
                                    prev.map((it, i) =>
                                      i === idx
                                        ? {
                                            ...it,
                                            taxCode: r.taxCode,
                                            taxRate: r.taxCode === 'ISE' ? 0 : r.rate,
                                            taxExemptionCode: r.exemptionCode || '',
                                            taxExemptionReason: r.legalBasis || '',
                                          }
                                        : it
                                    )
                                  );
                                }}
                                className="w-full px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded text-[11px]"
                              >
                                <option value="">Aplicar regra IVA...</option>
                                {activeRules.map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.description || r.taxCode} ({r.taxCode} {r.rate}%{r.exemptionCode ? ` · ${r.exemptionCode}` : ''})
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                          <div className={activeRules.length > 0 ? 'sm:col-span-3' : 'sm:col-span-4'}>
                            <select
                              value={row.taxCode}
                              onChange={(e) => {
                                const code = e.target.value as TaxCode;
                                setPurItems((prev) =>
                                  prev.map((it, i) =>
                                    i === idx
                                      ? {
                                          ...it,
                                          taxCode: code,
                                          taxRate:
                                            code === 'ISE' ? 0 : code === 'NAO_CONFIGURADO' ? null : it.taxRate,
                                        }
                                      : it
                                  )
                                );
                              }}
                              className="w-full px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded text-[11px]"
                            >
                              <option value="NAO_CONFIGURADO">IVA Não Configurado</option>
                              <option value="NOR">NOR — Taxa Normal</option>
                              <option value="INT">INT — Taxa Intermédia</option>
                              <option value="RED">RED — Taxa Reduzida</option>
                              <option value="ISE">ISE — Isento (0%)</option>
                              <option value="OUT">OUT — Outro</option>
                            </select>
                          </div>
                          {row.taxCode !== 'ISE' && row.taxCode !== 'NAO_CONFIGURADO' && (
                            <div className="sm:col-span-2 flex items-center gap-1">
                              <span className="text-slate-500">Taxa%:</span>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                value={row.taxRate ?? ''}
                                placeholder="ex: 14"
                                onChange={(e) =>
                                  setPurItems((prev) =>
                                    prev.map((it, i) =>
                                      i === idx
                                        ? {
                                            ...it,
                                            taxRate: e.target.value === '' ? null : Number(e.target.value),
                                          }
                                        : it
                                    )
                                  )
                                }
                                className="w-full px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded font-mono text-[11px]"
                              />
                            </div>
                          )}
                          {(row.taxCode === 'ISE' || row.taxCode === 'OUT') && (
                            <div className="sm:col-span-3 flex items-center gap-1">
                              <input
                                value={row.taxExemptionCode}
                                placeholder="Cód. Isenção (Mxx)"
                                onChange={(e) =>
                                  setPurItems((prev) =>
                                    prev.map((it, i) =>
                                      i === idx ? { ...it, taxExemptionCode: e.target.value.toUpperCase() } : it
                                    )
                                  )
                                }
                                className="w-24 px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded font-mono text-[11px]"
                              />
                              <input
                                value={row.taxExemptionReason}
                                placeholder="Motivo legal..."
                                onChange={(e) =>
                                  setPurItems((prev) =>
                                    prev.map((it, i) =>
                                      i === idx ? { ...it, taxExemptionReason: e.target.value } : it
                                    )
                                  )
                                }
                                className="flex-1 px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded text-[11px]"
                              />
                            </div>
                          )}
                          <div className="sm:col-span-3 sm:ml-auto text-right font-mono text-slate-700 dark:text-slate-300">
                            Base: {formatMoney(lineCalc.taxableBase, cur)} · IVA:{' '}
                            {formatMoney(lineCalc.taxAmount, cur)} · Total:{' '}
                            <strong>{formatMoney(lineCalc.subtotal, cur)}</strong>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Observações</label>
                  <input
                    value={purNotes}
                    onChange={(e) => setPurNotes(e.target.value)}
                    placeholder="Notas sobre entrega ou conferência..."
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                  />
                </div>
                <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-1 text-xs">
                  <div className="flex justify-between text-slate-600 dark:text-slate-400">
                    <span>Base Tributável (sem IVA):</span>
                    <span className="font-mono">{formatMoney(purchaseVatSummary.baseTotal, cur)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600 dark:text-slate-400">
                    <span>Total IVA Suportado:</span>
                    <span className="font-mono">{formatMoney(purchaseVatSummary.taxTotal, cur)}</span>
                  </div>
                  {purchaseVatSummary.taxBreakdown.length > 0 && (
                    <div className="pt-1 border-t border-slate-200 dark:border-slate-800 space-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      {purchaseVatSummary.taxBreakdown.map((tb, i) => (
                        <div key={i} className="flex justify-between">
                          <span>{taxCodeLabel(tb.taxCode, tb.taxRate)}</span>
                          <span className="font-mono">
                            Base {formatMoney(tb.taxableBase, cur)} · IVA {formatMoney(tb.taxAmount, cur)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-semibold text-slate-900 dark:text-slate-100 pt-1 border-t border-slate-200 dark:border-slate-800">
                    <span>Total da Compra (c/ IVA):</span>
                    <span className="font-mono">{formatMoney(purchaseVatSummary.grandTotal, cur)}</span>
                  </div>
                </div>
              </div>

              {!isOnline && (
                <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-xs font-medium text-amber-900 dark:text-amber-200">
                  Sem ligação à internet: não é possível registar compras ou aumentar stock no modo offline.
                </div>
              )}

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowPurModal(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={!isOnline || saving || suppliers.length === 0 || products.length === 0 || purItems.length === 0}
                  className="px-4 py-2 text-sm font-medium text-white bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 disabled:opacity-50 rounded-lg"
                >
                  {saving ? 'A confirmar...' : 'Confirmar Compra e Atualizar Stock'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showPurScanner && (
        <BarcodeScannerModal
          title="Ler Código de Barras na Entrada de Stock"
          subtitle="Aponte a câmara para o código de barras do produto recebido para o selecionar na lista da compra."
          onDetected={(code) => {
            setShowPurScanner(false);
            handlePurchaseBarcodeLookup(code, 'CAMERA');
          }}
          onClose={() => setShowPurScanner(false)}
        />
      )}
    </div>
  );
};
