import React, { useMemo, useState } from 'react';
import { Camera, Edit2, Layers, PackagePlus, Plus, Power, ScanBarcode, Search, X } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { apiFetch } from '../lib/api';
import { normalizeBarcode } from '../lib/barcode';
import { formatDatePT, formatMoney, getProductAlerts, taxCodeLabel } from '../lib/format';
import type {
  PharmacySettings,
  PharmacologicalClass,
  Product,
  ProductBatchTaxOverride,
  ProductFiscalValidationState,
  Supplier,
  TaxCode,
  User,
} from '../types';
import { BarcodeScannerModal } from './BarcodeScannerModal';

interface ProductsViewProps {
  user: User;
  settings: PharmacySettings;
  products: Product[];
  classes: PharmacologicalClass[];
  suppliers: Supplier[];
  initialAlertFilter?: 'ALL' | 'LOW' | 'OUT' | 'EXPIRING' | 'NO_TAX';
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onOpenPurchaseEntry?: (productId?: string) => void;
}

const emptyProductForm = {
  code: '',
  barcode: '',
  name: '',
  activeIngredient: '',
  classId: '',
  dosageForm: 'Comprimido',
  dosage: '',
  unit: 'Caixa',
  location: 'Prateleira A1',
  purchasePrice: '0',
  salePrice: '0',
  stock: '0',
  minStock: '5',
  batch: '',
  expiryDate: '',
  supplierId: '',
  taxType: 'IVA' as const,
  taxCode: 'NAO_CONFIGURADO' as TaxCode,
  taxRate: '',
  taxExemptionCode: '',
  taxExemptionReason: '',
  priceIncludesTaxMode: 'INHERIT' as 'INHERIT' | 'INCLUDED' | 'EXCLUDED',
  fiscalValidationState: 'PENDENTE_REVISAO' as ProductFiscalValidationState,
  taxRuleId: '',
  changeReason: '',
  batchTaxes: [] as ProductBatchTaxOverride[],
};

export const ProductsView: React.FC<ProductsViewProps> = ({
  user,
  settings,
  products,
  classes,
  suppliers,
  initialAlertFilter,
  onRefresh,
  onNotify,
  onOpenPurchaseEntry,
}) => {
  const isAdmin = user.role === 'ADMIN';
  const canConfigureVat = isAdmin || Boolean(user.permissions.canConfigureProductVat);
  const isOnline = useOnlineStatus();
  const cur = settings.currencySymbol || 'Kz';

  const [query, setQuery] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ACTIVE' | 'INACTIVE' | 'ALL'>('ACTIVE');
  const [alertFilter, setAlertFilter] = useState<'ALL' | 'LOW' | 'OUT' | 'EXPIRING' | 'NO_TAX'>(
    initialAlertFilter || 'ALL'
  );

  React.useEffect(() => {
    if (initialAlertFilter) setAlertFilter(initialAlertFilter);
  }, [initialAlertFilter]);

  const [showProductModal, setShowProductModal] = useState(false);
  const [vatOnlyModalProduct, setVatOnlyModalProduct] = useState<Product | null>(null);
  const [bulkVatModalOpen, setBulkVatModalOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [form, setForm] = useState(emptyProductForm);
  const [saving, setSaving] = useState(false);

  const [showClassModal, setShowClassModal] = useState(false);
  const [newClassName, setNewClassName] = useState('');
  const [newClassDesc, setNewClassDesc] = useState('');
  const [scannerTarget, setScannerTarget] = useState<'SEARCH' | 'FORM' | null>(null);

  const classMap = useMemo(() => new Map(classes.map((c) => [c.id, c.name])), [classes]);
  const supplierMap = useMemo(() => new Map(suppliers.map((s) => [s.id, s.name])), [suppliers]);

  const unconfiguredTaxCount = useMemo(
    () => products.filter((p) => p.active && (!p.taxCode || p.taxCode === 'NAO_CONFIGURADO')).length,
    [products]
  );

  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (statusFilter === 'ACTIVE' && !p.active) return false;
      if (statusFilter === 'INACTIVE' && p.active) return false;
      if (classFilter && p.classId !== classFilter) return false;

      const alerts = getProductAlerts(p, settings.expiryWarningDays);
      if (alertFilter === 'OUT' && !alerts.isOut) return false;
      if (alertFilter === 'LOW' && !alerts.isLow) return false;
      if (alertFilter === 'EXPIRING' && !alerts.isExpiringSoon && !alerts.isExpired) return false;
      if (alertFilter === 'NO_TAX' && p.taxCode && p.taxCode !== 'NAO_CONFIGURADO') return false;

      if (q) {
        const clsName = (classMap.get(p.classId) || '').toLowerCase();
        const hay = [
          p.name,
          p.activeIngredient,
          p.code,
          p.barcode || '',
          clsName,
          p.batch,
          p.expiryDate,
          formatDatePT(p.expiryDate),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [products, query, classFilter, statusFilter, alertFilter, classMap, settings.expiryWarningDays]);

  const populateFormFromProduct = (p: Product) => {
    setForm({
      code: p.code,
      barcode: p.barcode || '',
      name: p.name,
      activeIngredient: p.activeIngredient,
      classId: p.classId,
      dosageForm: p.dosageForm,
      dosage: p.dosage,
      unit: p.unit,
      location: p.location,
      purchasePrice: String(p.purchasePrice),
      salePrice: String(p.salePrice),
      stock: String(p.stock),
      minStock: String(p.minStock),
      batch: p.batch,
      expiryDate: p.expiryDate,
      supplierId: p.supplierId,
      taxType: p.taxType || 'IVA',
      taxCode: (p.taxCode || 'NAO_CONFIGURADO') as TaxCode,
      taxRate: p.taxRate !== null && p.taxRate !== undefined ? String(p.taxRate) : '',
      taxExemptionCode: p.taxExemptionCode || '',
      taxExemptionReason: p.taxExemptionReason || '',
      priceIncludesTaxMode:
        p.priceIncludesTax === true
          ? 'INCLUDED'
          : p.priceIncludesTax === false
          ? 'EXCLUDED'
          : 'INHERIT',
      fiscalValidationState: p.fiscalValidationState || 'PENDENTE_REVISAO',
      taxRuleId: p.taxRuleId || '',
      changeReason: '',
      batchTaxes: Array.isArray(p.batchTaxes) ? p.batchTaxes.map((b) => ({ ...b })) : [],
    });
  };

  const openCreateModal = () => {
    setEditingProduct(null);
    setVatOnlyModalProduct(null);
    setForm({
      ...emptyProductForm,
      classId: classes[0]?.id || '',
      supplierId: suppliers[0]?.id || '',
    });
    setShowProductModal(true);
  };

  const openEditModal = (p: Product) => {
    setEditingProduct(p);
    setVatOnlyModalProduct(null);
    populateFormFromProduct(p);
    setShowProductModal(true);
  };

  const openVatOnlyModal = (p: Product) => {
    setEditingProduct(null);
    setBulkVatModalOpen(false);
    setVatOnlyModalProduct(p);
    populateFormFromProduct(p);
  };

  const openBulkVatModal = (idsToConfigure?: string[]) => {
    const targetIds = idsToConfigure && idsToConfigure.length > 0 ? idsToConfigure : selectedIds;
    if (targetIds.length === 0) return;
    if (idsToConfigure) setSelectedIds(idsToConfigure);
    setEditingProduct(null);
    setVatOnlyModalProduct(null);
    setForm({ ...emptyProductForm });
    setBulkVatModalOpen(true);
  };

  const toggleSelectProduct = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const visibleIds = useMemo(() => filteredProducts.map((p) => p.id), [filteredProducts]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => prev.filter((id) => !visibleIds.includes(id)));
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  const buildVatPayloadFromForm = () => ({
    taxType: form.taxType,
    taxCode: form.taxCode,
    taxRate:
      form.taxCode === 'NAO_CONFIGURADO'
        ? null
        : form.taxCode === 'ISE'
        ? 0
        : form.taxRate.trim() === ''
        ? null
        : Number(form.taxRate),
    taxExemptionCode: form.taxExemptionCode.trim(),
    taxExemptionReason: form.taxExemptionReason.trim(),
    priceIncludesTax:
      form.priceIncludesTaxMode === 'INCLUDED'
        ? true
        : form.priceIncludesTaxMode === 'EXCLUDED'
        ? false
        : null,
    fiscalValidationState: form.fiscalValidationState,
    taxRuleId: form.taxRuleId || '',
    changeReason: form.changeReason.trim() || undefined,
    batchTaxes: form.batchTaxes.map((bt) => ({
      ...bt,
      batch: bt.batch.trim(),
      taxType: bt.taxType || 'IVA',
      taxRate:
        bt.taxCode === 'NAO_CONFIGURADO'
          ? null
          : bt.taxCode === 'ISE'
          ? 0
          : bt.taxRate !== null && bt.taxRate !== undefined
          ? Number(bt.taxRate)
          : null,
      taxExemptionCode: (bt.taxExemptionCode || '').trim(),
      taxExemptionReason: (bt.taxExemptionReason || '').trim(),
    })),
  });

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        barcode: normalizeBarcode(form.barcode),
        purchasePrice: Number(form.purchasePrice),
        salePrice: Number(form.salePrice),
        stock: Number(form.stock),
        minStock: Number(form.minStock),
        ...buildVatPayloadFromForm(),
      };
      if (editingProduct) {
        await apiFetch(`/api/products/${editingProduct.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        onNotify('Produto atualizado com sucesso.');
      } else {
        await apiFetch('/api/products', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onNotify('Produto cadastrado com sucesso.');
      }
      setShowProductModal(false);
      await onRefresh();
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao guardar produto.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveVatOnly = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (bulkVatModalOpen) {
        const vatPayload = buildVatPayloadFromForm();
        const res = await apiFetch<{ updatedCount: number }>('/api/products/fiscal/bulk', {
          method: 'POST',
          body: JSON.stringify({
            productIds: selectedIds,
            taxType: vatPayload.taxType,
            taxCode: vatPayload.taxCode,
            taxRate: vatPayload.taxRate,
            taxExemptionCode: vatPayload.taxExemptionCode,
            taxExemptionReason: vatPayload.taxExemptionReason,
            priceIncludesTax: vatPayload.priceIncludesTax,
            fiscalValidationState: vatPayload.fiscalValidationState,
            taxRuleId: vatPayload.taxRuleId,
            changeReason: vatPayload.changeReason,
          }),
        });
        onNotify(`Enquadramento de IVA atualizado para ${res.updatedCount} produto(s).`);
        setBulkVatModalOpen(false);
        setSelectedIds([]);
        await onRefresh();
        return;
      }
      if (!vatOnlyModalProduct) return;
      await apiFetch(`/api/products/${vatOnlyModalProduct.id}/fiscal`, {
        method: 'PUT',
        body: JSON.stringify(buildVatPayloadFromForm()),
      });
      onNotify('Enquadramento de IVA do produto atualizado com sucesso.');
      setVatOnlyModalProduct(null);
      await onRefresh();
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao atualizar IVA do produto.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const applyTaxRuleToForm = (ruleId: string) => {
    if (!ruleId) {
      setForm((prev) => ({ ...prev, taxRuleId: '' }));
      return;
    }
    const rule = (settings.taxRules || []).find((r) => r.id === ruleId);
    if (!rule) return;
    setForm((prev) => ({
      ...prev,
      taxRuleId: rule.id,
      taxType: rule.taxType || 'IVA',
      taxCode: rule.taxCode,
      taxRate: String(rule.rate),
      taxExemptionCode: rule.exemptionCode || '',
      taxExemptionReason: rule.exemptionCode || rule.rate === 0 ? rule.legalBasis : '',
    }));
  };

  const addBatchTaxOverride = () => {
    setForm((prev) => ({
      ...prev,
      batchTaxes: [
        ...prev.batchTaxes,
        {
          batch: prev.batch || '',
          taxType: 'IVA',
          taxCode: prev.taxCode,
          taxRate:
            prev.taxCode === 'NAO_CONFIGURADO'
              ? null
              : prev.taxCode === 'ISE'
              ? 0
              : prev.taxRate.trim() !== ''
              ? Number(prev.taxRate)
              : null,
          taxExemptionCode: prev.taxExemptionCode,
          taxExemptionReason: prev.taxExemptionReason,
          priceIncludesTax: null,
          fiscalValidationState: prev.fiscalValidationState,
          taxRuleId: prev.taxRuleId || undefined,
        },
      ],
    }));
  };

  const handleToggleStatus = async (p: Product) => {
    try {
      await apiFetch(`/api/products/${p.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !p.active }),
      });
      onNotify(`Produto ${p.active ? 'desativado' : 'ativado'} com sucesso.`);
      await onRefresh();
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao alterar estado.', 'error');
    }
  };

  const handleCreateClass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClassName.trim()) return;
    try {
      await apiFetch('/api/classes', {
        method: 'POST',
        body: JSON.stringify({ name: newClassName.trim(), description: newClassDesc.trim() }),
      });
      setNewClassName('');
      setNewClassDesc('');
      onNotify('Classe farmacológica criada.');
      await onRefresh();
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao criar classe.', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
            Produtos e Classes Farmacológicas
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            {isAdmin
              ? 'Gerir catálogo, stock mínimo, lotes, validades e classes farmacológicas.'
              : 'Consulta de medicamentos, preços e disponibilidade em stock.'}
          </p>
        </div>

        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            {onOpenPurchaseEntry && (
              <button
                type="button"
                onClick={() => onOpenPurchaseEntry()}
                className="min-h-[42px] px-4 py-2 bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
              >
                <PackagePlus className="w-4 h-4" />
                Registar compra / Entrada de stock
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowClassModal(true)}
              className="min-h-[42px] px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
            >
              <Layers className="w-4 h-4" />
              Classes ({classes.length})
            </button>
            <button
              type="button"
              onClick={openCreateModal}
              className="min-h-[42px] px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              Novo Produto
            </button>
          </div>
        )}
      </div>

      {/* Filters bar */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-5 flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Pesquisar por nome, princípio ativo, código, código de barras ou lote..."
                className="w-full min-h-[42px] pl-9 pr-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-green-700"
              />
            </div>
            <button
              type="button"
              onClick={() => setScannerTarget('SEARCH')}
              className="min-h-[42px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap"
              title="Ler código de barras pela câmara"
            >
              <Camera className="w-4 h-4 text-green-700 dark:text-green-400" />
              <span className="hidden sm:inline">Câmara</span>
            </button>
          </div>

          <div className="md:col-span-4">
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="w-full min-h-[42px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-green-700"
            >
              <option value="">Todas as classes farmacológicas</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="w-full min-h-[42px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-green-700"
            >
              <option value="ACTIVE">Estado: Ativos</option>
              <option value="INACTIVE">Estado: Inativos</option>
              <option value="ALL">Estado: Todos</option>
            </select>
          </div>
        </div>

        {/* Segmented alert filter */}
        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { id: 'ALL', label: 'Todos' },
            { id: 'LOW', label: 'Stock Baixo' },
            { id: 'OUT', label: 'Sem Stock' },
            { id: 'EXPIRING', label: 'Validade Próxima / Expirado' },
            {
              id: 'NO_TAX',
              label: `Sem IVA Configurado (${unconfiguredTaxCount})`,
            },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setAlertFilter(tab.id as any)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                alertFilter === tab.id
                  ? 'bg-green-700 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {canConfigureVat && unconfiguredTaxCount > 0 && (
          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span>
              Existem <strong>{unconfiguredTaxCount}</strong> produto(s) ativo(s) sem código/taxa de IVA atribuída. Pode editar individualmente ou selecionar vários produtos para atribuir em lote o tratamento confirmado pelo contabilista.
            </span>
            <div className="flex flex-wrap gap-2 self-start sm:self-auto shrink-0">
              {alertFilter !== 'NO_TAX' && (
                <button
                  type="button"
                  onClick={() => setAlertFilter('NO_TAX')}
                  className="px-2.5 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded-md font-medium whitespace-nowrap"
                >
                  Filtrar Sem IVA
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const unconfIds = products
                    .filter((p) => p.active && (!p.taxCode || p.taxCode === 'NAO_CONFIGURADO'))
                    .map((p) => p.id);
                  openBulkVatModal(unconfIds);
                }}
                className="px-2.5 py-1 bg-green-700 hover:bg-green-800 text-white rounded-md font-medium whitespace-nowrap"
              >
                Configurar {unconfiguredTaxCount} em Lote
              </button>
            </div>
          </div>
        )}

        {canConfigureVat && selectedIds.length > 0 && (
          <div className="p-2.5 rounded-lg bg-green-50 dark:bg-green-950/40 border border-green-300 dark:border-green-800 text-xs text-green-950 dark:text-green-100 flex flex-wrap items-center justify-between gap-2">
            <span>
              <strong>{selectedIds.length}</strong> produto(s) selecionado(s).
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openBulkVatModal()}
                className="px-3 py-1.5 bg-green-700 hover:bg-green-800 text-white rounded-md font-medium"
              >
                Atribuir IVA aos Selecionados ({selectedIds.length})
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds([])}
                className="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-md font-medium"
              >
                Limpar Seleção
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Product Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                {canConfigureVat && (
                  <th className="py-3 pl-4 pr-2 w-8">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisible}
                      aria-label="Selecionar todos os produtos visíveis"
                    />
                  </th>
                )}
                <th className="py-3 px-4 font-medium">Código / Produto</th>
                <th className="py-3 px-3 font-medium">Classe</th>
                <th className="py-3 px-3 font-medium">Lote / Validade</th>
                <th className="py-3 px-3 font-medium text-right">P. Venda</th>
                <th className="py-3 px-3 font-medium text-right">Stock</th>
                <th className="py-3 px-3 font-medium">Estado / Alertas</th>
                {canConfigureVat && <th className="py-3 px-4 font-medium text-right">Ações</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredProducts.map((p) => {
                const alerts = getProductAlerts(p, settings.expiryWarningDays);
                return (
                  <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    {canConfigureVat && (
                      <td className="py-3 pl-4 pr-2 align-top">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(p.id)}
                          onChange={() => toggleSelectProduct(p.id)}
                          aria-label={`Selecionar ${p.name}`}
                        />
                      </td>
                    )}
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{p.name}</div>
                      <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                        <span className="font-mono">{p.code}</span>
                        {p.barcode ? (
                          <span className="font-mono text-green-800 dark:text-green-400"> · Barras: {p.barcode}</span>
                        ) : (
                          <span> · Cód. barras: Não registado</span>
                        )}
                        {p.activeIngredient ? ` · ${p.activeIngredient}` : ''}
                        {p.dosage ? ` · ${p.dosageForm} ${p.dosage}` : ''}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {p.location} · Forn.: {supplierMap.get(p.supplierId) || 'Não registado'}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-slate-700 dark:text-slate-300">
                      {classMap.get(p.classId) || 'Sem classe'}
                    </td>
                    <td className="py-3 px-3 font-mono text-slate-700 dark:text-slate-300">
                      <div>{p.batch || '—'}</div>
                      <div className="text-slate-500 dark:text-slate-400">{formatDatePT(p.expiryDate)}</div>
                    </td>
                    <td className="py-3 px-3 text-right font-mono">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {formatMoney(p.salePrice, cur)}
                      </div>
                      <div className="text-[10px] font-sans text-slate-500 dark:text-slate-400">
                        {taxCodeLabel(p.taxCode, p.taxRate)}
                        {p.taxCode && p.taxCode !== 'NAO_CONFIGURADO' && (
                          <span>
                            {' · '}
                            {p.priceIncludesTax === true
                              ? 'IVA incl.'
                              : p.priceIncludesTax === false
                              ? 'IVA acresc.'
                              : settings.pricesIncludeTax
                              ? 'IVA incl. (loja)'
                              : 'IVA acresc. (loja)'}
                          </span>
                        )}
                      </div>
                      {p.taxCode && p.taxCode !== 'NAO_CONFIGURADO' && (
                        <div
                          className={`text-[10px] font-sans ${
                            p.fiscalValidationState === 'VALIDADO_CONTABILISTA'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {p.fiscalValidationState === 'VALIDADO_CONTABILISTA'
                            ? 'Validado contabilista'
                            : 'Pendente revisão'}
                          {p.batchTaxes && p.batchTaxes.length > 0
                            ? ` · ${p.batchTaxes.length} lote(s)`
                            : ''}
                        </div>
                      )}
                      {isAdmin && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          Custo: {formatMoney(p.purchasePrice, cur)}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right font-mono">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {p.stock} <span className="font-sans font-normal text-slate-500 dark:text-slate-400">{p.unit}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">Mín: {p.minStock}</div>
                      {p.quarantineStock > 0 && (
                        <div className="text-[11px] text-amber-700 dark:text-amber-400">
                          Quarentena: {p.quarantineStock}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <div className="space-y-0.5">
                        <div className={p.active ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-slate-500 dark:text-slate-400'}>
                          {p.active ? 'Ativo' : 'Inativo'}
                        </div>
                        {alerts.isOut && <div className="text-red-700 dark:text-red-400 font-medium">Sem stock</div>}
                        {alerts.isLow && <div className="text-amber-700 dark:text-amber-400 font-medium">Stock baixo</div>}
                        {alerts.isExpired && <div className="text-red-700 dark:text-red-400 font-medium">Expirado</div>}
                        {alerts.isExpiringSoon && (
                          <div className="text-amber-700 dark:text-amber-400 font-medium">Validade próxima</div>
                        )}
                      </div>
                    </td>
                    {canConfigureVat && (
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {isAdmin && onOpenPurchaseEntry && (
                            <button
                              type="button"
                              onClick={() => onOpenPurchaseEntry(p.id)}
                              className="p-2 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded-lg"
                              title="Registar compra / Entrada de stock"
                            >
                              <PackagePlus className="w-4 h-4" />
                            </button>
                          )}
                          {isAdmin ? (
                            <button
                              type="button"
                              onClick={() => openEditModal(p)}
                              className="p-2 text-slate-600 dark:text-slate-400 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                              title="Editar produto e IVA"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openVatOnlyModal(p)}
                              className="px-2.5 py-1 text-[11px] font-medium bg-slate-100 dark:bg-slate-800 hover:bg-green-700 hover:text-white text-slate-700 dark:text-slate-200 rounded-lg"
                              title="Configurar IVA do produto"
                            >
                              IVA
                            </button>
                          )}
                          {isAdmin && (
                            <button
                              type="button"
                              disabled={!isOnline}
                              onClick={() => handleToggleStatus(p)}
                              className={`p-2 rounded-lg disabled:opacity-50 ${
                                p.active
                                  ? 'text-slate-600 dark:text-slate-400 hover:text-red-700 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
                                  : 'text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'
                              }`}
                              title={p.active ? 'Desativar produto' : 'Ativar produto'}
                            >
                              <Power className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              {filteredProducts.length === 0 && (
                <tr>
                  <td colSpan={canConfigureVat ? 8 : 6} className="py-10 text-center text-slate-500 dark:text-slate-400">
                    Nenhum produto encontrado com os filtros aplicados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Product Create/Edit Modal */}
      {showProductModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5 my-8 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100">
                {editingProduct ? 'Editar Produto' : 'Cadastrar Novo Produto'}
              </h2>
              <button
                type="button"
                onClick={() => setShowProductModal(false)}
                className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Código / Referência *
                </label>
                <input
                  required
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="ex.: MED-010"
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Código de Barras (opcional, único)
                </label>
                <div className="flex gap-1.5">
                  <div className="relative flex-1">
                    <ScanBarcode className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      value={form.barcode}
                      onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                        }
                      }}
                      placeholder="EAN-13, EAN-8, UPC ou Code-128"
                      className="w-full min-h-[40px] pl-9 pr-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg font-mono text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setScannerTarget('FORM')}
                    className="min-h-[40px] px-3 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1 whitespace-nowrap"
                    title="Ler código de barras da embalagem pela câmara"
                  >
                    <Camera className="w-4 h-4 text-green-700 dark:text-green-400" />
                    Ler
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  Pode usar leitor USB neste campo ou a câmara. Deixe vazio se ainda não tiver código.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Nome Comercial *
                </label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="ex.: Azitromicina 500mg"
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Princípio Ativo
                </label>
                <input
                  value={form.activeIngredient}
                  onChange={(e) => setForm({ ...form, activeIngredient: e.target.value })}
                  placeholder="ex.: Azitromicina"
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Classe Farmacológica *
                </label>
                <select
                  required
                  value={form.classId}
                  onChange={(e) => setForm({ ...form, classId: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
                >
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Forma Farmacêutica
                </label>
                <input
                  value={form.dosageForm}
                  onChange={(e) => setForm({ ...form, dosageForm: e.target.value })}
                  placeholder="Comprimido, Xarope, Pomada..."
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Dosagem</label>
                <input
                  value={form.dosage}
                  onChange={(e) => setForm({ ...form, dosage: e.target.value })}
                  placeholder="ex.: 500 mg"
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Unidade de Medida
                </label>
                <input
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  placeholder="Caixa, Frasco, Unidade..."
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Localização / Prateleira
                </label>
                <input
                  value={form.location}
                  onChange={(e) => setForm({ ...form, location: e.target.value })}
                  placeholder="ex.: Prateleira B1"
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Preço de Compra ({cur}) *
                </label>
                <input
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.purchasePrice}
                  onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Preço de Venda ({cur}) *
                </label>
                <input
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.salePrice}
                  onChange={(e) => setForm({ ...form, salePrice: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono text-sm"
                />
              </div>

              {!editingProduct ? (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Stock Inicial
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={form.stock}
                    onChange={(e) => setForm({ ...form, stock: e.target.value })}
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono text-sm"
                  />
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                    Novas entradas após o cadastro devem ser feitas via Registar compra / Entrada de stock.
                  </p>
                </div>
              ) : (
                <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                      Stock atual: <span className="font-mono font-semibold">{editingProduct.stock} {editingProduct.unit}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Para aumentar o stock, registe uma compra.
                    </p>
                  </div>
                  {onOpenPurchaseEntry && (
                    <button
                      type="button"
                      onClick={() => {
                        const targetId = editingProduct.id;
                        setShowProductModal(false);
                        onOpenPurchaseEntry(targetId);
                      }}
                      className="px-2.5 py-1.5 bg-green-700 hover:bg-green-800 text-white text-xs font-medium rounded-lg whitespace-nowrap flex items-center gap-1"
                    >
                      <PackagePlus className="w-3.5 h-3.5" />
                      Entrada
                    </button>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Stock Mínimo
                </label>
                <input
                  type="number"
                  min="0"
                  value={form.minStock}
                  onChange={(e) => setForm({ ...form, minStock: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Lote</label>
                <input
                  value={form.batch}
                  onChange={(e) => setForm({ ...form, batch: e.target.value })}
                  placeholder="ex.: LT-2026B"
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Data de Validade
                </label>
                <input
                  type="date"
                  value={form.expiryDate}
                  onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Fornecedor Associado
                </label>
                <select
                  value={form.supplierId}
                  onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
                >
                  <option value="">Sem fornecedor associado</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2 p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Enquadramento Fiscal IVA (AGT / DP 71/25)
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      O sistema não assume taxas nem isenções automaticamente. Selecione o enquadramento apenas após confirmação contabilística.
                    </p>
                  </div>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300 self-start">
                    Imposto: {form.taxType}
                  </span>
                </div>
                {(settings.vatRegime === 'SIMPLIFICADO' || settings.vatRegime === 'EXCLUSAO') &&
                  (form.taxCode === 'NOR' ||
                    form.taxCode === 'INT' ||
                    form.taxCode === 'RED' ||
                    (form.taxCode === 'OUT' && Number(form.taxRate || 0) > 0)) && (
                    <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-[11px] text-red-900 dark:text-red-200">
                      Atenção: a farmácia está configurada em{' '}
                      <strong>
                        {settings.vatRegime === 'SIMPLIFICADO' ? 'Regime Simplificado' : 'Regime de Exclusão'}
                      </strong>
                      , não podendo liquidar IVA positivo em faturas. Confirme com o contabilista antes de faturar este produto.
                    </div>
                  )}

                {(settings.taxRules || []).length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Aplicar Regra da Tabela Fiscal (opcional)
                    </label>
                    <select
                      value={form.taxRuleId}
                      onChange={(e) => applyTaxRuleToForm(e.target.value)}
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs"
                    >
                      <option value="">Configuração manual / sem regra associada</option>
                      {(settings.taxRules || []).map((rule) => (
                        <option key={rule.id} value={rule.id}>
                          {rule.taxCode} ({rule.rate}%) — {rule.description} [{rule.validFrom}
                          {rule.validTo ? ` a ${rule.validTo}` : ''}]
                          {!rule.active ? ' (Inativa)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Código Fiscal IVA
                    </label>
                    <select
                      value={form.taxCode}
                      onChange={(e) => {
                        const nextCode = e.target.value as TaxCode;
                        setForm({
                          ...form,
                          taxCode: nextCode,
                          taxRuleId: '',
                          taxRate: nextCode === 'ISE' ? '0' : nextCode === 'NAO_CONFIGURADO' ? '' : form.taxRate,
                        });
                      }}
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs"
                    >
                      <option value="NAO_CONFIGURADO">Não configurado (aguarda contabilista)</option>
                      <option value="NOR">NOR — Taxa Normal (&gt; 0%)</option>
                      <option value="INT">INT — Taxa Intermédia (&gt; 0%)</option>
                      <option value="RED">RED — Taxa Reduzida (&gt; 0%)</option>
                      <option value="ISE">ISE — Isento (0% com código AGT)</option>
                      <option value="OUT">OUT — Outro / Sem liquidação de IVA</option>
                    </select>
                  </div>

                  {(form.taxCode === 'NOR' ||
                    form.taxCode === 'INT' ||
                    form.taxCode === 'RED' ||
                    form.taxCode === 'OUT') && (
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Taxa de IVA (%) *
                      </label>
                      <input
                        required
                        type="number"
                        min={form.taxCode === 'OUT' ? '0' : '0.01'}
                        max="100"
                        step="0.01"
                        value={form.taxRate}
                        onChange={(e) => setForm({ ...form, taxRate: e.target.value, taxRuleId: '' })}
                        placeholder={form.taxCode === 'OUT' ? 'ex.: 0' : 'Indique a taxa confirmada'}
                        className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono text-xs"
                      />
                    </div>
                  )}

                  {(form.taxCode === 'ISE' ||
                    (form.taxCode === 'OUT' && form.taxRate.trim() !== '' && Number(form.taxRate) === 0)) && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Código de Isenção / Motivo AGT {form.taxCode === 'ISE' ? '*' : '(opcional)'}
                        </label>
                        <input
                          required={form.taxCode === 'ISE'}
                          value={form.taxExemptionCode}
                          onChange={(e) => setForm({ ...form, taxExemptionCode: e.target.value })}
                          placeholder="Indique o código AGT confirmado (ex.: M...)"
                          className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono text-xs"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Menção / Base Legal (Art. 10.º DP 71/25) *
                        </label>
                        <input
                          required
                          value={form.taxExemptionReason}
                          onChange={(e) => setForm({ ...form, taxExemptionReason: e.target.value })}
                          placeholder="ex.: Menção legal confirmada pelo contabilista (isenção ou não liquidação)"
                          className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs"
                        />
                      </div>
                    </>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Preço de Venda com/sem IVA
                    </label>
                    <select
                      value={form.priceIncludesTaxMode}
                      onChange={(e) =>
                        setForm({ ...form, priceIncludesTaxMode: e.target.value as any })
                      }
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs"
                    >
                      <option value="INHERIT">
                        Herdar da farmácia ({settings.pricesIncludeTax ? 'IVA incluído' : 'IVA acrescido'})
                      </option>
                      <option value="INCLUDED">Este produto já inclui IVA no preço</option>
                      <option value="EXCLUDED">Acresce IVA ao preço de venda</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Estado de Validação Contabilística
                    </label>
                    <select
                      value={form.fiscalValidationState}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          fiscalValidationState: e.target.value as ProductFiscalValidationState,
                        })
                      }
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs"
                    >
                      <option value="PENDENTE_REVISAO">Pendente revisão do contabilista</option>
                      <option value="VALIDADO_CONTABILISTA">Validado pelo contabilista</option>
                    </select>
                  </div>
                </div>

                {/* Batch VAT Overrides */}
                <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                      Exceções de IVA por Lote ({form.batchTaxes.length})
                    </span>
                    <button
                      type="button"
                      onClick={addBatchTaxOverride}
                      className="px-2 py-1 text-[11px] font-medium bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded"
                    >
                      + Exceção por Lote
                    </button>
                  </div>
                  {form.batchTaxes.map((bt, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md grid grid-cols-1 sm:grid-cols-4 gap-2 items-center text-[11px]"
                    >
                      <input
                        placeholder="Lote *"
                        value={bt.batch}
                        onChange={(e) => {
                          const next = [...form.batchTaxes];
                          next[idx] = { ...next[idx], batch: e.target.value };
                          setForm({ ...form, batchTaxes: next });
                        }}
                        className="px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                      />
                      <select
                        value={bt.taxCode}
                        onChange={(e) => {
                          const nextCode = e.target.value as TaxCode;
                          const next = [...form.batchTaxes];
                          next[idx] = {
                            ...next[idx],
                            taxCode: nextCode,
                            taxRate: nextCode === 'ISE' ? 0 : nextCode === 'NAO_CONFIGURADO' ? null : next[idx].taxRate,
                          };
                          setForm({ ...form, batchTaxes: next });
                        }}
                        className="px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100"
                      >
                        <option value="NOR">NOR</option>
                        <option value="INT">INT</option>
                        <option value="RED">RED</option>
                        <option value="ISE">ISE</option>
                        <option value="OUT">OUT</option>
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        min={bt.taxCode === 'ISE' || bt.taxCode === 'OUT' ? '0' : '0.01'}
                        max="100"
                        disabled={bt.taxCode === 'ISE'}
                        placeholder="Taxa %"
                        value={bt.taxCode === 'ISE' ? '0' : bt.taxRate ?? ''}
                        onChange={(e) => {
                          const next = [...form.batchTaxes];
                          next[idx] = {
                            ...next[idx],
                            taxRate: e.target.value === '' ? null : Number(e.target.value),
                          };
                          setForm({ ...form, batchTaxes: next });
                        }}
                        className="px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                      />
                      <div className="flex items-center gap-1">
                        <select
                          value={
                            bt.priceIncludesTax === true
                              ? 'INCLUDED'
                              : bt.priceIncludesTax === false
                              ? 'EXCLUDED'
                              : 'INHERIT'
                          }
                          onChange={(e) => {
                            const v = e.target.value;
                            const next = [...form.batchTaxes];
                            next[idx] = {
                              ...next[idx],
                              priceIncludesTax: v === 'INCLUDED' ? true : v === 'EXCLUDED' ? false : null,
                            };
                            setForm({ ...form, batchTaxes: next });
                          }}
                          className="flex-1 px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100"
                        >
                          <option value="INHERIT">Herdar</option>
                          <option value="INCLUDED">Incl.</option>
                          <option value="EXCLUDED">Acresc.</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            setForm({
                              ...form,
                              batchTaxes: form.batchTaxes.filter((_, i) => i !== idx),
                            });
                          }}
                          className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                          title="Remover exceção"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {(bt.taxCode === 'ISE' || (bt.taxCode === 'OUT' && Number(bt.taxRate ?? 0) === 0)) && (
                        <>
                          <input
                            placeholder="Cód. Isenção AGT"
                            value={bt.taxExemptionCode || ''}
                            onChange={(e) => {
                              const next = [...form.batchTaxes];
                              next[idx] = { ...next[idx], taxExemptionCode: e.target.value };
                              setForm({ ...form, batchTaxes: next });
                            }}
                            className="px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                          />
                          <input
                            placeholder="Menção / Base Legal *"
                            value={bt.taxExemptionReason || ''}
                            onChange={(e) => {
                              const next = [...form.batchTaxes];
                              next[idx] = { ...next[idx], taxExemptionReason: e.target.value };
                              setForm({ ...form, batchTaxes: next });
                            }}
                            className="sm:col-span-3 px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100"
                          />
                        </>
                      )}
                    </div>
                  ))}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Motivo da Alteração Fiscal (registado no histórico)
                  </label>
                  <input
                    value={form.changeReason}
                    onChange={(e) => setForm({ ...form, changeReason: e.target.value })}
                    placeholder="Opcional — ex.: Validação contabilística de IVA"
                    className="w-full min-h-[36px] px-3 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs"
                  />
                </div>
              </div>

              <div className="sm:col-span-2 flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowProductModal(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving || !isOnline}
                  className="px-4 py-2 text-sm font-medium text-white bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 disabled:opacity-50 rounded-lg"
                >
                  {saving ? 'A guardar...' : 'Guardar Produto'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Seller VAT-only / Bulk VAT Modal */}
      {(vatOnlyModalProduct || bulkVatModalOpen) && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 my-8 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                  {bulkVatModalOpen
                    ? `Configurar IVA em Lote (${selectedIds.length} produto(s))`
                    : `Configurar IVA — ${vatOnlyModalProduct!.name}`}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                  {bulkVatModalOpen
                    ? 'Aplica apenas o código, taxa e base legal selecionados aos produtos marcados.'
                    : `${vatOnlyModalProduct!.code} · Preço: ${formatMoney(vatOnlyModalProduct!.salePrice, cur)}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setVatOnlyModalProduct(null);
                  setBulkVatModalOpen(false);
                }}
                className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveVatOnly} className="space-y-3 text-xs">
              {(settings.taxRules || []).length > 0 && (
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Aplicar Regra da Tabela Fiscal
                  </label>
                  <select
                    value={form.taxRuleId}
                    onChange={(e) => applyTaxRuleToForm(e.target.value)}
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    <option value="">Configuração manual</option>
                    {(settings.taxRules || []).map((rule) => (
                      <option key={rule.id} value={rule.id}>
                        {rule.taxCode} ({rule.rate}%) — {rule.description}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Código Fiscal IVA</label>
                  <select
                    value={form.taxCode}
                    onChange={(e) => {
                      const nextCode = e.target.value as TaxCode;
                      setForm({
                        ...form,
                        taxCode: nextCode,
                        taxRuleId: '',
                        taxRate: nextCode === 'ISE' ? '0' : nextCode === 'NAO_CONFIGURADO' ? '' : form.taxRate,
                      });
                    }}
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    <option value="NAO_CONFIGURADO">Não configurado</option>
                    <option value="NOR">NOR — Taxa Normal (&gt; 0%)</option>
                    <option value="INT">INT — Taxa Intermédia (&gt; 0%)</option>
                    <option value="RED">RED — Taxa Reduzida (&gt; 0%)</option>
                    <option value="ISE">ISE — Isento (0%)</option>
                    <option value="OUT">OUT — Outro</option>
                  </select>
                </div>
                {(form.taxCode === 'NOR' ||
                  form.taxCode === 'INT' ||
                  form.taxCode === 'RED' ||
                  form.taxCode === 'OUT') && (
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Taxa de IVA (%) *</label>
                    <input
                      required
                      type="number"
                      min={form.taxCode === 'OUT' ? '0' : '0.01'}
                      max="100"
                      step="0.01"
                      value={form.taxRate}
                      onChange={(e) => setForm({ ...form, taxRate: e.target.value })}
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                    />
                  </div>
                )}
              </div>

              {(form.taxCode === 'ISE' ||
                (form.taxCode === 'OUT' && form.taxRate.trim() !== '' && Number(form.taxRate) === 0)) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Código de Isenção AGT {form.taxCode === 'ISE' ? '*' : ''}
                    </label>
                    <input
                      required={form.taxCode === 'ISE'}
                      value={form.taxExemptionCode}
                      onChange={(e) => setForm({ ...form, taxExemptionCode: e.target.value })}
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Menção / Base Legal *</label>
                    <input
                      required
                      value={form.taxExemptionReason}
                      onChange={(e) => setForm({ ...form, taxExemptionReason: e.target.value })}
                      className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Modo do Preço</label>
                  <select
                    value={form.priceIncludesTaxMode}
                    onChange={(e) => setForm({ ...form, priceIncludesTaxMode: e.target.value as any })}
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    <option value="INHERIT">Herdar da farmácia</option>
                    <option value="INCLUDED">Preço inclui IVA</option>
                    <option value="EXCLUDED">Acresce IVA</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Validação Contabilística</label>
                  <select
                    value={form.fiscalValidationState}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        fiscalValidationState: e.target.value as ProductFiscalValidationState,
                      })
                    }
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    <option value="PENDENTE_REVISAO">Pendente revisão contabilística</option>
                    <option value="VALIDADO_CONTABILISTA">Validado pelo contabilista</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Motivo da Alteração</label>
                  <input
                    value={form.changeReason}
                    onChange={(e) => setForm({ ...form, changeReason: e.target.value })}
                    placeholder="Registado no histórico fiscal"
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setVatOnlyModalProduct(null);
                    setBulkVatModalOpen(false);
                  }}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving || !isOnline}
                  className="px-4 py-2 bg-green-700 hover:bg-green-800 text-white rounded-lg font-medium"
                >
                  {saving ? 'A guardar...' : bulkVatModalOpen ? `Aplicar a ${selectedIds.length}` : 'Guardar IVA'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Pharmacological Classes Modal */}
      {showClassModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5 my-8 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100">
                Classes Farmacológicas
              </h2>
              <button
                type="button"
                onClick={() => setShowClassModal(false)}
                className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateClass} className="space-y-3 pb-4 border-b border-slate-200 dark:border-slate-800">
              <input
                required
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
                placeholder="Nova classe farmacológica (ex.: Oftálmicos)"
                className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
              />
              <div className="flex gap-2">
                <input
                  value={newClassDesc}
                  onChange={(e) => setNewClassDesc(e.target.value)}
                  placeholder="Descrição opcional"
                  className="flex-1 min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
                />
                <button
                  type="submit"
                  className="px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white text-sm font-medium rounded-lg whitespace-nowrap"
                >
                  Adicionar
                </button>
              </div>
            </form>

            <div className="max-h-72 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
              {classes.map((c) => (
                <div key={c.id} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">{c.name}</div>
                    {c.description && <div className="text-slate-500 dark:text-slate-400">{c.description}</div>}
                  </div>
                  <span className="text-slate-500 dark:text-slate-400 font-mono">
                    {products.filter((p) => p.classId === c.id).length} prod.
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {scannerTarget && (
        <BarcodeScannerModal
          title={
            scannerTarget === 'FORM'
              ? 'Ler Código de Barras para Registo do Produto'
              : 'Pesquisar Produto por Código de Barras'
          }
          subtitle={
            scannerTarget === 'FORM'
              ? 'Aponte a câmara para o código de barras da embalagem para preencher o campo automaticamente.'
              : 'Aponte a câmara para o código de barras para filtrar a lista de produtos.'
          }
          onDetected={(code) => {
            if (scannerTarget === 'FORM') {
              setForm((prev) => ({ ...prev, barcode: code }));
              onNotify(`Código de barras ${code} preenchido no formulário.`);
            } else {
              setQuery(code);
            }
            setScannerTarget(null);
          }}
          onClose={() => setScannerTarget(null)}
        />
      )}
    </div>
  );
};
