import crypto from 'node:crypto';
import type {
  AgtPublicStatus,
  AgtSubmissionEvent,
  DatabaseSchema,
  FiscalValidationStatus,
  PharmacySettings,
  Product,
  ProductFiscalValidationState,
  ReturnItem,
  Sale,
  SaleDocumentType,
  SaleItem,
  SaleReturn,
  TaxBreakdownEntry,
  TaxCode,
  TaxRuleEntry,
  TaxType,
} from '../src/types.ts';
import { HttpError, formatDocNum, todayISO } from './db.ts';

const DEFAULT_AGT_HML_URL = 'https://sifphml.minfin.gov.ao/sigt/fe/v1';
const DEFAULT_AGT_PROD_URL = 'https://sifp.minfin.gov.ao/sigt/fe/v1';

export function roundMoney(n: number): number {
  const num = Number(n || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.sign(num) * (Math.round(Math.abs(num) * 100 + 1e-9) / 100);
}

export function isInvoiceSaleType(t: SaleDocumentType | string): boolean {
  return t === 'FATURA' || t === 'FACTURA' || t === 'FACTURA_RECIBO';
}

export function isImmediateCashOrRevenueSaleType(t: SaleDocumentType | string): boolean {
  return t === 'FATURA' || t === 'FACTURA' || t === 'FACTURA_RECIBO';
}

export function toAgtDocTypeCode(t: SaleDocumentType | string): 'FT' | 'FR' | 'RC' | 'PF' | 'NC' {
  switch (t) {
    case 'FACTURA':
    case 'FATURA':
      return 'FT';
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

export type SeriesDocKind =
  | 'FACTURA'
  | 'FACTURA_RECIBO'
  | 'RECIBO'
  | 'PROFORMA'
  | 'CREDIT_NOTE'
  | 'CANCELLATION'
  | 'PURCHASE'
  | 'INVENTORY'
  | 'GENERAL_CLOSING';

function defaultSeriesPrefixForKind(kind: SeriesDocKind, year: number, settings: PharmacySettings): string {
  const s = settings.series;
  const raw = (() => {
    switch (kind) {
      case 'FACTURA':
        return s.invoicePrefix || `FT ${year}`;
      case 'FACTURA_RECIBO':
        return s.invoiceReciboPrefix || `FR ${year}`;
      case 'RECIBO':
        return s.receiptPrefix || `RC ${year}`;
      case 'PROFORMA':
        return s.proformaPrefix || `PF ${year}`;
      case 'CREDIT_NOTE':
        return s.creditNotePrefix || `NC ${year}`;
      case 'CANCELLATION':
        return s.cancellationPrefix || `AN ${year}`;
      case 'PURCHASE':
        return s.purchasePrefix || `CP ${year}`;
      case 'INVENTORY':
        return s.inventoryPrefix || `INV ${year}`;
      case 'GENERAL_CLOSING':
        return s.generalClosingPrefix || `FG ${year}`;
    }
  })();
  // Keep custom prefix base, but align trailing 4-digit fiscal year if present
  if (/\b\d{4}$/.test(raw)) {
    return raw.replace(/\b\d{4}$/, String(year));
  }
  return `${raw} ${year}`;
}

function getLegacyNextForKind(kind: SeriesDocKind, settings: PharmacySettings): number {
  const s = settings.series;
  switch (kind) {
    case 'FACTURA':
      return Number(s.invoiceNext) || 1;
    case 'FACTURA_RECIBO':
      return Number(s.invoiceReciboNext) || 1;
    case 'RECIBO':
      return Number(s.receiptNext) || 1;
    case 'PROFORMA':
      return Number(s.proformaNext) || 1;
    case 'CREDIT_NOTE':
      return Number(s.creditNoteNext) || 1;
    case 'CANCELLATION':
      return Number(s.cancellationNext) || 1;
    case 'PURCHASE':
      return Number(s.purchaseNext) || 1;
    case 'INVENTORY':
      return Number(s.inventoryNext) || 1;
    case 'GENERAL_CLOSING':
      return Number(s.generalClosingNext) || 1;
  }
}

function setLegacyNextForKind(kind: SeriesDocKind, settings: PharmacySettings, nextVal: number): void {
  const s = settings.series;
  switch (kind) {
    case 'FACTURA':
      s.invoiceNext = nextVal;
      break;
    case 'FACTURA_RECIBO':
      s.invoiceReciboNext = nextVal;
      break;
    case 'RECIBO':
      s.receiptNext = nextVal;
      break;
    case 'PROFORMA':
      s.proformaNext = nextVal;
      break;
    case 'CREDIT_NOTE':
      s.creditNoteNext = nextVal;
      break;
    case 'CANCELLATION':
      s.cancellationNext = nextVal;
      break;
    case 'PURCHASE':
      s.purchaseNext = nextVal;
      break;
    case 'INVENTORY':
      s.inventoryNext = nextVal;
      break;
    case 'GENERAL_CLOSING':
      s.generalClosingNext = nextVal;
      break;
  }
}

export function allocateDocumentNumber(
  db: DatabaseSchema,
  kind: SeriesDocKind,
  dateISO: string
): string {
  const year = Number(dateISO.slice(0, 4)) || new Date().getFullYear();
  const prefix = defaultSeriesPrefixForKind(kind, year, db.settings);
  if (!db.settings.series.yearlyCounters) {
    db.settings.series.yearlyCounters = {};
  }
  const counterKey = `${kind}:${year}`;
  const currentSeriesYear = Number(db.settings.series.seriesYear) || year;

  // Enforce chronological order for fiscal documents in the same series prefix
  const isFiscalKind =
    kind === 'FACTURA' ||
    kind === 'FACTURA_RECIBO' ||
    kind === 'RECIBO' ||
    kind === 'CREDIT_NOTE';
  if (isFiscalKind) {
    const existingDates = [
      ...db.sales.filter((s) => s.documentNumber.startsWith(`${prefix}/`)).map((s) => s.date),
      ...db.returns.filter((r) => r.documentNumber.startsWith(`${prefix}/`)).map((r) => r.date),
    ];
    if (existingDates.some((d) => d > dateISO)) {
      throw new HttpError(
        409,
        `Ordem cronológica violada na série "${prefix}": já existe documento emitido com data posterior a ${dateISO}.`
      );
    }
  }

  let nextSeq = db.settings.series.yearlyCounters[counterKey];
  if (!nextSeq) {
    nextSeq = year === currentSeriesYear ? getLegacyNextForKind(kind, db.settings) : 1;
  }

  // Never collide with or reuse any existing document number in the same prefix/year
  const prefixWithSlash = `${prefix}/`;
  const existingNumbers = new Set<string>([
    ...db.sales.map((s) => s.documentNumber),
    ...db.returns.map((r) => r.documentNumber),
    ...db.returns.map((r) => r.internalCancellationRef || '').filter(Boolean),
    ...db.purchases.map((p) => p.internalNumber),
    ...db.inventories.map((i) => i.referenceNumber),
    ...db.generalClosings.map((g) => g.referenceNumber),
  ]);

  let maxExistingSeq = 0;
  for (const docNum of existingNumbers) {
    if (docNum.startsWith(prefixWithSlash)) {
      const seqPart = Number(docNum.slice(prefixWithSlash.length));
      if (Number.isFinite(seqPart) && seqPart > maxExistingSeq) {
        maxExistingSeq = seqPart;
      }
    }
  }
  if (nextSeq <= maxExistingSeq) {
    nextSeq = maxExistingSeq + 1;
  }

  let candidate = formatDocNum(prefix, nextSeq);
  while (existingNumbers.has(candidate)) {
    nextSeq += 1;
    candidate = formatDocNum(prefix, nextSeq);
  }

  db.settings.series.yearlyCounters[counterKey] = nextSeq + 1;
  if (year === currentSeriesYear) {
    setLegacyNextForKind(kind, db.settings, nextSeq + 1);
  }

  return candidate;
}

export function validateProductTaxInput(input: {
  taxType?: unknown;
  taxCode?: unknown;
  taxRate?: unknown;
  taxExemptionCode?: unknown;
  taxExemptionReason?: unknown;
}): {
  taxType: TaxType;
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode: string;
  taxExemptionReason: string;
} {
  const rawType = String(input.taxType || 'IVA').trim().toUpperCase();
  const taxType: TaxType = rawType === 'IVA' ? 'IVA' : 'IVA';
  const rawCode = String(input.taxCode || 'NAO_CONFIGURADO').trim().toUpperCase();
  const allowed: TaxCode[] = ['NAO_CONFIGURADO', 'NOR', 'INT', 'RED', 'ISE', 'OUT'];
  const taxCode: TaxCode = allowed.includes(rawCode as TaxCode)
    ? (rawCode as TaxCode)
    : 'NAO_CONFIGURADO';

  const taxExemptionCode = String(input.taxExemptionCode || '').trim().toUpperCase();
  const taxExemptionReason = String(input.taxExemptionReason || '').trim();

  if (taxCode === 'NAO_CONFIGURADO') {
    return {
      taxType,
      taxCode: 'NAO_CONFIGURADO',
      taxRate: null,
      taxExemptionCode: '',
      taxExemptionReason: '',
    };
  }

  if (taxCode === 'ISE') {
    if (!taxExemptionCode || !taxExemptionReason) {
      throw new HttpError(
        400,
        'Para produtos isentos (ISE), indique explicitamente o código de isenção AGT e a base legal/motivo.'
      );
    }
    return {
      taxType,
      taxCode: 'ISE',
      taxRate: 0,
      taxExemptionCode,
      taxExemptionReason,
    };
  }

  if (input.taxRate === null || input.taxRate === undefined || String(input.taxRate).trim() === '') {
    throw new HttpError(
      400,
      `Indique a taxa de imposto (%) para o código fiscal ${taxCode} (o sistema não assume taxas automaticamente).`
    );
  }
  const numericRate = Number(input.taxRate);
  if (!Number.isFinite(numericRate) || numericRate < 0 || numericRate > 100) {
    throw new HttpError(400, 'A taxa de imposto (%) deve ser um número entre 0 e 100.');
  }
  if ((taxCode === 'NOR' || taxCode === 'INT' || taxCode === 'RED') && numericRate <= 0) {
    throw new HttpError(
      400,
      `O código ${taxCode} exige uma taxa de IVA superior a 0%. Para operações isentas ou sem liquidação de IVA, utilize ISE ou OUT (0%).`
    );
  }
  if (taxCode === 'OUT' && numericRate === 0 && !taxExemptionReason) {
    throw new HttpError(
      400,
      'Para produtos com código OUT e taxa 0% (sem liquidação de IVA), indique a menção legal justificativa (Art. 10.º DP 71/25).'
    );
  }

  return {
    taxType,
    taxCode,
    taxRate: roundMoney(numericRate),
    taxExemptionCode: numericRate === 0 ? taxExemptionCode : '',
    taxExemptionReason: numericRate === 0 ? taxExemptionReason : '',
  };
}

export function isTaxRuleValidForDate(rule: TaxRuleEntry, dateISO = todayISO()): {
  active: boolean;
  validForDate: boolean;
  reason?: string;
} {
  if (!rule.active) {
    return { active: false, validForDate: false, reason: `Regra fiscal "${rule.description}" está inativa.` };
  }
  if (rule.validFrom && dateISO < rule.validFrom) {
    return {
      active: true,
      validForDate: false,
      reason: `Regra fiscal "${rule.description}" só entra em vigor em ${rule.validFrom}.`,
    };
  }
  if (rule.validTo && dateISO > rule.validTo) {
    return {
      active: true,
      validForDate: false,
      reason: `Regra fiscal "${rule.description}" caducou em ${rule.validTo}.`,
    };
  }
  return { active: true, validForDate: true };
}

export function resolveEffectiveProductTax(
  product: Pick<
    Product,
    | 'name'
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
  settings: Pick<PharmacySettings, 'pricesIncludeTax' | 'taxRules'>,
  batch?: string,
  dateISO = todayISO()
): {
  name: string;
  taxType: TaxType;
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode: string;
  taxExemptionReason: string;
  priceIncludesTax: boolean;
  fiscalValidationState: ProductFiscalValidationState;
  taxRuleId?: string;
  batchMatched: boolean;
  ruleError?: string;
} {
  const cleanBatch = String(batch || '').trim().toLowerCase();
  const batchMatch =
    cleanBatch && Array.isArray(product.batchTaxes)
      ? product.batchTaxes.find((bt) => String(bt.batch || '').trim().toLowerCase() === cleanBatch)
      : undefined;

  const src = batchMatch || product;
  const taxRuleId = src.taxRuleId || product.taxRuleId;
  let ruleError: string | undefined;
  if (taxRuleId && Array.isArray(settings.taxRules)) {
    const rule = settings.taxRules.find((r) => r.id === taxRuleId);
    if (rule) {
      const check = isTaxRuleValidForDate(rule, dateISO);
      if (!check.active || !check.validForDate) {
        ruleError = check.reason;
      }
    }
  }

  const resolvedIncludes =
    src.priceIncludesTax !== undefined && src.priceIncludesTax !== null
      ? Boolean(src.priceIncludesTax)
      : product.priceIncludesTax !== undefined && product.priceIncludesTax !== null
      ? Boolean(product.priceIncludesTax)
      : Boolean(settings.pricesIncludeTax);

  return {
    name: product.name,
    taxType: src.taxType || product.taxType || 'IVA',
    taxCode: src.taxCode || 'NAO_CONFIGURADO',
    taxRate:
      src.taxRate !== undefined && src.taxRate !== null && Number.isFinite(Number(src.taxRate))
        ? Number(src.taxRate)
        : null,
    taxExemptionCode: src.taxExemptionCode || '',
    taxExemptionReason: src.taxExemptionReason || '',
    priceIncludesTax: resolvedIncludes,
    fiscalValidationState:
      src.fiscalValidationState || product.fiscalValidationState || 'PENDENTE_REVISAO',
    taxRuleId,
    batchMatched: Boolean(batchMatch),
    ruleError,
  };
}

export function assertFiscalEmissionAllowed(
  settings: PharmacySettings,
  itemsOrProducts: Array<{
    name?: string;
    productName?: string;
    taxCode?: TaxCode;
    taxRate?: number | null;
    taxExemptionCode?: string;
    taxExemptionReason?: string;
    ruleError?: string;
  }>,
  docType: SaleDocumentType | 'CREDIT_NOTE' | 'NC'
): void {
  // Proforma é documento não fiscal (orçamento) e pode ser emitido antes da conclusão fiscal
  if (docType === 'PROFORMA') return;

  const missingIssuer: string[] = [];
  if (!settings.legalName?.trim()) missingIssuer.push('Denominação Legal');
  if (!settings.nif?.trim()) missingIssuer.push('NIF');
  if (!settings.address?.trim()) missingIssuer.push('Sede / Domicílio');
  if (!settings.establishmentName?.trim()) missingIssuer.push('Estabelecimento emissor');
  if (missingIssuer.length > 0) {
    throw new HttpError(
      409,
      `Emissão fiscal bloqueada (Art. 10.º DP 71/25): faltam dados obrigatórios da farmácia (${missingIssuer.join(', ')}). Peça ao Administrador para completar nas Configurações.`,
      { code: 'FISCAL_CONFIG_INCOMPLETE' }
    );
  }

  const regime = settings.vatRegime || 'NAO_CONFIGURADO';
  if (regime === 'NAO_CONFIGURADO') {
    throw new HttpError(
      409,
      'Emissão fiscal bloqueada: o regime de IVA da farmácia está "NAO_CONFIGURADO". Confirme o enquadramento com o contabilista nas Configurações (ou emita uma Proforma não fiscal).',
      { code: 'VAT_REGIME_NOT_CONFIGURED' }
    );
  }

  if (docType === 'RECIBO') return;

  const unconfigured: string[] = [];
  const expiredOrInactive: string[] = [];
  const incompleteIse: string[] = [];
  const incompleteOut: string[] = [];
  const regimeCoherence: string[] = [];

  for (const item of itemsOrProducts) {
    const label = item.productName || item.name || 'produto';
    const tCode = item.taxCode || 'NAO_CONFIGURADO';
    if (tCode === 'NAO_CONFIGURADO') {
      unconfigured.push(label);
      continue;
    }
    if (item.ruleError) {
      expiredOrInactive.push(`${label} (${item.ruleError})`);
    }
    if (tCode === 'ISE' && (!item.taxExemptionCode?.trim() || !item.taxExemptionReason?.trim())) {
      incompleteIse.push(label);
    }
    if (tCode === 'OUT' && Number(item.taxRate ?? 0) === 0 && !item.taxExemptionReason?.trim()) {
      incompleteOut.push(label);
    }
    if (
      docType !== 'NC' &&
      docType !== 'CREDIT_NOTE' &&
      (regime === 'SIMPLIFICADO' || regime === 'EXCLUSAO') &&
      ((item.taxRate ?? 0) > 0 || tCode === 'NOR' || tCode === 'INT' || tCode === 'RED')
    ) {
      regimeCoherence.push(label);
    }
  }

  if (unconfigured.length > 0) {
    throw new HttpError(
      409,
      `Emissão fiscal bloqueada: produto(s) sem enquadramento/taxa de IVA configurada ("NAO_CONFIGURADO"): ${unconfigured.join(', ')}. Confirme com o contabilista no catálogo ou emita Proforma.`,
      { code: 'PRODUCT_TAX_NOT_CONFIGURED' }
    );
  }
  if (expiredOrInactive.length > 0) {
    throw new HttpError(
      409,
      `Emissão fiscal bloqueada: regra fiscal expirada ou inativa para ${expiredOrInactive.join('; ')}.`,
      { code: 'PRODUCT_TAX_RULE_INVALID' }
    );
  }
  if (incompleteIse.length > 0) {
    throw new HttpError(
      409,
      `Emissão fiscal bloqueada: produto(s) isento(s) (ISE) sem código de isenção e motivo legal completos: ${incompleteIse.join(', ')}.`,
      { code: 'PRODUCT_TAX_INCOMPLETE' }
    );
  }
  if (incompleteOut.length > 0) {
    throw new HttpError(
      409,
      `Emissão fiscal bloqueada: produto(s) OUT (0%) sem menção legal justificativa da não liquidação de IVA: ${incompleteOut.join(', ')}.`,
      { code: 'PRODUCT_TAX_INCOMPLETE' }
    );
  }
  if (regimeCoherence.length > 0) {
    throw new HttpError(
      409,
      `Incoerência fiscal: a farmácia está em Regime ${regime === 'SIMPLIFICADO' ? 'Simplificado' : 'de Exclusão'}, não sendo permitido liquidar IVA positivo em: ${regimeCoherence.join(', ')}.`,
      { code: 'VAT_REGIME_COHERENCE_ERROR' }
    );
  }
}

export function buildLineTaxValues(
  netLineAmount: number,
  prod: Pick<Product, 'taxType' | 'taxCode' | 'taxRate' | 'taxExemptionCode' | 'taxExemptionReason'>,
  pricesIncludeTax: boolean
): {
  taxType: TaxType;
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode: string;
  taxExemptionReason: string;
  priceIncludesTax: boolean;
  taxableBase: number;
  taxAmount: number;
  lineTotalWithTax: number;
} {
  const taxType: TaxType = prod.taxType || 'IVA';
  const taxCode: TaxCode = prod.taxCode || 'NAO_CONFIGURADO';
  const taxRate: number | null =
    taxCode === 'NAO_CONFIGURADO'
      ? null
      : taxCode === 'ISE'
      ? 0
      : prod.taxRate !== null && prod.taxRate !== undefined
      ? Number(prod.taxRate)
      : null;
  const taxExemptionCode = prod.taxExemptionCode || '';
  const taxExemptionReason = prod.taxExemptionReason || '';

  if (taxCode === 'NAO_CONFIGURADO' || taxCode === 'ISE' || taxRate === null || taxRate <= 0) {
    return {
      taxType,
      taxCode,
      taxRate,
      taxExemptionCode,
      taxExemptionReason,
      priceIncludesTax: Boolean(pricesIncludeTax),
      taxableBase: roundMoney(netLineAmount),
      taxAmount: 0,
      lineTotalWithTax: roundMoney(netLineAmount),
    };
  }

  if (pricesIncludeTax) {
    const taxableBase = roundMoney(netLineAmount / (1 + taxRate / 100));
    const taxAmount = roundMoney(netLineAmount - taxableBase);
    return {
      taxType,
      taxCode,
      taxRate,
      taxExemptionCode,
      taxExemptionReason,
      priceIncludesTax: true,
      taxableBase,
      taxAmount,
      lineTotalWithTax: roundMoney(netLineAmount),
    };
  }

  const taxableBase = roundMoney(netLineAmount);
  const taxAmount = roundMoney((taxableBase * taxRate) / 100);
  return {
    taxType,
    taxCode,
    taxRate,
    taxExemptionCode,
    taxExemptionReason,
    priceIncludesTax: false,
    taxableBase,
    taxAmount,
    lineTotalWithTax: roundMoney(taxableBase + taxAmount),
  };
}

export function aggregateTaxBreakdown(
  items: Array<{
    taxCode?: TaxCode;
    taxRate?: number | null;
    taxExemptionCode?: string;
    taxExemptionReason?: string;
    taxableBase?: number;
    taxAmount?: number;
    subtotal?: number;
    refundAmount?: number;
  }>
): { taxTotal: number; taxBreakdown: TaxBreakdownEntry[] } {
  const groups = new Map<string, TaxBreakdownEntry>();
  let taxTotal = 0;

  for (const item of items) {
    const taxCode: TaxCode = item.taxCode || 'NAO_CONFIGURADO';
    const taxRate: number | null =
      taxCode === 'NAO_CONFIGURADO'
        ? null
        : taxCode === 'ISE'
        ? 0
        : item.taxRate !== null && item.taxRate !== undefined
        ? Number(item.taxRate)
        : null;
    const taxExemptionCode = item.taxExemptionCode || '';
    const taxExemptionReason = item.taxExemptionReason || '';
    const fallbackAmount = Number(item.subtotal ?? item.refundAmount ?? 0);
    const taxableBase = roundMoney(item.taxableBase ?? fallbackAmount);
    const taxAmount = roundMoney(item.taxAmount ?? 0);

    taxTotal = roundMoney(taxTotal + taxAmount);

    const key = `${taxCode}|${taxRate ?? 'NULL'}|${taxExemptionCode}|${taxExemptionReason}`;
    if (!groups.has(key)) {
      groups.set(key, {
        taxCode,
        taxRate,
        taxExemptionCode,
        taxExemptionReason,
        taxableBase: 0,
        taxAmount: 0,
        total: 0,
        itemsCount: 0,
      });
    }
    const g = groups.get(key)!;
    g.taxableBase = roundMoney(g.taxableBase + taxableBase);
    g.taxAmount = roundMoney(g.taxAmount + taxAmount);
    g.total = roundMoney(g.taxableBase + g.taxAmount);
    g.itemsCount += 1;
  }

  return {
    taxTotal,
    taxBreakdown: Array.from(groups.values()),
  };
}

function readPemFromEnv(envVarName: string): string {
  const raw = (process.env[envVarName] || '').trim();
  if (!raw) return '';
  return raw.replace(/\\n/g, '\n');
}

export function getAgtConfigStatus(): AgtPublicStatus {
  const envRaw = (process.env.AGT_ENV || '').trim().toUpperCase();
  const environment: AgtPublicStatus['environment'] =
    envRaw === 'PRODUCAO' || envRaw === 'PRODUCTION'
      ? 'PRODUCAO'
      : envRaw === 'HOMOLOGACAO' || envRaw === 'HML'
      ? 'HOMOLOGACAO'
      : 'NAO_CONFIGURADO';

  const customBaseUrl = (process.env.AGT_API_BASE_URL || '').trim();
  const baseUrl =
    customBaseUrl ||
    (environment === 'PRODUCAO'
      ? DEFAULT_AGT_PROD_URL
      : environment === 'HOMOLOGACAO'
      ? DEFAULT_AGT_HML_URL
      : '');

  const username = (process.env.AGT_API_USERNAME || '').trim();
  const password = (process.env.AGT_API_PASSWORD || '').trim();
  const basicAuthConfigured = Boolean(username && password);
  const productId = (process.env.AGT_SOFTWARE_PRODUCT_ID || '').trim();
  const softwareIdConfigured = Boolean(productId);
  const validationNo = (process.env.AGT_SOFTWARE_VALIDATION_NUMBER || '').trim();
  const softwareValidationNumberConfigured = Boolean(validationNo);
  const taxpayerPrivateKeyConfigured = Boolean(readPemFromEnv('AGT_PRIVATE_KEY_PEM'));
  const softwarePrivateKeyConfigured = Boolean(readPemFromEnv('AGT_SOFTWARE_PRIVATE_KEY_PEM'));

  const missingRequirements: string[] = [];
  if (environment === 'NAO_CONFIGURADO') {
    missingRequirements.push('Definir AGT_ENV (HOMOLOGACAO ou PRODUCAO) no servidor.');
  }
  if (!baseUrl) {
    missingRequirements.push('Definir AGT_API_BASE_URL (URL HTTPS oficial da AGT).');
  }
  if (!basicAuthConfigured) {
    missingRequirements.push('Definir AGT_API_USERNAME e AGT_API_PASSWORD (Portal do Parceiro AGT).');
  }
  if (!softwareValidationNumberConfigured) {
    missingRequirements.push('Definir AGT_SOFTWARE_VALIDATION_NUMBER (número de certificação/validação AGT).');
  }
  if (!taxpayerPrivateKeyConfigured) {
    missingRequirements.push('Definir AGT_PRIVATE_KEY_PEM (chave privada RSA >= 2048 bits do contribuinte).');
  }
  if (!softwarePrivateKeyConfigured) {
    missingRequirements.push('Definir AGT_SOFTWARE_PRIVATE_KEY_PEM (chave privada RSA da produtora de software).');
  }

  const configured = missingRequirements.length === 0;
  const homologationConfigured = configured && environment === 'HOMOLOGACAO';
  const officiallyValidatedOnAgtList =
    process.env.AGT_OFFICIAL_CERTIFICATION_PROOF === 'true' &&
    configured &&
    environment === 'PRODUCAO';
  const certified = officiallyValidatedOnAgtList;

  const maskedValidation =
    validationNo.length > 4
      ? `${validationNo.slice(0, 2)}***${validationNo.slice(-2)}`
      : validationNo
      ? '***'
      : 'Não configurado';

  const certifiedDisclaimer = certified
    ? 'Configuração AGT de Produção com validação oficial declarada no servidor. A validade fiscal depende igualmente da adesão ativa do contribuinte à Facturação Electrónica.'
    : homologationConfigured
    ? 'Ambiente de HOMOLOGAÇÃO AGT configurado no servidor para testes técnicos. O software Âncora SMS NÃO consta da lista oficial de softwares validados pela AGT e os documentos não têm validade fiscal comercial.'
    : 'Sistema NÃO certificado nem validado pela AGT (Âncora SMS não consta na lista oficial de softwares validados pela AGT). Os documentos emitidos sem validação/homologação são apenas rascunhos internos sem validade fiscal perante a AGT.';

  return {
    configured,
    homologationConfigured,
    certified,
    officiallyValidatedOnAgtList,
    environment,
    baseUrl,
    basicAuthConfigured,
    softwareIdConfigured,
    softwareValidationNumberConfigured,
    softwareValidationNumberMasked: maskedValidation,
    taxpayerPrivateKeyConfigured,
    softwarePrivateKeyConfigured,
    missingRequirements,
    certifiedDisclaimer,
  };
}

export function getDocumentReadinessWarnings(
  settings: PharmacySettings,
  items: Array<{ taxCode?: TaxCode; taxExemptionCode?: string; taxExemptionReason?: string; productName?: string }>
): string[] {
  const warnings: string[] = [];
  if (!settings.legalName?.trim() || !settings.nif?.trim() || !settings.address?.trim()) {
    warnings.push('Dados fiscais completos da farmácia (denominação legal, NIF e morada) incompletos.');
  }
  if (!settings.vatRegime || settings.vatRegime === 'NAO_CONFIGURADO') {
    warnings.push('Regime fiscal de IVA da farmácia ainda não foi confirmado/configurado.');
  }
  const unconfigured = items.filter((i) => !i.taxCode || i.taxCode === 'NAO_CONFIGURADO');
  if (unconfigured.length > 0) {
    warnings.push(
      `${unconfigured.length} linha(s) de produto ainda sem tratamento fiscal/taxa de IVA configurada (ex.: ${unconfigured[0].productName || 'produto'}).`
    );
  }
  const missingExemption = items.filter(
    (i) => i.taxCode === 'ISE' && (!i.taxExemptionCode?.trim() || !i.taxExemptionReason?.trim())
  );
  if (missingExemption.length > 0) {
    warnings.push('Existem linhas isentas (ISE) sem código ou motivo legal de isenção AGT.');
  }
  const missingOutZeroReason = items.filter(
    (i) => i.taxCode === 'OUT' && Number((i as any).taxRate ?? 0) === 0 && !i.taxExemptionReason?.trim()
  );
  if (missingOutZeroReason.length > 0) {
    warnings.push('Existem linhas OUT (0%) sem menção legal justificativa da não liquidação de IVA.');
  }
  return warnings;
}

function signJwsRs256(payloadObj: Record<string, unknown>, pemKey: string): string | null {
  if (!pemKey) return null;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(pemKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export function buildAgtFeSubmissionPayload(
  settings: PharmacySettings,
  doc: Sale | SaleReturn,
  kind: 'SALE' | 'RETURN'
): {
  schemaVersion: '2.0';
  submissionUUID: string;
  taxRegistrationNumber: string;
  submissionTimeStamp: string;
  softwareInfo: {
    softwareInfoDetail: {
      productId: string;
      productVersion: string;
      softwareValidationNumber: string | null;
    };
    jwsSoftwareSignature: string | null;
  };
  numberOfEntries: number;
  documents: Array<Record<string, unknown>>;
  readinessWarnings: string[];
  localValidation: { valid: boolean; errors: string[] };
  agtStatus: AgtPublicStatus;
} {
  const agtStatus = getAgtConfigStatus();
  const softwarePem = readPemFromEnv('AGT_SOFTWARE_PRIVATE_KEY_PEM');
  const taxpayerPem = readPemFromEnv('AGT_PRIVATE_KEY_PEM');

  const productId = (process.env.AGT_SOFTWARE_PRODUCT_ID || 'AncoraSMS').trim();
  const productVersion = (process.env.AGT_SOFTWARE_PRODUCT_VERSION || '1.0.0').trim();
  const validationNumber = (process.env.AGT_SOFTWARE_VALIDATION_NUMBER || '').trim() || null;

  const softwareInfoDetail = {
    productId,
    productVersion,
    softwareValidationNumber: validationNumber,
  };

  const jwsSoftwareSignature = softwarePem
    ? signJwsRs256(
        {
          productId,
          productVersion,
          softwareValidationNumber: validationNumber,
        },
        softwarePem
      )
    : null;

  const submissionUUID = crypto.randomUUID();
  const submissionTimeStamp = new Date().toISOString();

  let docEntry: Record<string, unknown>;
  let readinessWarnings: string[] = [];

  if (kind === 'SALE') {
    const s = doc as Sale;
    readinessWarnings = s.type === 'RECIBO' ? [] : getDocumentReadinessWarnings(settings, s.items);
    const agtType = toAgtDocTypeCode(s.type);
    const netTotal = roundMoney(s.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0));
    const taxPayable = roundMoney(s.taxTotal ?? s.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0));
    const grossTotal = roundMoney(netTotal + taxPayable);

    const baseDocPayload: Record<string, unknown> = {
      documentNo: s.documentNumber,
      documentStatus: s.status === 'ANULADA' ? 'A' : 'N',
      documentDate: s.date,
      documentType: agtType,
      eacCode: settings.establishmentCode || 'EST-01',
      systemEntryDate: s.issuedAt || s.createdAt,
      customerCountry: 'AO',
      customerTaxID: s.isCommonConsumer ? '999999999' : s.customerNif || '999999999',
      companyName: s.customerName || 'Consumidor Final',
      lines: s.items.map((item, idx) => {
        const rawDisc = roundMoney((item.quantity * item.unitPrice * (item.discountPercent || 0)) / 100);
        const rateNum = Number(item.taxRate ?? 0);
        const lineIncludesTax =
          item.priceIncludesTax !== undefined ? Boolean(item.priceIncludesTax) : Boolean(settings.pricesIncludeTax);
        const settlementBase =
          lineIncludesTax && rateNum > 0
            ? roundMoney(rawDisc / (1 + rateNum / 100))
            : rawDisc;
        const taxContribution = roundMoney(item.taxAmount ?? 0);
        return {
          lineNumber: idx + 1,
          productCode: item.productCode,
          productDescription: item.productName,
          quantity: item.quantity,
          unitOfMeasure: item.unit || 'Unidade',
          unitPrice: item.unitPrice,
          unitPriceBase: roundMoney((item.taxableBase ?? item.subtotal) / Math.max(1, item.quantity)),
          creditAmount: roundMoney(item.taxableBase ?? item.subtotal),
          taxes: [
            {
              taxType: item.taxType || 'IVA',
              taxCountryRegion: 'AO',
              taxCode: item.taxCode || 'NAO_CONFIGURADO',
              taxPercentage: item.taxRate ?? null,
              taxContribution,
              ...(item.taxCode === 'ISE' || (item.taxCode === 'OUT' && rateNum === 0)
                ? {
                    ...(item.taxExemptionCode ? { taxExemptionCode: item.taxExemptionCode } : {}),
                    ...(item.taxExemptionReason ? { taxExemptionReason: item.taxExemptionReason } : {}),
                  }
                : {}),
            },
          ],
          settlementAmount: settlementBase,
        };
      }),
      documentTotals: {
        taxPayable,
        netTotal,
        grossTotal,
        currency: {
          currencyCode: 'AOA',
          currencyAmount: grossTotal,
          exchangeRate: 1,
        },
      },
      ...(s.relatedInvoiceNumber
        ? {
            sourceDocuments: [
              {
                originatingON: s.relatedInvoiceNumber,
              },
            ],
          }
        : {}),
    };

    const jwsDocumentSignature = taxpayerPem
      ? signJwsRs256(
          {
            documentNo: s.documentNumber,
            taxRegistrationNumber: settings.nif,
            documentType: agtType,
            documentDate: s.date,
            customerTaxID: baseDocPayload.customerTaxID,
            grossTotal,
          },
          taxpayerPem
        )
      : null;

    docEntry = {
      ...baseDocPayload,
      jwsDocumentSignature,
    };
  } else {
    const r = doc as SaleReturn;
    readinessWarnings = getDocumentReadinessWarnings(settings, r.items);
    const netTotal = roundMoney(r.items.reduce((acc, it) => acc + (it.taxableBase ?? it.refundAmount), 0));
    const taxPayable = roundMoney(r.taxTotal ?? r.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0));
    const grossTotal = roundMoney(netTotal + taxPayable);

    const baseDocPayload: Record<string, unknown> = {
      documentNo: r.documentNumber,
      documentStatus: 'N',
      documentDate: r.date,
      documentType: 'NC',
      rejectedDocumentNo: r.type === 'ANULACAO' ? r.originalDocumentNumber : undefined,
      documentCancelReason: r.reason,
      rectificationNature: r.rectificationNature || (r.type === 'ANULACAO' ? 'ANULACAO' : 'RECTIFICACAO'),
      buyerAcknowledgement: r.buyerAcknowledgement || { confirmed: false },
      systemEntryDate: r.createdAt,
      customerCountry: 'AO',
      customerTaxID: r.customerNif || '999999999',
      companyName: r.customerName || 'Consumidor Final',
      lines: r.items.map((item, idx) => {
        const rateNum = Number(item.taxRate ?? 0);
        const taxContribution = roundMoney(item.taxAmount ?? 0);
        return {
          lineNumber: idx + 1,
          productCode: item.productCode,
          productDescription: item.productName,
          quantity: item.quantity,
          unitOfMeasure: 'Unidade',
          unitPrice: item.unitPrice,
          debitAmount: roundMoney(item.taxableBase ?? item.refundAmount),
          references: [
            {
              reference: r.originalDocumentNumber,
              reason: r.reason,
            },
          ],
          taxes: [
            {
              taxType: 'IVA',
              taxCountryRegion: 'AO',
              taxCode: item.taxCode || 'NAO_CONFIGURADO',
              taxPercentage: item.taxRate ?? null,
              taxContribution,
              ...(item.taxCode === 'ISE' || (item.taxCode === 'OUT' && rateNum === 0)
                ? {
                    ...(item.taxExemptionCode ? { taxExemptionCode: item.taxExemptionCode } : {}),
                    ...(item.taxExemptionReason ? { taxExemptionReason: item.taxExemptionReason } : {}),
                  }
                : {}),
            },
          ],
        };
      }),
      documentTotals: {
        taxPayable,
        netTotal,
        grossTotal,
        currency: {
          currencyCode: 'AOA',
          currencyAmount: grossTotal,
          exchangeRate: 1,
        },
      },
    };

    const jwsDocumentSignature = taxpayerPem
      ? signJwsRs256(
          {
            documentNo: r.documentNumber,
            taxRegistrationNumber: settings.nif,
            documentType: 'NC',
            documentDate: r.date,
            rejectedDocumentNo: r.originalDocumentNumber,
            grossTotal,
          },
          taxpayerPem
        )
      : null;

    docEntry = {
      ...baseDocPayload,
      jwsDocumentSignature,
    };
  }

  const localValidation = validateAgtDocumentLocally(settings, doc, kind, docEntry);

  return {
    schemaVersion: '2.0',
    submissionUUID,
    taxRegistrationNumber: settings.nif,
    submissionTimeStamp,
    softwareInfo: {
      softwareInfoDetail,
      jwsSoftwareSignature,
    },
    numberOfEntries: 1,
    documents: [docEntry],
    readinessWarnings,
    localValidation,
    agtStatus,
  };
}

export function validateAgtDocumentLocally(
  settings: PharmacySettings,
  doc: Sale | SaleReturn,
  kind: 'SALE' | 'RETURN',
  docEntry?: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!settings.legalName?.trim()) errors.push('Denominação legal do emissor em falta.');
  if (!settings.nif?.trim()) errors.push('NIF do emissor em falta.');
  if (!settings.address?.trim()) errors.push('Morada fiscal do emissor em falta.');
  if (!settings.vatRegime || settings.vatRegime === 'NAO_CONFIGURADO') {
    errors.push('Regime de IVA da farmácia está NAO_CONFIGURADO.');
  }
  if (!doc.documentNumber?.trim()) errors.push('Número de documento (documentNo) em falta.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.date || ''))) {
    errors.push('Data do documento inválida (esperado YYYY-MM-DD).');
  }

  if (kind === 'SALE') {
    const s = doc as Sale;
    if (s.type === 'PROFORMA') {
      errors.push('Proforma (PF) é documento não fiscal e não deve ser submetida como fatura fiscal à AGT.');
    }
    const agtType = toAgtDocTypeCode(s.type);
    if (!['FT', 'FR', 'RC'].includes(agtType)) {
      errors.push(`Tipo de documento fiscal AGT inválido: ${agtType}`);
    }
    if (!s.isCommonConsumer && !s.customerNif?.trim()) {
      errors.push('NIF do adquirente obrigatório para cliente identificado.');
    }
    if (s.type === 'RECIBO') {
      if (!s.relatedInvoiceNumber?.trim()) {
        errors.push('Recibo (RC) sem referência à fatura original (originatingON).');
      }
      if (Number(s.totalAmount || 0) <= 0) {
        errors.push('Recibo (RC) exige valor liquidado positivo.');
      }
    } else {
      if (!Array.isArray(s.items) || s.items.length === 0) {
        errors.push('Documento sem linhas de produto.');
      }
      for (const it of s.items) {
        if (!it.taxCode || it.taxCode === 'NAO_CONFIGURADO') {
          errors.push(`Linha "${it.productName}" com TaxCode NAO_CONFIGURADO.`);
        } else if (it.taxCode === 'ISE' && (!it.taxExemptionCode?.trim() || !it.taxExemptionReason?.trim())) {
          errors.push(`Linha "${it.productName}" (ISE) sem código ou motivo de isenção.`);
        } else if (it.taxCode === 'OUT' && Number(it.taxRate ?? 0) === 0 && !it.taxExemptionReason?.trim()) {
          errors.push(`Linha "${it.productName}" (OUT 0%) sem menção legal.`);
        } else if (
          (it.taxCode === 'NOR' || it.taxCode === 'INT' || it.taxCode === 'RED') &&
          Number(it.taxRate ?? 0) <= 0
        ) {
          errors.push(`Linha "${it.productName}" (${it.taxCode}) com taxa inválida (${it.taxRate ?? 0}%).`);
        }
      }
    }
  } else {
    const r = doc as SaleReturn;
    if (!r.originalDocumentNumber?.trim()) {
      errors.push('Nota de Crédito (NC) sem referência ao documento original.');
    }
    if (!r.reason?.trim()) {
      errors.push('Nota de Crédito (NC) sem motivo de rectificação/anulação.');
    }
    for (const it of r.items) {
      if (!it.taxCode || it.taxCode === 'NAO_CONFIGURADO') {
        errors.push(`Linha NC "${it.productName}" com TaxCode NAO_CONFIGURADO.`);
      } else if (it.taxCode === 'ISE' && (!it.taxExemptionCode?.trim() || !it.taxExemptionReason?.trim())) {
        errors.push(`Linha NC "${it.productName}" (ISE) sem código ou motivo de isenção.`);
      } else if (it.taxCode === 'OUT' && Number(it.taxRate ?? 0) === 0 && !it.taxExemptionReason?.trim()) {
        errors.push(`Linha NC "${it.productName}" (OUT 0%) sem menção legal.`);
      }
    }
  }

  if (docEntry && (docEntry as any).documentTotals) {
    const totals = (docEntry as any).documentTotals;
    const netTotal = roundMoney(Number(totals.netTotal || 0));
    const taxPayable = roundMoney(Number(totals.taxPayable || 0));
    const grossTotal = roundMoney(Number(totals.grossTotal || 0));
    if (Math.abs(roundMoney(netTotal + taxPayable) - grossTotal) > 0.01) {
      errors.push(
        `Inconsistência nos totais do payload AGT: netTotal (${netTotal}) + taxPayable (${taxPayable}) != grossTotal (${grossTotal}).`
      );
    }
    const lineTaxSum = roundMoney(
      Array.isArray((docEntry as any).lines)
        ? (docEntry as any).lines.reduce(
            (acc: number, l: any) =>
              acc +
              (Array.isArray(l.taxes)
                ? l.taxes.reduce((tAcc: number, t: any) => tAcc + Number(t.taxContribution || 0), 0)
                : 0),
            0
          )
        : 0
    );
    if ((kind === 'RETURN' || (doc as Sale).type !== 'RECIBO') && Math.abs(lineTaxSum - taxPayable) > 0.02) {
      errors.push(`Soma do IVA das linhas (${lineTaxSum}) diverge de taxPayable (${taxPayable}).`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function extractAgtArtifacts(parsed: Record<string, unknown>): {
  rejectionReason?: string;
  qrCode?: string;
  hash?: string;
  signature?: string;
  documentNo?: string;
} {
  const errArray = Array.isArray((parsed as any).errors)
    ? (parsed as any).errors
    : Array.isArray((parsed as any).errorList)
    ? (parsed as any).errorList
    : [];
  const errTexts = errArray
    .map((e: any) =>
      typeof e === 'string'
        ? e
        : [e?.code || e?.idError, e?.description || e?.message || e?.errorDescription]
            .filter(Boolean)
            .join(': ')
    )
    .filter(Boolean);
  const directErr =
    typeof (parsed as any).rejectionReason === 'string'
      ? (parsed as any).rejectionReason
      : typeof (parsed as any).errorDescription === 'string'
      ? (parsed as any).errorDescription
      : typeof (parsed as any).message === 'string'
      ? (parsed as any).message
      : '';
  const rejectionReason = [...errTexts, ...(errTexts.length === 0 && directErr ? [directErr] : [])]
    .join(' | ')
    .trim();

  const firstDoc =
    Array.isArray((parsed as any).documents) && (parsed as any).documents[0]
      ? ((parsed as any).documents[0] as Record<string, unknown>)
      : parsed;

  const qrCode =
    typeof (firstDoc as any).qrCode === 'string'
      ? String((firstDoc as any).qrCode).trim()
      : typeof (parsed as any).qrCode === 'string'
      ? String((parsed as any).qrCode).trim()
      : '';
  const hash =
    typeof (firstDoc as any).hash === 'string'
      ? String((firstDoc as any).hash).trim()
      : typeof (parsed as any).hash === 'string'
      ? String((parsed as any).hash).trim()
      : '';
  const signature =
    typeof (firstDoc as any).jwsDocumentSignature === 'string'
      ? String((firstDoc as any).jwsDocumentSignature).trim()
      : typeof (parsed as any).signature === 'string'
      ? String((parsed as any).signature).trim()
      : '';
  const documentNo =
    typeof (firstDoc as any).documentNo === 'string'
      ? String((firstDoc as any).documentNo).trim()
      : typeof (parsed as any).documentNo === 'string'
      ? String((parsed as any).documentNo).trim()
      : '';

  return {
    ...(rejectionReason ? { rejectionReason } : {}),
    ...(qrCode ? { qrCode } : {}),
    ...(hash ? { hash } : {}),
    ...(signature ? { signature } : {}),
    ...(documentNo ? { documentNo } : {}),
  };
}

function assertSafeAgtUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new HttpError(400, 'AGT_API_BASE_URL inválida.');
  }
  if (parsed.protocol !== 'https:') {
    throw new HttpError(400, 'A comunicação com a AGT exige ligação segura HTTPS (TLS >= 1.2).');
  }
  const host = parsed.hostname.toLowerCase();
  const isOfficialAgt = host === 'sifphml.minfin.gov.ao' || host === 'sifp.minfin.gov.ao';
  const envRaw = (process.env.AGT_ENV || '').trim().toUpperCase();
  const isHmlTestLocal =
    (envRaw === 'HOMOLOGACAO' || envRaw === 'HML') &&
    process.env.AGT_ALLOW_TEST_ENDPOINT === 'true' &&
    (host === '127.0.0.1' || host === 'localhost');
  if (!isOfficialAgt && !isHmlTestLocal) {
    throw new HttpError(400, 'Anfitrião AGT não autorizado. Utilize apenas os endpoints oficiais da AGT (sifphml.minfin.gov.ao / sifp.minfin.gov.ao).');
  }
  return parsed;
}

export async function submitToAgtEndpoint(
  settings: PharmacySettings,
  doc: Sale | SaleReturn,
  kind: 'SALE' | 'RETURN'
): Promise<{
  ok: boolean;
  validationStatus: FiscalValidationStatus;
  event: AgtSubmissionEvent;
  requestId?: string;
  rejectionReason?: string;
  qrCode?: string;
  hash?: string;
  signature?: string;
  documentNo?: string;
}> {
  const payload = buildAgtFeSubmissionPayload(settings, doc, kind);
  const nowIso = new Date().toISOString();

  if (!payload.localValidation.valid) {
    const msg = `Validação local AGT FE Schema 2.0 falhou: ${payload.localValidation.errors.join(' ')}`;
    return {
      ok: false,
      validationStatus: 'RASCUNHO_NAO_VALIDADO',
      rejectionReason: msg,
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'ERRO_AGT',
        validationStatus: 'RASCUNHO_NAO_VALIDADO',
        message: msg,
        payloadSummary: {
          localValidationErrors: payload.localValidation.errors,
        },
      },
    };
  }

  if (!payload.agtStatus.configured) {
    const msg =
      'Envio para a AGT não executado: credenciais/chaves/número de validação da AGT não configurados no servidor. Documento mantido como Rascunho Interno.';
    return {
      ok: false,
      validationStatus: 'RASCUNHO_NAO_VALIDADO',
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'MODO_RASCUNHO',
        validationStatus: 'RASCUNHO_NAO_VALIDADO',
        message: msg,
        payloadSummary: {
          schemaVersion: payload.schemaVersion,
          documentNo: doc.documentNumber,
          missingRequirements: payload.agtStatus.missingRequirements,
        },
      },
    };
  }

  if (payload.readinessWarnings.length > 0) {
    const msg = `Envio bloqueado por falta de dados fiscais obrigatórios: ${payload.readinessWarnings.join(' ')}`;
    return {
      ok: false,
      validationStatus: 'RASCUNHO_NAO_VALIDADO',
      rejectionReason: msg,
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'ERRO_AGT',
        validationStatus: 'RASCUNHO_NAO_VALIDADO',
        message: msg,
      },
    };
  }

  const baseUrl = assertSafeAgtUrl(payload.agtStatus.baseUrl);
  const endpoint = `${baseUrl.toString().replace(/\/+$/, '')}/registarFactura`;
  const username = (process.env.AGT_API_USERNAME || '').trim();
  const password = (process.env.AGT_API_PASSWORD || '').trim();
  const basicToken = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');

  const { readinessWarnings: _w, localValidation: _lv, agtStatus: _st, ...wirePayload } = payload;

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${basicToken}`,
      },
      body: JSON.stringify(wirePayload),
      signal: AbortSignal.timeout(15000),
    });

    const respText = await resp.text();
    let parsedResp: Record<string, unknown> = {};
    try {
      parsedResp = JSON.parse(respText);
    } catch {
      parsedResp = { raw: respText.slice(0, 500) };
    }

    const requestId =
      typeof parsedResp.requestID === 'string'
        ? parsedResp.requestID
        : typeof parsedResp.requestId === 'string'
        ? parsedResp.requestId
        : payload.submissionUUID;

    const artifacts = extractAgtArtifacts(parsedResp);

    if (!resp.ok) {
      return {
        ok: false,
        validationStatus: 'REJEITADO_AGT',
        requestId,
        rejectionReason: artifacts.rejectionReason || `HTTP ${resp.status}`,
        event: {
          id: `agt_${crypto.randomUUID().slice(0, 8)}`,
          timestamp: nowIso,
          action: 'ERRO_AGT',
          requestId,
          statusCode: resp.status,
          validationStatus: 'REJEITADO_AGT',
          message: `AGT respondeu com HTTP ${resp.status}${artifacts.rejectionReason ? `: ${artifacts.rejectionReason}` : '.'}`,
          responseSummary: parsedResp,
        },
      };
    }

    return {
      ok: true,
      validationStatus: 'PENDENTE_AGT',
      requestId,
      ...(artifacts.qrCode ? { qrCode: artifacts.qrCode } : {}),
      ...(artifacts.hash ? { hash: artifacts.hash } : {}),
      ...(artifacts.signature ? { signature: artifacts.signature } : {}),
      ...(artifacts.documentNo ? { documentNo: artifacts.documentNo } : {}),
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'ENVIO_AGT',
        requestId,
        statusCode: resp.status,
        validationStatus: 'PENDENTE_AGT',
        message: `Submetido à AGT (requestID: ${requestId}). Aguarda confirmação de estado.`,
        responseSummary: parsedResp,
      },
    };
  } catch (err: any) {
    const errMsg = `Falha de comunicação com o servidor AGT: ${err?.message || 'Erro de rede'}`;
    return {
      ok: false,
      validationStatus: 'PENDENTE_AGT',
      rejectionReason: errMsg,
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'ERRO_AGT',
        validationStatus: 'REJEITADO_AGT',
        message: errMsg,
      },
    };
  }
}

export async function pollAgtDocumentStatus(
  settings: PharmacySettings,
  requestId: string
): Promise<{
  ok: boolean;
  validationStatus: FiscalValidationStatus;
  event: AgtSubmissionEvent;
  rejectionReason?: string;
  qrCode?: string;
  hash?: string;
  signature?: string;
  documentNo?: string;
}> {
  const agtStatus = getAgtConfigStatus();
  const nowIso = new Date().toISOString();
  if (!agtStatus.configured) {
    return {
      ok: false,
      validationStatus: 'RASCUNHO_NAO_VALIDADO',
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'MODO_RASCUNHO',
        validationStatus: 'RASCUNHO_NAO_VALIDADO',
        message: 'Integração AGT não configurada no servidor.',
      },
    };
  }
  const baseUrl = assertSafeAgtUrl(agtStatus.baseUrl);
  const endpoint = `${baseUrl.toString().replace(/\/+$/, '')}/obterEstado`;
  const username = (process.env.AGT_API_USERNAME || '').trim();
  const password = (process.env.AGT_API_PASSWORD || '').trim();
  const basicToken = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');

  const body = {
    schemaVersion: '2.0',
    submissionUUID: crypto.randomUUID(),
    taxRegistrationNumber: settings.nif,
    submissionTimeStamp: nowIso,
    requestID: requestId,
  };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${basicToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }

    const resultCode = String((parsed as any).resultCode ?? (parsed as any).documentStatus ?? '').toUpperCase();
    const isValid = resp.ok && (resultCode === 'V' || resultCode === 'VALIDO' || resultCode === 'VALIDADO');
    const isRejected = !resp.ok || resultCode === 'I' || resultCode === 'INVALIDO' || resultCode === 'REJEITADO';
    const validationStatus: FiscalValidationStatus = isValid
      ? 'VALIDADO_AGT'
      : isRejected
      ? 'REJEITADO_AGT'
      : 'PENDENTE_AGT';
    const artifacts = extractAgtArtifacts(parsed);

    return {
      ok: resp.ok,
      validationStatus,
      ...(isRejected ? { rejectionReason: artifacts.rejectionReason || `Estado AGT: ${resultCode || resp.status}` } : {}),
      ...(artifacts.qrCode ? { qrCode: artifacts.qrCode } : {}),
      ...(artifacts.hash ? { hash: artifacts.hash } : {}),
      ...(artifacts.signature ? { signature: artifacts.signature } : {}),
      ...(artifacts.documentNo ? { documentNo: artifacts.documentNo } : {}),
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'CONSULTA_ESTADO',
        requestId,
        statusCode: resp.status,
        validationStatus,
        message: `Estado devolvido pela AGT: ${validationStatus}${isRejected && artifacts.rejectionReason ? ` (${artifacts.rejectionReason})` : ''}.`,
        responseSummary: parsed,
      },
    };
  } catch (err: any) {
    return {
      ok: false,
      validationStatus: 'PENDENTE_AGT',
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'ERRO_AGT',
        requestId,
        validationStatus: 'PENDENTE_AGT',
        message: `Erro ao consultar estado na AGT: ${err?.message || 'Erro de rede'}`,
      },
    };
  }
}

export async function consultAgtInvoice(
  settings: PharmacySettings,
  documentNo: string
): Promise<{
  ok: boolean;
  validationStatus: FiscalValidationStatus;
  event: AgtSubmissionEvent;
  response?: Record<string, unknown>;
  rejectionReason?: string;
  qrCode?: string;
  hash?: string;
  signature?: string;
}> {
  const agtStatus = getAgtConfigStatus();
  const nowIso = new Date().toISOString();
  if (!agtStatus.configured) {
    return {
      ok: false,
      validationStatus: 'RASCUNHO_NAO_VALIDADO',
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'MODO_RASCUNHO',
        validationStatus: 'RASCUNHO_NAO_VALIDADO',
        message: 'Integração AGT não configurada no servidor para executar consultarFactura.',
      },
    };
  }
  const baseUrl = assertSafeAgtUrl(agtStatus.baseUrl);
  const endpoint = `${baseUrl.toString().replace(/\/+$/, '')}/consultarFactura`;
  const username = (process.env.AGT_API_USERNAME || '').trim();
  const password = (process.env.AGT_API_PASSWORD || '').trim();
  const basicToken = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const taxpayerPem = readPemFromEnv('AGT_PRIVATE_KEY_PEM');
  const jwsDocumentSignature = taxpayerPem
    ? signJwsRs256(
        {
          taxRegistrationNumber: settings.nif,
          documentNo,
        },
        taxpayerPem
      )
    : null;

  const body = {
    schemaVersion: '2.0',
    submissionUUID: crypto.randomUUID(),
    taxRegistrationNumber: settings.nif,
    submissionTimeStamp: nowIso,
    documentNo,
    ...(jwsDocumentSignature ? { jwsSignature: jwsDocumentSignature } : {}),
  };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${basicToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }

    const docStatusRaw = String((parsed as any).documentStatus ?? (parsed as any).resultCode ?? '').toUpperCase();
    const isRejected = !resp.ok || docStatusRaw === 'I' || docStatusRaw === 'INVALIDO' || docStatusRaw === 'REJEITADO';
    const isValid = resp.ok && (docStatusRaw === 'V' || docStatusRaw === 'N' || docStatusRaw === 'VALIDO' || docStatusRaw === 'VALIDADO');
    const validationStatus: FiscalValidationStatus = isValid
      ? 'VALIDADO_AGT'
      : isRejected
      ? 'REJEITADO_AGT'
      : 'PENDENTE_AGT';
    const artifacts = extractAgtArtifacts(parsed);

    return {
      ok: resp.ok,
      validationStatus,
      response: parsed,
      ...(isRejected ? { rejectionReason: artifacts.rejectionReason || `Estado AGT: ${docStatusRaw || resp.status}` } : {}),
      ...(artifacts.qrCode ? { qrCode: artifacts.qrCode } : {}),
      ...(artifacts.hash ? { hash: artifacts.hash } : {}),
      ...(artifacts.signature ? { signature: artifacts.signature } : {}),
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'CONSULTA_ESTADO',
        statusCode: resp.status,
        validationStatus,
        message: resp.ok
          ? `Consulta consultarFactura (${documentNo}) respondida com HTTP ${resp.status}.`
          : `consultarFactura respondeu com HTTP ${resp.status}.`,
        responseSummary: parsed,
      },
    };
  } catch (err: any) {
    return {
      ok: false,
      validationStatus: 'PENDENTE_AGT',
      event: {
        id: `agt_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: nowIso,
        action: 'ERRO_AGT',
        validationStatus: 'PENDENTE_AGT',
        message: `Erro ao executar consultarFactura na AGT: ${err?.message || 'Erro de rede'}`,
      },
    };
  }
}

export async function requestAgtSeries(
  settings: PharmacySettings,
  input: {
    seriesYear?: number;
    documentType: string;
    establishmentNumber?: string;
    seriesContingencyIndicator?: string;
  }
): Promise<{
  ok: boolean;
  message: string;
  series?: {
    seriesCode: string;
    seriesYear: number;
    documentType: 'FT' | 'FR' | 'NC' | 'ND' | 'RC';
    establishmentNumber: string;
    seriesContingencyIndicator: 'N' | 'C';
    firstDocumentNumber?: number;
    lastDocumentNumber?: number;
    status?: string;
    environment: 'HOMOLOGACAO' | 'PRODUCAO';
    requestedAt: string;
    requestID?: string;
    source: 'AGT_HOMOLOGACAO' | 'AGT_OFICIAL';
  };
  responseSummary?: Record<string, unknown>;
}> {
  const allowedDocTypes = ['FT', 'FR', 'NC', 'ND', 'RC'] as const;
  const docType = String(input.documentType || '').trim().toUpperCase();
  if (!allowedDocTypes.includes(docType as any)) {
    throw new HttpError(
      400,
      `Tipo de documento "${docType || 'vazio'}" não aceite pela AGT em solicitarSerie. Tipos fiscais válidos: FT, FR, NC, ND, RC ("AN" e "PF" não são séries fiscais AGT).`
    );
  }

  const seriesYear = Number(input.seriesYear) || new Date().getFullYear();
  const establishmentNumber = String(input.establishmentNumber || settings.establishmentCode || 'EST-01').trim();
  const contingency = String(input.seriesContingencyIndicator || 'N').trim().toUpperCase() === 'C' ? 'C' : 'N';
  const agtStatus = getAgtConfigStatus();
  const nowIso = new Date().toISOString();

  if (!agtStatus.configured || agtStatus.environment === 'NAO_CONFIGURADO') {
    return {
      ok: false,
      message:
        'Pedido solicitarSerie não enviado: credenciais, chaves RS256 e número de validação AGT não configurados no servidor. As séries locais atuais permanecem como Numeração Interna (Não Oficial).',
    };
  }

  const baseUrl = assertSafeAgtUrl(agtStatus.baseUrl);
  const endpoint = `${baseUrl.toString().replace(/\/+$/, '')}/solicitarSerie`;
  const username = (process.env.AGT_API_USERNAME || '').trim();
  const password = (process.env.AGT_API_PASSWORD || '').trim();
  const basicToken = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const taxpayerPem = readPemFromEnv('AGT_PRIVATE_KEY_PEM');
  const jwsSignature = taxpayerPem
    ? signJwsRs256(
        {
          taxRegistrationNumber: settings.nif,
          seriesYear,
          documentType: docType,
          establishmentNumber,
          seriesContingencyIndicator: contingency,
        },
        taxpayerPem
      )
    : null;

  const body = {
    schemaVersion: '2.0',
    submissionUUID: crypto.randomUUID(),
    taxRegistrationNumber: settings.nif,
    submissionTimeStamp: nowIso,
    seriesInfo: {
      seriesYear,
      documentType: docType,
      establishmentNumber,
      seriesContingencyIndicator: contingency,
    },
    ...(jwsSignature ? { jwsSignature } : {}),
  };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${basicToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }

    if (!resp.ok) {
      return {
        ok: false,
        message: `AGT respondeu ao solicitarSerie com HTTP ${resp.status}.`,
        responseSummary: parsed,
      };
    }

    const seriesInfoObj = ((parsed as any).seriesInfo || parsed) as Record<string, unknown>;
    const seriesCode = String(seriesInfoObj.seriesCode || seriesInfoObj.serie || '').trim();
    if (!seriesCode) {
      return {
        ok: false,
        message: 'AGT respondeu sem seriesCode atribuído. Verifique a resposta técnica.',
        responseSummary: parsed,
      };
    }

    const envMode: 'HOMOLOGACAO' | 'PRODUCAO' =
      agtStatus.environment === 'PRODUCAO' ? 'PRODUCAO' : 'HOMOLOGACAO';
    return {
      ok: true,
      message: `Série ${seriesCode} atribuída pelo ambiente ${envMode} da AGT.`,
      responseSummary: parsed,
      series: {
        seriesCode,
        seriesYear,
        documentType: docType as 'FT' | 'FR' | 'NC' | 'ND' | 'RC',
        establishmentNumber,
        seriesContingencyIndicator: contingency,
        ...(seriesInfoObj.firstDocumentNumber !== undefined
          ? { firstDocumentNumber: Number(seriesInfoObj.firstDocumentNumber) }
          : {}),
        ...(seriesInfoObj.lastDocumentNumber !== undefined
          ? { lastDocumentNumber: Number(seriesInfoObj.lastDocumentNumber) }
          : {}),
        status: String(seriesInfoObj.seriesStatus || seriesInfoObj.status || 'A'),
        environment: envMode,
        requestedAt: nowIso,
        requestID: String((parsed as any).requestID || (parsed as any).requestId || body.submissionUUID),
        source: envMode === 'PRODUCAO' ? 'AGT_OFICIAL' : 'AGT_HOMOLOGACAO',
      },
    };
  } catch (err: any) {
    return {
      ok: false,
      message: `Erro de rede ao contactar /solicitarSerie na AGT: ${err?.message || 'Erro desconhecido'}`,
    };
  }
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateSaftAoXml(
  db: DatabaseSchema,
  startDate: string,
  endDate: string
): {
  xml: string;
  filename: string;
  readinessWarnings: string[];
  summary: {
    invoicesAndCreditNotesCount: number;
    workingDocumentsCount: number;
    paymentsCount: number;
    totalCredit: number;
    totalDebit: number;
    certified: boolean;
    saftCompliant: boolean;
    structureValid: boolean;
    structureErrors: string[];
    blockingIssues: string[];
  };
} {
  const settings = db.settings;
  const agtStatus = getAgtConfigStatus();
  const readinessWarnings: string[] = [];
  const blockingIssues: string[] = [];

  if (!agtStatus.certified) {
    const msg =
      'Software NÃO certificado pela AGT (sem número de validação AGT nem assinatura Hash RSA oficial). Ficheiro gerado apenas para preparação/revisão contabilística.';
    readinessWarnings.push(msg);
    blockingIssues.push(msg);
  }
  if (!settings.vatRegime || settings.vatRegime === 'NAO_CONFIGURADO') {
    const msg = 'Regime fiscal de IVA da farmácia está NAO_CONFIGURADO.';
    readinessWarnings.push(msg);
    blockingIssues.push(msg);
  }

  const periodSales = db.sales.filter((s) => s.date >= startDate && s.date <= endDate);
  const invoices = periodSales.filter((s) => isInvoiceSaleType(s.type));
  const proformas = periodSales.filter((s) => s.type === 'PROFORMA');
  const payments = periodSales.filter((s) => s.type === 'RECIBO');
  const periodReturns = db.returns.filter((r) => r.date >= startDate && r.date <= endDate);

  const fiscalYear = startDate.slice(0, 4) || String(new Date().getFullYear());
  const dateCreated = new Date().toISOString().slice(0, 10);
  const validationNumber = (process.env.AGT_SOFTWARE_VALIDATION_NUMBER || '').trim() || '0';
  const productId = (process.env.AGT_SOFTWARE_PRODUCT_ID || 'AncoraSMS').trim();
  const productVersion = (process.env.AGT_SOFTWARE_PRODUCT_VERSION || '1.0.0').trim();

  // Check missing tax treatments across period items
  const allPeriodItems: Array<{ taxCode?: TaxCode; productName?: string }> = [
    ...invoices.flatMap((s) => s.items),
    ...periodReturns.flatMap((r) => r.items),
  ];
  const unconfiguredLines = allPeriodItems.filter((i) => !i.taxCode || i.taxCode === 'NAO_CONFIGURADO').length;
  if (unconfiguredLines > 0) {
    const msg = `${unconfiguredLines} linha(s) de documentos históricos neste período têm tratamento fiscal "NAO_CONFIGURADO" (exportadas como OUT 0% na pré-visualização, mas bloqueiam conformidade SAF-T oficial até revisão contabilística).`;
    readinessWarnings.push(msg);
    blockingIssues.push(msg);
  }
  const legacyAnDocs = periodReturns.filter((r) => r.documentNumber.startsWith('AN '));
  if (legacyAnDocs.length > 0) {
    blockingIssues.push(`${legacyAnDocs.length} documento(s) de anulação possuem numeração histórica "AN" (devem constar como Nota de Crédito NC).`);
  }

  // Distinct tax table entries from rules + products + period documents
  const taxEntriesMap = new Map<
    string,
    { taxCode: string; percentage: number; description: string; expirationDate?: string }
  >();
  for (const rule of settings.taxRules || []) {
    const pct = rule.taxCode === 'ISE' ? 0 : Number(rule.rate ?? 0);
    const key = `${rule.taxCode}|${pct}`;
    if (!taxEntriesMap.has(key)) {
      taxEntriesMap.set(key, {
        taxCode: rule.taxCode,
        percentage: pct,
        description: rule.description || rule.legalBasis || rule.taxCode,
        ...(rule.validTo ? { expirationDate: rule.validTo } : {}),
      });
    }
  }
  for (const p of db.products) {
    if (p.taxCode && p.taxCode !== 'NAO_CONFIGURADO') {
      const pct = p.taxCode === 'ISE' ? 0 : Number(p.taxRate ?? 0);
      const key = `${p.taxCode}|${pct}`;
      if (!taxEntriesMap.has(key)) {
        taxEntriesMap.set(key, {
          taxCode: p.taxCode,
          percentage: pct,
          description:
            p.taxCode === 'ISE'
              ? p.taxExemptionReason || 'Isento'
              : p.taxCode === 'NOR'
              ? 'Taxa Normal'
              : p.taxCode === 'INT'
              ? 'Taxa Intermédia'
              : p.taxCode === 'RED'
              ? 'Taxa Reduzida'
              : 'Outros',
        });
      }
    }
  }
  for (const it of allPeriodItems) {
    const resolvedCode = !it.taxCode || it.taxCode === 'NAO_CONFIGURADO' ? 'OUT' : it.taxCode;
    const pct = resolvedCode === 'ISE' ? 0 : Number((it as any).taxRate ?? 0);
    const key = `${resolvedCode}|${pct}`;
    if (!taxEntriesMap.has(key)) {
      taxEntriesMap.set(key, {
        taxCode: resolvedCode,
        percentage: pct,
        description:
          resolvedCode === 'ISE'
            ? 'Isento'
            : resolvedCode === 'INT'
            ? 'Taxa Intermédia'
            : resolvedCode === 'OUT' && pct === 0
            ? 'Outros / Sem liquidação de IVA'
            : `IVA ${pct}%`,
      });
    }
  }

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  if (!agtStatus.certified) {
    lines.push(
      '<!-- EXPORTACAO PREPARATORIA SAF-T (AO) 1.01_01 - SOFTWARE NAO CERTIFICADO PELA AGT - NAO SUBMETER COMO FICHEIRO CERTIFICADO -->'
    );
  }
  lines.push(
    '<AuditFile xmlns="urn:OECD:StandardAuditFile-Tax:AO_1.01_01" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  );

  // Header
  lines.push('  <Header>');
  lines.push('    <AuditFileVersion>1.01_01</AuditFileVersion>');
  lines.push(`    <CompanyID>${escapeXml(settings.nif || '999999999')}</CompanyID>`);
  lines.push(`    <TaxRegistrationNumber>${escapeXml(settings.nif || '999999999')}</TaxRegistrationNumber>`);
  lines.push('    <TaxAccountingBasis>F</TaxAccountingBasis>');
  lines.push(`    <CompanyName>${escapeXml(settings.legalName || settings.pharmacyName)}</CompanyName>`);
  lines.push(`    <BusinessName>${escapeXml(settings.establishmentName || settings.pharmacyName)}</BusinessName>`);
  lines.push('    <CompanyAddress>');
  lines.push(`      <AddressDetail>${escapeXml(settings.address || 'Não registado')}</AddressDetail>`);
  lines.push(`      <City>${escapeXml(settings.city || 'Luanda')}</City>`);
  lines.push(`      <Country>${escapeXml(settings.country || 'AO')}</Country>`);
  lines.push('    </CompanyAddress>');
  lines.push(`    <FiscalYear>${escapeXml(fiscalYear)}</FiscalYear>`);
  lines.push(`    <StartDate>${escapeXml(startDate)}</StartDate>`);
  lines.push(`    <EndDate>${escapeXml(endDate)}</EndDate>`);
  lines.push('    <CurrencyCode>AOA</CurrencyCode>');
  lines.push(`    <DateCreated>${escapeXml(dateCreated)}</DateCreated>`);
  lines.push('    <TaxEntity>Global</TaxEntity>');
  lines.push(`    <ProductCompanyTaxID>${escapeXml(settings.nif || '999999999')}</ProductCompanyTaxID>`);
  lines.push(`    <SoftwareValidationNumber>${escapeXml(validationNumber)}</SoftwareValidationNumber>`);
  lines.push(`    <ProductID>${escapeXml(productId)}</ProductID>`);
  lines.push(`    <ProductVersion>${escapeXml(productVersion)}</ProductVersion>`);
  lines.push(`    <Telephone>${escapeXml(settings.phone || '')}</Telephone>`);
  lines.push(`    <Email>${escapeXml(settings.email || '')}</Email>`);
  lines.push('  </Header>');

  // MasterFiles
  lines.push('  <MasterFiles>');
  lines.push('    <Customer>');
  lines.push('      <CustomerID>CONSUMIDOR_FINAL</CustomerID>');
  lines.push('      <AccountID>Desconhecido</AccountID>');
  lines.push('      <CustomerTaxID>999999999</CustomerTaxID>');
  lines.push('      <CompanyName>Consumidor Final</CompanyName>');
  lines.push('      <BillingAddress>');
  lines.push('        <AddressDetail>Desconhecido</AddressDetail>');
  lines.push('        <City>Luanda</City>');
  lines.push('        <Country>AO</Country>');
  lines.push('      </BillingAddress>');
  lines.push('      <SelfBillingIndicator>0</SelfBillingIndicator>');
  lines.push('    </Customer>');
  for (const c of db.customers) {
    lines.push('    <Customer>');
    lines.push(`      <CustomerID>${escapeXml(c.id)}</CustomerID>`);
    lines.push('      <AccountID>Desconhecido</AccountID>');
    lines.push(`      <CustomerTaxID>${escapeXml(c.nif || '999999999')}</CustomerTaxID>`);
    lines.push(`      <CompanyName>${escapeXml(c.name)}</CompanyName>`);
    lines.push('      <BillingAddress>');
    lines.push(`        <AddressDetail>${escapeXml(c.address || 'Desconhecido')}</AddressDetail>`);
    lines.push(`        <City>${escapeXml(settings.city || 'Luanda')}</City>`);
    lines.push('        <Country>AO</Country>');
    lines.push('      </BillingAddress>');
    lines.push('      <SelfBillingIndicator>0</SelfBillingIndicator>');
    lines.push('    </Customer>');
  }

  for (const p of db.products) {
    lines.push('    <Product>');
    lines.push('      <ProductType>P</ProductType>');
    lines.push(`      <ProductCode>${escapeXml(p.code)}</ProductCode>`);
    lines.push(`      <ProductGroup>${escapeXml(p.classId)}</ProductGroup>`);
    lines.push(`      <ProductDescription>${escapeXml(p.name)}</ProductDescription>`);
    lines.push(`      <ProductNumberCode>${escapeXml(p.barcode || p.code)}</ProductNumberCode>`);
    lines.push('    </Product>');
  }

  if (taxEntriesMap.size > 0) {
    lines.push('    <TaxTable>');
    for (const entry of taxEntriesMap.values()) {
      lines.push('      <TaxTableEntry>');
      lines.push('        <TaxType>IVA</TaxType>');
      lines.push('        <TaxCountryRegion>AO</TaxCountryRegion>');
      lines.push(`        <TaxCode>${escapeXml(entry.taxCode)}</TaxCode>`);
      lines.push(`        <Description>${escapeXml(entry.description)}</Description>`);
      if (entry.expirationDate) {
        lines.push(`        <TaxExpirationDate>${escapeXml(entry.expirationDate)}</TaxExpirationDate>`);
      }
      lines.push(`        <TaxPercentage>${entry.percentage.toFixed(2)}</TaxPercentage>`);
      lines.push('      </TaxTableEntry>');
    }
    lines.push('    </TaxTable>');
  }
  lines.push('  </MasterFiles>');

  // SourceDocuments
  lines.push('  <SourceDocuments>');

  // SalesInvoices (FT, FR, NC)
  const totalCredit = roundMoney(
    invoices
      .filter((s) => s.status !== 'ANULADA')
      .reduce((acc, s) => acc + s.items.reduce((a, i) => a + (i.taxableBase ?? i.subtotal), 0), 0)
  );
  const totalDebit = roundMoney(
    periodReturns.reduce((acc, r) => acc + r.items.reduce((a, i) => a + (i.taxableBase ?? i.refundAmount), 0), 0)
  );
  const invoicesAndCreditNotesCount = invoices.length + periodReturns.length;

  lines.push('    <SalesInvoices>');
  lines.push(`      <NumberOfEntries>${invoicesAndCreditNotesCount}</NumberOfEntries>`);
  lines.push(`      <TotalDebit>${totalDebit.toFixed(2)}</TotalDebit>`);
  lines.push(`      <TotalCredit>${totalCredit.toFixed(2)}</TotalCredit>`);

  for (const s of invoices) {
    const netTotal = roundMoney(s.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0));
    const taxPayable = roundMoney(s.taxTotal ?? s.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0));
    const grossTotal = roundMoney(netTotal + taxPayable);
    const invType = s.type === 'FACTURA_RECIBO' ? 'FR' : 'FT';
    const docStatus = s.status === 'ANULADA' ? 'A' : 'N';

    lines.push('      <Invoice>');
    lines.push(`        <InvoiceNo>${escapeXml(s.documentNumber)}</InvoiceNo>`);
    lines.push('        <DocumentStatus>');
    lines.push(`          <InvoiceStatus>${docStatus}</InvoiceStatus>`);
    lines.push(`          <InvoiceStatusDate>${escapeXml(s.issuedAt || s.createdAt)}</InvoiceStatusDate>`);
    lines.push(`          <SourceID>${escapeXml(s.sellerId)}</SourceID>`);
    lines.push('          <SourceBilling>P</SourceBilling>');
    lines.push('        </DocumentStatus>');
    lines.push('        <Hash>0</Hash>');
    lines.push('        <HashControl>0</HashControl>');
    lines.push(`        <Period>${escapeXml(s.date.slice(5, 7))}</Period>`);
    lines.push(`        <InvoiceDate>${escapeXml(s.date)}</InvoiceDate>`);
    lines.push(`        <InvoiceType>${invType}</InvoiceType>`);
    lines.push('        <SpecialRegimes><SelfBillingIndicator>0</SelfBillingIndicator><CashVATSchemeIndicator>0</CashVATSchemeIndicator><ThirdPartiesBillingIndicator>0</ThirdPartiesBillingIndicator></SpecialRegimes>');
    lines.push(`        <SourceID>${escapeXml(s.sellerId)}</SourceID>`);
    lines.push(`        <SystemEntryDate>${escapeXml(s.issuedAt || s.createdAt)}</SystemEntryDate>`);
    lines.push(`        <CustomerID>${escapeXml(s.customerId || 'CONSUMIDOR_FINAL')}</CustomerID>`);

    s.items.forEach((it, idx) => {
      const lineTaxBase = roundMoney(it.taxableBase ?? it.subtotal);
      const rawLineDisc = roundMoney((it.quantity * it.unitPrice * (it.discountPercent || 0)) / 100);
      const rateNum = Number(it.taxRate ?? 0);
      const lineIncludesTax =
        it.priceIncludesTax !== undefined ? Boolean(it.priceIncludesTax) : Boolean(settings.pricesIncludeTax);
      const lineDisc =
        lineIncludesTax && rateNum > 0
          ? roundMoney(rawLineDisc / (1 + rateNum / 100))
          : rawLineDisc;
      const isUnconfigured = !it.taxCode || it.taxCode === 'NAO_CONFIGURADO';
      lines.push('        <Line>');
      lines.push(`          <LineNumber>${idx + 1}</LineNumber>`);
      lines.push(`          <ProductCode>${escapeXml(it.productCode)}</ProductCode>`);
      lines.push(`          <ProductDescription>${escapeXml(it.productName)}</ProductDescription>`);
      lines.push(`          <Quantity>${it.quantity}</Quantity>`);
      lines.push(`          <UnitOfMeasure>${escapeXml(it.unit || 'Unidade')}</UnitOfMeasure>`);
      lines.push(`          <UnitPrice>${roundMoney(lineTaxBase / Math.max(1, it.quantity)).toFixed(2)}</UnitPrice>`);
      lines.push(`          <TaxPointDate>${escapeXml(s.date)}</TaxPointDate>`);
      lines.push(`          <Description>${escapeXml(it.productName)}</Description>`);
      lines.push(`          <CreditAmount>${lineTaxBase.toFixed(2)}</CreditAmount>`);
      lines.push('          <Tax>');
      lines.push('            <TaxType>IVA</TaxType>');
      lines.push('            <TaxCountryRegion>AO</TaxCountryRegion>');
      lines.push(`            <TaxCode>${escapeXml(isUnconfigured ? 'OUT' : it.taxCode)}</TaxCode>`);
      lines.push(`            <TaxPercentage>${rateNum.toFixed(2)}</TaxPercentage>`);
      lines.push('          </Tax>');
      if (
        it.taxCode === 'ISE' ||
        (it.taxCode === 'OUT' && rateNum === 0 && it.taxExemptionReason) ||
        isUnconfigured
      ) {
        lines.push(
          `          <TaxExemptionReason>${escapeXml(
            isUnconfigured
              ? 'Tratamento fiscal pendente de confirmacao contabilistica (NAO_CONFIGURADO)'
              : it.taxExemptionReason || 'Não registado'
          )}</TaxExemptionReason>`
        );
        if (it.taxExemptionCode) {
          lines.push(`          <TaxExemptionCode>${escapeXml(it.taxExemptionCode)}</TaxExemptionCode>`);
        }
      }
      if (lineDisc > 0) {
        lines.push(`          <SettlementAmount>${lineDisc.toFixed(2)}</SettlementAmount>`);
      }
      lines.push('        </Line>');
    });

    lines.push('        <DocumentTotals>');
    lines.push(`          <TaxPayable>${taxPayable.toFixed(2)}</TaxPayable>`);
    lines.push(`          <NetTotal>${netTotal.toFixed(2)}</NetTotal>`);
    lines.push(`          <GrossTotal>${grossTotal.toFixed(2)}</GrossTotal>`);
    lines.push('        </DocumentTotals>');
    lines.push('      </Invoice>');
  }

  for (const r of periodReturns) {
    const netTotal = roundMoney(r.items.reduce((acc, it) => acc + (it.taxableBase ?? it.refundAmount), 0));
    const taxPayable = roundMoney(r.taxTotal ?? r.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0));
    const grossTotal = roundMoney(netTotal + taxPayable);
    const origSale = db.sales.find((s) => s.id === r.originalSaleId);
    const resolvedCustomerId = origSale?.customerId || 'CONSUMIDOR_FINAL';

    lines.push('      <Invoice>');
    lines.push(`        <InvoiceNo>${escapeXml(r.documentNumber)}</InvoiceNo>`);
    lines.push('        <DocumentStatus>');
    lines.push('          <InvoiceStatus>N</InvoiceStatus>');
    lines.push(`          <InvoiceStatusDate>${escapeXml(r.createdAt)}</InvoiceStatusDate>`);
    lines.push(`          <SourceID>${escapeXml(r.userId)}</SourceID>`);
    lines.push('          <SourceBilling>P</SourceBilling>');
    lines.push('        </DocumentStatus>');
    lines.push('        <Hash>0</Hash>');
    lines.push('        <HashControl>0</HashControl>');
    lines.push(`        <Period>${escapeXml(r.date.slice(5, 7))}</Period>`);
    lines.push(`        <InvoiceDate>${escapeXml(r.date)}</InvoiceDate>`);
    lines.push('        <InvoiceType>NC</InvoiceType>');
    lines.push('        <SpecialRegimes><SelfBillingIndicator>0</SelfBillingIndicator><CashVATSchemeIndicator>0</CashVATSchemeIndicator><ThirdPartiesBillingIndicator>0</ThirdPartiesBillingIndicator></SpecialRegimes>');
    lines.push(`        <SourceID>${escapeXml(r.userId)}</SourceID>`);
    lines.push(`        <SystemEntryDate>${escapeXml(r.createdAt)}</SystemEntryDate>`);
    lines.push(`        <CustomerID>${escapeXml(resolvedCustomerId)}</CustomerID>`);

    r.items.forEach((it, idx) => {
      const lineTaxBase = roundMoney(it.taxableBase ?? it.refundAmount);
      const rateNum = Number(it.taxRate ?? 0);
      const isUnconfigured = !it.taxCode || it.taxCode === 'NAO_CONFIGURADO';
      lines.push('        <Line>');
      lines.push(`          <LineNumber>${idx + 1}</LineNumber>`);
      lines.push(`          <ProductCode>${escapeXml(it.productCode)}</ProductCode>`);
      lines.push(`          <ProductDescription>${escapeXml(it.productName)}</ProductDescription>`);
      lines.push(`          <Quantity>${it.quantity}</Quantity>`);
      lines.push('          <UnitOfMeasure>Unidade</UnitOfMeasure>');
      lines.push(`          <UnitPrice>${roundMoney(lineTaxBase / Math.max(1, it.quantity)).toFixed(2)}</UnitPrice>`);
      lines.push(`          <TaxPointDate>${escapeXml(r.date)}</TaxPointDate>`);
      lines.push('          <References>');
      lines.push(`            <Reference>${escapeXml(r.originalDocumentNumber)}</Reference>`);
      lines.push(`            <Reason>${escapeXml(r.reason)}</Reason>`);
      lines.push('          </References>');
      lines.push(`          <Description>${escapeXml(it.productName)}</Description>`);
      lines.push(`          <DebitAmount>${lineTaxBase.toFixed(2)}</DebitAmount>`);
      lines.push('          <Tax>');
      lines.push('            <TaxType>IVA</TaxType>');
      lines.push('            <TaxCountryRegion>AO</TaxCountryRegion>');
      lines.push(`            <TaxCode>${escapeXml(isUnconfigured ? 'OUT' : it.taxCode)}</TaxCode>`);
      lines.push(`            <TaxPercentage>${rateNum.toFixed(2)}</TaxPercentage>`);
      lines.push('          </Tax>');
      if (
        it.taxCode === 'ISE' ||
        (it.taxCode === 'OUT' && rateNum === 0 && it.taxExemptionReason) ||
        isUnconfigured
      ) {
        lines.push(
          `          <TaxExemptionReason>${escapeXml(
            isUnconfigured
              ? 'Tratamento fiscal pendente de confirmacao contabilistica (NAO_CONFIGURADO)'
              : it.taxExemptionReason || 'Não registado'
          )}</TaxExemptionReason>`
        );
        if (it.taxExemptionCode) {
          lines.push(`          <TaxExemptionCode>${escapeXml(it.taxExemptionCode)}</TaxExemptionCode>`);
        }
      }
      lines.push('        </Line>');
    });

    lines.push('        <DocumentTotals>');
    lines.push(`          <TaxPayable>${taxPayable.toFixed(2)}</TaxPayable>`);
    lines.push(`          <NetTotal>${netTotal.toFixed(2)}</NetTotal>`);
    lines.push(`          <GrossTotal>${grossTotal.toFixed(2)}</GrossTotal>`);
    lines.push('        </DocumentTotals>');
    lines.push('      </Invoice>');
  }
  lines.push('    </SalesInvoices>');

  // WorkingDocuments (PF - Proformas)
  if (proformas.length > 0) {
    const workingTotal = roundMoney(proformas.reduce((acc, p) => acc + p.totalAmount, 0));
    lines.push('    <WorkingDocuments>');
    lines.push(`      <NumberOfEntries>${proformas.length}</NumberOfEntries>`);
    lines.push('      <TotalDebit>0.00</TotalDebit>');
    lines.push(`      <TotalCredit>${workingTotal.toFixed(2)}</TotalCredit>`);
    for (const p of proformas) {
      const netTotal = roundMoney(p.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0));
      const taxPayable = roundMoney(p.taxTotal ?? p.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0));
      const grossTotal = roundMoney(netTotal + taxPayable);
      lines.push('      <WorkDocument>');
      lines.push(`        <DocumentNumber>${escapeXml(p.documentNumber)}</DocumentNumber>`);
      lines.push('        <DocumentStatus>');
      lines.push(`          <WorkStatus>${p.status === 'CONVERTIDA' ? 'F' : 'N'}</WorkStatus>`);
      lines.push(`          <WorkStatusDate>${escapeXml(p.createdAt)}</WorkStatusDate>`);
      lines.push(`          <SourceID>${escapeXml(p.sellerId)}</SourceID>`);
      lines.push('          <SourceBilling>P</SourceBilling>');
      lines.push('        </DocumentStatus>');
      lines.push('        <Hash>0</Hash>');
      lines.push('        <HashControl>0</HashControl>');
      lines.push(`        <Period>${escapeXml(p.date.slice(5, 7))}</Period>`);
      lines.push(`        <WorkDate>${escapeXml(p.date)}</WorkDate>`);
      lines.push('        <WorkType>PF</WorkType>');
      lines.push(`        <SourceID>${escapeXml(p.sellerId)}</SourceID>`);
      lines.push(`        <SystemEntryDate>${escapeXml(p.createdAt)}</SystemEntryDate>`);
      lines.push(`        <CustomerID>${escapeXml(p.customerId || 'CONSUMIDOR_FINAL')}</CustomerID>`);
      p.items.forEach((it, idx) => {
        const lineTaxBase = roundMoney(it.taxableBase ?? it.subtotal);
        const rateNum = Number(it.taxRate ?? 0);
        const isUnconfigured = !it.taxCode || it.taxCode === 'NAO_CONFIGURADO';
        lines.push('        <Line>');
        lines.push(`          <LineNumber>${idx + 1}</LineNumber>`);
        lines.push(`          <ProductCode>${escapeXml(it.productCode)}</ProductCode>`);
        lines.push(`          <ProductDescription>${escapeXml(it.productName)}</ProductDescription>`);
        lines.push(`          <Quantity>${it.quantity}</Quantity>`);
        lines.push(`          <UnitOfMeasure>${escapeXml(it.unit || 'Unidade')}</UnitOfMeasure>`);
        lines.push(`          <UnitPrice>${roundMoney(lineTaxBase / Math.max(1, it.quantity)).toFixed(2)}</UnitPrice>`);
        lines.push(`          <TaxPointDate>${escapeXml(p.date)}</TaxPointDate>`);
        lines.push(`          <Description>${escapeXml(it.productName)}</Description>`);
        lines.push(`          <CreditAmount>${lineTaxBase.toFixed(2)}</CreditAmount>`);
        lines.push('          <Tax>');
        lines.push('            <TaxType>IVA</TaxType>');
        lines.push('            <TaxCountryRegion>AO</TaxCountryRegion>');
        lines.push(`            <TaxCode>${escapeXml(isUnconfigured ? 'OUT' : it.taxCode)}</TaxCode>`);
        lines.push(`            <TaxPercentage>${rateNum.toFixed(2)}</TaxPercentage>`);
        lines.push('          </Tax>');
        if (
          it.taxCode === 'ISE' ||
          (it.taxCode === 'OUT' && rateNum === 0 && it.taxExemptionReason) ||
          isUnconfigured
        ) {
          lines.push(
            `          <TaxExemptionReason>${escapeXml(
              isUnconfigured
                ? 'Tratamento fiscal pendente de confirmacao contabilistica (NAO_CONFIGURADO)'
                : it.taxExemptionReason || 'Não registado'
            )}</TaxExemptionReason>`
          );
          if (it.taxExemptionCode) {
            lines.push(`          <TaxExemptionCode>${escapeXml(it.taxExemptionCode)}</TaxExemptionCode>`);
          }
        }
        lines.push('        </Line>');
      });
      lines.push('        <DocumentTotals>');
      lines.push(`          <TaxPayable>${taxPayable.toFixed(2)}</TaxPayable>`);
      lines.push(`          <NetTotal>${netTotal.toFixed(2)}</NetTotal>`);
      lines.push(`          <GrossTotal>${grossTotal.toFixed(2)}</GrossTotal>`);
      lines.push('        </DocumentTotals>');
      lines.push('      </WorkDocument>');
    }
    lines.push('    </WorkingDocuments>');
  }

  // Payments (RC - Recibos)
  if (payments.length > 0) {
    const payCredit = roundMoney(payments.reduce((acc, p) => acc + p.totalAmount, 0));
    lines.push('    <Payments>');
    lines.push(`      <NumberOfEntries>${payments.length}</NumberOfEntries>`);
    lines.push('      <TotalDebit>0.00</TotalDebit>');
    lines.push(`      <TotalCredit>${payCredit.toFixed(2)}</TotalCredit>`);
    for (const rc of payments) {
      lines.push('      <Payment>');
      lines.push(`        <PaymentRefNo>${escapeXml(rc.documentNumber)}</PaymentRefNo>`);
      lines.push(`        <Period>${escapeXml(rc.date.slice(5, 7))}</Period>`);
      lines.push(`        <TransactionDate>${escapeXml(rc.date)}</TransactionDate>`);
      lines.push('        <PaymentType>RG</PaymentType>');
      lines.push('        <DocumentStatus>');
      lines.push('          <PaymentStatus>N</PaymentStatus>');
      lines.push(`          <PaymentStatusDate>${escapeXml(rc.issuedAt || rc.createdAt)}</PaymentStatusDate>`);
      lines.push(`          <SourceID>${escapeXml(rc.sellerId)}</SourceID>`);
      lines.push('          <SourcePayment>P</SourcePayment>');
      lines.push('        </DocumentStatus>');
      lines.push(`        <SourceID>${escapeXml(rc.sellerId)}</SourceID>`);
      lines.push(`        <SystemEntryDate>${escapeXml(rc.issuedAt || rc.createdAt)}</SystemEntryDate>`);
      lines.push(`        <CustomerID>${escapeXml(rc.customerId || 'CONSUMIDOR_FINAL')}</CustomerID>`);
      const origInv = db.sales.find((s) => s.id === rc.relatedInvoiceId);
      lines.push('        <Line>');
      lines.push('          <LineNumber>1</LineNumber>');
      lines.push('          <SourceDocumentID>');
      lines.push(`            <OriginatingON>${escapeXml(rc.relatedInvoiceNumber || '')}</OriginatingON>`);
      lines.push(`            <InvoiceDate>${escapeXml(origInv?.date || rc.date)}</InvoiceDate>`);
      lines.push('          </SourceDocumentID>');
      lines.push(`          <CreditAmount>${rc.totalAmount.toFixed(2)}</CreditAmount>`);
      lines.push('        </Line>');
      lines.push('        <DocumentTotals>');
      lines.push('          <TaxPayable>0.00</TaxPayable>');
      lines.push(`          <NetTotal>${rc.totalAmount.toFixed(2)}</NetTotal>`);
      lines.push(`          <GrossTotal>${rc.totalAmount.toFixed(2)}</GrossTotal>`);
      lines.push('        </DocumentTotals>');
      lines.push('      </Payment>');
    }
    lines.push('    </Payments>');
  }

  lines.push('  </SourceDocuments>');
  lines.push('</AuditFile>');

  const xml = lines.join('\n');
  const structureErrors = validateSaftAoStructure(xml, {
    invoicesAndCreditNotesCount,
    totalCredit,
    totalDebit,
    invoices,
    periodReturns,
  });

  return {
    xml,
    filename: `SAFT_AO_${settings.nif || 'ANCORA'}_${startDate}_${endDate}.xml`,
    readinessWarnings,
    summary: {
      invoicesAndCreditNotesCount,
      workingDocumentsCount: proformas.length,
      paymentsCount: payments.length,
      totalCredit,
      totalDebit,
      certified: agtStatus.certified,
      saftCompliant: blockingIssues.length === 0 && structureErrors.length === 0,
      structureValid: structureErrors.length === 0,
      structureErrors,
      blockingIssues,
    },
  };
}

function validateSaftAoStructure(
  xml: string,
  meta: {
    invoicesAndCreditNotesCount: number;
    totalCredit: number;
    totalDebit: number;
    invoices: Sale[];
    periodReturns: SaleReturn[];
  }
): string[] {
  const errors: string[] = [];
  const requiredNodes = [
    '<AuditFile ',
    '</AuditFile>',
    '<Header>',
    '<AuditFileVersion>1.01_01</AuditFileVersion>',
    '</Header>',
    '<MasterFiles>',
    '<Customer>',
    '</MasterFiles>',
    '<SourceDocuments>',
    '<SalesInvoices>',
    '</SalesInvoices>',
    '</SourceDocuments>',
  ];
  for (const node of requiredNodes) {
    if (!xml.includes(node)) {
      errors.push(`Nó obrigatório SAF-T (AO) em falta: ${node}`);
    }
  }
  const countMatch = xml.match(/<SalesInvoices>\s*<NumberOfEntries>(\d+)<\/NumberOfEntries>/);
  if (!countMatch || Number(countMatch[1]) !== meta.invoicesAndCreditNotesCount) {
    errors.push('NumberOfEntries de SalesInvoices não reconcilia com a contagem de faturas/NC.');
  }
  for (const s of meta.invoices) {
    const netTotal = roundMoney(s.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0));
    const taxPayable = roundMoney(s.taxTotal ?? s.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0));
    const grossTotal = roundMoney(netTotal + taxPayable);
    if (Math.abs(roundMoney(netTotal + taxPayable) - grossTotal) > 0.01) {
      errors.push(`Fatura ${s.documentNumber} com divergência em DocumentTotals.`);
    }
  }
  for (const r of meta.periodReturns) {
    const netTotal = roundMoney(r.items.reduce((acc, it) => acc + (it.taxableBase ?? it.refundAmount), 0));
    const taxPayable = roundMoney(r.taxTotal ?? r.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0));
    const grossTotal = roundMoney(netTotal + taxPayable);
    if (Math.abs(roundMoney(netTotal + taxPayable) - grossTotal) > 0.01) {
      errors.push(`Nota de Crédito ${r.documentNumber} com divergência em DocumentTotals.`);
    }
  }
  return errors;
}
