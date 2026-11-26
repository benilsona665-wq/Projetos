export type UserRole = 'ADMIN' | 'SELLER';

export interface SellerPermissions {
  canDiscount: boolean;
  maxDiscountPercent: number;
  canProcessReturns: boolean;
  canCancelSales: boolean;
  canViewPurchases: boolean;
  canStartInventoryCount: boolean;
  canConfigureProductVat?: boolean;
}

export interface User {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  active: boolean;
  permissions: SellerPermissions;
  createdAt: string;
  isDemoData?: boolean;
}

export interface StoredUser extends User {
  passwordHash: string;
  passwordSalt: string;
  tokensValidAfter?: number;
}

export interface PharmacologicalClass {
  id: string;
  name: string;
  description: string;
  active: boolean;
}

export type VatRegime = 'NAO_CONFIGURADO' | 'GERAL' | 'SIMPLIFICADO' | 'EXCLUSAO';
export type TaxType = 'IVA';
export type TaxCode = 'NAO_CONFIGURADO' | 'NOR' | 'INT' | 'RED' | 'ISE' | 'OUT';
export type ProductFiscalValidationState = 'PENDENTE_REVISAO' | 'VALIDADO_CONTABILISTA';
export type FiscalValidationStatus =
  | 'RASCUNHO_NAO_VALIDADO'
  | 'NAO_FISCAL_PROFORMA'
  | 'PENDENTE_AGT'
  | 'VALIDADO_AGT'
  | 'REJEITADO_AGT';

export interface TaxRuleEntry {
  id: string;
  taxType: TaxType;
  taxCode: Exclude<TaxCode, 'NAO_CONFIGURADO'>;
  description: string;
  rate: number;
  exemptionCode: string;
  legalBasis: string;
  validFrom: string; // YYYY-MM-DD
  validTo: string; // YYYY-MM-DD or ''
  active: boolean;
  confirmedByAccountant: boolean;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FiscalChangeEntry {
  id: string;
  timestamp: string;
  userId: string;
  userName: string;
  entityType: 'REGIME_IVA' | 'REGRA_FISCAL' | 'PRODUTO_IVA' | 'LOTE_IVA';
  entityId: string;
  entityLabel: string;
  field: string;
  previousValue: string;
  newValue: string;
  reason: string;
}

export interface ProductBatchTaxOverride {
  batch: string;
  taxType?: TaxType;
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode?: string;
  taxExemptionReason?: string;
  priceIncludesTax?: boolean | null;
  fiscalValidationState?: ProductFiscalValidationState;
  taxRuleId?: string;
  updatedAt?: string;
  updatedByName?: string;
}

export interface Product {
  id: string;
  code: string;
  barcode?: string;
  name: string;
  activeIngredient: string;
  classId: string;
  dosageForm: string;
  dosage: string;
  unit: string;
  location: string;
  purchasePrice: number;
  salePrice: number;
  stock: number;
  quarantineStock: number;
  minStock: number;
  batch: string;
  expiryDate: string; // YYYY-MM-DD or ''
  supplierId: string;
  active: boolean;
  updatedAt: string;
  taxType?: TaxType;
  taxCode?: TaxCode;
  taxRate?: number | null;
  taxExemptionCode?: string;
  taxExemptionReason?: string;
  priceIncludesTax?: boolean | null;
  fiscalValidationState?: ProductFiscalValidationState;
  taxRuleId?: string;
  batchTaxes?: ProductBatchTaxOverride[];
  isDemoData?: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  nif: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  active: boolean;
  createdAt: string;
  isDemoData?: boolean;
}

export interface PurchaseItem {
  productId: string;
  productCode: string;
  productBarcode?: string;
  productName: string;
  quantity: number;
  unitCost: number;
  taxType?: TaxType;
  taxCode?: TaxCode;
  taxRate?: number | null;
  taxExemptionCode?: string;
  taxExemptionReason?: string;
  priceIncludesTax?: boolean;
  taxableBase?: number;
  taxAmount?: number;
  subtotal: number;
  batch: string;
  expiryDate: string;
}

export interface Purchase {
  id: string;
  internalNumber: string;
  supplierId: string;
  supplierName: string;
  documentNumber: string;
  documentDate: string;
  items: PurchaseItem[];
  subtotal?: number;
  taxTotal?: number;
  taxBreakdown?: TaxBreakdownEntry[];
  pricesIncludeTax?: boolean;
  totalAmount: number;
  notes: string;
  userId: string;
  userName: string;
  createdAt: string;
  isDemoData?: boolean;
}

export interface Customer {
  id: string;
  name: string;
  nif: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  createdAt: string;
  isDemoData?: boolean;
}

export type PaymentMethod = 'DINHEIRO' | 'MULTICAIXA' | 'TRANSFERENCIA' | 'SEGURO';
export type SaleDocumentType = 'FACTURA' | 'FACTURA_RECIBO' | 'RECIBO' | 'PROFORMA' | 'FATURA';
export type SaleStatus =
  | 'EMITIDA'
  | 'PROFORMA'
  | 'CONVERTIDA'
  | 'PARCIALMENTE_DEVOLVIDA'
  | 'DEVOLVIDA'
  | 'ANULADA';

export interface TaxBreakdownEntry {
  taxCode: TaxCode;
  taxRate: number | null;
  taxExemptionCode: string;
  taxExemptionReason: string;
  taxableBase: number;
  taxAmount: number;
  total: number;
  itemsCount: number;
}

export interface AgtSubmissionEvent {
  id: string;
  timestamp: string;
  action: 'CRIADO_RASCUNHO' | 'ENVIO_AGT' | 'CONSULTA_ESTADO' | 'RESPOSTA_AGT' | 'ERRO_AGT' | 'MODO_RASCUNHO';
  requestId?: string;
  statusCode?: number;
  validationStatus: FiscalValidationStatus;
  message: string;
  payloadSummary?: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
}

export interface SaleItem {
  productId: string;
  productCode: string;
  productBarcode?: string;
  productName: string;
  activeIngredient: string;
  className?: string;
  dosageForm?: string;
  unit: string;
  batch: string;
  expiryDate: string;
  quantity: number;
  returnedQuantity: number;
  unitPrice: number;
  discountPercent: number;
  subtotal: number;
  taxType?: TaxType;
  taxCode?: TaxCode;
  taxRate?: number | null;
  taxExemptionCode?: string;
  taxExemptionReason?: string;
  priceIncludesTax?: boolean;
  taxableBase?: number;
  taxAmount?: number;
}

export interface Sale {
  id: string;
  documentNumber: string;
  type: SaleDocumentType;
  status: SaleStatus;
  customerId: string | null;
  customerName: string;
  customerNif: string;
  customerAddress?: string;
  isCommonConsumer: boolean;
  paymentMethod: PaymentMethod;
  items: SaleItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal?: number;
  taxBreakdown?: TaxBreakdownEntry[];
  totalAmount: number;
  notes: string;
  sellerId: string;
  sellerName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm:ss
  createdAt: string;
  issuedAt?: string;
  locationOfOperation?: string;
  paidAmount?: number;
  paymentStatus?: 'NAO_PAGO' | 'PARCIAL' | 'PAGO';
  relatedInvoiceId?: string;
  relatedInvoiceNumber?: string;
  convertedToSaleId?: string;
  convertedDocumentNumber?: string;
  sourceProformaId?: string;
  sourceProformaNumber?: string;
  cashRegisterId?: string;
  seriesSource?: 'INTERNA_NAO_OFICIAL' | 'AGT_HOMOLOGACAO' | 'AGT_OFICIAL';
  fiscalValidationStatus?: FiscalValidationStatus;
  agtRequestId?: string;
  agtDocumentNo?: string;
  agtRejectionReason?: string;
  agtQrCode?: string;
  agtHash?: string;
  agtSignature?: string;
  agtSubmissionHistory?: AgtSubmissionEvent[];
  isDemoData?: boolean;
}

export type ReturnType = 'DEVOLUCAO' | 'ANULACAO';
export type ReturnCondition = 'APT' | 'QUARANTINE';

export interface ReturnItem {
  productId: string;
  productCode: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  refundAmount: number;
  condition: ReturnCondition;
  taxCode?: TaxCode;
  taxRate?: number | null;
  taxExemptionCode?: string;
  taxExemptionReason?: string;
  taxableBase?: number;
  taxAmount?: number;
}

export type BuyerAckMethod =
  | 'NAO_REGISTADA'
  | 'CARTA'
  | 'EMAIL'
  | 'ASSINATURA_NIF'
  | 'CARIMBO_EMPRESA'
  | 'OUTRO';

export interface BuyerAcknowledgement {
  confirmed: boolean;
  method: BuyerAckMethod;
  reference: string;
  acknowledgedAt?: string;
  notes: string;
  recordedById?: string;
  recordedByName?: string;
}

export interface SaleReturn {
  id: string;
  documentNumber: string;
  type: ReturnType;
  rectificationNature?: 'ANULACAO' | 'RECTIFICACAO';
  originalSaleId: string;
  originalDocumentNumber: string;
  originalPaymentMethod: PaymentMethod;
  originalSellerId: string;
  originalSellerName: string;
  customerName?: string;
  customerNif?: string;
  reason: string;
  items: ReturnItem[];
  taxTotal?: number;
  taxBreakdown?: TaxBreakdownEntry[];
  totalRefund: number;
  userId: string;
  userName: string;
  date: string;
  createdAt: string;
  cashRegisterId?: string;
  internalCancellationRef?: string;
  seriesSource?: 'INTERNA_NAO_OFICIAL' | 'AGT_HOMOLOGACAO' | 'AGT_OFICIAL';
  buyerAcknowledgement?: BuyerAcknowledgement;
  fiscalValidationStatus?: FiscalValidationStatus;
  agtRequestId?: string;
  agtRejectionReason?: string;
  agtQrCode?: string;
  agtHash?: string;
  agtSignature?: string;
  agtSubmissionHistory?: AgtSubmissionEvent[];
  isDemoData?: boolean;
}

export type InventoryScope = 'ALL' | 'CLASS' | 'LOCATION';
export type InventoryStatus = 'PENDENTE_APROVACAO' | 'APROVADO' | 'REJEITADO';

export interface InventoryItem {
  productId: string;
  productCode: string;
  productName: string;
  className: string;
  location: string;
  systemQty: number;
  countedQty: number;
  difference: number;
  beforeQty: number;
  afterQty: number;
  unitCost: number;
  differenceValue: number;
  notes: string;
}

export interface InventorySession {
  id: string;
  referenceNumber: string;
  scope: InventoryScope;
  scopeFilter: string;
  status: InventoryStatus;
  items: InventoryItem[];
  totalDiscrepancies: number;
  totalShortageUnits: number;
  totalSurplusUnits: number;
  reason: string;
  notes: string;
  countedById: string;
  countedByName: string;
  countedAt: string;
  approvedById?: string;
  approvedByName?: string;
  approvedAt?: string;
  rejectedReason?: string;
  isDemoData?: boolean;
}

export type CashRegisterStatus = 'ABERTO' | 'FECHADO';

export interface SellerClosing {
  id: string;
  status?: CashRegisterStatus;
  date: string; // YYYY-MM-DD
  shiftNumber: 1 | 2;
  shiftLabel: string;
  sellerId: string;
  sellerName: string;
  openingBalance: number;
  openedAt?: string;
  openingNotes?: string;
  salesCount: number;
  salesByPayment: Record<PaymentMethod, number>;
  grossSalesTotal: number;
  returnsTotal: number;
  returnsCashTotal: number;
  cancellationsCount: number;
  cancellationsTotal: number;
  expectedCash: number;
  expectedTotal: number;
  countedCash: number;
  difference: number;
  notes: string;
  includedSaleIds: string[];
  includedReturnIds: string[];
  closedById: string;
  closedByName: string;
  closedAt?: string;
  createdAt: string;
  generalClosingId?: string;
  isDemoData?: boolean;
}

export interface CashRegisterStatusPayload {
  today: string;
  openRegister: (SellerClosing & { expectedCashSalesNet: number }) | null;
  closedTodayCount: number;
  totalTodayCount: number;
  maxAllowedPerDay: number;
  isPeriodClosed: boolean;
  closedPeriodRef: string | null;
  requiresOpenRegisterToSell: boolean;
  lastClosedToday: SellerClosing | null;
}

export interface GeneralClosingCorrection {
  id: string;
  action: 'REABERTURA' | 'CORRECAO';
  reason: string;
  previousTotalCounted?: number;
  newTotalCounted?: number;
  userId: string;
  userName: string;
  timestamp: string;
}

export interface GeneralClosing {
  id: string;
  referenceNumber: string;
  startDate: string;
  endDate: string;
  status: 'FECHADO' | 'REABERTO';
  sellerClosingIds: string[];
  salesCount: number;
  salesByPayment: Record<PaymentMethod, number>;
  totalSales: number;
  returnsTotal: number;
  cancellationsCount: number;
  cancellationsTotal: number;
  totalExpectedCash: number;
  totalCountedCash: number;
  totalDifference: number;
  notes: string;
  closedById: string;
  closedByName: string;
  closedAt: string;
  corrections: GeneralClosingCorrection[];
  isDemoData?: boolean;
}

export interface AgtSeriesEntry {
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
}

export interface DocumentSeriesConfig {
  seriesYear?: number;
  invoicePrefix: string;
  invoiceNext: number;
  invoiceReciboPrefix?: string;
  invoiceReciboNext?: number;
  receiptPrefix?: string;
  receiptNext?: number;
  proformaPrefix: string;
  proformaNext: number;
  creditNotePrefix: string;
  creditNoteNext: number;
  cancellationPrefix: string;
  cancellationNext: number;
  purchasePrefix: string;
  purchaseNext: number;
  inventoryPrefix: string;
  inventoryNext: number;
  generalClosingPrefix: string;
  generalClosingNext: number;
  yearlyCounters?: Record<string, number>;
  agtSeries?: AgtSeriesEntry[];
}

export interface BackupPolicySettings {
  enabled: boolean;
  retentionDays: number;
  dailyHourUTC: number;
  lastRunAt?: string;
  lastStatus?: 'SUCCESS' | 'ERROR' | 'NEVER';
  lastError?: string;
  lastBackupKey?: string;
}

export interface PharmacySettings {
  pharmacyName: string;
  legalName?: string;
  establishmentName?: string;
  establishmentCode?: string;
  nif: string;
  phone: string;
  email: string;
  address: string;
  city?: string;
  country?: string;
  vatRegime?: VatRegime;
  pricesIncludeTax?: boolean;
  agtElectronicInvoicingEnabled?: boolean;
  currencySymbol: string;
  expiryWarningDays: number;
  series: DocumentSeriesConfig;
  backupPolicy?: BackupPolicySettings;
  taxRules?: TaxRuleEntry[];
  fiscalHistory?: FiscalChangeEntry[];
}

export interface AgtPublicStatus {
  configured: boolean;
  homologationConfigured: boolean;
  certified: boolean;
  officiallyValidatedOnAgtList: boolean;
  environment: 'HOMOLOGACAO' | 'PRODUCAO' | 'NAO_CONFIGURADO';
  baseUrl: string;
  basicAuthConfigured: boolean;
  softwareIdConfigured: boolean;
  softwareValidationNumberConfigured: boolean;
  softwareValidationNumberMasked: string;
  taxpayerPrivateKeyConfigured: boolean;
  softwarePrivateKeyConfigured: boolean;
  missingRequirements: string[];
  certifiedDisclaimer: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  userId: string;
  username: string;
  userName: string;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  details?: Record<string, unknown>;
}

export interface DatabaseSchema {
  version: number;
  lastUpdated: string;
  users: StoredUser[];
  classes: PharmacologicalClass[];
  products: Product[];
  suppliers: Supplier[];
  purchases: Purchase[];
  customers: Customer[];
  sales: Sale[];
  returns: SaleReturn[];
  inventories: InventorySession[];
  sellerClosings: SellerClosing[];
  generalClosings: GeneralClosing[];
  settings: PharmacySettings;
  auditLogs: AuditLogEntry[];
}
