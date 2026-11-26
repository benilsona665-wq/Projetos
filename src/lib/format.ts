import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  BuyerAckMethod,
  FiscalValidationStatus,
  PaymentMethod,
  PharmacySettings,
  Product,
  ProductFiscalValidationState,
  SaleDocumentType,
  SaleStatus,
  TaxCode,
  TaxType,
  VatRegime,
} from '../types';

export function roundMoney(n: number): number {
  const num = Number(n || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.sign(num) * (Math.round(Math.abs(num) * 100 + 1e-9) / 100);
}

export function formatMoney(value: number, currency = 'Kz'): string {
  const num = Number(value || 0);
  return `${num.toLocaleString('pt-PT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function intToPortugueseWords(n: number): string {
  if (n === 0) return 'zero';
  const unidades = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
  const especiais = [
    'dez',
    'onze',
    'doze',
    'treze',
    'catorze',
    'quinze',
    'dezasseis',
    'dezassete',
    'dezoito',
    'dezanove',
  ];
  const dezenas = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const centenas = [
    '',
    'cento',
    'duzentos',
    'trezentos',
    'quatrocentos',
    'quinhentos',
    'seiscentos',
    'setecentos',
    'oitocentos',
    'novecentos',
  ];

  const under1000 = (num: number): string => {
    if (num === 0) return '';
    if (num === 100) return 'cem';
    const c = Math.floor(num / 100);
    const rem = num % 100;
    const parts: string[] = [];
    if (c > 0) parts.push(centenas[c]);
    if (rem >= 10 && rem <= 19) {
      parts.push(especiais[rem - 10]);
    } else {
      const d = Math.floor(rem / 10);
      const u = rem % 10;
      if (d > 0) parts.push(dezenas[d]);
      if (u > 0) parts.push(unidades[u]);
    }
    return parts.join(' e ');
  };

  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;

  const chunks: string[] = [];
  if (millions > 0) {
    chunks.push(millions === 1 ? 'um milhão' : `${under1000(millions)} milhões`);
  }
  if (thousands > 0) {
    chunks.push(thousands === 1 ? 'mil' : `${under1000(thousands)} mil`);
  }
  if (rest > 0) {
    chunks.push(under1000(rest));
  }

  if (chunks.length === 1) return chunks[0];
  if (chunks.length === 2) {
    const secondVal = rest > 0 ? rest : thousands * 1000;
    const joiner = rest > 0 && (rest < 100 || rest % 100 === 0) ? ' e ' : thousands > 0 && rest === 0 && millions > 0 ? ' e ' : ', ';
    if (secondVal < 100 || secondVal % 100 === 0) return `${chunks[0]} e ${chunks[1]}`;
    return `${chunks[0]}${joiner}${chunks[1]}`;
  }
  return `${chunks[0]}, ${chunks[1]}${rest < 100 || rest % 100 === 0 ? ' e ' : ' '}${chunks[2]}`;
}

export function valorPorExtensoAOA(amount: number, currency = 'Kz'): string {
  const safe = Math.max(0, Math.round(Number(amount || 0) * 100) / 100);
  const integerPart = Math.floor(safe);
  const cents = Math.round((safe - integerPart) * 100);

  const unitSingular = currency === 'Kz' || currency === 'AOA' ? 'Kwanza' : currency;
  const unitPlural = currency === 'Kz' || currency === 'AOA' ? 'Kwanzas' : currency;
  const mainUnit = integerPart === 1 ? unitSingular : unitPlural;

  const mainText = `${intToPortugueseWords(integerPart)} ${mainUnit}`;
  const full =
    cents > 0
      ? `${mainText} e ${intToPortugueseWords(cents)} ${cents === 1 ? 'cêntimo' : 'cêntimos'}`
      : mainText;

  return full.charAt(0).toUpperCase() + full.slice(1);
}

export function formatDatePT(isoDate?: string): string {
  if (!isoDate) return '—';
  const clean = isoDate.slice(0, 10);
  const parts = clean.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function formatDateTimePT(isoTimestamp?: string): string {
  if (!isoTimestamp) return '—';
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp;
  return d.toLocaleString('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function todayLocalISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isInvoiceSaleType(t: SaleDocumentType | string): boolean {
  return t === 'FATURA' || t === 'FACTURA' || t === 'FACTURA_RECIBO';
}

export function saleDocShortCode(t: SaleDocumentType | string): 'FT' | 'FR' | 'RC' | 'PF' {
  switch (t) {
    case 'FACTURA_RECIBO':
      return 'FR';
    case 'RECIBO':
      return 'RC';
    case 'PROFORMA':
      return 'PF';
    default:
      return 'FT';
  }
}

export function saleDocTypeLabel(t: SaleDocumentType | string): string {
  switch (t) {
    case 'FACTURA_RECIBO':
      return 'Fatura-Recibo (FR)';
    case 'FACTURA':
      return 'Fatura (FT)';
    case 'RECIBO':
      return 'Recibo (RC)';
    case 'PROFORMA':
      return 'Proforma (PF)';
    case 'FATURA':
      return 'Fatura (Histórico)';
    default:
      return String(t);
  }
}

export function vatRegimeLabel(r?: VatRegime): string {
  switch (r) {
    case 'GERAL':
      return 'Regime Geral de IVA';
    case 'SIMPLIFICADO':
      return 'Regime Simplificado';
    case 'EXCLUSAO':
      return 'Regime de Exclusão';
    default:
      return 'Não configurado (requer confirmação contabilística)';
  }
}

export function taxCodeLabel(code?: TaxCode, rate?: number | null): string {
  switch (code) {
    case 'NOR':
      return rate !== null && rate !== undefined ? `Normal (${rate}%)` : 'Normal';
    case 'INT':
      return rate !== null && rate !== undefined ? `Intermédia (${rate}%)` : 'Intermédia';
    case 'RED':
      return rate !== null && rate !== undefined ? `Reduzida (${rate}%)` : 'Reduzida';
    case 'ISE':
      return 'Isento (0%)';
    case 'OUT':
      return rate === 0
        ? 'Sem IVA liquidado (OUT 0%)'
        : rate !== null && rate !== undefined
        ? `Outro (${rate}%)`
        : 'Outro';
    default:
      return 'IVA não configurado';
  }
}

export interface EffectiveProductTax {
  taxType: TaxType;
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode: string;
  taxExemptionReason: string;
  priceIncludesTax: boolean;
  fiscalValidationState: ProductFiscalValidationState;
  taxRuleId?: string;
  batchMatched: boolean;
  ruleExpired: boolean;
  ruleInactive: boolean;
}

export function resolveEffectiveProductTax(
  product: Pick<
    Product,
    | 'taxType'
    | 'taxCode'
    | 'taxRate'
    | 'taxExemptionCode'
    | 'taxExemptionReason'
    | 'priceIncludesTax'
    | 'fiscalValidationState'
    | 'taxRuleId'
    | 'batchTaxes'
  >,
  settings?: Pick<PharmacySettings, 'pricesIncludeTax' | 'taxRules'> | null,
  batch?: string,
  dateISO = todayLocalISO()
): EffectiveProductTax {
  const cleanBatch = String(batch || '').trim().toLowerCase();
  const batchMatch =
    cleanBatch && Array.isArray(product.batchTaxes)
      ? product.batchTaxes.find((bt) => String(bt.batch || '').trim().toLowerCase() === cleanBatch)
      : undefined;

  const source = batchMatch || product;
  const taxRuleId = source.taxRuleId || product.taxRuleId;
  const rule = taxRuleId && Array.isArray(settings?.taxRules)
    ? settings.taxRules.find((r) => r.id === taxRuleId)
    : undefined;

  const ruleInactive = Boolean(rule && !rule.active);
  const ruleExpired = Boolean(
    rule &&
      ((rule.validFrom && dateISO < rule.validFrom) ||
        (rule.validTo && dateISO > rule.validTo))
  );

  const defaultIncludes = Boolean(settings?.pricesIncludeTax);
  const resolvedIncludes =
    source.priceIncludesTax !== undefined && source.priceIncludesTax !== null
      ? Boolean(source.priceIncludesTax)
      : product.priceIncludesTax !== undefined && product.priceIncludesTax !== null
      ? Boolean(product.priceIncludesTax)
      : defaultIncludes;

  return {
    taxType: source.taxType || product.taxType || 'IVA',
    taxCode: source.taxCode || 'NAO_CONFIGURADO',
    taxRate:
      source.taxRate !== undefined && source.taxRate !== null && Number.isFinite(Number(source.taxRate))
        ? Number(source.taxRate)
        : null,
    taxExemptionCode: source.taxExemptionCode || '',
    taxExemptionReason: source.taxExemptionReason || '',
    priceIncludesTax: resolvedIncludes,
    fiscalValidationState:
      source.fiscalValidationState || product.fiscalValidationState || 'PENDENTE_REVISAO',
    taxRuleId,
    batchMatched: Boolean(batchMatch),
    ruleExpired,
    ruleInactive,
  };
}

export function calculateLineVat(
  quantity: number,
  unitPrice: number,
  discountPercent: number,
  taxSpec: {
    taxCode?: TaxCode;
    taxRate?: number | null;
    priceIncludesTax?: boolean | null;
  },
  defaultPricesIncludeTax = false
) {
  const qty = Number(quantity || 0);
  const price = Number(unitPrice || 0);
  const discPct = Math.max(0, Math.min(100, Number(discountPercent || 0)));
  const includesTax =
    taxSpec.priceIncludesTax !== undefined && taxSpec.priceIncludesTax !== null
      ? Boolean(taxSpec.priceIncludesTax)
      : Boolean(defaultPricesIncludeTax);
  const effectiveRate =
    taxSpec.taxCode === 'ISE' || taxSpec.taxCode === 'NAO_CONFIGURADO' || !taxSpec.taxCode
      ? 0
      : Math.max(0, Number(taxSpec.taxRate ?? 0));

  const grossBeforeDiscount = roundMoney(qty * price);
  const discountAmount = roundMoney(grossBeforeDiscount * (discPct / 100));
  const netAfterDiscount = roundMoney(grossBeforeDiscount - discountAmount);

  if (effectiveRate <= 0) {
    return {
      grossBeforeDiscount,
      discountAmount,
      taxableBase: netAfterDiscount,
      taxAmount: 0,
      subtotal: netAfterDiscount,
      priceIncludesTax: includesTax,
      effectiveRate: 0,
    };
  }

  if (includesTax) {
    const taxableBase = roundMoney(netAfterDiscount / (1 + effectiveRate / 100));
    const taxAmount = roundMoney(netAfterDiscount - taxableBase);
    return {
      grossBeforeDiscount,
      discountAmount,
      taxableBase,
      taxAmount,
      subtotal: netAfterDiscount,
      priceIncludesTax: true,
      effectiveRate,
    };
  }

  const taxableBase = netAfterDiscount;
  const taxAmount = roundMoney(taxableBase * (effectiveRate / 100));
  return {
    grossBeforeDiscount,
    discountAmount,
    taxableBase,
    taxAmount,
    subtotal: roundMoney(taxableBase + taxAmount),
    priceIncludesTax: false,
    effectiveRate,
  };
}

export function fiscalStatusLabel(status?: FiscalValidationStatus): string {
  switch (status) {
    case 'VALIDADO_AGT':
      return 'Validado pela AGT';
    case 'PENDENTE_AGT':
      return 'Pendente / Submetido AGT';
    case 'REJEITADO_AGT':
      return 'Rejeitado pela AGT';
    case 'NAO_FISCAL_PROFORMA':
      return 'Não Fiscal (Proforma)';
    default:
      return 'Rascunho Interno (Sem Validação AGT)';
  }
}

export function buyerAckMethodLabel(method?: BuyerAckMethod): string {
  switch (method) {
    case 'CARTA':
      return 'Carta / Protocolo';
    case 'EMAIL':
      return 'Correio Electrónico';
    case 'ASSINATURA_NIF':
      return 'Assinatura + NIF no Documento';
    case 'CARIMBO_EMPRESA':
      return 'Carimbo e Rubrica do Adquirente';
    case 'OUTRO':
      return 'Outro Meio Documentado';
    default:
      return 'Não registada';
  }
}

export function paymentMethodLabel(method: PaymentMethod): string {
  switch (method) {
    case 'DINHEIRO':
      return 'Dinheiro';
    case 'MULTICAIXA':
      return 'Multicaixa / TPA';
    case 'TRANSFERENCIA':
      return 'Transferência';
    case 'SEGURO':
      return 'Seguro / Convénio';
  }
}

export function saleStatusLabel(status: SaleStatus): string {
  switch (status) {
    case 'EMITIDA':
      return 'Emitida';
    case 'PROFORMA':
      return 'Proforma';
    case 'CONVERTIDA':
      return 'Convertida em Fatura';
    case 'PARCIALMENTE_DEVOLVIDA':
      return 'Parcialmente Devolvida';
    case 'DEVOLVIDA':
      return 'Totalmente Devolvida';
    case 'ANULADA':
      return 'Anulada';
  }
}

export function getProductAlerts(product: Product, warningDays = 60) {
  const today = todayLocalISO();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + warningDays);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const isOut = product.stock <= 0;
  const isLow = product.stock > 0 && product.stock <= product.minStock;
  const isExpired = Boolean(product.expiryDate && product.expiryDate < today);
  const isExpiringSoon = Boolean(
    product.expiryDate && product.expiryDate >= today && product.expiryDate <= cutoffISO
  );

  return { isOut, isLow, isExpired, isExpiringSoon };
}

export function exportToExcel(
  filename: string,
  sheets: Array<{ name: string; rows: Array<Record<string, string | number>> }>
): void {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.json_to_sheet(
      sheet.rows.length > 0 ? sheet.rows : [{ Mensagem: 'Sem registos no período selecionado' }]
    );
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

export function exportTableToPDF(
  filename: string,
  title: string,
  subtitle: string,
  headers: string[],
  rows: Array<Array<string | number>>,
  pharmacyName = 'Âncora SMS'
): void {
  const doc = new jsPDF({ orientation: headers.length > 6 ? 'landscape' : 'portrait' });
  doc.setFontSize(14);
  doc.setTextColor(11, 107, 58);
  doc.text(`${pharmacyName} — Stock Management System`, 14, 16);
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(11);
  doc.text(title, 14, 23);
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(`${subtitle} · Emitido em ${formatDateTimePT(new Date().toISOString())}`, 14, 29);

  autoTable(doc, {
    head: [headers],
    body: rows.length > 0 ? rows : [['Sem dados disponíveis']],
    startY: 34,
    styles: { fontSize: 8, cellPadding: 2.5 },
    headStyles: { fillColor: [11, 107, 58], textColor: 255 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  doc.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}
