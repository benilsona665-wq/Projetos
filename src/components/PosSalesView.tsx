import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRightLeft,
  Camera,
  CheckCircle2,
  FileCode2,
  FileText,
  Lock,
  Plus,
  Printer,
  Receipt,
  ScanBarcode,
  Search,
  Send,
  ShoppingBag,
  Trash2,
  Unlock,
  UserPlus,
  X,
} from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { ApiError, apiFetch } from '../lib/api';
import { findProductByBarcodeOrCode, normalizeBarcode } from '../lib/barcode';
import {
  calculateLineVat,
  fiscalStatusLabel,
  formatDatePT,
  formatDateTimePT,
  formatMoney,
  isInvoiceSaleType,
  paymentMethodLabel,
  resolveEffectiveProductTax,
  roundMoney,
  saleDocTypeLabel,
  saleStatusLabel,
  taxCodeLabel,
  todayLocalISO,
} from '../lib/format';
import type {
  AgtPublicStatus,
  CashRegisterStatusPayload,
  Customer,
  PaymentMethod,
  PharmacySettings,
  Product,
  Sale,
  SaleDocumentType,
  TaxBreakdownEntry,
  User,
} from '../types';
import { BarcodeScannerModal } from './BarcodeScannerModal';
import type { PrintableDocPayload } from './PrintableDocumentModal';

interface PosSalesViewProps {
  mode: 'POS' | 'PROFORMAS';
  user: User;
  settings: PharmacySettings;
  products: Product[];
  customers: Customer[];
  sales: Sale[];
  cashRegisterStatus?: CashRegisterStatusPayload | null;
  onOpenCashRegister?: () => void;
  onOpenVatSettings?: () => void;
  onOpenProductsNoTax?: () => void;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onPrintDoc: (payload: PrintableDocPayload) => void;
}

interface CartLine {
  productId: string;
  quantity: number;
  discountPercent: number;
}

export const PosSalesView: React.FC<PosSalesViewProps> = ({
  mode,
  user,
  settings,
  products,
  customers,
  sales,
  cashRegisterStatus,
  onOpenCashRegister,
  onOpenVatSettings,
  onOpenProductsNoTax,
  onRefresh,
  onNotify,
  onPrintDoc,
}) => {
  const cur = settings.currencySymbol || 'Kz';
  const isOnline = useOnlineStatus();
  const isAdmin = user.role === 'ADMIN';
  const maxDiscount = isAdmin ? 100 : user.permissions.canDiscount ? user.permissions.maxDiscountPercent : 0;
  const registerBlocked = Boolean(
    cashRegisterStatus?.requiresOpenRegisterToSell && !cashRegisterStatus?.openRegister
  );
  const canOpenAnotherRegister =
    !cashRegisterStatus?.openRegister &&
    !cashRegisterStatus?.isPeriodClosed &&
    (cashRegisterStatus?.closedTodayCount ?? 0) < (cashRegisterStatus?.maxAllowedPerDay ?? 2);

  const [subTab, setSubTab] = useState<'NEW' | 'HISTORY'>(mode === 'PROFORMAS' ? 'HISTORY' : 'NEW');
  const [prodQuery, setProdQuery] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [fiscalDocType, setFiscalDocType] = useState<'FACTURA_RECIBO' | 'FACTURA'>('FACTURA_RECIBO');
  const [isCommonConsumer, setIsCommonConsumer] = useState(true);
  const [customerId, setCustomerId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('DINHEIRO');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [agtStatus, setAgtStatus] = useState<AgtPublicStatus | null>(null);
  const [receiptTarget, setReceiptTarget] = useState<Sale | null>(null);
  const [receiptAmount, setReceiptAmount] = useState('');
  const [receiptPaymentMethod, setReceiptPaymentMethod] = useState<PaymentMethod>('DINHEIRO');
  const [receiptNotes, setReceiptNotes] = useState('');

  const [agtModalSale, setAgtModalSale] = useState<Sale | null>(null);
  const [agtJsonPreview, setAgtJsonPreview] = useState<Record<string, unknown> | null>(null);
  const [agtLoading, setAgtLoading] = useState(false);

  useEffect(() => {
    apiFetch<AgtPublicStatus>('/api/fiscal/agt/status')
      .then((res) => setAgtStatus(res))
      .catch(() => {});
  }, []);

  const [stockShortageAlert, setStockShortageAlert] = useState<{
    message: string;
    shortages: Array<{ productId: string; productName: string; requested: number; available: number }>;
  } | null>(null);
  const [barcodeFeedback, setBarcodeFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Quick customer creation inside POS
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  const [qcName, setQcName] = useState('');
  const [qcNif, setQcNif] = useState('');
  const [qcPhone, setQcPhone] = useState('');
  const [qcAddress, setQcAddress] = useState('');

  // History filters
  const [histQuery, setHistQuery] = useState('');
  const [histDate, setHistDate] = useState('');
  const [histSeller, setHistSeller] = useState('');
  const [histType, setHistType] = useState<
    'ALL' | 'FACTURA_RECIBO' | 'FACTURA' | 'FATURA' | 'RECIBO' | 'PROFORMA'
  >(mode === 'PROFORMAS' ? 'PROFORMA' : 'ALL');

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const searchableProducts = useMemo(() => {
    const q = prodQuery.trim().toLowerCase();
    return products
      .filter((p) => p.active)
      .filter((p) => {
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          p.activeIngredient.toLowerCase().includes(q) ||
          p.code.toLowerCase().includes(q) ||
          (p.barcode || '').toLowerCase().includes(q) ||
          p.batch.toLowerCase().includes(q)
        );
      })
      .slice(0, 30);
  }, [products, prodQuery]);

  const addToCart = (product: Product) => {
    setStockShortageAlert(null);
    setCart((prev) => {
      const existing = prev.find((c) => c.productId === product.id);
      if (existing) {
        return prev.map((c) =>
          c.productId === product.id ? { ...c, quantity: c.quantity + 1 } : c
        );
      }
      return [...prev, { productId: product.id, quantity: 1, discountPercent: 0 }];
    });
  };

  const handleBarcodeLookup = (rawInput: string, source: 'USB' | 'CAMERA') => {
    const clean = normalizeBarcode(rawInput);
    if (!clean) return;

    const match = findProductByBarcodeOrCode(products, clean);
    if (!match) {
      if (source === 'USB' && searchableProducts.length > 0) {
        setBarcodeFeedback({
          type: 'success',
          message: `A mostrar ${searchableProducts.length} produto(s) compatíveis por nome/pesquisa. Selecione manualmente ou leia um código de barras exato.`,
        });
        return;
      }
      const msg = `Código "${clean}" não encontrado no catálogo. Nenhuma venda foi criada nem o stock foi alterado.`;
      setBarcodeFeedback({ type: 'error', message: msg });
      onNotify(msg, 'error');
      return;
    }

    if (!match.active) {
      const msg = `O produto "${match.name}" (${match.barcode || match.code}) encontra-se inativo e não pode ser vendido.`;
      setBarcodeFeedback({ type: 'error', message: msg });
      onNotify(msg, 'error');
      return;
    }

    const existingQty = cart.find((c) => c.productId === match.id)?.quantity ?? 0;
    const nextQty = existingQty + 1;
    addToCart(match);
    setProdQuery('');
    const stockNote =
      match.stock <= 0 || nextQty > match.stock
        ? ` Atenção: stock disponível (${match.stock} ${match.unit}) insuficiente para faturar — reveja ou emita proforma.`
        : ' (reveja a quantidade e conclua manualmente).';
    const successMsg = `${
      source === 'CAMERA' ? 'Leitura por câmara' : 'Código lido'
    }: "${match.name}" adicionado ao documento atual${stockNote}`;
    setBarcodeFeedback({ type: 'success', message: successMsg });
    searchInputRef.current?.focus();
  };

  const updateCartLine = (productId: string, patch: Partial<CartLine>) => {
    setStockShortageAlert(null);
    setCart((prev) =>
      prev.map((c) => (c.productId === productId ? { ...c, ...patch } : c))
    );
  };

  const removeCartLine = (productId: string) => {
    setStockShortageAlert(null);
    setCart((prev) => prev.filter((c) => c.productId !== productId));
  };

  const totals = useMemo(() => {
    let subtotal = 0;
    let discountTotal = 0;
    let taxableBaseTotal = 0;
    let taxTotal = 0;
    let total = 0;
    let unconfiguredTaxCount = 0;
    const unconfiguredProducts: string[] = [];
    const invalidRuleProducts: string[] = [];
    const incompleteTaxProducts: string[] = [];
    const positiveVatProducts: string[] = [];
    const groups = new Map<string, TaxBreakdownEntry>();
    const shortages: Array<{ productId: string; productName: string; requested: number; available: number }> = [];
    const today = todayLocalISO();

    for (const line of cart) {
      const p = productMap.get(line.productId);
      if (!p) continue;

      const effTax = resolveEffectiveProductTax(p, settings, p.batch, today);
      const calc = calculateLineVat(
        line.quantity,
        p.salePrice,
        line.discountPercent,
        effTax,
        effTax.priceIncludesTax
      );

      if (effTax.taxCode === 'NAO_CONFIGURADO') {
        unconfiguredTaxCount += 1;
        unconfiguredProducts.push(p.name);
      }
      if (effTax.ruleExpired || effTax.ruleInactive) {
        invalidRuleProducts.push(p.name);
      }
      if (
        (effTax.taxCode === 'ISE' && (!effTax.taxExemptionCode.trim() || !effTax.taxExemptionReason.trim())) ||
        (effTax.taxCode === 'OUT' && Number(effTax.taxRate ?? 0) === 0 && !effTax.taxExemptionReason.trim()) ||
        ((effTax.taxCode === 'NOR' || effTax.taxCode === 'INT' || effTax.taxCode === 'RED') &&
          !(effTax.taxRate !== null && effTax.taxRate > 0))
      ) {
        incompleteTaxProducts.push(p.name);
      }
      if (
        effTax.taxCode === 'NOR' ||
        effTax.taxCode === 'INT' ||
        effTax.taxCode === 'RED' ||
        (effTax.taxRate ?? 0) > 0
      ) {
        positiveVatProducts.push(p.name);
      }

      subtotal = roundMoney(subtotal + calc.grossBeforeDiscount);
      discountTotal = roundMoney(discountTotal + calc.discountAmount);
      taxableBaseTotal = roundMoney(taxableBaseTotal + calc.taxableBase);
      taxTotal = roundMoney(taxTotal + calc.taxAmount);
      total = roundMoney(total + calc.subtotal);

      const effRate =
        effTax.taxCode === 'NAO_CONFIGURADO' ? null : effTax.taxCode === 'ISE' ? 0 : effTax.taxRate ?? null;
      const key = `${effTax.taxCode}|${effRate ?? 'NULL'}|${effTax.taxExemptionCode || ''}|${
        effTax.taxExemptionReason || ''
      }`;
      if (!groups.has(key)) {
        groups.set(key, {
          taxCode: effTax.taxCode,
          taxRate: effRate,
          taxExemptionCode: effTax.taxExemptionCode || '',
          taxExemptionReason: effTax.taxExemptionReason || '',
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

      if (line.quantity > p.stock) {
        shortages.push({
          productId: p.id,
          productName: p.name,
          requested: line.quantity,
          available: p.stock,
        });
      }
    }
    return {
      subtotal,
      discountTotal,
      taxableBaseTotal,
      taxTotal,
      total,
      unconfiguredTaxCount,
      unconfiguredProducts,
      invalidRuleProducts,
      incompleteTaxProducts,
      positiveVatProducts,
      taxBreakdown: Array.from(groups.values()),
      shortages,
    };
  }, [cart, productMap, settings]);

  const vatGlobalBlockedReason = useMemo(() => {
    const missingIssuer: string[] = [];
    if (!settings.legalName?.trim()) missingIssuer.push('Denominação Legal');
    if (!settings.nif?.trim()) missingIssuer.push('NIF');
    if (!settings.address?.trim()) missingIssuer.push('Sede / Domicílio');
    if (!settings.establishmentName?.trim()) missingIssuer.push('Estabelecimento emissor');
    if (missingIssuer.length > 0) {
      return `Emissão fiscal bloqueada: faltam dados obrigatórios da farmácia (${missingIssuer.join(', ')}). Peça ao Administrador para completar nas Configurações.`;
    }
    if (!settings.vatRegime || settings.vatRegime === 'NAO_CONFIGURADO') {
      return 'Emissão fiscal bloqueada: o regime de IVA da farmácia está "NAO_CONFIGURADO". Peça ao Administrador para confirmar o enquadramento com o contabilista nas Configurações (pode emitir Proforma não fiscal).';
    }
    return null;
  }, [settings]);

  const vatBlockedReason = useMemo(() => {
    if (vatGlobalBlockedReason) return vatGlobalBlockedReason;
    if (totals.unconfiguredProducts.length > 0) {
      return `Emissão fiscal bloqueada: artigo(s) sem código/taxa de IVA configurado(s): ${totals.unconfiguredProducts.join(', ')}. Configure no Catálogo de Produtos ou emita uma Proforma.`;
    }
    if (totals.invalidRuleProducts.length > 0) {
      return `Emissão fiscal bloqueada: a regra/taxa de IVA associada a ${totals.invalidRuleProducts.join(', ')} está inativa ou fora de vigência para a data de hoje.`;
    }
    if (totals.incompleteTaxProducts.length > 0) {
      return `Emissão fiscal bloqueada: configuração de IVA incompleta (falta taxa positiva ou código/motivo legal de isenção) em: ${totals.incompleteTaxProducts.join(', ')}.`;
    }
    if (
      (settings.vatRegime === 'SIMPLIFICADO' || settings.vatRegime === 'EXCLUSAO') &&
      totals.positiveVatProducts.length > 0
    ) {
      return `Incoerência fiscal: a farmácia está em Regime ${
        settings.vatRegime === 'SIMPLIFICADO' ? 'Simplificado' : 'de Exclusão'
      }, não podendo liquidar IVA positivo em faturas (${totals.positiveVatProducts.join(', ')}).`;
    }
    return null;
  }, [vatGlobalBlockedReason, totals, settings.vatRegime]);

  const submitDocument = async (docType: SaleDocumentType) => {
    if (cart.length === 0) {
      onNotify('Adicione pelo menos um produto ao carrinho.', 'error');
      return;
    }
    if (!isCommonConsumer && !customerId) {
      onNotify('Selecione o cliente ou escolha Consumidor Final.', 'error');
      return;
    }

    const isFiscal = docType !== 'PROFORMA';
    if (isFiscal && vatBlockedReason) {
      onNotify(vatBlockedReason, 'error');
      return;
    }
    if (isFiscal && registerBlocked) {
      onNotify(
        'O caixa desta sessão está fechado. Abra o caixa antes de concluir uma venda faturada.',
        'error'
      );
      return;
    }

    if (isFiscal && totals.shortages.length > 0) {
      setStockShortageAlert({
        message:
          'A quantidade pedida é superior ao stock disponível. Não é possível concluir a venda faturada, mas pode emitir uma Proforma sem baixar o stock.',
        shortages: totals.shortages,
      });
      return;
    }

    setSubmitting(true);
    setStockShortageAlert(null);
    try {
      const created = await apiFetch<Sale>('/api/sales', {
        method: 'POST',
        body: JSON.stringify({
          type: docType,
          isCommonConsumer,
          customerId: isCommonConsumer ? null : customerId,
          paymentMethod,
          notes,
          items: cart,
        }),
      });
      setCart([]);
      setNotes('');
      await onRefresh();
      onNotify(
        isFiscal
          ? `${saleDocTypeLabel(docType)} ${created.documentNumber} concluída e stock atualizado.`
          : `Proforma ${created.documentNumber} emitida (stock não alterado).`
      );
      onPrintDoc({ kind: 'SALE', doc: created });
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK' && err.shortages) {
        setStockShortageAlert({
          message: err.message,
          shortages: err.shortages,
        });
      } else if (err instanceof ApiError && err.code === 'CASH_REGISTER_CLOSED') {
        onNotify(err.message, 'error');
        await onRefresh();
      } else {
        onNotify(err?.message || 'Erro ao emitir documento.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openReceiptModal = (inv: Sale) => {
    const alreadyPaid = inv.paidAmount ?? (inv.type === 'FACTURA' ? 0 : inv.totalAmount);
    const remaining = Math.max(0, Math.round((inv.totalAmount - alreadyPaid) * 100) / 100);
    setReceiptTarget(inv);
    setReceiptAmount(String(remaining));
    setReceiptPaymentMethod(inv.paymentMethod || 'DINHEIRO');
    setReceiptNotes(`Liquidação referente à ${inv.documentNumber}`);
  };

  const handleIssueReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receiptTarget) return;
    setSubmitting(true);
    try {
      const createdReceipt = await apiFetch<Sale>('/api/sales', {
        method: 'POST',
        body: JSON.stringify({
          type: 'RECIBO',
          relatedInvoiceId: receiptTarget.id,
          amount: Number(receiptAmount),
          paymentMethod: receiptPaymentMethod,
          notes: receiptNotes.trim(),
        }),
      });
      setReceiptTarget(null);
      await onRefresh();
      onNotify(`Recibo ${createdReceipt.documentNumber} emitido.`);
      onPrintDoc({ kind: 'SALE', doc: createdReceipt });
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao emitir recibo.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const openAgtInspector = async (sale: Sale) => {
    setAgtModalSale(sale);
    setAgtJsonPreview(null);
    setAgtLoading(true);
    try {
      const payload = await apiFetch<Record<string, unknown>>(
        `/api/fiscal/agt/payload/SALE/${sale.id}`
      );
      setAgtJsonPreview(payload);
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao gerar pré-visualização JSON v2.0.', 'error');
    } finally {
      setAgtLoading(false);
    }
  };

  const handleSubmitToAgt = async (sale: Sale) => {
    setAgtLoading(true);
    try {
      const res = await apiFetch<{ submission: { event: { message: string } }; document: Sale }>(
        `/api/fiscal/agt/submit/SALE/${sale.id}`,
        { method: 'POST' }
      );
      setAgtModalSale(res.document);
      await onRefresh();
      onNotify(res.submission.event.message);
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao submeter à AGT.', 'error');
    } finally {
      setAgtLoading(false);
    }
  };

  const handlePollAgtStatus = async (sale: Sale) => {
    setAgtLoading(true);
    try {
      const res = await apiFetch<{ poll: { event: { message: string } }; document: Sale }>(
        `/api/fiscal/agt/poll/SALE/${sale.id}`,
        { method: 'POST' }
      );
      setAgtModalSale(res.document);
      await onRefresh();
      onNotify(res.poll.event.message);
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao consultar estado na AGT.', 'error');
    } finally {
      setAgtLoading(false);
    }
  };

  const handleConsultAgtInvoice = async (sale: Sale) => {
    setAgtLoading(true);
    try {
      const res = await apiFetch<{ consult: { event: { message: string } }; document: Sale }>(
        `/api/fiscal/agt/consultar/SALE/${sale.id}`,
        { method: 'POST' }
      );
      setAgtModalSale(res.document);
      await onRefresh();
      onNotify(res.consult.event.message);
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao consultar factura na AGT.', 'error');
    } finally {
      setAgtLoading(false);
    }
  };

  const handleConvertProforma = async (proforma: Sale) => {
    if (registerBlocked) {
      onNotify(
        'O caixa desta sessão está fechado. Abra o caixa antes de faturar uma proforma.',
        'error'
      );
      return;
    }
    try {
      const converted = await apiFetch<Sale>(`/api/sales/${proforma.id}/convert-proforma`, {
        method: 'POST',
        body: JSON.stringify({ paymentMethod: proforma.paymentMethod }),
      });
      await onRefresh();
      onNotify(`Proforma ${proforma.documentNumber} convertida na fatura ${converted.documentNumber}.`);
      onPrintDoc({ kind: 'SALE', doc: converted });
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'CASH_REGISTER_CLOSED') {
        onNotify(err.message, 'error');
        await onRefresh();
        return;
      }
      onNotify(err?.message || 'Não foi possível converter a proforma.', 'error');
    }
  };

  const handleCreateQuickCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await apiFetch<Customer>('/api/customers', {
        method: 'POST',
        body: JSON.stringify({
          name: qcName,
          nif: qcNif,
          phone: qcPhone,
          address: qcAddress,
        }),
      });
      await onRefresh();
      setIsCommonConsumer(false);
      setCustomerId(created.id);
      setShowQuickCustomer(false);
      setQcName('');
      setQcNif('');
      setQcPhone('');
      setQcAddress('');
      onNotify(`Cliente ${created.name} registado.`);
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao cadastrar cliente.', 'error');
    }
  };

  const sellersList = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sales) map.set(s.sellerId, s.sellerName);
    return Array.from(map.entries());
  }, [sales]);

  const filteredHistory = useMemo(() => {
    const q = histQuery.trim().toLowerCase();
    return sales.filter((s) => {
      if (histType !== 'ALL' && s.type !== histType) return false;
      if (histDate && s.date !== histDate) return false;
      if (histSeller && s.sellerId !== histSeller) return false;
      if (q) {
        const hay = `${s.documentNumber} ${s.customerName} ${s.customerNif} ${s.sellerName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sales, histQuery, histDate, histSeller, histType]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
            {mode === 'PROFORMAS' ? 'Proformas e Orçamentos' : 'Vendas e Facturação (DP 71/25)'}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Fatura-Recibo (FR), Fatura (FT), Recibo (RC) e Proforma (PF) com validação de stock e apuramento de imposto por linha.
          </p>
        </div>

        <div className="inline-flex p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setSubTab('NEW')}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'NEW'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Novo Atendimento
          </button>
          <button
            type="button"
            onClick={() => setSubTab('HISTORY')}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'HISTORY'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Histórico de Documentos ({sales.length})
          </button>
        </div>
      </div>

      {agtStatus && !agtStatus.certified && (
        <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
          <span>{agtStatus.certifiedDisclaimer}</span>
        </div>
      )}

      {subTab === 'NEW' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Product search catalog */}
          <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={prodQuery}
                    onChange={(e) => {
                      setProdQuery(e.target.value);
                      if (barcodeFeedback) setBarcodeFeedback(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && prodQuery.trim()) {
                        e.preventDefault();
                        handleBarcodeLookup(prodQuery, 'USB');
                      }
                    }}
                    placeholder="Pesquisar produto por nome ou ler código de barras (USB + Enter)..."
                    className="w-full min-h-[42px] pl-9 pr-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-700"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={!prodQuery.trim()}
                    onClick={() => handleBarcodeLookup(prodQuery, 'USB')}
                    className="min-h-[42px] px-3 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 text-slate-800 dark:text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap"
                    title="Localizar pelo código exato digitado ou lido por leitor USB"
                  >
                    <ScanBarcode className="w-4 h-4 text-green-700 dark:text-green-400" />
                    Ler Código
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowScanner(true)}
                    className="min-h-[42px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap"
                    title="Ativar câmara para ler código de barras"
                  >
                    <Camera className="w-4 h-4 text-green-700 dark:text-green-400" />
                    Ler Câmara
                  </button>
                </div>
              </div>

              {barcodeFeedback && (
                <div
                  role={barcodeFeedback.type === 'error' ? 'alert' : 'status'}
                  className={`px-3 py-2 rounded-lg border text-xs flex items-center justify-between gap-2 ${
                    barcodeFeedback.type === 'error'
                      ? 'bg-red-50 dark:bg-red-950/60 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
                      : 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                  }`}
                >
                  <span>{barcodeFeedback.message}</span>
                  <button
                    type="button"
                    onClick={() => setBarcodeFeedback(null)}
                    className="p-0.5 opacity-70 hover:opacity-100"
                    aria-label="Fechar aviso"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[540px] overflow-y-auto">
              {searchableProducts.map((p) => (
                <div
                  key={p.id}
                  className="p-3.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{p.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                      <span className="font-mono">{p.code}</span>
                      {p.barcode ? <span className="font-mono"> · Barras: {p.barcode}</span> : ''}
                      {p.activeIngredient ? ` · ${p.activeIngredient}` : ''}
                      {p.dosage ? ` · ${p.dosage}` : ''}
                      {p.batch ? ` · Lote ${p.batch}` : ''}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="text-sm font-mono font-semibold text-slate-900 dark:text-slate-100">
                        {formatMoney(p.salePrice, cur)}
                      </div>
                      <div
                        className={`text-[11px] font-mono ${
                          p.stock <= 0
                            ? 'text-red-700 dark:text-red-400 font-semibold'
                            : p.stock <= p.minStock
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-emerald-700 dark:text-emerald-400'
                        }`}
                      >
                        Disp.: {p.stock} {p.unit}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => addToCart(p)}
                      className="min-h-[40px] px-3 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white text-xs font-medium rounded-lg flex items-center gap-1 whitespace-nowrap"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Adicionar
                    </button>
                  </div>
                </div>
              ))}
              {searchableProducts.length === 0 && (
                <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                  Nenhum produto ativo corresponde à pesquisa.
                </div>
              )}
            </div>
          </div>

          {/* Right: Cart & Checkout */}
          <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-4 h-4 text-green-700 dark:text-green-400" />
                <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
                  Documento Atual ({cart.length} artigo{cart.length === 1 ? '' : 's'})
                </h2>
              </div>
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setCart([]);
                    setStockShortageAlert(null);
                  }}
                  className="text-xs text-slate-500 dark:text-slate-400 hover:text-red-700 dark:hover:text-red-400"
                >
                  Limpar
                </button>
              )}
            </div>

            {/* Customer Selection */}
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <label className="font-medium text-slate-700 dark:text-slate-300">Cliente / Faturação</label>
                <button
                  type="button"
                  onClick={() => setShowQuickCustomer(true)}
                  className="text-green-700 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 font-medium inline-flex items-center gap-1"
                >
                  <UserPlus className="w-3.5 h-3.5" /> Novo Cliente NIF
                </button>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsCommonConsumer(true)}
                  className={`flex-1 py-2 px-2.5 rounded-lg border text-xs font-medium transition-colors ${
                    isCommonConsumer
                      ? 'bg-green-50 dark:bg-green-950/60 border-green-700 dark:border-green-500 text-green-900 dark:text-green-200'
                      : 'bg-white dark:bg-slate-950 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  Consumidor Comum
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsCommonConsumer(false);
                    if (!customerId && customers[0]) setCustomerId(customers[0].id);
                  }}
                  className={`flex-1 py-2 px-2.5 rounded-lg border text-xs font-medium transition-colors ${
                    !isCommonConsumer
                      ? 'bg-green-50 dark:bg-green-950/60 border-green-700 dark:border-green-500 text-green-900 dark:text-green-200'
                      : 'bg-white dark:bg-slate-950 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  Cliente com NIF
                </button>
              </div>
              {!isCommonConsumer && (
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
                >
                  <option value="">Selecionar cliente registado...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} (NIF: {c.nif || 'N/D'})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Cart items */}
            <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-64 overflow-y-auto border-t border-b border-slate-200 dark:border-slate-800">
              {cart.map((line) => {
                const p = productMap.get(line.productId);
                if (!p) return null;
                const exceeds = line.quantity > p.stock;
                const effTax = resolveEffectiveProductTax(p, settings, p.batch, todayLocalISO());
                const calc = calculateLineVat(
                  line.quantity,
                  p.salePrice,
                  line.discountPercent,
                  effTax,
                  effTax.priceIncludesTax
                );
                const tCode = effTax.taxCode;
                const tRate = tCode === 'NAO_CONFIGURADO' ? null : tCode === 'ISE' ? 0 : effTax.taxRate ?? null;
                const lineTax = calc.taxAmount;
                const lineFinal = calc.subtotal;
                return (
                  <div key={line.productId} className="py-3 space-y-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{p.name}</div>
                        <div className="text-slate-500 dark:text-slate-400 font-mono">
                          {formatMoney(p.salePrice, cur)} ({effTax.priceIncludesTax ? 'c/ IVA' : '+ IVA'}) · Stock: {p.stock} ·{' '}
                          <span className={tCode === 'NAO_CONFIGURADO' || effTax.ruleExpired || effTax.ruleInactive ? 'text-amber-700 dark:text-amber-400 font-semibold' : ''}>
                            {taxCodeLabel(tCode, tRate)}
                          </span>
                          {effTax.batchMatched && <span className="ml-1 text-sky-700 dark:text-sky-400">[Lote]</span>}
                        </div>
                        {exceeds && (
                          <div className="text-red-700 dark:text-red-400 font-medium mt-0.5">
                            Quantidade superior ao stock disponível ({p.stock}).
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeCartLine(line.productId)}
                        className="p-1.5 text-slate-400 hover:text-red-700 dark:hover:text-red-400"
                        aria-label="Remover artigo"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <label className="text-slate-500 dark:text-slate-400">Qtd:</label>
                        <input
                          type="number"
                          min="1"
                          value={line.quantity}
                          onChange={(e) =>
                            updateCartLine(line.productId, {
                              quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                            })
                          }
                          className="w-16 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded font-mono text-xs"
                        />
                        {maxDiscount > 0 && (
                          <>
                            <label className="text-slate-500 dark:text-slate-400 ml-1">Desc.%:</label>
                            <input
                              type="number"
                              min="0"
                              max={maxDiscount}
                              value={line.discountPercent}
                              onChange={(e) =>
                                updateCartLine(line.productId, {
                                  discountPercent: Math.min(
                                    maxDiscount,
                                    Math.max(0, Number(e.target.value) || 0)
                                  ),
                                })
                              }
                              className="w-16 px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded font-mono text-xs"
                            />
                          </>
                        )}
                      </div>
                      <div className="text-right font-mono">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {formatMoney(lineFinal, cur)}
                        </div>
                        {lineTax > 0 && (
                          <div className="text-[10px] text-slate-500 dark:text-slate-400">
                            IVA: {formatMoney(lineTax, cur)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {cart.length === 0 && (
                <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
                  Pesquise e adicione medicamentos à esquerda para iniciar a venda ou proforma.
                </div>
              )}
            </div>

            {/* Fiscal Document Type Selector */}
            <div className="space-y-1.5 text-xs">
              <label className="block font-medium text-slate-700 dark:text-slate-300">
                Tipo de Documento Fiscal a Emitir
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setFiscalDocType('FACTURA_RECIBO')}
                  className={`py-2 px-2.5 rounded-lg border text-left transition-colors ${
                    fiscalDocType === 'FACTURA_RECIBO'
                      ? 'bg-green-50 dark:bg-green-950/60 border-green-700 dark:border-green-500 text-green-900 dark:text-green-200'
                      : 'bg-white dark:bg-slate-950 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <div className="font-semibold">Fatura-Recibo (FR)</div>
                  <div className="text-[10px] opacity-80">Liquidação imediata no ato</div>
                </button>
                <button
                  type="button"
                  onClick={() => setFiscalDocType('FACTURA')}
                  className={`py-2 px-2.5 rounded-lg border text-left transition-colors ${
                    fiscalDocType === 'FACTURA'
                      ? 'bg-green-50 dark:bg-green-950/60 border-green-700 dark:border-green-500 text-green-900 dark:text-green-200'
                      : 'bg-white dark:bg-slate-950 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <div className="font-semibold">Fatura (FT)</div>
                  <div className="text-[10px] opacity-80">Liquidação posterior (Recibo)</div>
                </button>
              </div>
            </div>

            {/* Payment method & notes */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {fiscalDocType === 'FACTURA' ? 'Modalidade Prevista' : 'Forma de Pagamento'}
                </label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs"
                >
                  <option value="DINHEIRO">Dinheiro</option>
                  <option value="MULTICAIXA">Multicaixa / TPA</option>
                  <option value="TRANSFERENCIA">Transferência</option>
                  <option value="SEGURO">Seguro / Convénio</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Observações</label>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Opcional..."
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-xs"
                />
              </div>
            </div>

            {/* Totals with Separated Tax Lines */}
            <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-600 dark:text-slate-400">
                <span>Subtotal (Catálogo)</span>
                <span className="font-mono">{formatMoney(totals.subtotal, cur)}</span>
              </div>
              <div className="flex justify-between text-slate-600 dark:text-slate-400">
                <span>Descontos</span>
                <span className="font-mono">-{formatMoney(totals.discountTotal, cur)}</span>
              </div>
              <div className="flex justify-between text-slate-600 dark:text-slate-400">
                <span>Base Tributável / Incidência</span>
                <span className="font-mono">{formatMoney(totals.taxableBaseTotal, cur)}</span>
              </div>
              <div className="flex justify-between text-slate-600 dark:text-slate-400">
                <span>Imposto (IVA)</span>
                <span className="font-mono">{formatMoney(totals.taxTotal, cur)}</span>
              </div>
              {totals.taxBreakdown.length > 0 && (
                <div className="pt-1 border-t border-slate-200/80 dark:border-slate-800 space-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {totals.taxBreakdown.map((tb, idx) => (
                    <div key={idx} className="flex justify-between">
                      <span>
                        {taxCodeLabel(tb.taxCode, tb.taxRate)}
                        {tb.taxExemptionCode ? ` [${tb.taxExemptionCode}]` : ''}
                      </span>
                      <span className="font-mono">
                        Base {formatMoney(tb.taxableBase, cur)} · IVA {formatMoney(tb.taxAmount, cur)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {totals.unconfiguredTaxCount > 0 && (
                <div className="text-[11px] text-amber-700 dark:text-amber-400">
                  {totals.unconfiguredTaxCount} artigo(s) no carrinho sem taxa de IVA configurada.
                </div>
              )}
              <div className="flex justify-between text-sm font-semibold text-slate-900 dark:text-slate-100 pt-1.5 border-t border-slate-200 dark:border-slate-800">
                <span>{fiscalDocType === 'FACTURA' ? 'Total da Fatura' : 'Total a Pagar'}</span>
                <span className="font-mono">{formatMoney(totals.total, cur)}</span>
              </div>
            </div>

            {/* Stock shortage hard block & proforma option */}
            {stockShortageAlert && (
              <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-700 space-y-2.5 text-xs text-amber-950 dark:text-amber-200">
                <div className="flex items-start gap-2 font-semibold">
                  <AlertCircle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                  <span>{stockShortageAlert.message}</span>
                </div>
                <ul className="list-disc pl-5 space-y-0.5 font-mono text-[11px]">
                  {stockShortageAlert.shortages.map((s) => (
                    <li key={s.productId}>
                      {s.productName}: pedido {s.requested} · disponível {s.available}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={submitting || !isOnline}
                  onClick={() => submitDocument('PROFORMA')}
                  className="w-full min-h-[40px] px-3 py-2 bg-amber-700 hover:bg-amber-800 disabled:opacity-50 text-white font-medium rounded-lg flex items-center justify-center gap-1.5"
                >
                  <FileText className="w-4 h-4" />
                  Emitir Proforma (sem baixar stock)
                </button>
              </div>
            )}

            {registerBlocked && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-200 space-y-2"
              >
                <div className="flex items-start gap-2 font-medium">
                  <Lock className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    {cashRegisterStatus?.isPeriodClosed
                      ? `Período de hoje encerrado (${cashRegisterStatus.closedPeriodRef}). Novas vendas faturadas estão bloqueadas.`
                      : (cashRegisterStatus?.closedTodayCount ?? 0) >=
                        (cashRegisterStatus?.maxAllowedPerDay ?? 2)
                      ? `Caixa fechado após atingir o limite de ${cashRegisterStatus?.maxAllowedPerDay ?? 2} fechos diários. Não é possível registar novas vendas hoje.`
                      : 'Caixa fechado nesta sessão. Para concluir vendas faturadas, abra primeiro o seu caixa.'}
                  </span>
                </div>
                {canOpenAnotherRegister && onOpenCashRegister && (
                  <button
                    type="button"
                    onClick={onOpenCashRegister}
                    className="min-h-[36px] px-3 py-1.5 bg-green-700 hover:bg-green-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5"
                  >
                    <Unlock className="w-3.5 h-3.5" />
                    Abrir caixa
                  </button>
                )}
              </div>
            )}

            {vatBlockedReason && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-300 dark:border-red-800 text-xs text-red-950 dark:text-red-200 space-y-2"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-700 dark:text-red-400 shrink-0 mt-0.5" />
                  <span>{vatBlockedReason}</span>
                </div>
                {(onOpenVatSettings || onOpenProductsNoTax) && (
                  <div className="flex flex-wrap gap-2 pl-6">
                    {isAdmin && onOpenVatSettings && (
                      <button
                        type="button"
                        onClick={onOpenVatSettings}
                        className="px-2.5 py-1 rounded-md bg-red-700 hover:bg-red-800 text-white font-medium text-[11px]"
                      >
                        Configurar Dados Fiscais e Regime de IVA
                      </button>
                    )}
                    {onOpenProductsNoTax && (
                      <button
                        type="button"
                        onClick={onOpenProductsNoTax}
                        className="px-2.5 py-1 rounded-md bg-white dark:bg-slate-900 border border-red-300 dark:border-red-700 hover:bg-red-100/60 dark:hover:bg-red-900/40 text-red-900 dark:text-red-100 font-medium text-[11px]"
                      >
                        Configurar IVA dos Produtos
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {!isOnline && (
              <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-[11px] font-medium text-amber-900 dark:text-amber-200">
                Sem ligação à internet: não é possível emitir faturas ou proformas no modo offline.
              </div>
            )}

            {/* Action buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={submitting || cart.length === 0 || !isOnline}
                onClick={() => submitDocument('PROFORMA')}
                className="min-h-[44px] px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 text-slate-800 dark:text-slate-200 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <FileText className="w-4 h-4" />
                Emitir Proforma
              </button>
              <button
                type="button"
                disabled={submitting || cart.length === 0 || !isOnline || registerBlocked || Boolean(vatBlockedReason)}
                onClick={() => submitDocument(fiscalDocType)}
                className="min-h-[44px] px-3 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <CheckCircle2 className="w-4 h-4" />
                {fiscalDocType === 'FACTURA' ? 'Emitir Fatura (FT)' : 'Emitir Fatura-Recibo (FR)'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* History Tab */
        <div className="space-y-4">
          {registerBlocked && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2 font-medium">
                <Lock className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0" />
                <span>
                  Caixa fechado nesta sessão. Abra o caixa para converter proformas em faturas.
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
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="relative sm:col-span-2">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={histQuery}
                onChange={(e) => setHistQuery(e.target.value)}
                placeholder="Pesquisar por número, cliente, NIF ou vendedor..."
                className="w-full min-h-[40px] pl-9 pr-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
              />
            </div>
            <select
              value={histType}
              onChange={(e) => setHistType(e.target.value as any)}
              className="min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
            >
              <option value="ALL">Todos os documentos</option>
              <option value="FACTURA_RECIBO">Fatura-Recibo (FR)</option>
              <option value="FACTURA">Fatura (FT)</option>
              <option value="RECIBO">Recibo (RC)</option>
              <option value="PROFORMA">Proforma (PF)</option>
              <option value="FATURA">Faturas Históricas</option>
            </select>
            <div className="flex gap-2">
              <input
                type="date"
                value={histDate}
                onChange={(e) => setHistDate(e.target.value)}
                className="flex-1 min-h-[40px] px-2.5 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-xs font-mono"
              />
              {histDate && (
                <button
                  type="button"
                  onClick={() => setHistDate('')}
                  className="px-2.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 border border-slate-300 dark:border-slate-700 rounded-lg"
                >
                  Limpar
                </button>
              )}
            </div>
            {sellersList.length > 1 && (
              <select
                value={histSeller}
                onChange={(e) => setHistSeller(e.target.value)}
                className="sm:col-span-2 min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
              >
                <option value="">Todos os vendedores</option>
                {sellersList.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                    <th className="py-3 px-4 font-medium">Documento</th>
                    <th className="py-3 px-3 font-medium">Data / Hora</th>
                    <th className="py-3 px-3 font-medium">Cliente</th>
                    <th className="py-3 px-3 font-medium">Vendedor</th>
                    <th className="py-3 px-3 font-medium">Pagamento</th>
                    <th className="py-3 px-3 font-medium text-right">Total</th>
                    <th className="py-3 px-3 font-medium">Estado</th>
                    <th className="py-3 px-4 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {filteredHistory.map((s) => {
                    const paid = s.paidAmount ?? (s.type === 'FACTURA' ? 0 : s.totalAmount);
                    const remainingDebt = Math.max(0, Math.round((s.totalAmount - paid) * 100) / 100);
                    const canIssueReceipt =
                      isInvoiceSaleType(s.type) &&
                      s.status !== 'ANULADA' &&
                      s.status !== 'DEVOLVIDA' &&
                      remainingDebt > 0.01;
                    return (
                      <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <td className="py-3 px-4 font-mono">
                          <div className="font-semibold text-slate-900 dark:text-slate-100">{s.documentNumber}</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {saleDocTypeLabel(s.type)}
                          </div>
                          {s.relatedInvoiceNumber && (
                            <div className="text-[10px] text-slate-500 dark:text-slate-400">
                              Ref.: {s.relatedInvoiceNumber}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-700 dark:text-slate-300">
                          <div>{formatDatePT(s.date)}</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">{s.time}</div>
                        </td>
                        <td className="py-3 px-3">
                          <div className="font-medium text-slate-900 dark:text-slate-100">{s.customerName}</div>
                          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">NIF: {s.customerNif}</div>
                        </td>
                        <td className="py-3 px-3 text-slate-700 dark:text-slate-300">{s.sellerName}</td>
                        <td className="py-3 px-3 text-slate-700 dark:text-slate-300">
                          <div>{paymentMethodLabel(s.paymentMethod)}</div>
                          {s.type === 'FACTURA' && (
                            <div className="text-[10px] font-mono text-amber-700 dark:text-amber-400">
                              {remainingDebt > 0.01 ? `Em dívida: ${formatMoney(remainingDebt, cur)}` : 'Liquidada'}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                          {formatMoney(s.totalAmount, cur)}
                        </td>
                        <td className="py-3 px-3">
                          <span
                            className={`font-medium ${
                              s.status === 'ANULADA'
                                ? 'text-red-700 dark:text-red-400'
                                : s.status === 'DEVOLVIDA' || s.status === 'PARCIALMENTE_DEVOLVIDA'
                                ? 'text-amber-700 dark:text-amber-400'
                                : s.status === 'PROFORMA'
                                ? 'text-slate-700 dark:text-slate-300'
                                : 'text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            {saleStatusLabel(s.status)}
                          </span>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {fiscalStatusLabel(s.fiscalValidationStatus)}
                          </div>
                          {s.convertedDocumentNumber && (
                            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                              → {s.convertedDocumentNumber}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            {s.type === 'PROFORMA' && s.status === 'PROFORMA' && (
                              <button
                                type="button"
                                disabled={!isOnline || registerBlocked || Boolean(vatGlobalBlockedReason)}
                                onClick={() => handleConvertProforma(s)}
                                className="px-2.5 py-1.5 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 disabled:opacity-50 text-white text-[11px] font-medium rounded-lg inline-flex items-center gap-1"
                                title={
                                  vatGlobalBlockedReason ||
                                  (registerBlocked
                                    ? 'Abra o caixa antes de faturar a proforma'
                                    : 'Converter proforma em Fatura-Recibo (baixa stock)')
                                }
                              >
                                <ArrowRightLeft className="w-3.5 h-3.5" />
                                Faturar
                              </button>
                            )}
                            {canIssueReceipt && (
                              <button
                                type="button"
                                disabled={!isOnline || registerBlocked || Boolean(vatGlobalBlockedReason)}
                                onClick={() => openReceiptModal(s)}
                                className="px-2.5 py-1.5 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-[11px] font-medium rounded-lg inline-flex items-center gap-1"
                                title={
                                  vatGlobalBlockedReason ||
                                  'Emitir Recibo (RC) de liquidação total ou parcial'
                                }
                              >
                                <Receipt className="w-3.5 h-3.5" />
                                Recibo
                              </button>
                            )}
                            {isAdmin && s.type !== 'PROFORMA' && (
                              <button
                                type="button"
                                onClick={() => openAgtInspector(s)}
                                className="p-2 text-slate-600 dark:text-slate-400 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                                title="Inspeção AGT FE (JSON v2.0 e Submissão)"
                              >
                                <FileCode2 className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onPrintDoc({ kind: 'SALE', doc: s })}
                              className="p-2 text-slate-600 dark:text-slate-400 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                              title="Imprimir / Guardar PDF"
                            >
                              <Printer className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredHistory.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-500 dark:text-slate-400">
                        Nenhum documento encontrado com os filtros atuais.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Quick Customer Modal */}
      {showQuickCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                Novo Cliente com NIF
              </h3>
              <button
                type="button"
                onClick={() => setShowQuickCustomer(false)}
                className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateQuickCustomer} className="space-y-3 text-sm">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Nome completo *</label>
                <input
                  required
                  value={qcName}
                  onChange={(e) => setQcName(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">NIF *</label>
                <input
                  required
                  value={qcNif}
                  onChange={(e) => setQcNif(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Contacto</label>
                <input
                  value={qcPhone}
                  onChange={(e) => setQcPhone(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Endereço</label>
                <input
                  value={qcAddress}
                  onChange={(e) => setQcAddress(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowQuickCustomer(false)}
                  className="px-4 py-2 text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white rounded-lg font-medium"
                >
                  Guardar Cliente
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {receiptTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                Emitir Recibo (RC) — {receiptTarget.documentNumber}
              </h3>
              <button
                type="button"
                onClick={() => setReceiptTarget(null)}
                className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleIssueReceipt} className="space-y-3 text-xs">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1">
                <div>Cliente: <strong>{receiptTarget.customerName}</strong> (NIF: {receiptTarget.customerNif})</div>
                <div className="text-[11px] text-slate-600 dark:text-slate-400 font-mono">
                  Base: {formatMoney(roundMoney(receiptTarget.totalAmount - (receiptTarget.taxTotal || 0)), cur)} + IVA:{' '}
                  {formatMoney(receiptTarget.taxTotal || 0, cur)}
                </div>
                <div>Total da Fatura: <span className="font-mono font-semibold">{formatMoney(receiptTarget.totalAmount, cur)}</span></div>
                <div>Já Liquidado: <span className="font-mono">{formatMoney(receiptTarget.paidAmount || 0, cur)}</span></div>
                <div>
                  Saldo em Dívida:{' '}
                  <span className="font-mono font-semibold text-amber-700 dark:text-amber-400">
                    {formatMoney(Math.max(0, roundMoney(receiptTarget.totalAmount - (receiptTarget.paidAmount || 0))), cur)}
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 pt-1">
                  O Recibo (RC) regista o recebimento da fatura original sem voltar a liquidar IVA.
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Valor Recebido ({cur}) *
                </label>
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={receiptAmount}
                  onChange={(e) => setReceiptAmount(e.target.value)}
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono text-sm"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Forma de Pagamento</label>
                <select
                  value={receiptPaymentMethod}
                  onChange={(e) => setReceiptPaymentMethod(e.target.value as PaymentMethod)}
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
                >
                  <option value="DINHEIRO">Dinheiro</option>
                  <option value="MULTICAIXA">Multicaixa / TPA</option>
                  <option value="TRANSFERENCIA">Transferência</option>
                  <option value="SEGURO">Seguro / Convénio</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Observações</label>
                <input
                  value={receiptNotes}
                  onChange={(e) => setReceiptNotes(e.target.value)}
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setReceiptTarget(null)}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-green-700 hover:bg-green-800 text-white rounded-lg font-medium"
                >
                  {submitting ? 'A emitir...' : 'Confirmar Recibo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {agtModalSale && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 my-8 shadow-2xl text-xs">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                  Comunicação Fiscal AGT — {agtModalSale.documentNumber}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Estado atual: {fiscalStatusLabel(agtModalSale.fiscalValidationStatus)}
                  {agtModalSale.agtRequestId ? ` · requestID: ${agtModalSale.agtRequestId}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAgtModalSale(null)}
                className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {agtStatus && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-950 dark:text-amber-200">
                {agtStatus.certifiedDisclaimer}
              </div>
            )}

            {agtModalSale.agtRejectionReason && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-red-900 dark:text-red-200">
                <strong>Motivo de Rejeição / Alerta AGT:</strong> {agtModalSale.agtRejectionReason}
              </div>
            )}

            {(agtModalSale.agtHash || agtModalSale.agtQrCode) && (
              <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-[11px] font-mono space-y-1">
                {agtModalSale.agtHash && <div>Hash AGT: {agtModalSale.agtHash}</div>}
                {agtModalSale.agtQrCode && <div>QR AGT: {agtModalSale.agtQrCode}</div>}
              </div>
            )}

            {(() => {
              const localVal = agtJsonPreview?.localValidation as
                | { valid?: boolean; errors?: string[] }
                | undefined;
              if (!localVal) return null;
              return (
                <div
                  className={`p-3 rounded-lg border text-[11px] space-y-1 ${
                    localVal.valid
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                      : 'bg-red-50 dark:bg-red-950/60 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
                  }`}
                >
                  <div className="font-semibold">
                    Validação Estrutural Local (Schema FE 2.0): {localVal.valid ? 'Conforme' : 'Com erros impeditivos'}
                  </div>
                  {Array.isArray(localVal.errors) && localVal.errors.length > 0 && (
                    <ul className="list-disc pl-5 space-y-0.5">
                      {localVal.errors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={agtLoading}
                onClick={() => handleSubmitToAgt(agtModalSale)}
                className="px-3.5 py-2 bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-lg font-medium inline-flex items-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5" />
                Submeter à AGT (registarFactura)
              </button>
              {agtModalSale.agtRequestId && (
                <button
                  type="button"
                  disabled={agtLoading}
                  onClick={() => handlePollAgtStatus(agtModalSale)}
                  className="px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg font-medium"
                >
                  Consultar Estado (obterEstado)
                </button>
              )}
              <button
                type="button"
                disabled={agtLoading}
                onClick={() => handleConsultAgtInvoice(agtModalSale)}
                className="px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg font-medium"
              >
                Consultar Factura (consultarFactura)
              </button>
            </div>

            {Array.isArray(agtModalSale.agtSubmissionHistory) && agtModalSale.agtSubmissionHistory.length > 0 && (
              <div className="space-y-1.5">
                <div className="font-semibold text-slate-800 dark:text-slate-200">Histórico de Comunicação AGT</div>
                <div className="max-h-36 overflow-y-auto space-y-1 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5">
                  {agtModalSale.agtSubmissionHistory.map((ev) => (
                    <div key={ev.id} className="text-[11px] text-slate-700 dark:text-slate-300">
                      <span className="font-mono text-slate-500">{formatDateTimePT(ev.timestamp)}</span> ·{' '}
                      <strong className="font-mono">{ev.action}</strong> — {ev.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                Pré-visualização JSON FE AGT (Schema 2.0)
              </div>
              <pre className="max-h-60 overflow-auto p-3 rounded-lg bg-slate-950 text-slate-100 font-mono text-[11px]">
                {agtLoading
                  ? 'A carregar payload...'
                  : agtJsonPreview
                  ? JSON.stringify(agtJsonPreview, null, 2)
                  : 'Sem dados.'}
              </pre>
            </div>
          </div>
        </div>
      )}

      {showScanner && (
        <BarcodeScannerModal
          title="Ler Código de Barras na Venda"
          subtitle="Aponte a câmara para o código de barras do medicamento. A leitura apenas adiciona o artigo ao carrinho."
          onDetected={(code) => {
            setShowScanner(false);
            handleBarcodeLookup(code, 'CAMERA');
          }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
};
