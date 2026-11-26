import React, { useEffect, useMemo, useState } from 'react';
import { FileDown, FileSpreadsheet, Lock, Printer, Search } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { fieldOrUnregistered } from '../lib/barcode';
import {
  exportTableToPDF,
  exportToExcel,
  formatDatePT,
  formatMoney,
  paymentMethodLabel,
  roundMoney,
  saleDocTypeLabel,
  saleStatusLabel,
  taxCodeLabel,
  todayLocalISO,
} from '../lib/format';
import type {
  PaymentMethod,
  PharmacySettings,
  PharmacologicalClass,
  Product,
  Purchase,
  SaleStatus,
  Supplier,
  TaxBreakdownEntry,
  TaxCode,
  User,
} from '../types';
import { ANCORA_LOGO_SRC } from './BrandLogo';

interface ReportsViewProps {
  user: User;
  settings: PharmacySettings;
  users: User[];
  products: Product[];
  classes: PharmacologicalClass[];
  suppliers: Supplier[];
}

interface DetailedSaleItemReport {
  productId: string;
  productName: string;
  productCode: string;
  productBarcode: string;
  className: string;
  dosageForm: string;
  dosage: string;
  unit: string;
  quantity: number;
  returnedQuantity: number;
  unitPrice: number;
  discountPercent: number;
  discountAmount: number;
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode: string;
  taxExemptionReason: string;
  taxableBase: number;
  taxAmount: number;
  subtotal: number;
}

interface DetailedSaleReport {
  id: string;
  documentNumber: string;
  documentType?: string;
  date: string;
  time: string;
  sellerId: string;
  sellerName: string;
  paymentMethod: PaymentMethod;
  customerName: string;
  status: SaleStatus;
  subtotal: number;
  discountTotal: number;
  taxableBaseTotal: number;
  taxTotal: number;
  taxBreakdown: TaxBreakdownEntry[];
  totalAmount: number;
  filteredTotal: number;
  items: DetailedSaleItemReport[];
}

interface StockReportRow extends Omit<Product, 'purchasePrice'> {
  barcode: string;
  className: string;
  supplierName: string;
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode: string;
  taxExemptionReason: string;
  purchasePrice: number | null;
  costValue: number | null;
  saleValue: number;
  isOut: boolean;
  isLow: boolean;
  isExpired: boolean;
  isExpiring: boolean;
}

interface PeriodTaxSummaryEntry {
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode: string;
  taxExemptionReason: string;
  salesBase: number;
  salesTax: number;
  salesTotal: number;
  salesItemsCount: number;
  returnsBase: number;
  returnsTax: number;
  returnsTotal: number;
  returnsItemsCount: number;
  netBase: number;
  netTax: number;
  netTotal: number;
}

interface ReportResponse {
  filters: {
    startDate: string;
    endDate: string;
    prevStartDate: string;
    prevEndDate: string;
    spanDays: number;
    effectiveSellerId?: string;
    canSeeCosts?: boolean;
  };
  summary: {
    invoicesCount: number;
    proformasCount: number;
    unitsSold: number;
    grossTotal: number;
    returnsTotal: number;
    cancellationsCount: number;
    netTotal: number;
    salesTaxableBaseTotal: number;
    salesTaxTotal: number;
    returnsTaxableBaseTotal: number;
    returnsTaxTotal: number;
    netTaxableBaseTotal: number;
    netTaxTotal: number;
    taxBreakdown: PeriodTaxSummaryEntry[];
    paymentTotals: Record<PaymentMethod, number>;
    comparison: {
      previousGrossTotal: number;
      previousReturnsTotal: number;
      previousNetTotal: number;
      deltaNet: number;
      deltaPercent: number;
    };
  };
  detailedSales: DetailedSaleReport[];
  dailyBySeller: Array<{
    date: string;
    sellerId: string;
    sellerName: string;
    invoicesCount: number;
    unitsSold: number;
    grossTotal: number;
    returnsCount: number;
    cancellationsCount: number;
    returnsTotal: number;
    netTotal: number;
    byPayment: Record<PaymentMethod, number>;
  }>;
  dailySeries: Array<{ date: string; sales: number; returns: number; net: number }>;
  returnsList: Array<{
    id: string;
    documentNumber: string;
    type: string;
    rectificationNature?: string;
    originalDocumentNumber: string;
    originalSellerName: string;
    reason: string;
    taxableBaseTotal?: number;
    taxTotal?: number;
    taxBreakdown?: TaxBreakdownEntry[];
    buyerAcknowledgement?: {
      confirmed?: boolean;
      method?: string;
      reference?: string;
    };
    totalRefund: number;
    date: string;
  }>;
  purchasesReport?: {
    count: number;
    baseTotal: number;
    taxTotal: number;
    totalAmount: number;
    taxBreakdown: TaxBreakdownEntry[];
    items: Purchase[];
  };
  stockReport: StockReportRow[];
  alerts: {
    outOfStock: Array<StockReportRow>;
    lowStock: Array<StockReportRow>;
    expiringSoon: Array<StockReportRow>;
  };
  inventories: Array<{
    id: string;
    referenceNumber: string;
    countedAt: string;
    countedByName: string;
    status: string;
    totalDiscrepancies: number;
    totalShortageUnits: number;
    totalSurplusUnits: number;
    reason: string;
  }>;
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function monthStartISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export const ReportsView: React.FC<ReportsViewProps> = ({
  user,
  settings,
  users,
  products,
  classes,
  suppliers,
}) => {
  const cur = settings.currencySymbol || 'Kz';
  const today = todayLocalISO();
  const isAdmin = user.role === 'ADMIN';
  const canSeeCosts = isAdmin || Boolean(user.permissions.canViewPurchases);

  const [preset, setPreset] = useState<'TODAY' | 'WEEK' | 'MONTH' | 'CUSTOM'>('MONTH');
  const [startDate, setStartDate] = useState(monthStartISO());
  const [endDate, setEndDate] = useState(today);
  const [sellerId, setSellerId] = useState(isAdmin ? '' : user.id);
  const [productId, setProductId] = useState('');
  const [classId, setClassId] = useState('');
  const [searchText, setSearchText] = useState('');
  const [stockSupplierFilter, setStockSupplierFilter] = useState('');
  const [stockStatusFilter, setStockStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE' | 'LOW' | 'OUT' | 'EXPIRING'>('ALL');
  const [activeTab, setActiveTab] = useState<
    'SALES_DETAIL' | 'DAILY_SELLER' | 'CREDIT_NOTES' | 'PURCHASES' | 'PERIODS' | 'STOCK' | 'ALERTS' | 'INVENTORY'
  >('SALES_DETAIL');

  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const effectiveSellerQuery = isAdmin ? sellerId : user.id;

  const applyPreset = (next: 'TODAY' | 'WEEK' | 'MONTH') => {
    setPreset(next);
    if (next === 'TODAY') {
      setStartDate(today);
      setEndDate(today);
    } else if (next === 'WEEK') {
      setStartDate(daysAgoISO(6));
      setEndDate(today);
    } else {
      setStartDate(monthStartISO());
      setEndDate(today);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams({ startDate, endDate });
    if (effectiveSellerQuery) params.set('sellerId', effectiveSellerQuery);
    if (productId) params.set('productId', productId);
    if (classId) params.set('classId', classId);
    setLoading(true);
    apiFetch<ReportResponse>(`/api/reports?${params.toString()}`)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [startDate, endDate, effectiveSellerQuery, productId, classId]);

  const filteredDetailedSales = useMemo(() => {
    if (!data?.detailedSales) return [];
    const q = searchText.trim().toLowerCase();
    if (!q) return data.detailedSales;

    return data.detailedSales
      .map((sale) => {
        const headerMatches =
          sale.documentNumber.toLowerCase().includes(q) ||
          sale.sellerName.toLowerCase().includes(q) ||
          paymentMethodLabel(sale.paymentMethod).toLowerCase().includes(q) ||
          sale.customerName.toLowerCase().includes(q);
        if (headerMatches) return sale;

        const matchingItems = sale.items.filter((it) => {
          const hay = [
            it.productName,
            it.productCode,
            it.productBarcode,
            it.className,
            it.dosageForm,
            it.dosage,
          ]
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        });
        if (matchingItems.length === 0) return null;
        return {
          ...sale,
          items: matchingItems,
          filteredTotal: matchingItems.reduce((acc, it) => acc + it.subtotal, 0),
        };
      })
      .filter((s): s is DetailedSaleReport => s !== null);
  }, [data, searchText]);

  const filteredStockRows = useMemo(() => {
    if (!data?.stockReport) return [];
    const q = searchText.trim().toLowerCase();
    return data.stockReport.filter((p) => {
      if (stockSupplierFilter && p.supplierId !== stockSupplierFilter) return false;
      if (stockStatusFilter === 'ACTIVE' && !p.active) return false;
      if (stockStatusFilter === 'INACTIVE' && p.active) return false;
      if (stockStatusFilter === 'LOW' && !p.isLow) return false;
      if (stockStatusFilter === 'OUT' && !p.isOut) return false;
      if (stockStatusFilter === 'EXPIRING' && !p.isExpired && !p.isExpiring) return false;
      if (q) {
        const hay = [
          p.name,
          p.code,
          p.barcode,
          p.className,
          p.dosageForm,
          p.dosage,
          p.supplierName,
          p.batch,
          p.expiryDate,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, searchText, stockSupplierFilter, stockStatusFilter]);

  const serverCanSeeCosts = data?.filters?.canSeeCosts ?? canSeeCosts;

  const handleExportExcel = () => {
    if (!data) return;

    const detailedSalesRows = filteredDetailedSales.flatMap((sale) =>
      sale.items.map((item) => ({
        Documento: sale.documentNumber,
        Data: formatDatePT(sale.date),
        Hora: sale.time,
        Vendedor: sale.sellerName,
        Pagamento: paymentMethodLabel(sale.paymentMethod),
        Produto: item.productName,
        Codigo: fieldOrUnregistered(item.productCode),
        CodigoBarras: fieldOrUnregistered(item.productBarcode),
        ClasseFarmacologica: fieldOrUnregistered(item.className),
        TipoForma: fieldOrUnregistered(
          [item.dosageForm, item.dosage].filter(Boolean).join(' · ')
        ),
        Quantidade: item.quantity,
        PrecoUnitario: item.unitPrice,
        DescontoPercent: item.discountPercent,
        DescontoValor: item.discountAmount,
        CodigoIVA: item.taxCode,
        TaxaIVAPercent: item.taxRate ?? 'Não configurado',
        MotivoIsencao: item.taxExemptionCode
          ? `${item.taxExemptionCode}${item.taxExemptionReason ? ` — ${item.taxExemptionReason}` : ''}`
          : item.taxExemptionReason || '—',
        BaseTributavel: item.taxableBase,
        ValorIVA: item.taxAmount,
        SubtotalLinha: item.subtotal,
        TotalVenda: sale.totalAmount,
      }))
    );

    const vatSummaryRows = (data.summary.taxBreakdown || []).map((tb) => ({
      CodigoTaxa: `${taxCodeLabel(tb.taxCode, tb.taxRate)}${tb.taxExemptionCode ? ` (${tb.taxExemptionCode})` : ''}`,
      BaseLegal: tb.taxExemptionReason || '—',
      VendasBase: tb.salesBase,
      VendasIVA: tb.salesTax,
      VendasTotal: tb.salesTotal,
      DevolucoesNCBase: tb.returnsBase,
      DevolucoesNCIVA: tb.returnsTax,
      LiquidoBase: tb.netBase,
      LiquidoIVA: tb.netTax,
      LiquidoTotal: tb.netTotal,
    }));

    const stockRows = filteredStockRows.map((p) => {
      const base: Record<string, string | number> = {
        Codigo: fieldOrUnregistered(p.code),
        CodigoBarras: fieldOrUnregistered(p.barcode),
        Produto: p.name,
        Classe: fieldOrUnregistered(p.className),
        TipoForma: fieldOrUnregistered([p.dosageForm, p.dosage].filter(Boolean).join(' · ')),
        EnquadramentoIVA: `${taxCodeLabel(p.taxCode, p.taxRate)}${p.taxExemptionCode ? ` (${p.taxExemptionCode})` : ''}`,
        Quantidade: p.stock,
        Quarentena: p.quarantineStock,
        StockMinimo: p.minStock,
      };
      if (serverCanSeeCosts) {
        base.PrecoCompra = p.purchasePrice ?? 0;
        base.ValorCusto = p.costValue ?? 0;
      }
      base.PrecoVenda = p.salePrice;
      base.ValorVenda = p.saleValue;
      base.Fornecedor = fieldOrUnregistered(p.supplierName);
      base.Lote = fieldOrUnregistered(p.batch);
      base.Validade = p.expiryDate ? formatDatePT(p.expiryDate) : 'Não registado';
      base.Estado = p.active ? 'Ativo' : 'Inativo';
      return base;
    });

    const creditNotesRows = data.returnsList.map((r) => ({
      Documento: r.documentNumber,
      Natureza: r.rectificationNature || r.type,
      FaturaOriginal: r.originalDocumentNumber,
      Data: formatDatePT(r.date),
      Vendedor: r.originalSellerName,
      Motivo: r.reason,
      ProvaAdquirente: r.buyerAcknowledgement?.confirmed
        ? `${r.buyerAcknowledgement.method || 'Confirmada'}${r.buyerAcknowledgement.reference ? ` (${r.buyerAcknowledgement.reference})` : ''}`
        : 'Pendente',
      BaseCreditada: r.taxableBaseTotal ?? roundMoney(r.totalRefund - (r.taxTotal || 0)),
      IVACreditado: r.taxTotal || 0,
      TotalCreditado: r.totalRefund,
    }));

    const purchaseExcelRows =
      serverCanSeeCosts && data.purchasesReport
        ? data.purchasesReport.items.map((pur) => ({
            RefInterna: pur.internalNumber,
            DocFornecedor: pur.documentNumber,
            Data: formatDatePT(pur.documentDate),
            Fornecedor: pur.supplierName,
            BaseTributavel:
              pur.subtotal ??
              roundMoney(pur.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0)),
            IVASuportado:
              pur.taxTotal ?? roundMoney(pur.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0)),
            TotalComIVA: pur.totalAmount,
            Responsavel: pur.userName,
          }))
        : [];

    exportToExcel(`relatorio_ancora_sms_${startDate}_${endDate}.xlsx`, [
      {
        name: 'Vendas Detalhadas',
        rows: detailedSalesRows,
      },
      {
        name: 'Resumo IVA',
        rows: vatSummaryRows,
      },
      {
        name: 'Notas de Credito',
        rows: creditNotesRows,
      },
      ...(serverCanSeeCosts
        ? [
            {
              name: 'Compras e IVA Suportado',
              rows: purchaseExcelRows,
            },
          ]
        : []),
      {
        name: 'Vendas por Vendedor',
        rows: data.dailyBySeller.map((r) => ({
          Data: formatDatePT(r.date),
          Vendedor: r.sellerName,
          Faturas: r.invoicesCount,
          Unidades: r.unitsSold,
          Dinheiro: r.byPayment.DINHEIRO,
          Multicaixa: r.byPayment.MULTICAIXA,
          Transferencia: r.byPayment.TRANSFERENCIA,
          Seguro: r.byPayment.SEGURO,
          Bruto: r.grossTotal,
          Devolucoes: r.returnsTotal,
          Anulacoes: r.cancellationsCount,
          Liquido: r.netTotal,
        })),
      },
      {
        name: 'Relatorio de Stock',
        rows: stockRows,
      },
      {
        name: 'Alertas',
        rows: [
          ...data.alerts.outOfStock.map((p) => ({
            TipoAlerta: 'Sem Stock',
            Codigo: p.code,
            CodigoBarras: fieldOrUnregistered(p.barcode),
            Produto: p.name,
            Stock: p.stock,
            Validade: p.expiryDate ? formatDatePT(p.expiryDate) : 'Não registado',
          })),
          ...data.alerts.lowStock.map((p) => ({
            TipoAlerta: 'Stock Baixo',
            Codigo: p.code,
            CodigoBarras: fieldOrUnregistered(p.barcode),
            Produto: p.name,
            Stock: p.stock,
            Validade: p.expiryDate ? formatDatePT(p.expiryDate) : 'Não registado',
          })),
          ...data.alerts.expiringSoon.map((p) => ({
            TipoAlerta: p.isExpired ? 'Expirado' : 'Validade Próxima',
            Codigo: p.code,
            CodigoBarras: fieldOrUnregistered(p.barcode),
            Produto: p.name,
            Stock: p.stock,
            Validade: p.expiryDate ? formatDatePT(p.expiryDate) : 'Não registado',
          })),
        ],
      },
    ]);
  };

  const handleExportPdf = () => {
    if (!data) return;

    if (activeTab === 'STOCK') {
      const headers = serverCanSeeCosts
        ? [
            'Código / Barras',
            'Produto',
            'Classe / Forma',
            'IVA',
            'Qtd',
            'P. Compra',
            'P. Venda',
            'Fornecedor',
            'Lote / Validade',
          ]
        : ['Código / Barras', 'Produto', 'Classe / Forma', 'IVA', 'Qtd', 'P. Venda', 'Fornecedor', 'Lote / Validade'];

      const rows = filteredStockRows.map((p) => {
        const codeCol = `${p.code}${p.barcode ? `\nBarras: ${p.barcode}` : '\nBarras: Não registado'}`;
        const classFormCol = `${fieldOrUnregistered(p.className)}\n${fieldOrUnregistered(
          [p.dosageForm, p.dosage].filter(Boolean).join(' · ')
        )}`;
        const taxCol = `${taxCodeLabel(p.taxCode, p.taxRate)}${p.taxExemptionCode ? `\n(${p.taxExemptionCode})` : ''}`;
        const batchExp = `${fieldOrUnregistered(p.batch)}\n${
          p.expiryDate ? formatDatePT(p.expiryDate) : 'Não registado'
        }`;
        if (serverCanSeeCosts) {
          return [
            codeCol,
            p.name,
            classFormCol,
            taxCol,
            p.stock,
            formatMoney(p.purchasePrice ?? 0, cur),
            formatMoney(p.salePrice, cur),
            fieldOrUnregistered(p.supplierName),
            batchExp,
          ];
        }
        return [
          codeCol,
          p.name,
          classFormCol,
          taxCol,
          p.stock,
          formatMoney(p.salePrice, cur),
          fieldOrUnregistered(p.supplierName),
          batchExp,
        ];
      });

      exportTableToPDF(
        `relatorio_stock_${today}.pdf`,
        'Relatório Completo de Stock',
        `Produtos listados: ${filteredStockRows.length}`,
        headers,
        rows,
        settings.pharmacyName
      );
      return;
    }

    if (activeTab === 'SALES_DETAIL') {
      const rows = filteredDetailedSales.flatMap((sale) =>
        sale.items.map((item) => [
          `${sale.documentNumber}\n${formatDatePT(sale.date)} ${sale.time.slice(0, 5)}`,
          `${sale.sellerName}\n(${paymentMethodLabel(sale.paymentMethod)})`,
          `${item.productName}\nCód: ${item.productCode} · Barras: ${fieldOrUnregistered(item.productBarcode)}`,
          `${fieldOrUnregistered(item.className)}\n${fieldOrUnregistered(
            [item.dosageForm, item.dosage].filter(Boolean).join(' · ')
          )}`,
          item.quantity,
          formatMoney(item.unitPrice, cur),
          item.discountPercent > 0
            ? `${item.discountPercent}% (-${formatMoney(item.discountAmount, cur)})`
            : '0%',
          `${taxCodeLabel(item.taxCode, item.taxRate)}\nBase: ${formatMoney(item.taxableBase, cur)}\nIVA: ${formatMoney(item.taxAmount, cur)}`,
          `${formatMoney(item.subtotal, cur)}\n(Venda: ${formatMoney(sale.totalAmount, cur)})`,
        ])
      );

      exportTableToPDF(
        `relatorio_vendas_detalhado_${startDate}_${endDate}.pdf`,
        'Relatório Detalhado de Vendas por Vendedor e Produto',
        `Período: ${formatDatePT(startDate)} a ${formatDatePT(endDate)} · Faturas: ${filteredDetailedSales.length} · IVA Líquido: ${formatMoney(data.summary.netTaxTotal, cur)}`,
        [
          'Doc. / Data',
          'Vendedor / Pag.',
          'Produto / Código / Barras',
          'Classe / Forma',
          'Qtd',
          'P. Unit.',
          'Desconto',
          'IVA / Base',
          'Subtotal / Total',
        ],
        rows,
        settings.pharmacyName
      );
      return;
    }

    if (activeTab === 'CREDIT_NOTES') {
      exportTableToPDF(
        `relatorio_notas_credito_${startDate}_${endDate}.pdf`,
        'Relatório de Notas de Crédito, Devoluções e Anulações',
        `Período: ${formatDatePT(startDate)} a ${formatDatePT(endDate)} · IVA Revertido: ${formatMoney(data.summary.returnsTaxTotal, cur)}`,
        ['Documento NC', 'Natureza', 'Fatura Orig.', 'Data', 'Prova Adq.', 'Base Creditada', 'IVA Creditado', 'Total'],
        data.returnsList.map((r) => [
          r.documentNumber,
          r.rectificationNature || r.type,
          r.originalDocumentNumber,
          formatDatePT(r.date),
          r.buyerAcknowledgement?.confirmed ? r.buyerAcknowledgement.method || 'Confirmada' : 'Pendente',
          formatMoney(r.taxableBaseTotal ?? roundMoney(r.totalRefund - (r.taxTotal || 0)), cur),
          formatMoney(r.taxTotal || 0, cur),
          formatMoney(r.totalRefund, cur),
        ]),
        settings.pharmacyName
      );
      return;
    }

    if (activeTab === 'PURCHASES' && serverCanSeeCosts && data.purchasesReport) {
      exportTableToPDF(
        `relatorio_compras_iva_${startDate}_${endDate}.pdf`,
        'Relatório de Compras e IVA Suportado',
        `Período: ${formatDatePT(startDate)} a ${formatDatePT(endDate)} · Base: ${formatMoney(data.purchasesReport.baseTotal, cur)} · IVA Suportado: ${formatMoney(data.purchasesReport.taxTotal, cur)}`,
        ['Ref. Interna', 'Doc. Fornecedor', 'Data', 'Fornecedor', 'Base s/ IVA', 'IVA Suportado', 'Total c/ IVA'],
        data.purchasesReport.items.map((pur) => [
          pur.internalNumber,
          pur.documentNumber,
          formatDatePT(pur.documentDate),
          pur.supplierName,
          formatMoney(
            pur.subtotal ?? roundMoney(pur.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0)),
            cur
          ),
          formatMoney(
            pur.taxTotal ?? roundMoney(pur.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0)),
            cur
          ),
          formatMoney(pur.totalAmount, cur),
        ]),
        settings.pharmacyName
      );
      return;
    }

    exportTableToPDF(
      `relatorio_vendas_${startDate}_${endDate}.pdf`,
      'Relatório de Vendas Diárias por Vendedor',
      `Período: ${formatDatePT(startDate)} a ${formatDatePT(endDate)} · Total Líquido: ${formatMoney(data.summary.netTotal, cur)}`,
      ['Data', 'Vendedor', 'Faturas', 'Qtd', 'Dinheiro', 'TPA/Mult.', 'Devoluções', 'Líquido'],
      data.dailyBySeller.map((r) => [
        formatDatePT(r.date),
        r.sellerName,
        r.invoicesCount,
        r.unitsSold,
        formatMoney(r.byPayment.DINHEIRO, cur),
        formatMoney(r.byPayment.MULTICAIXA, cur),
        formatMoney(r.returnsTotal, cur),
        formatMoney(r.netTotal, cur),
      ]),
      settings.pharmacyName
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 no-print">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
            Relatórios e Análise
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Vendas detalhadas por vendedor e produto, formas de pagamento, relatório completo de stock, alertas e inventários.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportExcel}
            className="min-h-[40px] px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 whitespace-nowrap"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Exportar Excel
          </button>
          <button
            type="button"
            onClick={handleExportPdf}
            className="min-h-[40px] px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 whitespace-nowrap"
          >
            <FileDown className="w-4 h-4" />
            Exportar PDF
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-[40px] px-3.5 py-2 bg-green-800 hover:bg-green-900 dark:bg-green-700 dark:hover:bg-green-600 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 whitespace-nowrap"
          >
            <Printer className="w-4 h-4" />
            Imprimir
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3 no-print">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: 'TODAY', label: 'Hoje' },
              { id: 'WEEK', label: 'Últimos 7 dias' },
              { id: 'MONTH', label: 'Este Mês' },
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id as any)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  preset === p.id
                    ? 'bg-green-800 dark:bg-green-700 text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {!isAdmin && (
            <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-md">
              <Lock className="w-3.5 h-3.5 text-green-700 dark:text-green-400" />
              Perfil Vendedor: a consultar apenas os seus registos autorizados
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 text-xs">
          <div>
            <label className="block text-slate-600 dark:text-slate-400 mb-1">Data Inicial</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setPreset('CUSTOM');
                setStartDate(e.target.value);
              }}
              className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono"
            />
          </div>
          <div>
            <label className="block text-slate-600 dark:text-slate-400 mb-1">Data Final</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => {
                setPreset('CUSTOM');
                setEndDate(e.target.value);
              }}
              className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono"
            />
          </div>
          <div>
            <label className="block text-slate-600 dark:text-slate-400 mb-1">Vendedor</label>
            {isAdmin ? (
              <select
                value={sellerId}
                onChange={(e) => setSellerId(e.target.value)}
                className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
              >
                <option value="">Todos os vendedores</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                readOnly
                value={user.fullName}
                className="w-full min-h-[38px] px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-lg cursor-not-allowed"
              />
            )}
          </div>
          <div>
            <label className="block text-slate-600 dark:text-slate-400 mb-1">Classe Farmacológica</label>
            <select
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
            >
              <option value="">Todas as classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-600 dark:text-slate-400 mb-1">Produto</label>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
            >
              <option value="">Todos os produtos</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-600 dark:text-slate-400 mb-1">Filtrar texto / código</label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Nome, barras, doc., lote..."
                className="w-full min-h-[38px] pl-8 pr-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Summary KPIs */}
      {data && (
        <div className="print-area space-y-5">
          <div className="hidden print-only border-b border-slate-300 pb-4 mb-4 flex items-center justify-between bg-white text-slate-900">
            <div className="flex items-center gap-3">
              <img
                src={ANCORA_LOGO_SRC}
                alt="Logotipo Âncora SMS"
                className="w-12 h-12 object-contain"
              />
              <div>
                <h2 className="text-lg font-display font-bold text-green-800">
                  {settings.pharmacyName}
                </h2>
                <p className="text-xs text-green-700">Stock Management System — Relatório de Gestão</p>
              </div>
            </div>
            <div className="text-right text-xs text-slate-600">
              Período: {formatDatePT(startDate)} a {formatDatePT(endDate)}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <p className="text-xs text-slate-500 dark:text-slate-400">Vendas Brutas c/ IVA ({data.summary.invoicesCount} fat.)</p>
              <p className="text-xl font-mono font-semibold text-slate-900 dark:text-slate-100 mt-1">
                {formatMoney(data.summary.grossTotal, cur)}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-mono">
                Base: {formatMoney(data.summary.salesTaxableBaseTotal, cur)} · IVA: {formatMoney(data.summary.salesTaxTotal, cur)}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {data.summary.unitsSold} un. vendidas · {data.summary.proformasCount} proformas
              </p>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <p className="text-xs text-slate-500 dark:text-slate-400">Notas de Crédito / Anulações</p>
              <p className="text-xl font-mono font-semibold text-red-700 dark:text-red-400 mt-1">
                -{formatMoney(data.summary.returnsTotal, cur)}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-mono">
                Base: -{formatMoney(data.summary.returnsTaxableBaseTotal, cur)} · IVA: -{formatMoney(data.summary.returnsTaxTotal, cur)}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {data.returnsList.length} documento(s) ({data.summary.cancellationsCount} anulações)
              </p>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <p className="text-xs text-slate-500 dark:text-slate-400">Receita Líquida do Período</p>
              <p className="text-xl font-mono font-semibold text-green-800 dark:text-green-400 mt-1">
                {formatMoney(data.summary.netTotal, cur)}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-mono">
                Base Líq.: {formatMoney(data.summary.netTaxableBaseTotal, cur)} · IVA Líq.: {formatMoney(data.summary.netTaxTotal, cur)}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                vs período anterior: {data.summary.comparison.deltaPercent >= 0 ? '+' : ''}
                {data.summary.comparison.deltaPercent}%
              </p>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <p className="text-xs text-slate-500 dark:text-slate-400">Por Forma de Pagamento</p>
              <div className="mt-1 space-y-0.5 text-[11px] font-mono text-slate-700 dark:text-slate-300">
                {(Object.keys(data.summary.paymentTotals) as PaymentMethod[]).map((pm) => (
                  <div key={pm} className="flex justify-between">
                    <span className="font-sans text-slate-600 dark:text-slate-400">{paymentMethodLabel(pm)}:</span>
                    <span>{formatMoney(data.summary.paymentTotals[pm], cur)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Period VAT Summary Breakdown */}
          {data.summary.taxBreakdown && data.summary.taxBreakdown.length > 0 && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  Resumo Fiscal de IVA do Período (por Taxa e Enquadramento)
                </span>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
                  <span className="text-slate-600 dark:text-slate-300">
                    IVA Faturas: <strong>{formatMoney(data.summary.salesTaxTotal, cur)}</strong>
                  </span>
                  <span className="text-red-700 dark:text-red-400">
                    IVA Revertido (NC): <strong>-{formatMoney(data.summary.returnsTaxTotal, cur)}</strong>
                  </span>
                  <span className="text-green-800 dark:text-green-400">
                    IVA Líquido: <strong>{formatMoney(data.summary.netTaxTotal, cur)}</strong>
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                      <th className="py-2 px-4 font-medium">Código / Taxa</th>
                      <th className="py-2 px-3 font-medium">Base Legal / Motivo</th>
                      <th className="py-2 px-3 font-medium text-right">Base Vendas</th>
                      <th className="py-2 px-3 font-medium text-right">IVA Vendas</th>
                      <th className="py-2 px-3 font-medium text-right">Base NC/Devol.</th>
                      <th className="py-2 px-3 font-medium text-right">IVA NC/Devol.</th>
                      <th className="py-2 px-3 font-medium text-right">Base Líquida</th>
                      <th className="py-2 px-4 font-medium text-right">IVA Líquido</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {data.summary.taxBreakdown.map((tb, idx) => (
                      <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-2 px-4 font-mono font-medium text-slate-900 dark:text-slate-100">
                          {taxCodeLabel(tb.taxCode, tb.taxRate)}
                          {tb.taxExemptionCode ? ` (${tb.taxExemptionCode})` : ''}
                        </td>
                        <td className="py-2 px-3 text-slate-600 dark:text-slate-400">
                          {tb.taxExemptionReason || '—'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                          {formatMoney(tb.salesBase, cur)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                          {formatMoney(tb.salesTax, cur)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-red-700 dark:text-red-400">
                          -{formatMoney(tb.returnsBase, cur)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-red-700 dark:text-red-400">
                          -{formatMoney(tb.returnsTax, cur)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-slate-900 dark:text-slate-100">
                          {formatMoney(tb.netBase, cur)}
                        </td>
                        <td className="py-2 px-4 text-right font-mono font-semibold text-green-800 dark:text-green-400">
                          {formatMoney(tb.netTax, cur)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Report Section Tabs */}
          <div className="flex flex-wrap gap-1.5 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg no-print">
            {[
              { id: 'SALES_DETAIL', label: `Vendas Detalhadas (${filteredDetailedSales.length})` },
              { id: 'CREDIT_NOTES', label: `Notas de Crédito (${data.returnsList.length})` },
              ...(serverCanSeeCosts && data.purchasesReport
                ? [{ id: 'PURCHASES', label: `Compras / IVA Suportado (${data.purchasesReport.count})` }]
                : []),
              { id: 'DAILY_SELLER', label: 'Resumo por Vendedor' },
              { id: 'PERIODS', label: 'Comparação Semanal / Mensal' },
              { id: 'STOCK', label: `Relatório de Stock (${filteredStockRows.length})` },
              {
                id: 'ALERTS',
                label: `Alertas (${
                  data.alerts.outOfStock.length +
                  data.alerts.lowStock.length +
                  data.alerts.expiringSoon.length
                })`,
              },
              { id: 'INVENTORY', label: `Inventários (${data.inventories.length})` },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id as any)}
                className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  activeTab === t.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500 dark:text-slate-400">
              A calcular relatório...
            </div>
          ) : (
            <>
              {activeTab === 'SALES_DETAIL' && (
                <div className="space-y-4">
                  {filteredDetailedSales.map((sale) => (
                    <div
                      key={sale.id}
                      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
                    >
                      <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {sale.documentNumber}
                          </span>
                          {sale.documentType && (
                            <span className="px-1.5 py-0.5 rounded bg-slate-200/80 dark:bg-slate-700 text-[10px] font-medium text-slate-700 dark:text-slate-200">
                              {saleDocTypeLabel(sale.documentType)}
                            </span>
                          )}
                          <span className="font-mono text-slate-600 dark:text-slate-300">
                            {formatDatePT(sale.date)} {sale.time}
                          </span>
                          <span className="text-slate-700 dark:text-slate-200">
                            Vendedor: <span className="font-semibold">{sale.sellerName}</span>
                          </span>
                          <span className="text-slate-600 dark:text-slate-300">
                            Pagamento: <span className="font-medium">{paymentMethodLabel(sale.paymentMethod)}</span>
                          </span>
                          <span
                            className={`font-medium ${
                              sale.status === 'ANULADA'
                                ? 'text-red-700 dark:text-red-400'
                                : sale.status === 'DEVOLVIDA' || sale.status === 'PARCIALMENTE_DEVOLVIDA'
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            {saleStatusLabel(sale.status)}
                          </span>
                        </div>
                        <div className="font-mono text-right space-x-3">
                          <span className="text-slate-500 dark:text-slate-400">
                            Base: {formatMoney(sale.taxableBaseTotal ?? sale.totalAmount, cur)}
                          </span>
                          <span className="text-slate-500 dark:text-slate-400">
                            IVA: {formatMoney(sale.taxTotal ?? 0, cur)}
                          </span>
                          <span>
                            <span className="text-slate-500 dark:text-slate-400 mr-1.5">Total:</span>
                            <span className="font-semibold text-slate-900 dark:text-slate-100">
                              {formatMoney(sale.totalAmount, cur)}
                            </span>
                          </span>
                        </div>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                              <th className="py-2.5 px-4 font-medium">Produto / Código / Cód. Barras</th>
                              <th className="py-2.5 px-3 font-medium">Classe / Tipo / Forma</th>
                              <th className="py-2.5 px-3 font-medium text-right">Qtd</th>
                              <th className="py-2.5 px-3 font-medium text-right">Preço Unit.</th>
                              <th className="py-2.5 px-3 font-medium text-right">Desconto</th>
                              <th className="py-2.5 px-3 font-medium">IVA / Isenção</th>
                              <th className="py-2.5 px-3 font-medium text-right">Base / IVA</th>
                              <th className="py-2.5 px-4 font-medium text-right">Subtotal da Linha</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                            {sale.items.map((item, idx) => {
                              const formText = [item.dosageForm, item.dosage].filter(Boolean).join(' · ');
                              return (
                                <tr key={`${sale.id}_${item.productId}_${idx}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                  <td className="py-2.5 px-4">
                                    <div className="font-medium text-slate-900 dark:text-slate-100">{item.productName}</div>
                                    <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                                      Cód.: {fieldOrUnregistered(item.productCode)} · Barras:{' '}
                                      {fieldOrUnregistered(item.productBarcode)}
                                    </div>
                                  </td>
                                  <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">
                                    <div>{fieldOrUnregistered(item.className)}</div>
                                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                      {fieldOrUnregistered(formText)}
                                    </div>
                                  </td>
                                  <td className="py-2.5 px-3 text-right font-mono text-slate-800 dark:text-slate-200">
                                    {item.quantity}
                                    {item.returnedQuantity > 0 && (
                                      <div className="text-[10px] text-amber-700 dark:text-amber-400">
                                        (Devol.: {item.returnedQuantity})
                                      </div>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                                    {formatMoney(item.unitPrice, cur)}
                                  </td>
                                  <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                                    {item.discountPercent > 0 ? (
                                      <span className="text-amber-700 dark:text-amber-400">
                                        {item.discountPercent}% (-{formatMoney(item.discountAmount, cur)})
                                      </span>
                                    ) : (
                                      <span className="text-slate-400 dark:text-slate-500">Sem desconto</span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                                    <div>{taxCodeLabel(item.taxCode, item.taxRate)}</div>
                                    {item.taxExemptionCode && (
                                      <div className="text-[10px] text-slate-500 dark:text-slate-400">
                                        Cód.: {item.taxExemptionCode}
                                      </div>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 text-right font-mono text-[11px] text-slate-700 dark:text-slate-300">
                                    <div>{formatMoney(item.taxableBase, cur)}</div>
                                    <div className="text-slate-500 dark:text-slate-400">
                                      IVA: {formatMoney(item.taxAmount, cur)}
                                    </div>
                                  </td>
                                  <td className="py-2.5 px-4 text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                                    {formatMoney(item.subtotal, cur)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}

                  {filteredDetailedSales.length === 0 && (
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center text-xs text-slate-500 dark:text-slate-400">
                      Nenhuma venda faturada encontrada para os filtros selecionados.
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'CREDIT_NOTES' && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      Notas de Crédito, Devoluções e Anulações (Rectificações de IVA)
                    </span>
                    <span className="font-mono text-[11px] text-red-700 dark:text-red-400">
                      Base Creditada: -{formatMoney(data.summary.returnsTaxableBaseTotal, cur)} · IVA Revertido: -
                      {formatMoney(data.summary.returnsTaxTotal, cur)}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                          <th className="py-2.5 px-4 font-medium">Documento NC / Natureza</th>
                          <th className="py-2.5 px-3 font-medium">Fatura Orig.</th>
                          <th className="py-2.5 px-3 font-medium">Data</th>
                          <th className="py-2.5 px-3 font-medium">Vendedor Orig.</th>
                          <th className="py-2.5 px-3 font-medium">Motivo / Prova Adquirente</th>
                          <th className="py-2.5 px-3 font-medium text-right">Base Creditada</th>
                          <th className="py-2.5 px-3 font-medium text-right">IVA Revertido</th>
                          <th className="py-2.5 px-4 font-medium text-right">Total Creditado</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {data.returnsList.map((r) => {
                          const baseCred =
                            r.taxableBaseTotal ?? roundMoney(r.totalRefund - (r.taxTotal || 0));
                          return (
                            <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                              <td className="py-2.5 px-4 font-mono">
                                <div className="font-semibold text-slate-900 dark:text-slate-100">
                                  {r.documentNumber}
                                </div>
                                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                  {r.rectificationNature || r.type}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 font-mono text-slate-700 dark:text-slate-300">
                                {r.originalDocumentNumber}
                              </td>
                              <td className="py-2.5 px-3 font-mono text-slate-700 dark:text-slate-300">
                                {formatDatePT(r.date)}
                              </td>
                              <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">
                                {r.originalSellerName}
                              </td>
                              <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">
                                <div>{r.reason}</div>
                                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                  Prova adquirente:{' '}
                                  {r.buyerAcknowledgement?.confirmed
                                    ? `${r.buyerAcknowledgement.method || 'Confirmada'}${
                                        r.buyerAcknowledgement.reference
                                          ? ` (${r.buyerAcknowledgement.reference})`
                                          : ''
                                      }`
                                    : 'Pendente'}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                                -{formatMoney(baseCred, cur)}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono text-red-700 dark:text-red-400">
                                -{formatMoney(r.taxTotal || 0, cur)}
                              </td>
                              <td className="py-2.5 px-4 text-right font-mono font-semibold text-red-700 dark:text-red-400">
                                -{formatMoney(r.totalRefund, cur)}
                              </td>
                            </tr>
                          );
                        })}
                        {data.returnsList.length === 0 && (
                          <tr>
                            <td colSpan={8} className="py-8 text-center text-slate-500 dark:text-slate-400">
                              Nenhuma nota de crédito ou anulação no período selecionado.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === 'PURCHASES' && serverCanSeeCosts && data.purchasesReport && (
                <div className="space-y-4">
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Base de Compras ({data.purchasesReport.count} doc.)</p>
                      <p className="text-lg font-mono font-semibold text-slate-900 dark:text-slate-100 mt-1">
                        {formatMoney(data.purchasesReport.baseTotal, cur)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">IVA Suportado nas Compras</p>
                      <p className="text-lg font-mono font-semibold text-sky-700 dark:text-sky-400 mt-1">
                        {formatMoney(data.purchasesReport.taxTotal, cur)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Total de Compras (c/ IVA)</p>
                      <p className="text-lg font-mono font-semibold text-slate-900 dark:text-slate-100 mt-1">
                        {formatMoney(data.purchasesReport.totalAmount, cur)}
                      </p>
                    </div>
                  </div>

                  {data.purchasesReport.taxBreakdown.length > 0 && (
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                      <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200">
                        Resumo de IVA Suportado por Taxa / Código
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                              <th className="py-2 px-4 font-medium">Código / Taxa</th>
                              <th className="py-2 px-3 font-medium">Motivo Legal</th>
                              <th className="py-2 px-3 font-medium text-right">Base s/ IVA</th>
                              <th className="py-2 px-3 font-medium text-right">IVA Suportado</th>
                              <th className="py-2 px-4 font-medium text-right">Total c/ IVA</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                            {data.purchasesReport.taxBreakdown.map((tb, idx) => (
                              <tr key={idx}>
                                <td className="py-2 px-4 font-mono">
                                  {taxCodeLabel(tb.taxCode, tb.taxRate)}
                                  {tb.taxExemptionCode ? ` (${tb.taxExemptionCode})` : ''}
                                </td>
                                <td className="py-2 px-3 text-slate-600 dark:text-slate-400">
                                  {tb.taxExemptionReason || '—'}
                                </td>
                                <td className="py-2 px-3 text-right font-mono">{formatMoney(tb.taxableBase, cur)}</td>
                                <td className="py-2 px-3 text-right font-mono">{formatMoney(tb.taxAmount, cur)}</td>
                                <td className="py-2 px-4 text-right font-mono font-semibold">
                                  {formatMoney(tb.total, cur)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                            <th className="py-2.5 px-4 font-medium">Ref. / Doc. Fornecedor</th>
                            <th className="py-2.5 px-3 font-medium">Data</th>
                            <th className="py-2.5 px-3 font-medium">Fornecedor</th>
                            <th className="py-2.5 px-3 font-medium text-right">Base s/ IVA</th>
                            <th className="py-2.5 px-3 font-medium text-right">IVA Suportado</th>
                            <th className="py-2.5 px-4 font-medium text-right">Total c/ IVA</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {data.purchasesReport.items.map((pur) => {
                            const baseVal =
                              pur.subtotal ??
                              roundMoney(
                                pur.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0)
                              );
                            const taxVal =
                              pur.taxTotal ??
                              roundMoney(pur.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0));
                            return (
                              <tr key={pur.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                <td className="py-2.5 px-4 font-mono">
                                  <div className="font-semibold text-slate-900 dark:text-slate-100">
                                    {pur.internalNumber}
                                  </div>
                                  <div className="text-[11px] text-slate-500">{pur.documentNumber}</div>
                                </td>
                                <td className="py-2.5 px-3 font-mono text-slate-700 dark:text-slate-300">
                                  {formatDatePT(pur.documentDate)}
                                </td>
                                <td className="py-2.5 px-3 text-slate-800 dark:text-slate-200">
                                  {pur.supplierName}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono">{formatMoney(baseVal, cur)}</td>
                                <td className="py-2.5 px-3 text-right font-mono">{formatMoney(taxVal, cur)}</td>
                                <td className="py-2.5 px-4 text-right font-mono font-semibold">
                                  {formatMoney(pur.totalAmount, cur)}
                                </td>
                              </tr>
                            );
                          })}
                          {data.purchasesReport.items.length === 0 && (
                            <tr>
                              <td colSpan={6} className="py-8 text-center text-slate-500 dark:text-slate-400">
                                Nenhuma compra registada no período selecionado.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'DAILY_SELLER' && (
                <div className="space-y-4">
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                            <th className="py-3 px-4 font-medium">Data</th>
                            <th className="py-3 px-3 font-medium">Vendedor</th>
                            <th className="py-3 px-2 font-medium text-right">Fat.</th>
                            <th className="py-3 px-2 font-medium text-right">Un.</th>
                            <th className="py-3 px-3 font-medium text-right">Dinheiro</th>
                            <th className="py-3 px-3 font-medium text-right">Multicaixa</th>
                            <th className="py-3 px-3 font-medium text-right">Devol./Anul.</th>
                            <th className="py-3 px-4 font-medium text-right">Líquido</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {data.dailyBySeller.map((row, idx) => (
                            <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                              <td className="py-2.5 px-4 font-mono text-slate-700 dark:text-slate-300">{formatDatePT(row.date)}</td>
                              <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100">
                                {row.sellerName}
                              </td>
                              <td className="py-2.5 px-2 text-right font-mono text-slate-700 dark:text-slate-300">{row.invoicesCount}</td>
                              <td className="py-2.5 px-2 text-right font-mono text-slate-700 dark:text-slate-300">{row.unitsSold}</td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                                {formatMoney(row.byPayment.DINHEIRO, cur)}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                                {formatMoney(row.byPayment.MULTICAIXA, cur)}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono text-red-700 dark:text-red-400">
                                -{formatMoney(row.returnsTotal, cur)} ({row.cancellationsCount} anul.)
                              </td>
                              <td className="py-2.5 px-4 text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                                {formatMoney(row.netTotal, cur)}
                              </td>
                            </tr>
                          ))}
                          {data.dailyBySeller.length === 0 && (
                            <tr>
                              <td colSpan={8} className="py-8 text-center text-slate-500 dark:text-slate-400">
                                Sem vendas ou devoluções registadas neste período.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {data.returnsList.length > 0 && (
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                      <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200">
                        Detalhe de Devoluções e Anulações no Período
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                              <th className="py-2 px-4 font-medium">Documento</th>
                              <th className="py-2 px-3 font-medium">Fatura Orig.</th>
                              <th className="py-2 px-3 font-medium">Data</th>
                              <th className="py-2 px-3 font-medium">Motivo</th>
                              <th className="py-2 px-4 font-medium text-right">IVA Revertido</th>
                              <th className="py-2 px-4 font-medium text-right">Valor</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                            {data.returnsList.map((r) => (
                              <tr key={r.id}>
                                <td className="py-2 px-4 font-mono font-medium text-slate-900 dark:text-slate-100">
                                  {r.documentNumber} ({r.rectificationNature || r.type})
                                </td>
                                <td className="py-2 px-3 font-mono text-slate-700 dark:text-slate-300">{r.originalDocumentNumber}</td>
                                <td className="py-2 px-3 font-mono text-slate-700 dark:text-slate-300">{formatDatePT(r.date)}</td>
                                <td className="py-2 px-3 text-slate-700 dark:text-slate-300">{r.reason}</td>
                                <td className="py-2 px-4 text-right font-mono text-red-700 dark:text-red-400">
                                  -{formatMoney(r.taxTotal || 0, cur)}
                                </td>
                                <td className="py-2 px-4 text-right font-mono text-red-700 dark:text-red-400">
                                  -{formatMoney(r.totalRefund, cur)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'PERIODS' && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs border-b border-slate-200 dark:border-slate-800 pb-4">
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">
                        Período Atual ({formatDatePT(data.filters.startDate)} –{' '}
                        {formatDatePT(data.filters.endDate)})
                      </p>
                      <p className="text-lg font-mono font-semibold text-slate-900 dark:text-slate-100 mt-1">
                        {formatMoney(data.summary.netTotal, cur)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">
                        Período Anterior ({formatDatePT(data.filters.prevStartDate)} –{' '}
                        {formatDatePT(data.filters.prevEndDate)})
                      </p>
                      <p className="text-lg font-mono font-semibold text-slate-700 dark:text-slate-300 mt-1">
                        {formatMoney(data.summary.comparison.previousNetTotal, cur)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Variação</p>
                      <p
                        className={`text-lg font-mono font-semibold mt-1 ${
                          data.summary.comparison.deltaNet >= 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }`}
                      >
                        {data.summary.comparison.deltaNet >= 0 ? '+' : ''}
                        {formatMoney(data.summary.comparison.deltaNet, cur)} (
                        {data.summary.comparison.deltaPercent}%)
                      </p>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                          <th className="py-2.5 px-4 font-medium">Data</th>
                          <th className="py-2.5 px-3 font-medium text-right">Vendas Brutas</th>
                          <th className="py-2.5 px-3 font-medium text-right">Devoluções</th>
                          <th className="py-2.5 px-4 font-medium text-right">Líquido Diário</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {data.dailySeries.map((ds) => (
                          <tr key={ds.date}>
                            <td className="py-2.5 px-4 font-mono text-slate-700 dark:text-slate-300">{formatDatePT(ds.date)}</td>
                            <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                              {formatMoney(ds.sales, cur)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono text-red-700 dark:text-red-400">
                              -{formatMoney(ds.returns, cur)}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                              {formatMoney(ds.net, cur)}
                            </td>
                          </tr>
                        ))}
                        {data.dailySeries.length === 0 && (
                          <tr>
                            <td colSpan={4} className="py-8 text-center text-slate-500 dark:text-slate-400">
                              Sem movimentos no intervalo selecionado.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === 'STOCK' && (
                <div className="space-y-3">
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs no-print">
                    <div>
                      <label className="block text-slate-600 dark:text-slate-400 mb-1">Filtrar por Fornecedor</label>
                      <select
                        value={stockSupplierFilter}
                        onChange={(e) => setStockSupplierFilter(e.target.value)}
                        className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                      >
                        <option value="">Todos os fornecedores</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-600 dark:text-slate-400 mb-1">Estado / Situação de Stock</label>
                      <select
                        value={stockStatusFilter}
                        onChange={(e) => setStockStatusFilter(e.target.value as any)}
                        className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                      >
                        <option value="ALL">Todos os produtos registados</option>
                        <option value="ACTIVE">Apenas Ativos</option>
                        <option value="INACTIVE">Apenas Inativos</option>
                        <option value="LOW">Stock Baixo</option>
                        <option value="OUT">Sem Stock</option>
                        <option value="EXPIRING">Validade Próxima / Expirado</option>
                      </select>
                    </div>
                    <div className="flex items-end justify-between sm:justify-end gap-2">
                      <div className="text-right">
                        <div className="text-slate-500 dark:text-slate-400">Artigos apresentados</div>
                        <div className="font-mono font-semibold text-sm text-slate-900 dark:text-slate-100">
                          {filteredStockRows.length} de {data.stockReport.length}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                            <th className="py-3 px-4 font-medium">Produto / Código / Barras</th>
                            <th className="py-3 px-3 font-medium">Classe / Tipo / Forma</th>
                            <th className="py-3 px-3 font-medium">Enquadramento IVA</th>
                            <th className="py-3 px-3 font-medium text-right">Qtd</th>
                            {serverCanSeeCosts && (
                              <th className="py-3 px-3 font-medium text-right">P. Compra</th>
                            )}
                            <th className="py-3 px-3 font-medium text-right">P. Venda</th>
                            <th className="py-3 px-3 font-medium">Fornecedor</th>
                            <th className="py-3 px-3 font-medium">Lote / Validade</th>
                            {serverCanSeeCosts && (
                              <th className="py-3 px-3 font-medium text-right">Valor Custo</th>
                            )}
                            <th className="py-3 px-4 font-medium text-right">Valor Venda</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {filteredStockRows.map((p) => {
                            const formText = [p.dosageForm, p.dosage].filter(Boolean).join(' · ');
                            return (
                              <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                <td className="py-2.5 px-4">
                                  <div className="font-medium text-slate-900 dark:text-slate-100">
                                    {p.name}
                                    {!p.active && (
                                      <span className="ml-1.5 text-[10px] text-slate-500 dark:text-slate-400">(Inativo)</span>
                                    )}
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                                    Cód.: {fieldOrUnregistered(p.code)} · Barras: {fieldOrUnregistered(p.barcode)}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">
                                  <div>{fieldOrUnregistered(p.className)}</div>
                                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                    {fieldOrUnregistered(formText)}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                                  <div
                                    className={
                                      p.taxCode === 'NAO_CONFIGURADO'
                                        ? 'text-amber-700 dark:text-amber-400 font-semibold'
                                        : ''
                                    }
                                  >
                                    {taxCodeLabel(p.taxCode, p.taxRate)}
                                  </div>
                                  {p.taxExemptionCode && (
                                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                                      Cód.: {p.taxExemptionCode}
                                    </div>
                                  )}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono">
                                  <div
                                    className={`font-semibold ${
                                      p.isOut
                                        ? 'text-red-700 dark:text-red-400'
                                        : p.isLow
                                        ? 'text-amber-700 dark:text-amber-400'
                                        : 'text-slate-900 dark:text-slate-100'
                                    }`}
                                  >
                                    {p.stock}
                                  </div>
                                  {p.quarantineStock > 0 && (
                                    <div className="text-[10px] text-amber-700 dark:text-amber-400">
                                      Quarent.: {p.quarantineStock}
                                    </div>
                                  )}
                                </td>
                                {serverCanSeeCosts && (
                                  <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                                    {p.purchasePrice !== null ? formatMoney(p.purchasePrice, cur) : 'Não registado'}
                                  </td>
                                )}
                                <td className="py-2.5 px-3 text-right font-mono text-slate-800 dark:text-slate-200">
                                  {formatMoney(p.salePrice, cur)}
                                </td>
                                <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">
                                  {fieldOrUnregistered(p.supplierName)}
                                </td>
                                <td className="py-2.5 px-3 font-mono text-slate-700 dark:text-slate-300">
                                  <div>{fieldOrUnregistered(p.batch)}</div>
                                  <div
                                    className={`text-[11px] ${
                                      p.isExpired
                                        ? 'text-red-700 dark:text-red-400 font-semibold'
                                        : p.isExpiring
                                        ? 'text-amber-700 dark:text-amber-400'
                                        : 'text-slate-500 dark:text-slate-400'
                                    }`}
                                  >
                                    {p.expiryDate ? formatDatePT(p.expiryDate) : 'Não registado'}
                                  </div>
                                </td>
                                {serverCanSeeCosts && (
                                  <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                                    {p.costValue !== null ? formatMoney(p.costValue, cur) : 'Não registado'}
                                  </td>
                                )}
                                <td className="py-2.5 px-4 text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                                  {formatMoney(p.saleValue, cur)}
                                </td>
                              </tr>
                            );
                          })}
                          {filteredStockRows.length === 0 && (
                            <tr>
                              <td
                                colSpan={serverCanSeeCosts ? 10 : 8}
                                className="py-8 text-center text-slate-500 dark:text-slate-400"
                              >
                                Nenhum produto encontrado no relatório de stock com os filtros aplicados.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'ALERTS' && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
                    <h3 className="text-xs font-semibold text-red-700 dark:text-red-400">
                      Sem Stock ({data.alerts.outOfStock.length})
                    </h3>
                    <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                      {data.alerts.outOfStock.map((p) => (
                        <div key={p.id} className="py-2">
                          <div className="font-medium text-slate-900 dark:text-slate-100">{p.name}</div>
                          <div className="text-slate-500 dark:text-slate-400 font-mono">
                            {p.code} · Mín.: {p.minStock}
                          </div>
                        </div>
                      ))}
                      {data.alerts.outOfStock.length === 0 && (
                        <p className="text-slate-500 dark:text-slate-400 py-3">Nenhum produto sem stock.</p>
                      )}
                    </div>
                  </div>

                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
                    <h3 className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                      Stock Baixo ({data.alerts.lowStock.length})
                    </h3>
                    <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                      {data.alerts.lowStock.map((p) => (
                        <div key={p.id} className="py-2 flex justify-between">
                          <div>
                            <div className="font-medium text-slate-900 dark:text-slate-100">{p.name}</div>
                            <div className="text-slate-500 dark:text-slate-400 font-mono">{p.code}</div>
                          </div>
                          <div className="font-mono text-right text-slate-700 dark:text-slate-300">
                            {p.stock} / {p.minStock}
                          </div>
                        </div>
                      ))}
                      {data.alerts.lowStock.length === 0 && (
                        <p className="text-slate-500 dark:text-slate-400 py-3">Nenhum produto com stock baixo.</p>
                      )}
                    </div>
                  </div>

                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
                    <h3 className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                      Validade Próxima / Expirados ({data.alerts.expiringSoon.length})
                    </h3>
                    <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                      {data.alerts.expiringSoon.map((p) => (
                        <div key={p.id} className="py-2 flex justify-between">
                          <div>
                            <div className="font-medium text-slate-900 dark:text-slate-100">{p.name}</div>
                            <div className="text-slate-500 dark:text-slate-400 font-mono">
                              Lote: {fieldOrUnregistered(p.batch)}
                            </div>
                          </div>
                          <div className="font-mono text-right">
                            <div className={p.isExpired ? 'text-red-700 dark:text-red-400 font-semibold' : 'text-amber-700 dark:text-amber-400'}>
                              {p.expiryDate ? formatDatePT(p.expiryDate) : 'Não registado'}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">Stock: {p.stock}</div>
                          </div>
                        </div>
                      ))}
                      {data.alerts.expiringSoon.length === 0 && (
                        <p className="text-slate-500 dark:text-slate-400 py-3">Sem alertas de validade.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'INVENTORY' && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                          <th className="py-3 px-4 font-medium">Referência</th>
                          <th className="py-3 px-3 font-medium">Data</th>
                          <th className="py-3 px-3 font-medium">Responsável</th>
                          <th className="py-3 px-3 font-medium">Estado</th>
                          <th className="py-3 px-3 font-medium text-right">Divergências</th>
                          <th className="py-3 px-3 font-medium text-right">Faltas / Sobras</th>
                          <th className="py-3 px-4 font-medium">Motivo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {data.inventories.map((inv) => (
                          <tr key={inv.id}>
                            <td className="py-2.5 px-4 font-mono font-semibold text-slate-900 dark:text-slate-100">{inv.referenceNumber}</td>
                            <td className="py-2.5 px-3 font-mono text-slate-700 dark:text-slate-300">{formatDatePT(inv.countedAt)}</td>
                            <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">{inv.countedByName}</td>
                            <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">{inv.status}</td>
                            <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">{inv.totalDiscrepancies}</td>
                            <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                              -{inv.totalShortageUnits} / +{inv.totalSurplusUnits}
                            </td>
                            <td className="py-2.5 px-4 text-slate-700 dark:text-slate-300">{fieldOrUnregistered(inv.reason)}</td>
                          </tr>
                        ))}
                        {data.inventories.length === 0 && (
                          <tr>
                            <td colSpan={7} className="py-8 text-center text-slate-500 dark:text-slate-400">
                              Sem inventários registados no período selecionado.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
