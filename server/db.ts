import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient } from 'pg';
import type {
  AuditLogEntry,
  Customer,
  DatabaseSchema,
  GeneralClosing,
  InventorySession,
  PharmacySettings,
  PharmacologicalClass,
  Product,
  Purchase,
  Sale,
  SaleReturn,
  SellerClosing,
  StoredUser,
  Supplier,
  User,
} from '../src/types.ts';

const LEGACY_JSON_FILE = path.resolve(process.cwd(), 'data', 'farmacia-db.json');
const DEFAULT_SQLITE_FILE = path.resolve(
  process.cwd(),
  process.env.DATABASE_PATH || './data/ancora-sms.sqlite'
);
const PG_LOCK_KEY = 78451209;

export type DbEngine = 'postgresql' | 'sqlite';

export class HttpError extends Error {
  status: number;
  code?: string;
  shortages?: Array<{ productId: string; productName: string; requested: number; available: number }>;

  constructor(
    status: number,
    message: string,
    extra?: {
      code?: string;
      shortages?: Array<{ productId: string; productName: string; requested: number; available: number }>;
    }
  ) {
    super(message);
    this.status = status;
    this.code = extra?.code;
    this.shortages = extra?.shortages;
  }
}

export function hashPassword(password: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}

export function stripUserSecrets(user: StoredUser): User {
  const { passwordHash: _h, passwordSalt: _s, ...safe } = user;
  return safe;
}

export function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function nowTimeStr(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

export function addDaysISO(days: number): string {
  const dt = new Date();
  dt.setDate(dt.getDate() + days);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDocNum(prefix: string, seq: number): string {
  return `${prefix}/${String(seq).padStart(4, '0')}`;
}

export function appendAudit(
  db: DatabaseSchema,
  user: { id: string; username: string; fullName: string },
  action: string,
  entityType: string,
  entityId: string,
  description: string,
  details?: Record<string, unknown>
): void {
  db.auditLogs.unshift({
    id: `aud_${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    userId: user.id,
    username: user.username,
    userName: user.fullName,
    action,
    entityType,
    entityId,
    description,
    details,
  });
  if (db.auditLogs.length > 5000) {
    db.auditLogs = db.auditLogs.slice(0, 5000);
  }
}

function defaultClasses(): PharmacologicalClass[] {
  return [
    { id: 'cls_analg', name: 'Analgésicos e Antipiréticos', description: 'Alívio da dor e redução da febre', active: true },
    { id: 'cls_antib', name: 'Antibióticos', description: 'Tratamento de infeções bacterianas', active: true },
    { id: 'cls_antiinf', name: 'Anti-inflamatórios', description: 'AINEs e corticosteroides', active: true },
    { id: 'cls_cardio', name: 'Anti-hipertensores e Cardiovasculares', description: 'Controlo da pressão arterial e função cardíaca', active: true },
    { id: 'cls_diab', name: 'Antidiabéticos', description: 'Controlo glicémico oral e injetável', active: true },
    { id: 'cls_gastro', name: 'Gastrointestinais', description: 'Protetores gástricos, antiácidos e probióticos', active: true },
    { id: 'cls_alerg', name: 'Antialérgicos e Respiratórios', description: 'Anti-histamínicos e broncodilatadores', active: true },
    { id: 'cls_vit', name: 'Vitaminas e Suplementos', description: 'Suplementação vitamínica e mineral', active: true },
    { id: 'cls_mat', name: 'Material Clínico e Pensos', description: 'Consumíveis hospitalares e primeiros socorros', active: true },
  ];
}

export function normalizeSettings(raw: Partial<PharmacySettings> | undefined, nextSeq = 1): PharmacySettings {
  const curYear = new Date().getFullYear();
  const baseSeries = raw?.series || ({} as PharmacySettings['series']);
  return {
    pharmacyName: raw?.pharmacyName || 'Âncora SMS',
    legalName: raw?.legalName ?? raw?.pharmacyName ?? 'Âncora SMS',
    establishmentName: raw?.establishmentName ?? raw?.pharmacyName ?? 'Estabelecimento Sede',
    establishmentCode: raw?.establishmentCode ?? 'EST-01',
    nif: raw?.nif ?? '5400112233',
    phone: raw?.phone ?? '+244 923 000 100',
    email: raw?.email ?? 'geral@ancorasms.ao',
    address: raw?.address ?? 'Rua Direita da Maianga Nº 72, Luanda',
    city: raw?.city ?? 'Luanda',
    country: raw?.country ?? 'AO',
    vatRegime: raw?.vatRegime ?? 'NAO_CONFIGURADO',
    pricesIncludeTax: Boolean(raw?.pricesIncludeTax ?? false),
    agtElectronicInvoicingEnabled: Boolean(raw?.agtElectronicInvoicingEnabled ?? false),
    currencySymbol: raw?.currencySymbol || 'Kz',
    expiryWarningDays: Number(raw?.expiryWarningDays) || 60,
    series: {
      seriesYear: Number(baseSeries.seriesYear) || curYear,
      invoicePrefix: baseSeries.invoicePrefix || `FT ${curYear}`,
      invoiceNext: Number(baseSeries.invoiceNext) || nextSeq,
      invoiceReciboPrefix: baseSeries.invoiceReciboPrefix || `FR ${curYear}`,
      invoiceReciboNext: Number(baseSeries.invoiceReciboNext) || 1,
      receiptPrefix: baseSeries.receiptPrefix || `RC ${curYear}`,
      receiptNext: Number(baseSeries.receiptNext) || 1,
      proformaPrefix: baseSeries.proformaPrefix || `PF ${curYear}`,
      proformaNext: Number(baseSeries.proformaNext) || nextSeq,
      creditNotePrefix: baseSeries.creditNotePrefix || `NC ${curYear}`,
      creditNoteNext: Number(baseSeries.creditNoteNext) || nextSeq,
      cancellationPrefix: baseSeries.cancellationPrefix || `AN ${curYear}`,
      cancellationNext: Number(baseSeries.cancellationNext) || 1,
      purchasePrefix: baseSeries.purchasePrefix || `CP ${curYear}`,
      purchaseNext: Number(baseSeries.purchaseNext) || nextSeq,
      inventoryPrefix: baseSeries.inventoryPrefix || `INV ${curYear}`,
      inventoryNext: Number(baseSeries.inventoryNext) || 1,
      generalClosingPrefix: baseSeries.generalClosingPrefix || `FG ${curYear}`,
      generalClosingNext: Number(baseSeries.generalClosingNext) || 1,
      yearlyCounters: baseSeries.yearlyCounters ? { ...baseSeries.yearlyCounters } : {},
      agtSeries: Array.isArray(baseSeries.agtSeries) ? [...baseSeries.agtSeries] : [],
    },
    backupPolicy: raw?.backupPolicy || {
      enabled: process.env.BACKUP_ENABLED === 'true',
      retentionDays: Math.max(1, Math.min(365, Number(process.env.BACKUP_RETENTION_DAYS) || 30)),
      dailyHourUTC: Math.max(0, Math.min(23, Number(process.env.BACKUP_SCHEDULE_HOUR_UTC) || 2)),
      lastStatus: 'NEVER',
    },
    taxRules: Array.isArray(raw?.taxRules) ? [...raw.taxRules] : [],
    fiscalHistory: Array.isArray(raw?.fiscalHistory) ? [...raw.fiscalHistory] : [],
  };
}

function defaultSettings(nextSeq = 1): PharmacySettings {
  return normalizeSettings(undefined, nextSeq);
}

export function createCleanProductionDatabase(
  adminUsername = process.env.ADMIN_USERNAME || 'admin',
  adminPassword = process.env.ADMIN_PASSWORD || ''
): DatabaseSchema {
  const isStrictProd =
    process.env.NODE_ENV === 'production' && process.env.STRICT_PRODUCTION === 'true';
  const trimmedPwd = String(adminPassword || '').trim();
  if (isStrictProd && trimmedPwd.length < 8) {
    throw new Error(
      'Segurança em produção: defina ADMIN_PASSWORD (mínimo 8 caracteres) para inicializar uma base de dados vazia, ou execute a migração a partir do SQLite.'
    );
  }
  const now = new Date().toISOString();
  const cleanUser = adminUsername.trim().toLowerCase() || 'admin';
  const effectivePwd = trimmedPwd || crypto.randomBytes(12).toString('base64url');
  if (!trimmedPwd) {
    console.warn(
      `AVISO: ADMIN_PASSWORD não definida ao inicializar base limpa. Palavra-passe temporária para "${cleanUser}": ${effectivePwd}`
    );
  }
  const adminCred = hashPassword(effectivePwd);

  const users: StoredUser[] = [
    {
      id: 'usr_admin',
      username: cleanUser,
      fullName: 'Administrador Principal',
      role: 'ADMIN',
      active: true,
      permissions: {
        canDiscount: true,
        maxDiscountPercent: 100,
        canProcessReturns: true,
        canCancelSales: true,
        canViewPurchases: true,
        canStartInventoryCount: true,
      },
      createdAt: now,
      passwordHash: adminCred.hash,
      passwordSalt: adminCred.salt,
      isDemoData: false,
    },
  ];

  return {
    version: 1,
    lastUpdated: now,
    users,
    classes: defaultClasses(),
    products: [],
    suppliers: [],
    purchases: [],
    customers: [],
    sales: [],
    returns: [],
    inventories: [],
    sellerClosings: [],
    generalClosings: [],
    settings: defaultSettings(1),
    auditLogs: [
      {
        id: 'aud_init',
        timestamp: now,
        userId: 'usr_admin',
        username: cleanUser,
        userName: 'Administrador Principal',
        action: 'SISTEMA_INICIALIZADO',
        entityType: 'SISTEMA',
        entityId: 'bootstrap',
        description: 'Base de dados inicializada em modo de produção.',
      },
    ],
  };
}

export function createSeedDatabase(): DatabaseSchema {
  const now = new Date().toISOString();
  const today = todayISO();
  const yesterday = addDaysISO(-1);
  const twoDaysAgo = addDaysISO(-2);

  const envAdminUsername = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const envAdminPassword = (process.env.ADMIN_PASSWORD || '').trim();
  const hasCustomAdmin = Boolean(envAdminUsername || envAdminPassword);

  const adminCred = hashPassword(envAdminPassword || 'admin123');
  const benilsonCred = hashPassword('farmacia123');
  const sofiaCred = hashPassword('farmacia123');

  const users: StoredUser[] = [
    {
      id: 'usr_admin',
      username: envAdminUsername || 'admin',
      fullName: 'Vladmir (Administrador)',
      role: 'ADMIN',
      active: true,
      permissions: {
        canDiscount: true,
        maxDiscountPercent: 100,
        canProcessReturns: true,
        canCancelSales: true,
        canViewPurchases: true,
        canStartInventoryCount: true,
      },
      createdAt: now,
      passwordHash: adminCred.hash,
      passwordSalt: adminCred.salt,
      isDemoData: !hasCustomAdmin,
    },
    {
      id: 'usr_benilson',
      username: 'benilson',
      fullName: 'Benilson (Farmacêutico)',
      role: 'SELLER',
      active: true,
      permissions: {
        canDiscount: true,
        maxDiscountPercent: 10,
        canProcessReturns: true,
        canCancelSales: false,
        canViewPurchases: true,
        canStartInventoryCount: true,
      },
      createdAt: now,
      passwordHash: benilsonCred.hash,
      passwordSalt: benilsonCred.salt,
      isDemoData: true,
    },
    {
      id: 'usr_sofia',
      username: 'sofia',
      fullName: 'Sofia Mendes (Vendedora)',
      role: 'SELLER',
      active: true,
      permissions: {
        canDiscount: true,
        maxDiscountPercent: 5,
        canProcessReturns: false,
        canCancelSales: false,
        canViewPurchases: false,
        canStartInventoryCount: true,
      },
      createdAt: now,
      passwordHash: sofiaCred.hash,
      passwordSalt: sofiaCred.salt,
      isDemoData: true,
    },
  ];

  const classes = defaultClasses();

  const suppliers: Supplier[] = [
    {
      id: 'sup_1',
      name: 'MedDistribuidora Atlântico Lda',
      nif: '5401928374',
      phone: '+244 923 410 220',
      email: 'encomendas@medatlantico.ao',
      address: 'Zona Industrial de Viana, Lote 14, Luanda',
      notes: 'Fornecedor principal de antibióticos e genéricos hospitalares (Demo)',
      active: true,
      createdAt: now,
      isDemoData: true,
    },
    {
      id: 'sup_2',
      name: 'PharmaSul Importações SA',
      nif: '5408837162',
      phone: '+244 912 780 550',
      email: 'comercial@pharmasul.ao',
      address: 'Av. Comandante Valódia 118, Luanda',
      notes: 'Especializado em cardiovasculares, antidiabéticos e suplementos (Demo)',
      active: true,
      createdAt: now,
      isDemoData: true,
    },
  ];

  const products: Product[] = [
    {
      id: 'prd_1',
      code: 'MED-001',
      barcode: '',
      name: 'Paracetamol Ben-U-Ron',
      activeIngredient: 'Paracetamol',
      classId: 'cls_analg',
      dosageForm: 'Comprimido',
      dosage: '1000 mg',
      unit: 'Caixa (18 comp.)',
      location: 'Prateleira A1',
      purchasePrice: 1200,
      salePrice: 1850,
      stock: 48,
      quarantineStock: 0,
      minStock: 15,
      batch: 'LT-2026A',
      expiryDate: addDaysISO(420),
      supplierId: 'sup_1',
      active: true,
      updatedAt: now,
      isDemoData: true,
    },
    {
      id: 'prd_2',
      code: 'MED-002',
      barcode: '',
      name: 'Amoxicilina + Ác. Clavulânico',
      activeIngredient: 'Amoxicilina / Ácido Clavulânico',
      classId: 'cls_antib',
      dosageForm: 'Comprimido Revestido',
      dosage: '875 mg + 125 mg',
      unit: 'Caixa (16 comp.)',
      location: 'Prateleira B2',
      purchasePrice: 3100,
      salePrice: 4600,
      stock: 22,
      quarantineStock: 1,
      minStock: 10,
      batch: 'AMX-904',
      expiryDate: addDaysISO(280),
      supplierId: 'sup_1',
      active: true,
      updatedAt: now,
      isDemoData: true,
    },
    {
      id: 'prd_3',
      code: 'MED-003',
      barcode: '',
      name: 'Ibuprofeno Brufen',
      activeIngredient: 'Ibuprofeno',
      classId: 'cls_antiinf',
      dosageForm: 'Comprimido',
      dosage: '600 mg',
      unit: 'Caixa (20 comp.)',
      location: 'Prateleira A3',
      purchasePrice: 1650,
      salePrice: 2500,
      stock: 6,
      quarantineStock: 0,
      minStock: 12,
      batch: 'IBU-412',
      expiryDate: addDaysISO(190),
      supplierId: 'sup_1',
      active: true,
      updatedAt: now,
      isDemoData: true,
    },
    {
      id: 'prd_4',
      code: 'MED-004',
      barcode: '',
      name: 'Omeprazol Generis',
      activeIngredient: 'Omeprazol',
      classId: 'cls_gastro',
      dosageForm: 'Cápsula Gastrorresistente',
      dosage: '20 mg',
      unit: 'Caixa (28 cáps.)',
      location: 'Prateleira C1',
      purchasePrice: 1400,
      salePrice: 2200,
      stock: 34,
      quarantineStock: 0,
      minStock: 10,
      batch: 'OMP-771',
      expiryDate: addDaysISO(32),
      supplierId: 'sup_2',
      active: true,
      updatedAt: now,
      isDemoData: true,
    },
    {
      id: 'prd_5',
      code: 'MED-005',
      barcode: '',
      name: 'Losartan + Hidroclorotiazida',
      activeIngredient: 'Losartan Potássico / HCTZ',
      classId: 'cls_cardio',
      dosageForm: 'Comprimido',
      dosage: '50 mg + 12.5 mg',
      unit: 'Caixa (28 comp.)',
      location: 'Prateleira D1',
      purchasePrice: 2800,
      salePrice: 4100,
      stock: 19,
      quarantineStock: 0,
      minStock: 8,
      batch: 'LOS-310',
      expiryDate: addDaysISO(365),
      supplierId: 'sup_2',
      active: true,
      updatedAt: now,
      isDemoData: true,
    },
    {
      id: 'prd_6',
      code: 'MED-006',
      barcode: '',
      name: 'Metformina Glucophage',
      activeIngredient: 'Cloridrato de Metformina',
      classId: 'cls_diab',
      dosageForm: 'Comprimido',
      dosage: '850 mg',
      unit: 'Caixa (30 comp.)',
      location: 'Prateleira D2',
      purchasePrice: 1900,
      salePrice: 2950,
      stock: 0,
      quarantineStock: 0,
      minStock: 10,
      batch: 'MET-118',
      expiryDate: addDaysISO(240),
      supplierId: 'sup_2',
      active: true,
      updatedAt: now,
      isDemoData: true,
    },
    {
      id: 'prd_7',
      code: 'MED-007',
      barcode: '',
      name: 'Cetirizina Zyrtec',
      activeIngredient: 'Dicloridrato de Cetirizina',
      classId: 'cls_alerg',
      dosageForm: 'Comprimido',
      dosage: '10 mg',
      unit: 'Caixa (20 comp.)',
      location: 'Prateleira C4',
      purchasePrice: 1500,
      salePrice: 2400,
      stock: 27,
      quarantineStock: 0,
      minStock: 8,
      batch: 'CET-520',
      expiryDate: addDaysISO(310),
      supplierId: 'sup_1',
      active: true,
      updatedAt: now,
      isDemoData: true,
    },
    {
      id: 'prd_8',
      code: 'MED-008',
      barcode: '',
      name: 'Vitamina C + Zinco Redoxon',
      activeIngredient: 'Ácido Ascórbico / Zinco',
      classId: 'cls_vit',
      dosageForm: 'Comprimido Efervescente',
      dosage: '1000 mg + 10 mg',
      unit: 'Tubo (15 comp.)',
      location: 'Prateleira E1',
      purchasePrice: 2100,
      salePrice: 3300,
      stock: 15,
      quarantineStock: 0,
      minStock: 10,
      batch: 'VIT-808',
      expiryDate: addDaysISO(45),
      supplierId: 'sup_2',
      active: true,
      updatedAt: now,
      isDemoData: true,
    },
    {
      id: 'prd_9',
      code: 'MAT-001',
      barcode: '',
      name: 'Luvas de Exame Nitrilo M',
      activeIngredient: 'Nitrilo sem pó',
      classId: 'cls_mat',
      dosageForm: 'Consumível',
      dosage: 'Tamanho M',
      unit: 'Caixa (100 un.)',
      location: 'Prateleira F1',
      purchasePrice: 3400,
      salePrice: 5200,
      stock: 12,
      quarantineStock: 0,
      minStock: 5,
      batch: 'LUV-092',
      expiryDate: addDaysISO(720),
      supplierId: 'sup_1',
      active: true,
      updatedAt: now,
      isDemoData: true,
    },
  ];

  const customers: Customer[] = [
    {
      id: 'cus_1',
      name: 'Clínica Esperança Médica Lda',
      nif: '5410293847',
      phone: '+244 924 111 890',
      email: 'compras@clinicaesperanca.ao',
      address: 'Rua Rei Katyavala 45, Maculusso, Luanda',
      notes: 'Cliente empresarial com faturação mensal (Demo)',
      createdAt: now,
      isDemoData: true,
    },
    {
      id: 'cus_2',
      name: 'Mateus António Domingos',
      nif: '004829103LA042',
      phone: '+244 931 554 019',
      email: 'mateus.domingos@email.ao',
      address: 'Bairro Talatona, Condomínio Sol 12',
      notes: 'Paciente crónico — hipertensão (Demo)',
      createdAt: now,
      isDemoData: true,
    },
  ];

  const purchases: Purchase[] = [
    {
      id: 'pur_1',
      internalNumber: 'CP 2026/0001',
      supplierId: 'sup_1',
      supplierName: 'MedDistribuidora Atlântico Lda',
      documentNumber: 'FAT-FORN-8812',
      documentDate: twoDaysAgo,
      items: [
        {
          productId: 'prd_1',
          productCode: 'MED-001',
          productName: 'Paracetamol Ben-U-Ron',
          quantity: 50,
          unitCost: 1200,
          subtotal: 60000,
          batch: 'LT-2026A',
          expiryDate: addDaysISO(420),
        },
        {
          productId: 'prd_2',
          productCode: 'MED-002',
          productName: 'Amoxicilina + Ác. Clavulânico',
          quantity: 25,
          unitCost: 3100,
          subtotal: 77500,
          batch: 'AMX-904',
          expiryDate: addDaysISO(280),
        },
      ],
      totalAmount: 137500,
      notes: 'Reposição inicial de stock semanal (Demo)',
      userId: 'usr_admin',
      userName: 'Vladmir (Administrador)',
      createdAt: `${twoDaysAgo}T09:15:00.000Z`,
      isDemoData: true,
    },
  ];

  const sales: Sale[] = [
    {
      id: 'sal_1',
      documentNumber: 'FT 2026/0001',
      type: 'FATURA',
      status: 'PARCIALMENTE_DEVOLVIDA',
      customerId: 'cus_2',
      customerName: 'Mateus António Domingos',
      customerNif: '004829103LA042',
      isCommonConsumer: false,
      paymentMethod: 'DINHEIRO',
      items: [
        {
          productId: 'prd_5',
          productCode: 'MED-005',
          productName: 'Losartan + Hidroclorotiazida',
          activeIngredient: 'Losartan Potássico / HCTZ',
          unit: 'Caixa (28 comp.)',
          batch: 'LOS-310',
          expiryDate: addDaysISO(365),
          quantity: 2,
          returnedQuantity: 0,
          unitPrice: 4100,
          discountPercent: 0,
          subtotal: 8200,
        },
        {
          productId: 'prd_2',
          productCode: 'MED-002',
          productName: 'Amoxicilina + Ác. Clavulânico',
          activeIngredient: 'Amoxicilina / Ácido Clavulânico',
          unit: 'Caixa (16 comp.)',
          batch: 'AMX-904',
          expiryDate: addDaysISO(280),
          quantity: 2,
          returnedQuantity: 1,
          unitPrice: 4600,
          discountPercent: 0,
          subtotal: 9200,
        },
      ],
      subtotal: 17400,
      discountTotal: 0,
      totalAmount: 17400,
      notes: 'Venda demonstrativa com devolução parcial associada',
      sellerId: 'usr_benilson',
      sellerName: 'Benilson (Farmacêutico)',
      date: yesterday,
      time: '10:25:10',
      createdAt: `${yesterday}T10:25:10.000Z`,
      isDemoData: true,
    },
    {
      id: 'sal_2',
      documentNumber: 'FT 2026/0002',
      type: 'FATURA',
      status: 'EMITIDA',
      customerId: null,
      customerName: 'Consumidor Comum',
      customerNif: '999999999',
      isCommonConsumer: true,
      paymentMethod: 'MULTICAIXA',
      items: [
        {
          productId: 'prd_1',
          productCode: 'MED-001',
          productName: 'Paracetamol Ben-U-Ron',
          activeIngredient: 'Paracetamol',
          unit: 'Caixa (18 comp.)',
          batch: 'LT-2026A',
          expiryDate: addDaysISO(420),
          quantity: 2,
          returnedQuantity: 0,
          unitPrice: 1850,
          discountPercent: 0,
          subtotal: 3700,
        },
        {
          productId: 'prd_8',
          productCode: 'MED-008',
          productName: 'Vitamina C + Zinco Redoxon',
          activeIngredient: 'Ácido Ascórbico / Zinco',
          unit: 'Tubo (15 comp.)',
          batch: 'VIT-808',
          expiryDate: addDaysISO(45),
          quantity: 1,
          returnedQuantity: 0,
          unitPrice: 3300,
          discountPercent: 0,
          subtotal: 3300,
        },
      ],
      subtotal: 7000,
      discountTotal: 0,
      totalAmount: 7000,
      notes: '',
      sellerId: 'usr_benilson',
      sellerName: 'Benilson (Farmacêutico)',
      date: today,
      time: '09:12:40',
      createdAt: `${today}T09:12:40.000Z`,
      isDemoData: true,
    },
    {
      id: 'sal_3',
      documentNumber: 'FT 2026/0003',
      type: 'FATURA',
      status: 'EMITIDA',
      customerId: 'cus_1',
      customerName: 'Clínica Esperança Médica Lda',
      customerNif: '5410293847',
      isCommonConsumer: false,
      paymentMethod: 'DINHEIRO',
      items: [
        {
          productId: 'prd_9',
          productCode: 'MAT-001',
          productName: 'Luvas de Exame Nitrilo M',
          activeIngredient: 'Nitrilo sem pó',
          unit: 'Caixa (100 un.)',
          batch: 'LUV-092',
          expiryDate: addDaysISO(720),
          quantity: 3,
          returnedQuantity: 0,
          unitPrice: 5200,
          discountPercent: 5,
          subtotal: 14820,
        },
      ],
      subtotal: 15600,
      discountTotal: 780,
      totalAmount: 14820,
      notes: 'Desconto autorizado 5% (Demo)',
      sellerId: 'usr_sofia',
      sellerName: 'Sofia Mendes (Vendedora)',
      date: today,
      time: '10:05:18',
      createdAt: `${today}T10:05:18.000Z`,
      isDemoData: true,
    },
    {
      id: 'sal_4',
      documentNumber: 'PF 2026/0001',
      type: 'PROFORMA',
      status: 'PROFORMA',
      customerId: 'cus_1',
      customerName: 'Clínica Esperança Médica Lda',
      customerNif: '5410293847',
      isCommonConsumer: false,
      paymentMethod: 'TRANSFERENCIA',
      items: [
        {
          productId: 'prd_6',
          productCode: 'MED-006',
          productName: 'Metformina Glucophage',
          activeIngredient: 'Cloridrato de Metformina',
          unit: 'Caixa (30 comp.)',
          batch: 'MET-118',
          expiryDate: addDaysISO(240),
          quantity: 10,
          returnedQuantity: 0,
          unitPrice: 2950,
          discountPercent: 0,
          subtotal: 29500,
        },
      ],
      subtotal: 29500,
      discountTotal: 0,
      totalAmount: 29500,
      notes: 'Proforma emitida por falta de stock (aguarda reposição)',
      sellerId: 'usr_benilson',
      sellerName: 'Benilson (Farmacêutico)',
      date: today,
      time: '10:40:00',
      createdAt: `${today}T10:40:00.000Z`,
      isDemoData: true,
    },
  ];

  const returns: SaleReturn[] = [
    {
      id: 'ret_1',
      documentNumber: 'NC 2026/0001',
      type: 'DEVOLUCAO',
      originalSaleId: 'sal_1',
      originalDocumentNumber: 'FT 2026/0001',
      originalPaymentMethod: 'DINHEIRO',
      originalSellerId: 'usr_benilson',
      originalSellerName: 'Benilson (Farmacêutico)',
      reason: 'Embalagem violada pelo cliente — encaminhada para quarentena (Demo)',
      items: [
        {
          productId: 'prd_2',
          productCode: 'MED-002',
          productName: 'Amoxicilina + Ác. Clavulânico',
          quantity: 1,
          unitPrice: 4600,
          refundAmount: 4600,
          condition: 'QUARANTINE',
        },
      ],
      totalRefund: 4600,
      userId: 'usr_benilson',
      userName: 'Benilson (Farmacêutico)',
      date: yesterday,
      createdAt: `${yesterday}T14:10:00.000Z`,
      isDemoData: true,
    },
  ];

  const auditLogs: AuditLogEntry[] = [
    {
      id: 'aud_1',
      timestamp: `${twoDaysAgo}T09:15:00.000Z`,
      userId: 'usr_admin',
      username: 'admin',
      userName: 'Vladmir (Administrador)',
      action: 'COMPRA_REGISTADA',
      entityType: 'COMPRA',
      entityId: 'pur_1',
      description: 'Compra CP 2026/0001 (Doc. FAT-FORN-8812) confirmada e adicionada ao stock.',
    },
    {
      id: 'aud_2',
      timestamp: `${yesterday}T14:10:00.000Z`,
      userId: 'usr_benilson',
      username: 'benilson',
      userName: 'Benilson (Farmacêutico)',
      action: 'DEVOLUCAO_REGISTADA',
      entityType: 'DEVOLUCAO',
      entityId: 'ret_1',
      description: 'Nota de Crédito NC 2026/0001 emitida sobre FT 2026/0001 (1x Amoxicilina para quarentena).',
    },
  ];

  const settings = defaultSettings(1);
  settings.series.invoiceNext = 4;
  settings.series.proformaNext = 2;
  settings.series.creditNoteNext = 2;
  settings.series.purchaseNext = 2;

  return {
    version: 1,
    lastUpdated: now,
    users,
    classes,
    products,
    suppliers,
    purchases,
    customers,
    sales,
    returns,
    inventories: [],
    sellerClosings: [],
    generalClosings: [],
    settings,
    auditLogs,
  };
}

export function clearDemoFromDatabase(db: DatabaseSchema, actingUser: StoredUser): void {
  const adminUsers = db.users.filter((u) => !u.isDemoData || u.id === actingUser.id);
  for (const u of adminUsers) {
    if (u.id === actingUser.id) {
      u.isDemoData = false;
    }
  }
  db.users = adminUsers;
  db.products = db.products.filter((p) => !p.isDemoData);
  db.suppliers = db.suppliers.filter((s) => !s.isDemoData);
  db.purchases = db.purchases.filter((p) => !p.isDemoData);
  db.customers = db.customers.filter((c) => !c.isDemoData);
  db.sales = db.sales.filter((s) => !s.isDemoData);
  db.returns = db.returns.filter((r) => !r.isDemoData);
  db.inventories = db.inventories.filter((i) => !i.isDemoData);
  db.sellerClosings = db.sellerClosings.filter((c) => !c.isDemoData);
  db.generalClosings = db.generalClosings.filter((g) => !g.isDemoData);
  appendAudit(
    db,
    actingUser,
    'MODO_PRODUCAO_LIMPEZA_DEMO',
    'SISTEMA',
    'production',
    'Dados de demonstração removidos. Sistema pronto para operação real.'
  );
}

// =========================================================================
// SQLITE & POSTGRESQL RELATIONAL STORAGE ENGINE
// =========================================================================

let engine: DbEngine = 'sqlite';
let sqliteDb: DatabaseSync | null = null;
let pgPool: Pool | null = null;
let initialized = false;
let writeQueue: Promise<unknown> = Promise.resolve();

function serializeSnapshots(db: DatabaseSchema) {
  return {
    settings: JSON.stringify({ version: db.version, lastUpdated: db.lastUpdated, settings: db.settings }),
    users: JSON.stringify(db.users),
    classes: JSON.stringify(db.classes),
    suppliers: JSON.stringify(db.suppliers),
    products: JSON.stringify(db.products),
    customers: JSON.stringify(db.customers),
    purchases: JSON.stringify(db.purchases),
    sales: JSON.stringify(db.sales),
    returns: JSON.stringify(db.returns),
    inventories: JSON.stringify(db.inventories),
    sellerClosings: JSON.stringify(db.sellerClosings),
    generalClosings: JSON.stringify(db.generalClosings),
    auditLogs: JSON.stringify(db.auditLogs),
  };
}

export const PG_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS app_settings (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    last_updated TEXT NOT NULL,
    data JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    username TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL,
    active BOOLEAN NOT NULL,
    permissions JSONB NOT NULL,
    created_at TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    tokens_valid_after BIGINT,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_after BIGINT`,
  `CREATE TABLE IF NOT EXISTS classes (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    active BOOLEAN NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    name TEXT NOT NULL,
    nif TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    address TEXT NOT NULL,
    notes TEXT NOT NULL,
    active BOOLEAN NOT NULL,
    created_at TEXT NOT NULL,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    code TEXT UNIQUE NOT NULL,
    barcode TEXT,
    name TEXT NOT NULL,
    active_ingredient TEXT NOT NULL,
    class_id TEXT NOT NULL,
    dosage_form TEXT NOT NULL,
    dosage TEXT NOT NULL,
    unit TEXT NOT NULL,
    location TEXT NOT NULL,
    purchase_price DOUBLE PRECISION NOT NULL,
    sale_price DOUBLE PRECISION NOT NULL,
    stock INTEGER NOT NULL,
    quarantine_stock INTEGER NOT NULL,
    min_stock INTEGER NOT NULL,
    batch TEXT NOT NULL,
    expiry_date TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    active BOOLEAN NOT NULL,
    updated_at TEXT NOT NULL,
    tax_code TEXT,
    tax_rate DOUBLE PRECISION,
    tax_exemption_code TEXT,
    tax_exemption_reason TEXT,
    fiscal_meta JSONB,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_code TEXT`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_rate DOUBLE PRECISION`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_exemption_code TEXT`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_exemption_reason TEXT`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS fiscal_meta JSONB`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique ON products (UPPER(barcode)) WHERE barcode IS NOT NULL AND barcode <> ''`,
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    name TEXT NOT NULL,
    nif TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    address TEXT NOT NULL,
    notes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    internal_number TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    supplier_name TEXT NOT NULL,
    document_number TEXT NOT NULL,
    document_date TEXT NOT NULL,
    items JSONB NOT NULL,
    total_amount DOUBLE PRECISION NOT NULL,
    notes TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    fiscal_data JSONB,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS fiscal_data JSONB`,
  `CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    document_number TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT NOT NULL,
    customer_nif TEXT NOT NULL,
    is_common_consumer BOOLEAN NOT NULL,
    payment_method TEXT NOT NULL,
    items JSONB NOT NULL,
    subtotal DOUBLE PRECISION NOT NULL,
    discount_total DOUBLE PRECISION NOT NULL,
    total_amount DOUBLE PRECISION NOT NULL,
    notes TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    seller_name TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    created_at TEXT NOT NULL,
    converted_to_sale_id TEXT,
    converted_document_number TEXT,
    source_proforma_id TEXT,
    source_proforma_number TEXT,
    cash_register_id TEXT,
    fiscal_data JSONB,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS cash_register_id TEXT`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS fiscal_data JSONB`,
  `CREATE TABLE IF NOT EXISTS returns (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    document_number TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    original_sale_id TEXT NOT NULL,
    original_document_number TEXT NOT NULL,
    original_payment_method TEXT NOT NULL,
    original_seller_id TEXT NOT NULL,
    original_seller_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    items JSONB NOT NULL,
    total_refund DOUBLE PRECISION NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    cash_register_id TEXT,
    fiscal_data JSONB,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `ALTER TABLE returns ADD COLUMN IF NOT EXISTS cash_register_id TEXT`,
  `ALTER TABLE returns ADD COLUMN IF NOT EXISTS fiscal_data JSONB`,
  `CREATE TABLE IF NOT EXISTS inventories (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    reference_number TEXT UNIQUE NOT NULL,
    scope TEXT NOT NULL,
    scope_filter TEXT NOT NULL,
    status TEXT NOT NULL,
    items JSONB NOT NULL,
    total_discrepancies INTEGER NOT NULL,
    total_shortage_units INTEGER NOT NULL,
    total_surplus_units INTEGER NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT NOT NULL,
    counted_by_id TEXT NOT NULL,
    counted_by_name TEXT NOT NULL,
    counted_at TEXT NOT NULL,
    approved_by_id TEXT,
    approved_by_name TEXT,
    approved_at TEXT,
    rejected_reason TEXT,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `CREATE TABLE IF NOT EXISTS seller_closings (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'FECHADO',
    date TEXT NOT NULL,
    shift_number INTEGER NOT NULL,
    shift_label TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    seller_name TEXT NOT NULL,
    opening_balance DOUBLE PRECISION NOT NULL,
    opened_at TEXT,
    opening_notes TEXT,
    sales_count INTEGER NOT NULL,
    sales_by_payment JSONB NOT NULL,
    gross_sales_total DOUBLE PRECISION NOT NULL,
    returns_total DOUBLE PRECISION NOT NULL,
    returns_cash_total DOUBLE PRECISION NOT NULL,
    cancellations_count INTEGER NOT NULL,
    cancellations_total DOUBLE PRECISION NOT NULL,
    expected_cash DOUBLE PRECISION NOT NULL,
    expected_total DOUBLE PRECISION NOT NULL,
    counted_cash DOUBLE PRECISION NOT NULL,
    difference DOUBLE PRECISION NOT NULL,
    notes TEXT NOT NULL,
    included_sale_ids JSONB NOT NULL,
    included_return_ids JSONB NOT NULL,
    closed_by_id TEXT NOT NULL,
    closed_by_name TEXT NOT NULL,
    closed_at TEXT,
    created_at TEXT NOT NULL,
    general_closing_id TEXT,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `ALTER TABLE seller_closings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'FECHADO'`,
  `ALTER TABLE seller_closings ADD COLUMN IF NOT EXISTS opened_at TEXT`,
  `ALTER TABLE seller_closings ADD COLUMN IF NOT EXISTS opening_notes TEXT`,
  `ALTER TABLE seller_closings ADD COLUMN IF NOT EXISTS closed_at TEXT`,
  `CREATE TABLE IF NOT EXISTS general_closings (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    reference_number TEXT UNIQUE NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL,
    seller_closing_ids JSONB NOT NULL,
    sales_count INTEGER NOT NULL,
    sales_by_payment JSONB NOT NULL,
    total_sales DOUBLE PRECISION NOT NULL,
    returns_total DOUBLE PRECISION NOT NULL,
    cancellations_count INTEGER NOT NULL,
    cancellations_total DOUBLE PRECISION NOT NULL,
    total_expected_cash DOUBLE PRECISION NOT NULL,
    total_counted_cash DOUBLE PRECISION NOT NULL,
    total_difference DOUBLE PRECISION NOT NULL,
    notes TEXT NOT NULL,
    closed_by_id TEXT NOT NULL,
    closed_by_name TEXT NOT NULL,
    closed_at TEXT NOT NULL,
    corrections JSONB NOT NULL,
    is_demo_data BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    description TEXT NOT NULL,
    details JSONB
  )`,
  `CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    revoked_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens (expires_at)`,
];

const SQLITE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_updated TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL,
  permissions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  tokens_valid_after INTEGER,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  active INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  nif TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  notes TEXT NOT NULL,
  active INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  code TEXT UNIQUE NOT NULL,
  barcode TEXT,
  name TEXT NOT NULL,
  active_ingredient TEXT NOT NULL,
  class_id TEXT NOT NULL,
  dosage_form TEXT NOT NULL,
  dosage TEXT NOT NULL,
  unit TEXT NOT NULL,
  location TEXT NOT NULL,
  purchase_price REAL NOT NULL,
  sale_price REAL NOT NULL,
  stock INTEGER NOT NULL,
  quarantine_stock INTEGER NOT NULL,
  min_stock INTEGER NOT NULL,
  batch TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  active INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  tax_code TEXT,
  tax_rate REAL,
  tax_exemption_code TEXT,
  tax_exemption_reason TEXT,
  fiscal_meta TEXT,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  nif TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  internal_number TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  document_number TEXT NOT NULL,
  document_date TEXT NOT NULL,
  items TEXT NOT NULL,
  total_amount REAL NOT NULL,
  notes TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fiscal_data TEXT,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  document_number TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  customer_id TEXT,
  customer_name TEXT NOT NULL,
  customer_nif TEXT NOT NULL,
  is_common_consumer INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  items TEXT NOT NULL,
  subtotal REAL NOT NULL,
  discount_total REAL NOT NULL,
  total_amount REAL NOT NULL,
  notes TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  created_at TEXT NOT NULL,
  converted_to_sale_id TEXT,
  converted_document_number TEXT,
  source_proforma_id TEXT,
  source_proforma_number TEXT,
  cash_register_id TEXT,
  fiscal_data TEXT,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS returns (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  document_number TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  original_sale_id TEXT NOT NULL,
  original_document_number TEXT NOT NULL,
  original_payment_method TEXT NOT NULL,
  original_seller_id TEXT NOT NULL,
  original_seller_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  items TEXT NOT NULL,
  total_refund REAL NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cash_register_id TEXT,
  fiscal_data TEXT,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventories (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  reference_number TEXT UNIQUE NOT NULL,
  scope TEXT NOT NULL,
  scope_filter TEXT NOT NULL,
  status TEXT NOT NULL,
  items TEXT NOT NULL,
  total_discrepancies INTEGER NOT NULL,
  total_shortage_units INTEGER NOT NULL,
  total_surplus_units INTEGER NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT NOT NULL,
  counted_by_id TEXT NOT NULL,
  counted_by_name TEXT NOT NULL,
  counted_at TEXT NOT NULL,
  approved_by_id TEXT,
  approved_by_name TEXT,
  approved_at TEXT,
  rejected_reason TEXT,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS seller_closings (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'FECHADO',
  date TEXT NOT NULL,
  shift_number INTEGER NOT NULL,
  shift_label TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  opening_balance REAL NOT NULL,
  opened_at TEXT,
  opening_notes TEXT,
  sales_count INTEGER NOT NULL,
  sales_by_payment TEXT NOT NULL,
  gross_sales_total REAL NOT NULL,
  returns_total REAL NOT NULL,
  returns_cash_total REAL NOT NULL,
  cancellations_count INTEGER NOT NULL,
  cancellations_total REAL NOT NULL,
  expected_cash REAL NOT NULL,
  expected_total REAL NOT NULL,
  counted_cash REAL NOT NULL,
  difference REAL NOT NULL,
  notes TEXT NOT NULL,
  included_sale_ids TEXT NOT NULL,
  included_return_ids TEXT NOT NULL,
  closed_by_id TEXT NOT NULL,
  closed_by_name TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  general_closing_id TEXT,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS general_closings (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  reference_number TEXT UNIQUE NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL,
  seller_closing_ids TEXT NOT NULL,
  sales_count INTEGER NOT NULL,
  sales_by_payment TEXT NOT NULL,
  total_sales REAL NOT NULL,
  returns_total REAL NOT NULL,
  cancellations_count INTEGER NOT NULL,
  cancellations_total REAL NOT NULL,
  total_expected_cash REAL NOT NULL,
  total_counted_cash REAL NOT NULL,
  total_difference REAL NOT NULL,
  notes TEXT NOT NULL,
  closed_by_id TEXT NOT NULL,
  closed_by_name TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  corrections TEXT NOT NULL,
  is_demo_data INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  description TEXT NOT NULL,
  details TEXT
);

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens (expires_at);
`;

function parseJsonField<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

function readDbFromSqliteHandle(handle: DatabaseSync): DatabaseSchema {
  const settingRow = handle
    .prepare('SELECT version, last_updated, data FROM app_settings WHERE id = ?')
    .get('default') as { version: number; last_updated: string; data: string } | undefined;

  const settings = normalizeSettings(
    settingRow ? (JSON.parse(settingRow.data) as PharmacySettings) : undefined,
    1
  );

  const users = (
    handle.prepare('SELECT * FROM users ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => ({
    id: r.id,
    username: r.username,
    fullName: r.full_name,
    role: r.role,
    active: Boolean(r.active),
    permissions: parseJsonField(r.permissions, {} as StoredUser['permissions']),
    createdAt: r.created_at,
    passwordHash: r.password_hash,
    passwordSalt: r.password_salt,
    ...(r.tokens_valid_after ? { tokensValidAfter: Number(r.tokens_valid_after) } : {}),
    isDemoData: Boolean(r.is_demo_data),
  })) as StoredUser[];

  const classes = (
    handle.prepare('SELECT * FROM classes ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    active: Boolean(r.active),
  }));

  const suppliers = (
    handle.prepare('SELECT * FROM suppliers ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => ({
    id: r.id,
    name: r.name,
    nif: r.nif,
    phone: r.phone,
    email: r.email,
    address: r.address,
    notes: r.notes,
    active: Boolean(r.active),
    createdAt: r.created_at,
    isDemoData: Boolean(r.is_demo_data),
  }));

  const products = (
    handle.prepare('SELECT * FROM products ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => {
    const fiscalMeta = parseJsonField<Record<string, any>>(r.fiscal_meta, {});
    return {
      id: r.id,
      code: r.code,
      barcode: r.barcode ? String(r.barcode).trim() : '',
      name: r.name,
      activeIngredient: r.active_ingredient,
      classId: r.class_id,
      dosageForm: r.dosage_form,
      dosage: r.dosage,
      unit: r.unit,
      location: r.location,
      purchasePrice: Number(r.purchase_price),
      salePrice: Number(r.sale_price),
      stock: Number(r.stock),
      quarantineStock: Number(r.quarantine_stock),
      minStock: Number(r.min_stock),
      batch: r.batch,
      expiryDate: r.expiry_date,
      supplierId: r.supplier_id,
      active: Boolean(r.active),
      updatedAt: r.updated_at,
      taxType: (fiscalMeta.taxType as Product['taxType']) || 'IVA',
      taxCode: (r.tax_code as Product['taxCode']) || 'NAO_CONFIGURADO',
      taxRate: r.tax_rate !== null && r.tax_rate !== undefined ? Number(r.tax_rate) : null,
      taxExemptionCode: r.tax_exemption_code || '',
      taxExemptionReason: r.tax_exemption_reason || '',
      ...(fiscalMeta.priceIncludesTax !== undefined ? { priceIncludesTax: fiscalMeta.priceIncludesTax } : {}),
      ...(fiscalMeta.fiscalValidationState ? { fiscalValidationState: fiscalMeta.fiscalValidationState } : {}),
      ...(fiscalMeta.taxRuleId ? { taxRuleId: fiscalMeta.taxRuleId } : {}),
      ...(Array.isArray(fiscalMeta.batchTaxes) ? { batchTaxes: fiscalMeta.batchTaxes } : {}),
      isDemoData: Boolean(r.is_demo_data),
    };
  });

  const customers = (
    handle.prepare('SELECT * FROM customers ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => ({
    id: r.id,
    name: r.name,
    nif: r.nif,
    phone: r.phone,
    email: r.email,
    address: r.address,
    notes: r.notes,
    createdAt: r.created_at,
    isDemoData: Boolean(r.is_demo_data),
  }));

  const purchases = (
    handle.prepare('SELECT * FROM purchases ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => {
    const fiscal = parseJsonField<Record<string, any>>(r.fiscal_data, {});
    return {
      ...fiscal,
      id: r.id,
      internalNumber: r.internal_number,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      documentNumber: r.document_number,
      documentDate: r.document_date,
      items: parseJsonField(r.items, []),
      totalAmount: Number(r.total_amount),
      notes: r.notes,
      userId: r.user_id,
      userName: r.user_name,
      createdAt: r.created_at,
      isDemoData: Boolean(r.is_demo_data),
    };
  });

  const sales = (
    handle.prepare('SELECT * FROM sales ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => {
    const fiscal = parseJsonField<Record<string, any>>(r.fiscal_data, {});
    return {
      ...fiscal,
      id: r.id,
      documentNumber: r.document_number,
      type: r.type,
      status: r.status,
      customerId: r.customer_id || null,
      customerName: r.customer_name,
      customerNif: r.customer_nif,
      isCommonConsumer: Boolean(r.is_common_consumer),
      paymentMethod: r.payment_method,
      items: parseJsonField(r.items, []),
      subtotal: Number(r.subtotal),
      discountTotal: Number(r.discount_total),
      totalAmount: Number(r.total_amount),
      notes: r.notes,
      sellerId: r.seller_id,
      sellerName: r.seller_name,
      date: r.date,
      time: r.time,
      createdAt: r.created_at,
      ...(r.converted_to_sale_id ? { convertedToSaleId: r.converted_to_sale_id } : {}),
      ...(r.converted_document_number ? { convertedDocumentNumber: r.converted_document_number } : {}),
      ...(r.source_proforma_id ? { sourceProformaId: r.source_proforma_id } : {}),
      ...(r.source_proforma_number ? { sourceProformaNumber: r.source_proforma_number } : {}),
      ...(r.cash_register_id ? { cashRegisterId: r.cash_register_id } : {}),
      isDemoData: Boolean(r.is_demo_data),
    };
  });

  const returns = (
    handle.prepare('SELECT * FROM returns ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => {
    const fiscal = parseJsonField<Record<string, any>>(r.fiscal_data, {});
    return {
      ...fiscal,
      id: r.id,
      documentNumber: r.document_number,
      type: r.type,
      originalSaleId: r.original_sale_id,
      originalDocumentNumber: r.original_document_number,
      originalPaymentMethod: r.original_payment_method,
      originalSellerId: r.original_seller_id,
      originalSellerName: r.original_seller_name,
      reason: r.reason,
      items: parseJsonField(r.items, []),
      totalRefund: Number(r.total_refund),
      userId: r.user_id,
      userName: r.user_name,
      date: r.date,
      createdAt: r.created_at,
      ...(r.cash_register_id ? { cashRegisterId: r.cash_register_id } : {}),
      isDemoData: Boolean(r.is_demo_data),
    };
  });

  const inventories = (
    handle.prepare('SELECT * FROM inventories ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => ({
    id: r.id,
    referenceNumber: r.reference_number,
    scope: r.scope,
    scopeFilter: r.scope_filter,
    status: r.status,
    items: parseJsonField(r.items, []),
    totalDiscrepancies: Number(r.total_discrepancies),
    totalShortageUnits: Number(r.total_shortage_units),
    totalSurplusUnits: Number(r.total_surplus_units),
    reason: r.reason,
    notes: r.notes,
    countedById: r.counted_by_id,
    countedByName: r.counted_by_name,
    countedAt: r.counted_at,
    ...(r.approved_by_id ? { approvedById: r.approved_by_id } : {}),
    ...(r.approved_by_name ? { approvedByName: r.approved_by_name } : {}),
    ...(r.approved_at ? { approvedAt: r.approved_at } : {}),
    ...(r.rejected_reason ? { rejectedReason: r.rejected_reason } : {}),
    isDemoData: Boolean(r.is_demo_data),
  }));

  const sellerClosings = (
    handle.prepare('SELECT * FROM seller_closings ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => {
    const status = r.status === 'ABERTO' ? ('ABERTO' as const) : ('FECHADO' as const);
    return {
      id: r.id,
      status,
      date: r.date,
      shiftNumber: Number(r.shift_number) as 1 | 2,
      shiftLabel: r.shift_label,
      sellerId: r.seller_id,
      sellerName: r.seller_name,
      openingBalance: Number(r.opening_balance),
      openedAt: r.opened_at || r.created_at,
      openingNotes: r.opening_notes || '',
      salesCount: Number(r.sales_count),
      salesByPayment: parseJsonField(r.sales_by_payment, {
        DINHEIRO: 0,
        MULTICAIXA: 0,
        TRANSFERENCIA: 0,
        SEGURO: 0,
      }),
      grossSalesTotal: Number(r.gross_sales_total),
      returnsTotal: Number(r.returns_total),
      returnsCashTotal: Number(r.returns_cash_total),
      cancellationsCount: Number(r.cancellations_count),
      cancellationsTotal: Number(r.cancellations_total),
      expectedCash: Number(r.expected_cash),
      expectedTotal: Number(r.expected_total),
      countedCash: Number(r.counted_cash),
      difference: Number(r.difference),
      notes: r.notes,
      includedSaleIds: parseJsonField(r.included_sale_ids, []),
      includedReturnIds: parseJsonField(r.included_return_ids, []),
      closedById: r.closed_by_id,
      closedByName: r.closed_by_name,
      ...(r.closed_at ? { closedAt: r.closed_at } : status === 'FECHADO' ? { closedAt: r.created_at } : {}),
      createdAt: r.created_at,
      ...(r.general_closing_id ? { generalClosingId: r.general_closing_id } : {}),
      isDemoData: Boolean(r.is_demo_data),
    };
  });

  const generalClosings = (
    handle.prepare('SELECT * FROM general_closings ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => ({
    id: r.id,
    referenceNumber: r.reference_number,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    sellerClosingIds: parseJsonField(r.seller_closing_ids, []),
    salesCount: Number(r.sales_count),
    salesByPayment: parseJsonField(r.sales_by_payment, {
      DINHEIRO: 0,
      MULTICAIXA: 0,
      TRANSFERENCIA: 0,
      SEGURO: 0,
    }),
    totalSales: Number(r.total_sales),
    returnsTotal: Number(r.returns_total),
    cancellationsCount: Number(r.cancellations_count),
    cancellationsTotal: Number(r.cancellations_total),
    totalExpectedCash: Number(r.total_expected_cash),
    totalCountedCash: Number(r.total_counted_cash),
    totalDifference: Number(r.total_difference),
    notes: r.notes,
    closedById: r.closed_by_id,
    closedByName: r.closed_by_name,
    closedAt: r.closed_at,
    corrections: parseJsonField(r.corrections, []),
    isDemoData: Boolean(r.is_demo_data),
  }));

  const auditLogs = (
    handle.prepare('SELECT * FROM audit_logs ORDER BY sort_order ASC').all() as Array<Record<string, any>>
  ).map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    userId: r.user_id,
    username: r.username,
    userName: r.user_name,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    description: r.description,
    ...(r.details ? { details: parseJsonField(r.details, undefined) } : {}),
  }));

  return {
    version: settingRow?.version ?? 1,
    lastUpdated: settingRow?.last_updated ?? new Date().toISOString(),
    users,
    classes,
    products,
    suppliers,
    purchases,
    customers,
    sales,
    returns,
    inventories,
    sellerClosings,
    generalClosings,
    settings,
    auditLogs,
  };
}

function readDbFromSqlite(): DatabaseSchema {
  if (!sqliteDb) throw new Error('SQLite database not initialized.');
  return readDbFromSqliteHandle(sqliteDb);
}

export function readSqliteFileSnapshot(filePath: string): DatabaseSchema {
  const resolved = path.resolve(filePath);
  const handle = new DatabaseSync(resolved, { readOnly: true });
  try {
    return readDbFromSqliteHandle(handle);
  } finally {
    handle.close();
  }
}

function writeDbToSqlite(db: DatabaseSchema, prev?: ReturnType<typeof serializeSnapshots>): void {
  if (!sqliteDb) throw new Error('SQLite database not initialized.');
  db.lastUpdated = new Date().toISOString();
  const next = serializeSnapshots(db);

  if (!prev || prev.settings !== next.settings) {
    sqliteDb.prepare('DELETE FROM app_settings').run();
    sqliteDb
      .prepare('INSERT INTO app_settings (id, version, last_updated, data) VALUES (?, ?, ?, ?)')
      .run('default', db.version, db.lastUpdated, JSON.stringify(db.settings));
  }

  if (!prev || prev.users !== next.users) {
    sqliteDb.prepare('DELETE FROM users').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO users (id, sort_order, username, full_name, role, active, permissions, created_at, password_hash, password_salt, tokens_valid_after, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.users.forEach((u, idx) => {
      stmt.run(
        u.id,
        idx,
        u.username,
        u.fullName,
        u.role,
        u.active ? 1 : 0,
        JSON.stringify(u.permissions),
        u.createdAt,
        u.passwordHash,
        u.passwordSalt,
        u.tokensValidAfter ?? null,
        u.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.classes !== next.classes) {
    sqliteDb.prepare('DELETE FROM classes').run();
    const stmt = sqliteDb.prepare(
      'INSERT INTO classes (id, sort_order, name, description, active) VALUES (?, ?, ?, ?, ?)'
    );
    db.classes.forEach((c, idx) => {
      stmt.run(c.id, idx, c.name, c.description, c.active ? 1 : 0);
    });
  }

  if (!prev || prev.suppliers !== next.suppliers) {
    sqliteDb.prepare('DELETE FROM suppliers').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO suppliers (id, sort_order, name, nif, phone, email, address, notes, active, created_at, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.suppliers.forEach((s, idx) => {
      stmt.run(
        s.id,
        idx,
        s.name,
        s.nif,
        s.phone,
        s.email,
        s.address,
        s.notes,
        s.active ? 1 : 0,
        s.createdAt,
        s.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.products !== next.products) {
    sqliteDb.prepare('DELETE FROM products').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO products (id, sort_order, code, barcode, name, active_ingredient, class_id, dosage_form, dosage, unit, location, purchase_price, sale_price, stock, quarantine_stock, min_stock, batch, expiry_date, supplier_id, active, updated_at, tax_code, tax_rate, tax_exemption_code, tax_exemption_reason, fiscal_meta, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.products.forEach((p, idx) => {
      const barcodeVal = p.barcode && p.barcode.trim() ? p.barcode.trim() : null;
      const fiscalMeta = {
        ...(p.taxType ? { taxType: p.taxType } : {}),
        ...(p.priceIncludesTax !== undefined ? { priceIncludesTax: p.priceIncludesTax } : {}),
        ...(p.fiscalValidationState ? { fiscalValidationState: p.fiscalValidationState } : {}),
        ...(p.taxRuleId ? { taxRuleId: p.taxRuleId } : {}),
        ...(Array.isArray(p.batchTaxes) && p.batchTaxes.length > 0 ? { batchTaxes: p.batchTaxes } : {}),
      };
      stmt.run(
        p.id,
        idx,
        p.code,
        barcodeVal,
        p.name,
        p.activeIngredient,
        p.classId,
        p.dosageForm,
        p.dosage,
        p.unit,
        p.location,
        p.purchasePrice,
        p.salePrice,
        p.stock,
        p.quarantineStock,
        p.minStock,
        p.batch,
        p.expiryDate,
        p.supplierId,
        p.active ? 1 : 0,
        p.updatedAt,
        p.taxCode || 'NAO_CONFIGURADO',
        p.taxRate !== null && p.taxRate !== undefined ? p.taxRate : null,
        p.taxExemptionCode || null,
        p.taxExemptionReason || null,
        Object.keys(fiscalMeta).length > 0 ? JSON.stringify(fiscalMeta) : null,
        p.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.customers !== next.customers) {
    sqliteDb.prepare('DELETE FROM customers').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO customers (id, sort_order, name, nif, phone, email, address, notes, created_at, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.customers.forEach((c, idx) => {
      stmt.run(
        c.id,
        idx,
        c.name,
        c.nif,
        c.phone,
        c.email,
        c.address,
        c.notes,
        c.createdAt,
        c.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.purchases !== next.purchases) {
    sqliteDb.prepare('DELETE FROM purchases').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO purchases (id, sort_order, internal_number, supplier_id, supplier_name, document_number, document_date, items, total_amount, notes, user_id, user_name, created_at, fiscal_data, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.purchases.forEach((p, idx) => {
      const fiscalPayload = {
        ...(p.subtotal !== undefined ? { subtotal: p.subtotal } : {}),
        ...(p.taxTotal !== undefined ? { taxTotal: p.taxTotal } : {}),
        ...(p.taxBreakdown !== undefined ? { taxBreakdown: p.taxBreakdown } : {}),
        ...(p.pricesIncludeTax !== undefined ? { pricesIncludeTax: p.pricesIncludeTax } : {}),
      };
      stmt.run(
        p.id,
        idx,
        p.internalNumber,
        p.supplierId,
        p.supplierName,
        p.documentNumber,
        p.documentDate,
        JSON.stringify(p.items),
        p.totalAmount,
        p.notes,
        p.userId,
        p.userName,
        p.createdAt,
        Object.keys(fiscalPayload).length > 0 ? JSON.stringify(fiscalPayload) : null,
        p.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.sales !== next.sales) {
    sqliteDb.prepare('DELETE FROM sales').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO sales (id, sort_order, document_number, type, status, customer_id, customer_name, customer_nif, is_common_consumer, payment_method, items, subtotal, discount_total, total_amount, notes, seller_id, seller_name, date, time, created_at, converted_to_sale_id, converted_document_number, source_proforma_id, source_proforma_number, cash_register_id, fiscal_data, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.sales.forEach((s, idx) => {
      const fiscalPayload = {
        ...(s.customerAddress !== undefined ? { customerAddress: s.customerAddress } : {}),
        ...(s.taxTotal !== undefined ? { taxTotal: s.taxTotal } : {}),
        ...(s.taxBreakdown !== undefined ? { taxBreakdown: s.taxBreakdown } : {}),
        ...(s.issuedAt !== undefined ? { issuedAt: s.issuedAt } : {}),
        ...(s.locationOfOperation !== undefined ? { locationOfOperation: s.locationOfOperation } : {}),
        ...(s.paidAmount !== undefined ? { paidAmount: s.paidAmount } : {}),
        ...(s.paymentStatus !== undefined ? { paymentStatus: s.paymentStatus } : {}),
        ...(s.relatedInvoiceId !== undefined ? { relatedInvoiceId: s.relatedInvoiceId } : {}),
        ...(s.relatedInvoiceNumber !== undefined ? { relatedInvoiceNumber: s.relatedInvoiceNumber } : {}),
        ...(s.fiscalValidationStatus !== undefined ? { fiscalValidationStatus: s.fiscalValidationStatus } : {}),
        ...(s.agtRequestId !== undefined ? { agtRequestId: s.agtRequestId } : {}),
        ...(s.agtDocumentNo !== undefined ? { agtDocumentNo: s.agtDocumentNo } : {}),
        ...(s.agtRejectionReason !== undefined ? { agtRejectionReason: s.agtRejectionReason } : {}),
        ...(s.agtQrCode !== undefined ? { agtQrCode: s.agtQrCode } : {}),
        ...(s.agtHash !== undefined ? { agtHash: s.agtHash } : {}),
        ...(s.agtSignature !== undefined ? { agtSignature: s.agtSignature } : {}),
        ...(s.agtSubmissionHistory !== undefined ? { agtSubmissionHistory: s.agtSubmissionHistory } : {}),
      };
      stmt.run(
        s.id,
        idx,
        s.documentNumber,
        s.type,
        s.status,
        s.customerId,
        s.customerName,
        s.customerNif,
        s.isCommonConsumer ? 1 : 0,
        s.paymentMethod,
        JSON.stringify(s.items),
        s.subtotal,
        s.discountTotal,
        s.totalAmount,
        s.notes,
        s.sellerId,
        s.sellerName,
        s.date,
        s.time,
        s.createdAt,
        s.convertedToSaleId || null,
        s.convertedDocumentNumber || null,
        s.sourceProformaId || null,
        s.sourceProformaNumber || null,
        s.cashRegisterId || null,
        Object.keys(fiscalPayload).length > 0 ? JSON.stringify(fiscalPayload) : null,
        s.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.returns !== next.returns) {
    sqliteDb.prepare('DELETE FROM returns').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO returns (id, sort_order, document_number, type, original_sale_id, original_document_number, original_payment_method, original_seller_id, original_seller_name, reason, items, total_refund, user_id, user_name, date, created_at, cash_register_id, fiscal_data, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.returns.forEach((r, idx) => {
      const fiscalPayload = {
        ...(r.rectificationNature !== undefined ? { rectificationNature: r.rectificationNature } : {}),
        ...(r.customerName !== undefined ? { customerName: r.customerName } : {}),
        ...(r.customerNif !== undefined ? { customerNif: r.customerNif } : {}),
        ...(r.taxTotal !== undefined ? { taxTotal: r.taxTotal } : {}),
        ...(r.taxBreakdown !== undefined ? { taxBreakdown: r.taxBreakdown } : {}),
        ...(r.buyerAcknowledgement !== undefined ? { buyerAcknowledgement: r.buyerAcknowledgement } : {}),
        ...(r.fiscalValidationStatus !== undefined ? { fiscalValidationStatus: r.fiscalValidationStatus } : {}),
        ...(r.agtRequestId !== undefined ? { agtRequestId: r.agtRequestId } : {}),
        ...(r.agtRejectionReason !== undefined ? { agtRejectionReason: r.agtRejectionReason } : {}),
        ...(r.agtQrCode !== undefined ? { agtQrCode: r.agtQrCode } : {}),
        ...(r.agtHash !== undefined ? { agtHash: r.agtHash } : {}),
        ...(r.agtSignature !== undefined ? { agtSignature: r.agtSignature } : {}),
        ...(r.agtSubmissionHistory !== undefined ? { agtSubmissionHistory: r.agtSubmissionHistory } : {}),
      };
      stmt.run(
        r.id,
        idx,
        r.documentNumber,
        r.type,
        r.originalSaleId,
        r.originalDocumentNumber,
        r.originalPaymentMethod,
        r.originalSellerId,
        r.originalSellerName,
        r.reason,
        JSON.stringify(r.items),
        r.totalRefund,
        r.userId,
        r.userName,
        r.date,
        r.createdAt,
        r.cashRegisterId || null,
        Object.keys(fiscalPayload).length > 0 ? JSON.stringify(fiscalPayload) : null,
        r.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.inventories !== next.inventories) {
    sqliteDb.prepare('DELETE FROM inventories').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO inventories (id, sort_order, reference_number, scope, scope_filter, status, items, total_discrepancies, total_shortage_units, total_surplus_units, reason, notes, counted_by_id, counted_by_name, counted_at, approved_by_id, approved_by_name, approved_at, rejected_reason, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.inventories.forEach((i, idx) => {
      stmt.run(
        i.id,
        idx,
        i.referenceNumber,
        i.scope,
        i.scopeFilter,
        i.status,
        JSON.stringify(i.items),
        i.totalDiscrepancies,
        i.totalShortageUnits,
        i.totalSurplusUnits,
        i.reason,
        i.notes,
        i.countedById,
        i.countedByName,
        i.countedAt,
        i.approvedById || null,
        i.approvedByName || null,
        i.approvedAt || null,
        i.rejectedReason || null,
        i.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.sellerClosings !== next.sellerClosings) {
    sqliteDb.prepare('DELETE FROM seller_closings').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO seller_closings (id, sort_order, status, date, shift_number, shift_label, seller_id, seller_name, opening_balance, opened_at, opening_notes, sales_count, sales_by_payment, gross_sales_total, returns_total, returns_cash_total, cancellations_count, cancellations_total, expected_cash, expected_total, counted_cash, difference, notes, included_sale_ids, included_return_ids, closed_by_id, closed_by_name, closed_at, created_at, general_closing_id, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.sellerClosings.forEach((c, idx) => {
      stmt.run(
        c.id,
        idx,
        c.status || 'FECHADO',
        c.date,
        c.shiftNumber,
        c.shiftLabel,
        c.sellerId,
        c.sellerName,
        c.openingBalance,
        c.openedAt || c.createdAt,
        c.openingNotes || '',
        c.salesCount,
        JSON.stringify(c.salesByPayment),
        c.grossSalesTotal,
        c.returnsTotal,
        c.returnsCashTotal,
        c.cancellationsCount,
        c.cancellationsTotal,
        c.expectedCash,
        c.expectedTotal,
        c.countedCash,
        c.difference,
        c.notes,
        JSON.stringify(c.includedSaleIds),
        JSON.stringify(c.includedReturnIds),
        c.closedById,
        c.closedByName,
        c.closedAt || null,
        c.createdAt,
        c.generalClosingId || null,
        c.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.generalClosings !== next.generalClosings) {
    sqliteDb.prepare('DELETE FROM general_closings').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO general_closings (id, sort_order, reference_number, start_date, end_date, status, seller_closing_ids, sales_count, sales_by_payment, total_sales, returns_total, cancellations_count, cancellations_total, total_expected_cash, total_counted_cash, total_difference, notes, closed_by_id, closed_by_name, closed_at, corrections, is_demo_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.generalClosings.forEach((g, idx) => {
      stmt.run(
        g.id,
        idx,
        g.referenceNumber,
        g.startDate,
        g.endDate,
        g.status,
        JSON.stringify(g.sellerClosingIds),
        g.salesCount,
        JSON.stringify(g.salesByPayment),
        g.totalSales,
        g.returnsTotal,
        g.cancellationsCount,
        g.cancellationsTotal,
        g.totalExpectedCash,
        g.totalCountedCash,
        g.totalDifference,
        g.notes,
        g.closedById,
        g.closedByName,
        g.closedAt,
        JSON.stringify(g.corrections),
        g.isDemoData ? 1 : 0
      );
    });
  }

  if (!prev || prev.auditLogs !== next.auditLogs) {
    sqliteDb.prepare('DELETE FROM audit_logs').run();
    const stmt = sqliteDb.prepare(
      `INSERT INTO audit_logs (id, sort_order, timestamp, user_id, username, user_name, action, entity_type, entity_id, description, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.auditLogs.forEach((a, idx) => {
      stmt.run(
        a.id,
        idx,
        a.timestamp,
        a.userId,
        a.username,
        a.userName,
        a.action,
        a.entityType,
        a.entityId,
        a.description,
        a.details ? JSON.stringify(a.details) : null
      );
    });
  }
}

export async function readDbFromPgClient(client: PoolClient): Promise<DatabaseSchema> {
  const [
    settingsRes,
    usersRes,
    classesRes,
    suppliersRes,
    productsRes,
    customersRes,
    purchasesRes,
    salesRes,
    returnsRes,
    inventoriesRes,
    sellerClosingsRes,
    generalClosingsRes,
    auditLogsRes,
  ] = await Promise.all([
    client.query('SELECT version, last_updated, data FROM app_settings WHERE id = $1', ['default']),
    client.query('SELECT * FROM users ORDER BY sort_order ASC'),
    client.query('SELECT * FROM classes ORDER BY sort_order ASC'),
    client.query('SELECT * FROM suppliers ORDER BY sort_order ASC'),
    client.query('SELECT * FROM products ORDER BY sort_order ASC'),
    client.query('SELECT * FROM customers ORDER BY sort_order ASC'),
    client.query('SELECT * FROM purchases ORDER BY sort_order ASC'),
    client.query('SELECT * FROM sales ORDER BY sort_order ASC'),
    client.query('SELECT * FROM returns ORDER BY sort_order ASC'),
    client.query('SELECT * FROM inventories ORDER BY sort_order ASC'),
    client.query('SELECT * FROM seller_closings ORDER BY sort_order ASC'),
    client.query('SELECT * FROM general_closings ORDER BY sort_order ASC'),
    client.query('SELECT * FROM audit_logs ORDER BY sort_order ASC'),
  ]);

  const settingRow = settingsRes.rows[0];
  const settings = normalizeSettings(
    settingRow ? parseJsonField<PharmacySettings>(settingRow.data, defaultSettings(1)) : undefined,
    1
  );

  return {
    version: settingRow ? Number(settingRow.version) : 1,
    lastUpdated: settingRow ? settingRow.last_updated : new Date().toISOString(),
    settings,
    users: usersRes.rows.map((r) => ({
      id: r.id,
      username: r.username,
      fullName: r.full_name,
      role: r.role,
      active: Boolean(r.active),
      permissions: parseJsonField(r.permissions, {} as StoredUser['permissions']),
      createdAt: r.created_at,
      passwordHash: r.password_hash,
      passwordSalt: r.password_salt,
      ...(r.tokens_valid_after ? { tokensValidAfter: Number(r.tokens_valid_after) } : {}),
      isDemoData: Boolean(r.is_demo_data),
    })),
    classes: classesRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      active: Boolean(r.active),
    })),
    suppliers: suppliersRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      nif: r.nif,
      phone: r.phone,
      email: r.email,
      address: r.address,
      notes: r.notes,
      active: Boolean(r.active),
      createdAt: r.created_at,
      isDemoData: Boolean(r.is_demo_data),
    })),
    products: productsRes.rows.map((r) => {
      const fiscalMeta = parseJsonField<Record<string, any>>(r.fiscal_meta, {});
      return {
        id: r.id,
        code: r.code,
        barcode: r.barcode ? String(r.barcode).trim() : '',
        name: r.name,
        activeIngredient: r.active_ingredient,
        classId: r.class_id,
        dosageForm: r.dosage_form,
        dosage: r.dosage,
        unit: r.unit,
        location: r.location,
        purchasePrice: Number(r.purchase_price),
        salePrice: Number(r.sale_price),
        stock: Number(r.stock),
        quarantineStock: Number(r.quarantine_stock),
        minStock: Number(r.min_stock),
        batch: r.batch,
        expiryDate: r.expiry_date,
        supplierId: r.supplier_id,
        active: Boolean(r.active),
        updatedAt: r.updated_at,
        taxType: (fiscalMeta.taxType as Product['taxType']) || 'IVA',
        taxCode: (r.tax_code as Product['taxCode']) || 'NAO_CONFIGURADO',
        taxRate: r.tax_rate !== null && r.tax_rate !== undefined ? Number(r.tax_rate) : null,
        taxExemptionCode: r.tax_exemption_code || '',
        taxExemptionReason: r.tax_exemption_reason || '',
        ...(fiscalMeta.priceIncludesTax !== undefined ? { priceIncludesTax: fiscalMeta.priceIncludesTax } : {}),
        ...(fiscalMeta.fiscalValidationState ? { fiscalValidationState: fiscalMeta.fiscalValidationState } : {}),
        ...(fiscalMeta.taxRuleId ? { taxRuleId: fiscalMeta.taxRuleId } : {}),
        ...(Array.isArray(fiscalMeta.batchTaxes) ? { batchTaxes: fiscalMeta.batchTaxes } : {}),
        isDemoData: Boolean(r.is_demo_data),
      };
    }),
    customers: customersRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      nif: r.nif,
      phone: r.phone,
      email: r.email,
      address: r.address,
      notes: r.notes,
      createdAt: r.created_at,
      isDemoData: Boolean(r.is_demo_data),
    })),
    purchases: purchasesRes.rows.map((r) => {
      const fiscal = parseJsonField<Record<string, any>>(r.fiscal_data, {});
      return {
        ...fiscal,
        id: r.id,
        internalNumber: r.internal_number,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        documentNumber: r.document_number,
        documentDate: r.document_date,
        items: parseJsonField(r.items, []),
        totalAmount: Number(r.total_amount),
        notes: r.notes,
        userId: r.user_id,
        userName: r.user_name,
        createdAt: r.created_at,
        isDemoData: Boolean(r.is_demo_data),
      };
    }),
    sales: salesRes.rows.map((r) => {
      const fiscal = parseJsonField<Record<string, any>>(r.fiscal_data, {});
      return {
        ...fiscal,
        id: r.id,
        documentNumber: r.document_number,
        type: r.type,
        status: r.status,
        customerId: r.customer_id ?? null,
        customerName: r.customer_name,
        customerNif: r.customer_nif,
        isCommonConsumer: Boolean(r.is_common_consumer),
        paymentMethod: r.payment_method,
        items: parseJsonField(r.items, []),
        subtotal: Number(r.subtotal),
        discountTotal: Number(r.discount_total),
        totalAmount: Number(r.total_amount),
        notes: r.notes,
        sellerId: r.seller_id,
        sellerName: r.seller_name,
        date: r.date,
        time: r.time,
        createdAt: r.created_at,
        ...(r.converted_to_sale_id ? { convertedToSaleId: r.converted_to_sale_id } : {}),
        ...(r.converted_document_number ? { convertedDocumentNumber: r.converted_document_number } : {}),
        ...(r.source_proforma_id ? { sourceProformaId: r.source_proforma_id } : {}),
        ...(r.source_proforma_number ? { sourceProformaNumber: r.source_proforma_number } : {}),
        ...(r.cash_register_id ? { cashRegisterId: r.cash_register_id } : {}),
        isDemoData: Boolean(r.is_demo_data),
      };
    }),
    returns: returnsRes.rows.map((r) => {
      const fiscal = parseJsonField<Record<string, any>>(r.fiscal_data, {});
      return {
        ...fiscal,
        id: r.id,
        documentNumber: r.document_number,
        type: r.type,
        originalSaleId: r.original_sale_id,
        originalDocumentNumber: r.original_document_number,
        originalPaymentMethod: r.original_payment_method,
        originalSellerId: r.original_seller_id,
        originalSellerName: r.original_seller_name,
        reason: r.reason,
        items: parseJsonField(r.items, []),
        totalRefund: Number(r.total_refund),
        userId: r.user_id,
        userName: r.user_name,
        date: r.date,
        createdAt: r.created_at,
        ...(r.cash_register_id ? { cashRegisterId: r.cash_register_id } : {}),
        isDemoData: Boolean(r.is_demo_data),
      };
    }),
    inventories: inventoriesRes.rows.map((r) => ({
      id: r.id,
      referenceNumber: r.reference_number,
      scope: r.scope,
      scopeFilter: r.scope_filter,
      status: r.status,
      items: parseJsonField(r.items, []),
      totalDiscrepancies: Number(r.total_discrepancies),
      totalShortageUnits: Number(r.total_shortage_units),
      totalSurplusUnits: Number(r.total_surplus_units),
      reason: r.reason,
      notes: r.notes,
      countedById: r.counted_by_id,
      countedByName: r.counted_by_name,
      countedAt: r.counted_at,
      ...(r.approved_by_id ? { approvedById: r.approved_by_id } : {}),
      ...(r.approved_by_name ? { approvedByName: r.approved_by_name } : {}),
      ...(r.approved_at ? { approvedAt: r.approved_at } : {}),
      ...(r.rejected_reason ? { rejectedReason: r.rejected_reason } : {}),
      isDemoData: Boolean(r.is_demo_data),
    })),
    sellerClosings: sellerClosingsRes.rows.map((r) => {
      const status = r.status === 'ABERTO' ? ('ABERTO' as const) : ('FECHADO' as const);
      return {
        id: r.id,
        status,
        date: r.date,
        shiftNumber: Number(r.shift_number) as 1 | 2,
        shiftLabel: r.shift_label,
        sellerId: r.seller_id,
        sellerName: r.seller_name,
        openingBalance: Number(r.opening_balance),
        openedAt: r.opened_at || r.created_at,
        openingNotes: r.opening_notes || '',
        salesCount: Number(r.sales_count),
        salesByPayment: parseJsonField(r.sales_by_payment, {
          DINHEIRO: 0,
          MULTICAIXA: 0,
          TRANSFERENCIA: 0,
          SEGURO: 0,
        }),
        grossSalesTotal: Number(r.gross_sales_total),
        returnsTotal: Number(r.returns_total),
        returnsCashTotal: Number(r.returns_cash_total),
        cancellationsCount: Number(r.cancellations_count),
        cancellationsTotal: Number(r.cancellations_total),
        expectedCash: Number(r.expected_cash),
        expectedTotal: Number(r.expected_total),
        countedCash: Number(r.counted_cash),
        difference: Number(r.difference),
        notes: r.notes,
        includedSaleIds: parseJsonField(r.included_sale_ids, []),
        includedReturnIds: parseJsonField(r.included_return_ids, []),
        closedById: r.closed_by_id,
        closedByName: r.closed_by_name,
        ...(r.closed_at ? { closedAt: r.closed_at } : status === 'FECHADO' ? { closedAt: r.created_at } : {}),
        createdAt: r.created_at,
        ...(r.general_closing_id ? { generalClosingId: r.general_closing_id } : {}),
        isDemoData: Boolean(r.is_demo_data),
      };
    }),
    generalClosings: generalClosingsRes.rows.map((r) => ({
      id: r.id,
      referenceNumber: r.reference_number,
      startDate: r.start_date,
      endDate: r.end_date,
      status: r.status,
      sellerClosingIds: parseJsonField(r.seller_closing_ids, []),
      salesCount: Number(r.sales_count),
      salesByPayment: parseJsonField(r.sales_by_payment, {
        DINHEIRO: 0,
        MULTICAIXA: 0,
        TRANSFERENCIA: 0,
        SEGURO: 0,
      }),
      totalSales: Number(r.total_sales),
      returnsTotal: Number(r.returns_total),
      cancellationsCount: Number(r.cancellations_count),
      cancellationsTotal: Number(r.cancellations_total),
      totalExpectedCash: Number(r.total_expected_cash),
      totalCountedCash: Number(r.total_counted_cash),
      totalDifference: Number(r.total_difference),
      notes: r.notes,
      closedById: r.closed_by_id,
      closedByName: r.closed_by_name,
      closedAt: r.closed_at,
      corrections: parseJsonField(r.corrections, []),
      isDemoData: Boolean(r.is_demo_data),
    })),
    auditLogs: auditLogsRes.rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      userId: r.user_id,
      username: r.username,
      userName: r.user_name,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      description: r.description,
      ...(r.details ? { details: parseJsonField(r.details, undefined) } : {}),
    })),
  };
}

export async function writeDbToPgClient(
  client: PoolClient,
  db: DatabaseSchema,
  prev?: ReturnType<typeof serializeSnapshots>
): Promise<void> {
  db.lastUpdated = new Date().toISOString();
  const next = serializeSnapshots(db);

  if (!prev || prev.settings !== next.settings) {
    await client.query('DELETE FROM app_settings');
    await client.query(
      'INSERT INTO app_settings (id, version, last_updated, data) VALUES ($1, $2, $3, $4::jsonb)',
      ['default', db.version, db.lastUpdated, JSON.stringify(db.settings)]
    );
  }

  if (!prev || prev.users !== next.users) {
    await client.query('DELETE FROM users');
    for (let idx = 0; idx < db.users.length; idx++) {
      const u = db.users[idx];
      await client.query(
        `INSERT INTO users (id, sort_order, username, full_name, role, active, permissions, created_at, password_hash, password_salt, tokens_valid_after, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [
          u.id,
          idx,
          u.username,
          u.fullName,
          u.role,
          Boolean(u.active),
          JSON.stringify(u.permissions),
          u.createdAt,
          u.passwordHash,
          u.passwordSalt,
          u.tokensValidAfter ?? null,
          Boolean(u.isDemoData),
        ]
      );
    }
  }

  if (!prev || prev.classes !== next.classes) {
    await client.query('DELETE FROM classes');
    for (let idx = 0; idx < db.classes.length; idx++) {
      const c = db.classes[idx];
      await client.query(
        'INSERT INTO classes (id, sort_order, name, description, active) VALUES ($1,$2,$3,$4,$5)',
        [c.id, idx, c.name, c.description, Boolean(c.active)]
      );
    }
  }

  if (!prev || prev.suppliers !== next.suppliers) {
    await client.query('DELETE FROM suppliers');
    for (let idx = 0; idx < db.suppliers.length; idx++) {
      const s = db.suppliers[idx];
      await client.query(
        `INSERT INTO suppliers (id, sort_order, name, nif, phone, email, address, notes, active, created_at, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [s.id, idx, s.name, s.nif, s.phone, s.email, s.address, s.notes, Boolean(s.active), s.createdAt, Boolean(s.isDemoData)]
      );
    }
  }

  if (!prev || prev.products !== next.products) {
    await client.query('DELETE FROM products');
    for (let idx = 0; idx < db.products.length; idx++) {
      const p = db.products[idx];
      const barcodeVal = p.barcode && p.barcode.trim() ? p.barcode.trim() : null;
      const fiscalMeta = {
        ...(p.taxType ? { taxType: p.taxType } : {}),
        ...(p.priceIncludesTax !== undefined ? { priceIncludesTax: p.priceIncludesTax } : {}),
        ...(p.fiscalValidationState ? { fiscalValidationState: p.fiscalValidationState } : {}),
        ...(p.taxRuleId ? { taxRuleId: p.taxRuleId } : {}),
        ...(Array.isArray(p.batchTaxes) && p.batchTaxes.length > 0 ? { batchTaxes: p.batchTaxes } : {}),
      };
      await client.query(
        `INSERT INTO products (id, sort_order, code, barcode, name, active_ingredient, class_id, dosage_form, dosage, unit, location, purchase_price, sale_price, stock, quarantine_stock, min_stock, batch, expiry_date, supplier_id, active, updated_at, tax_code, tax_rate, tax_exemption_code, tax_exemption_reason, fiscal_meta, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27)`,
        [
          p.id,
          idx,
          p.code,
          barcodeVal,
          p.name,
          p.activeIngredient,
          p.classId,
          p.dosageForm,
          p.dosage,
          p.unit,
          p.location,
          p.purchasePrice,
          p.salePrice,
          p.stock,
          p.quarantineStock,
          p.minStock,
          p.batch,
          p.expiryDate,
          p.supplierId,
          Boolean(p.active),
          p.updatedAt,
          p.taxCode || 'NAO_CONFIGURADO',
          p.taxRate !== null && p.taxRate !== undefined ? p.taxRate : null,
          p.taxExemptionCode || null,
          p.taxExemptionReason || null,
          Object.keys(fiscalMeta).length > 0 ? JSON.stringify(fiscalMeta) : null,
          Boolean(p.isDemoData),
        ]
      );
    }
  }

  if (!prev || prev.customers !== next.customers) {
    await client.query('DELETE FROM customers');
    for (let idx = 0; idx < db.customers.length; idx++) {
      const c = db.customers[idx];
      await client.query(
        `INSERT INTO customers (id, sort_order, name, nif, phone, email, address, notes, created_at, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [c.id, idx, c.name, c.nif, c.phone, c.email, c.address, c.notes, c.createdAt, Boolean(c.isDemoData)]
      );
    }
  }

  if (!prev || prev.purchases !== next.purchases) {
    await client.query('DELETE FROM purchases');
    for (let idx = 0; idx < db.purchases.length; idx++) {
      const p = db.purchases[idx];
      const fiscalPayload = {
        ...(p.subtotal !== undefined ? { subtotal: p.subtotal } : {}),
        ...(p.taxTotal !== undefined ? { taxTotal: p.taxTotal } : {}),
        ...(p.taxBreakdown !== undefined ? { taxBreakdown: p.taxBreakdown } : {}),
        ...(p.pricesIncludeTax !== undefined ? { pricesIncludeTax: p.pricesIncludeTax } : {}),
      };
      await client.query(
        `INSERT INTO purchases (id, sort_order, internal_number, supplier_id, supplier_name, document_number, document_date, items, total_amount, notes, user_id, user_name, created_at, fiscal_data, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
        [
          p.id,
          idx,
          p.internalNumber,
          p.supplierId,
          p.supplierName,
          p.documentNumber,
          p.documentDate,
          JSON.stringify(p.items),
          p.totalAmount,
          p.notes,
          p.userId,
          p.userName,
          p.createdAt,
          Object.keys(fiscalPayload).length > 0 ? JSON.stringify(fiscalPayload) : null,
          Boolean(p.isDemoData),
        ]
      );
    }
  }

  if (!prev || prev.sales !== next.sales) {
    await client.query('DELETE FROM sales');
    for (let idx = 0; idx < db.sales.length; idx++) {
      const s = db.sales[idx];
      const fiscalPayload = {
        ...(s.customerAddress !== undefined ? { customerAddress: s.customerAddress } : {}),
        ...(s.taxTotal !== undefined ? { taxTotal: s.taxTotal } : {}),
        ...(s.taxBreakdown !== undefined ? { taxBreakdown: s.taxBreakdown } : {}),
        ...(s.issuedAt !== undefined ? { issuedAt: s.issuedAt } : {}),
        ...(s.locationOfOperation !== undefined ? { locationOfOperation: s.locationOfOperation } : {}),
        ...(s.paidAmount !== undefined ? { paidAmount: s.paidAmount } : {}),
        ...(s.paymentStatus !== undefined ? { paymentStatus: s.paymentStatus } : {}),
        ...(s.relatedInvoiceId !== undefined ? { relatedInvoiceId: s.relatedInvoiceId } : {}),
        ...(s.relatedInvoiceNumber !== undefined ? { relatedInvoiceNumber: s.relatedInvoiceNumber } : {}),
        ...(s.fiscalValidationStatus !== undefined ? { fiscalValidationStatus: s.fiscalValidationStatus } : {}),
        ...(s.agtRequestId !== undefined ? { agtRequestId: s.agtRequestId } : {}),
        ...(s.agtDocumentNo !== undefined ? { agtDocumentNo: s.agtDocumentNo } : {}),
        ...(s.agtRejectionReason !== undefined ? { agtRejectionReason: s.agtRejectionReason } : {}),
        ...(s.agtQrCode !== undefined ? { agtQrCode: s.agtQrCode } : {}),
        ...(s.agtHash !== undefined ? { agtHash: s.agtHash } : {}),
        ...(s.agtSignature !== undefined ? { agtSignature: s.agtSignature } : {}),
        ...(s.agtSubmissionHistory !== undefined ? { agtSubmissionHistory: s.agtSubmissionHistory } : {}),
      };
      await client.query(
        `INSERT INTO sales (id, sort_order, document_number, type, status, customer_id, customer_name, customer_nif, is_common_consumer, payment_method, items, subtotal, discount_total, total_amount, notes, seller_id, seller_name, date, time, created_at, converted_to_sale_id, converted_document_number, source_proforma_id, source_proforma_number, cash_register_id, fiscal_data, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27)`,
        [
          s.id,
          idx,
          s.documentNumber,
          s.type,
          s.status,
          s.customerId,
          s.customerName,
          s.customerNif,
          Boolean(s.isCommonConsumer),
          s.paymentMethod,
          JSON.stringify(s.items),
          s.subtotal,
          s.discountTotal,
          s.totalAmount,
          s.notes,
          s.sellerId,
          s.sellerName,
          s.date,
          s.time,
          s.createdAt,
          s.convertedToSaleId || null,
          s.convertedDocumentNumber || null,
          s.sourceProformaId || null,
          s.sourceProformaNumber || null,
          s.cashRegisterId || null,
          Object.keys(fiscalPayload).length > 0 ? JSON.stringify(fiscalPayload) : null,
          Boolean(s.isDemoData),
        ]
      );
    }
  }

  if (!prev || prev.returns !== next.returns) {
    await client.query('DELETE FROM returns');
    for (let idx = 0; idx < db.returns.length; idx++) {
      const r = db.returns[idx];
      const fiscalPayload = {
        ...(r.rectificationNature !== undefined ? { rectificationNature: r.rectificationNature } : {}),
        ...(r.customerName !== undefined ? { customerName: r.customerName } : {}),
        ...(r.customerNif !== undefined ? { customerNif: r.customerNif } : {}),
        ...(r.taxTotal !== undefined ? { taxTotal: r.taxTotal } : {}),
        ...(r.taxBreakdown !== undefined ? { taxBreakdown: r.taxBreakdown } : {}),
        ...(r.buyerAcknowledgement !== undefined ? { buyerAcknowledgement: r.buyerAcknowledgement } : {}),
        ...(r.fiscalValidationStatus !== undefined ? { fiscalValidationStatus: r.fiscalValidationStatus } : {}),
        ...(r.agtRequestId !== undefined ? { agtRequestId: r.agtRequestId } : {}),
        ...(r.agtRejectionReason !== undefined ? { agtRejectionReason: r.agtRejectionReason } : {}),
        ...(r.agtQrCode !== undefined ? { agtQrCode: r.agtQrCode } : {}),
        ...(r.agtHash !== undefined ? { agtHash: r.agtHash } : {}),
        ...(r.agtSignature !== undefined ? { agtSignature: r.agtSignature } : {}),
        ...(r.agtSubmissionHistory !== undefined ? { agtSubmissionHistory: r.agtSubmissionHistory } : {}),
      };
      await client.query(
        `INSERT INTO returns (id, sort_order, document_number, type, original_sale_id, original_document_number, original_payment_method, original_seller_id, original_seller_name, reason, items, total_refund, user_id, user_name, date, created_at, cash_register_id, fiscal_data, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)`,
        [
          r.id,
          idx,
          r.documentNumber,
          r.type,
          r.originalSaleId,
          r.originalDocumentNumber,
          r.originalPaymentMethod,
          r.originalSellerId,
          r.originalSellerName,
          r.reason,
          JSON.stringify(r.items),
          r.totalRefund,
          r.userId,
          r.userName,
          r.date,
          r.createdAt,
          r.cashRegisterId || null,
          Object.keys(fiscalPayload).length > 0 ? JSON.stringify(fiscalPayload) : null,
          Boolean(r.isDemoData),
        ]
      );
    }
  }

  if (!prev || prev.inventories !== next.inventories) {
    await client.query('DELETE FROM inventories');
    for (let idx = 0; idx < db.inventories.length; idx++) {
      const i = db.inventories[idx];
      await client.query(
        `INSERT INTO inventories (id, sort_order, reference_number, scope, scope_filter, status, items, total_discrepancies, total_shortage_units, total_surplus_units, reason, notes, counted_by_id, counted_by_name, counted_at, approved_by_id, approved_by_name, approved_at, rejected_reason, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          i.id,
          idx,
          i.referenceNumber,
          i.scope,
          i.scopeFilter,
          i.status,
          JSON.stringify(i.items),
          i.totalDiscrepancies,
          i.totalShortageUnits,
          i.totalSurplusUnits,
          i.reason,
          i.notes,
          i.countedById,
          i.countedByName,
          i.countedAt,
          i.approvedById || null,
          i.approvedByName || null,
          i.approvedAt || null,
          i.rejectedReason || null,
          Boolean(i.isDemoData),
        ]
      );
    }
  }

  if (!prev || prev.sellerClosings !== next.sellerClosings) {
    await client.query('DELETE FROM seller_closings');
    for (let idx = 0; idx < db.sellerClosings.length; idx++) {
      const c = db.sellerClosings[idx];
      await client.query(
        `INSERT INTO seller_closings (id, sort_order, status, date, shift_number, shift_label, seller_id, seller_name, opening_balance, opened_at, opening_notes, sales_count, sales_by_payment, gross_sales_total, returns_total, returns_cash_total, cancellations_count, cancellations_total, expected_cash, expected_total, counted_cash, difference, notes, included_sale_ids, included_return_ids, closed_by_id, closed_by_name, closed_at, created_at, general_closing_id, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25::jsonb,$26,$27,$28,$29,$30,$31)`,
        [
          c.id,
          idx,
          c.status || 'FECHADO',
          c.date,
          c.shiftNumber,
          c.shiftLabel,
          c.sellerId,
          c.sellerName,
          c.openingBalance,
          c.openedAt || c.createdAt,
          c.openingNotes || '',
          c.salesCount,
          JSON.stringify(c.salesByPayment),
          c.grossSalesTotal,
          c.returnsTotal,
          c.returnsCashTotal,
          c.cancellationsCount,
          c.cancellationsTotal,
          c.expectedCash,
          c.expectedTotal,
          c.countedCash,
          c.difference,
          c.notes,
          JSON.stringify(c.includedSaleIds),
          JSON.stringify(c.includedReturnIds),
          c.closedById,
          c.closedByName,
          c.closedAt || null,
          c.createdAt,
          c.generalClosingId || null,
          Boolean(c.isDemoData),
        ]
      );
    }
  }

  if (!prev || prev.generalClosings !== next.generalClosings) {
    await client.query('DELETE FROM general_closings');
    for (let idx = 0; idx < db.generalClosings.length; idx++) {
      const g = db.generalClosings[idx];
      await client.query(
        `INSERT INTO general_closings (id, sort_order, reference_number, start_date, end_date, status, seller_closing_ids, sales_count, sales_by_payment, total_sales, returns_total, cancellations_count, cancellations_total, total_expected_cash, total_counted_cash, total_difference, notes, closed_by_id, closed_by_name, closed_at, corrections, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)`,
        [
          g.id,
          idx,
          g.referenceNumber,
          g.startDate,
          g.endDate,
          g.status,
          JSON.stringify(g.sellerClosingIds),
          g.salesCount,
          JSON.stringify(g.salesByPayment),
          g.totalSales,
          g.returnsTotal,
          g.cancellationsCount,
          g.cancellationsTotal,
          g.totalExpectedCash,
          g.totalCountedCash,
          g.totalDifference,
          g.notes,
          g.closedById,
          g.closedByName,
          g.closedAt,
          JSON.stringify(g.corrections),
          Boolean(g.isDemoData),
        ]
      );
    }
  }

  if (!prev || prev.auditLogs !== next.auditLogs) {
    await client.query('DELETE FROM audit_logs');
    for (let idx = 0; idx < db.auditLogs.length; idx++) {
      const a = db.auditLogs[idx];
      await client.query(
        `INSERT INTO audit_logs (id, sort_order, timestamp, user_id, username, user_name, action, entity_type, entity_id, description, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [
          a.id,
          idx,
          a.timestamp,
          a.userId,
          a.username,
          a.userName,
          a.action,
          a.entityType,
          a.entityId,
          a.description,
          a.details ? JSON.stringify(a.details) : null,
        ]
      );
    }
  }
}

function getInitialDatabaseFromEnvOrLegacy(): DatabaseSchema {
  if (fs.existsSync(LEGACY_JSON_FILE)) {
    try {
      const raw = fs.readFileSync(LEGACY_JSON_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as DatabaseSchema;
      if (parsed && Array.isArray(parsed.users) && parsed.settings) {
        if (parsed.settings.pharmacyName === 'Farmácia Vladmir & Benilson') {
          parsed.settings.pharmacyName = 'Âncora SMS';
        }
        return parsed;
      }
    } catch {
      // Fallback to fresh seed if legacy JSON cannot be parsed
    }
  }

  if (process.env.SEED_DEMO_DATA === 'false') {
    return createCleanProductionDatabase();
  }
  return createSeedDatabase();
}

export async function initDb(): Promise<{ engine: DbEngine; target: string }> {
  if (initialized) {
    return {
      engine,
      target: engine === 'postgresql' ? 'PostgreSQL (DATABASE_URL)' : DEFAULT_SQLITE_FILE,
    };
  }

  const isProd = process.env.NODE_ENV === 'production';
  const isStrictProd = isProd && process.env.STRICT_PRODUCTION === 'true';
  const databaseUrl = (process.env.DATABASE_URL || '').trim();

  if (isStrictProd && !databaseUrl) {
    throw new Error(
      'Configuração inválida para produção: DATABASE_URL não está definida. Em produção é obrigatório utilizar PostgreSQL persistente e partilhado (o SQLite local está restrito ao desenvolvimento).'
    );
  }
  if (isProd && !databaseUrl) {
    console.warn(
      'AVISO: Aplicação iniciada em produção sem DATABASE_URL (a usar SQLite local temporário). Configure PostgreSQL persistente e STRICT_PRODUCTION=true para operação real multiutilizador.'
    );
  }

  if (databaseUrl) {
    if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
      throw new Error('DATABASE_URL inválida: deve começar por postgres:// ou postgresql://.');
    }
    engine = 'postgresql';
    const useSsl =
      process.env.DATABASE_SSL === 'true' ||
      databaseUrl.includes('sslmode=require') ||
      (!databaseUrl.includes('localhost') && !databaseUrl.includes('127.0.0.1'));
    pgPool = new Pool({
      connectionString: databaseUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(${PG_LOCK_KEY})`);
      for (const stmt of PG_SCHEMA_STATEMENTS) {
        await client.query(stmt);
      }
      const existing = await client.query('SELECT COUNT(*)::int AS cnt FROM users');
      if (Number(existing.rows[0]?.cnt || 0) === 0) {
        if (isProd && process.env.SEED_DEMO_DATA === 'true') {
          throw new Error(
            'Segurança em produção: SEED_DEMO_DATA=true não é permitido em produção.'
          );
        }
        const seed = isProd ? createCleanProductionDatabase() : getInitialDatabaseFromEnvOrLegacy();
        await writeDbToPgClient(client, seed);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    initialized = true;
    return { engine, target: 'PostgreSQL (DATABASE_URL)' };
  }

  // SQLite relational fallback for local development using Node built-in node:sqlite
  engine = 'sqlite';
  const dir = path.dirname(DEFAULT_SQLITE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  sqliteDb = new DatabaseSync(DEFAULT_SQLITE_FILE);
  sqliteDb.exec(SQLITE_SCHEMA_SQL);

  // Non-destructive column upgrades for existing SQLite databases
  const userCols = sqliteDb.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === 'tokens_valid_after')) {
    sqliteDb.exec('ALTER TABLE users ADD COLUMN tokens_valid_after INTEGER');
  }
  const prodCols = sqliteDb.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>;
  if (!prodCols.some((c) => c.name === 'barcode')) {
    sqliteDb.exec('ALTER TABLE products ADD COLUMN barcode TEXT');
  }
  if (!prodCols.some((c) => c.name === 'tax_code')) {
    sqliteDb.exec('ALTER TABLE products ADD COLUMN tax_code TEXT');
  }
  if (!prodCols.some((c) => c.name === 'tax_rate')) {
    sqliteDb.exec('ALTER TABLE products ADD COLUMN tax_rate REAL');
  }
  if (!prodCols.some((c) => c.name === 'tax_exemption_code')) {
    sqliteDb.exec('ALTER TABLE products ADD COLUMN tax_exemption_code TEXT');
  }
  if (!prodCols.some((c) => c.name === 'tax_exemption_reason')) {
    sqliteDb.exec('ALTER TABLE products ADD COLUMN tax_exemption_reason TEXT');
  }
  if (!prodCols.some((c) => c.name === 'fiscal_meta')) {
    sqliteDb.exec('ALTER TABLE products ADD COLUMN fiscal_meta TEXT');
  }
  const purchaseCols = sqliteDb.prepare('PRAGMA table_info(purchases)').all() as Array<{ name: string }>;
  if (!purchaseCols.some((c) => c.name === 'fiscal_data')) {
    sqliteDb.exec('ALTER TABLE purchases ADD COLUMN fiscal_data TEXT');
  }
  const saleCols = sqliteDb.prepare('PRAGMA table_info(sales)').all() as Array<{ name: string }>;
  if (!saleCols.some((c) => c.name === 'cash_register_id')) {
    sqliteDb.exec('ALTER TABLE sales ADD COLUMN cash_register_id TEXT');
  }
  if (!saleCols.some((c) => c.name === 'fiscal_data')) {
    sqliteDb.exec('ALTER TABLE sales ADD COLUMN fiscal_data TEXT');
  }
  const returnCols = sqliteDb.prepare('PRAGMA table_info(returns)').all() as Array<{ name: string }>;
  if (!returnCols.some((c) => c.name === 'cash_register_id')) {
    sqliteDb.exec('ALTER TABLE returns ADD COLUMN cash_register_id TEXT');
  }
  if (!returnCols.some((c) => c.name === 'fiscal_data')) {
    sqliteDb.exec('ALTER TABLE returns ADD COLUMN fiscal_data TEXT');
  }
  const scCols = sqliteDb.prepare('PRAGMA table_info(seller_closings)').all() as Array<{ name: string }>;
  if (!scCols.some((c) => c.name === 'status')) {
    sqliteDb.exec("ALTER TABLE seller_closings ADD COLUMN status TEXT NOT NULL DEFAULT 'FECHADO'");
  }
  if (!scCols.some((c) => c.name === 'opened_at')) {
    sqliteDb.exec('ALTER TABLE seller_closings ADD COLUMN opened_at TEXT');
  }
  if (!scCols.some((c) => c.name === 'opening_notes')) {
    sqliteDb.exec('ALTER TABLE seller_closings ADD COLUMN opening_notes TEXT');
  }
  if (!scCols.some((c) => c.name === 'closed_at')) {
    sqliteDb.exec('ALTER TABLE seller_closings ADD COLUMN closed_at TEXT');
  }
  sqliteDb.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique ON products (UPPER(barcode)) WHERE barcode IS NOT NULL AND barcode <> ''`
  );

  const countRow = sqliteDb.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number };
  if (Number(countRow?.cnt || 0) === 0) {
    const seed = getInitialDatabaseFromEnvOrLegacy();
    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
      writeDbToSqlite(seed);
      sqliteDb.exec('COMMIT');
    } catch (err) {
      sqliteDb.exec('ROLLBACK');
      throw err;
    }
  }

  initialized = true;
  return { engine, target: DEFAULT_SQLITE_FILE };
}

const revokedTokenCache = new Set<string>();

export async function revokeTokenInDb(jti: string, userId: string, expiresAt: number): Promise<void> {
  if (!jti) return;
  if (!initialized) {
    await initDb();
  }
  revokedTokenCache.add(jti);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (engine === 'postgresql' && pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query('DELETE FROM revoked_tokens WHERE expires_at < $1', [nowMs]);
      await client.query(
        `INSERT INTO revoked_tokens (jti, user_id, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (jti) DO NOTHING`,
        [jti, userId, expiresAt, nowIso]
      );
    } finally {
      client.release();
    }
    return;
  }

  if (sqliteDb) {
    sqliteDb.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?').run(nowMs);
    sqliteDb
      .prepare(
        `INSERT OR IGNORE INTO revoked_tokens (jti, user_id, expires_at, revoked_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(jti, userId, expiresAt, nowIso);
  }
}

export async function isTokenRevokedInDb(jti: string): Promise<boolean> {
  if (!jti) return false;
  if (revokedTokenCache.has(jti)) return true;
  if (!initialized) {
    await initDb();
  }

  if (engine === 'postgresql' && pgPool) {
    const client = await pgPool.connect();
    try {
      const res = await client.query('SELECT 1 FROM revoked_tokens WHERE jti = $1 LIMIT 1', [jti]);
      if (res.rowCount && res.rowCount > 0) {
        revokedTokenCache.add(jti);
        return true;
      }
      return false;
    } finally {
      client.release();
    }
  }

  if (sqliteDb) {
    const row = sqliteDb.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ? LIMIT 1').get(jti);
    if (row) {
      revokedTokenCache.add(jti);
      return true;
    }
  }
  return false;
}

export function getDbInfo(): { engine: DbEngine; target: string } {
  return {
    engine,
    target: engine === 'postgresql' ? 'PostgreSQL (Partilhado)' : path.basename(DEFAULT_SQLITE_FILE),
  };
}

export async function loadDbAsync(): Promise<DatabaseSchema> {
  if (!initialized) {
    await initDb();
  }
  if (engine === 'postgresql' && pgPool) {
    const client = await pgPool.connect();
    try {
      return await readDbFromPgClient(client);
    } finally {
      client.release();
    }
  }
  return readDbFromSqlite();
}

export async function mutateDb<T>(fn: (db: DatabaseSchema) => T | Promise<T>): Promise<T> {
  if (!initialized) {
    await initDb();
  }

  const run = async (): Promise<T> => {
    if (engine === 'postgresql' && pgPool) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(${PG_LOCK_KEY})`);
        const db = await readDbFromPgClient(client);
        const before = serializeSnapshots(db);
        const result = await fn(db);
        await writeDbToPgClient(client, db, before);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    if (!sqliteDb) throw new Error('SQLite database not initialized.');
    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
      const db = readDbFromSqlite();
      const before = serializeSnapshots(db);
      const result = await fn(db);
      writeDbToSqlite(db, before);
      sqliteDb.exec('COMMIT');
      return result;
    } catch (err) {
      sqliteDb.exec('ROLLBACK');
      throw err;
    }
  };

  const task = writeQueue.then(run, run);
  writeQueue = task.catch(() => {});
  return task;
}

export async function replaceDbAsync(nextDb: DatabaseSchema): Promise<void> {
  await mutateDb((db) => {
    db.version = nextDb.version || 1;
    db.lastUpdated = new Date().toISOString();
    db.users = nextDb.users || [];
    db.classes = nextDb.classes || [];
    db.products = nextDb.products || [];
    db.suppliers = nextDb.suppliers || [];
    db.purchases = nextDb.purchases || [];
    db.customers = nextDb.customers || [];
    db.sales = nextDb.sales || [];
    db.returns = nextDb.returns || [];
    db.inventories = nextDb.inventories || [];
    db.sellerClosings = nextDb.sellerClosings || [];
    db.generalClosings = nextDb.generalClosings || [];
    db.settings = nextDb.settings;
    db.auditLogs = nextDb.auditLogs || [];
  });
}
