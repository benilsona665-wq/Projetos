import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  getBackupConfigStatus,
  normalizePolicy,
  runExternalBackup,
  startDailyBackupScheduler,
} from './server/backup.ts';
import {
  HttpError,
  appendAudit,
  clearDemoFromDatabase,
  createSeedDatabase,
  formatDocNum,
  getDbInfo,
  hashPassword,
  initDb,
  isTokenRevokedInDb,
  loadDbAsync,
  mutateDb,
  nowTimeStr,
  replaceDbAsync,
  revokeTokenInDb,
  stripUserSecrets,
  todayISO,
  verifyPassword,
} from './server/db.ts';
import {
  aggregateTaxBreakdown,
  allocateDocumentNumber,
  assertFiscalEmissionAllowed,
  buildAgtFeSubmissionPayload,
  buildLineTaxValues,
  consultAgtInvoice,
  generateSaftAoXml,
  getAgtConfigStatus,
  isInvoiceSaleType,
  isTaxRuleValidForDate,
  pollAgtDocumentStatus,
  requestAgtSeries,
  resolveEffectiveProductTax,
  roundMoney,
  submitToAgtEndpoint,
  validateProductTaxInput,
} from './server/fiscal.ts';
import type {
  BuyerAcknowledgement,
  DatabaseSchema,
  FiscalChangeEntry,
  FiscalValidationStatus,
  InventoryItem,
  PaymentMethod,
  Product,
  ProductBatchTaxOverride,
  ProductFiscalValidationState,
  PurchaseItem,
  ReturnItem,
  Sale,
  SaleDocumentType,
  SaleItem,
  SaleReturn,
  SellerClosing,
  StoredUser,
  TaxCode,
  TaxRuleEntry,
  TaxType,
  VatRegime,
} from './src/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const IS_STRICT_PROD = IS_PROD && process.env.STRICT_PRODUCTION === 'true';

const KNOWN_WEAK_SECRETS = new Set([
  'ancora-sms-local-secret-key-2026',
  'altere-esta-chave-secreta-em-producao-2026',
  'changeme',
  'secret',
  'default',
  'password',
]);

function validateAndResolveSessionSecret(): string {
  const configured = (process.env.SESSION_SECRET || '').trim();
  if (configured) {
    if (IS_PROD && (configured.length < 32 || KNOWN_WEAK_SECRETS.has(configured.toLowerCase()))) {
      throw new Error(
        'Configuração insegura bloqueada em produção: a SESSION_SECRET definida é fraca ou curta (mínimo 32 caracteres aleatórios).'
      );
    }
    if (configured.length >= 16) {
      return configured;
    }
  }
  if (IS_STRICT_PROD) {
    throw new Error(
      'Configuração insegura bloqueada em produção: defina SESSION_SECRET com pelo menos 32 caracteres aleatórios através do Gestor de Segredos do servidor.'
    );
  }
  if (IS_PROD) {
    console.warn(
      'AVISO: SESSION_SECRET não definida; gerado segredo criptográfico efémero em memória para esta instância. Configure SESSION_SECRET (>=32 caracteres) e STRICT_PRODUCTION=true em produção definitiva.'
    );
  }
  // Ephemeral cryptographic secret generated in memory (no hardcoded fallback)
  return crypto.randomBytes(32).toString('hex');
}

const TOKEN_SECRET = validateAndResolveSessionSecret();

interface AuthTokenPayload {
  jti: string;
  userId: string;
  username: string;
  iat: number;
  exp: number;
}

interface AuthedRequest extends Request {
  currentUser?: StoredUser;
  tokenPayload?: AuthTokenPayload;
}

function signToken(user: StoredUser): string {
  const payload: AuthTokenPayload = {
    jti: crypto.randomUUID(),
    userId: user.id,
    username: user.username,
    iat: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token: string): AuthTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8')) as AuthTokenPayload;
    if (!parsed.jti || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Login / password verification rate limiter (per IP+username and per IP)
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_USER_ATTEMPTS = 5;
const MAX_IP_ATTEMPTS = 25;
const failedLoginBuckets = new Map<string, { count: number; resetAt: number }>();

function getClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function pruneExpiredBuckets(now: number): void {
  if (failedLoginBuckets.size < 500) return;
  for (const [k, v] of failedLoginBuckets.entries()) {
    if (v.resetAt <= now) failedLoginBuckets.delete(k);
  }
}

function assertLoginAllowed(ip: string, usernameKey: string, res: Response): void {
  const now = Date.now();
  pruneExpiredBuckets(now);
  for (const bucketKey of [`ip:${ip}`, `acct:${ip}:${usernameKey}`]) {
    const limit = bucketKey.startsWith('ip:') ? MAX_IP_ATTEMPTS : MAX_USER_ATTEMPTS;
    const entry = failedLoginBuckets.get(bucketKey);
    if (entry && entry.resetAt > now && entry.count >= limit) {
      const retrySecs = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      const retryMins = Math.ceil(retrySecs / 60);
      res.setHeader('Retry-After', String(retrySecs));
      throw new HttpError(
        429,
        `Demasiadas tentativas de autenticação. Aguarde ${retryMins} minuto(s) e tente novamente.`
      );
    }
  }
}

function recordFailedLogin(ip: string, usernameKey: string): void {
  const now = Date.now();
  for (const bucketKey of [`ip:${ip}`, `acct:${ip}:${usernameKey}`]) {
    const existing = failedLoginBuckets.get(bucketKey);
    if (!existing || existing.resetAt <= now) {
      failedLoginBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    } else {
      existing.count += 1;
    }
  }
}

function clearLoginFailures(ip: string, usernameKey: string): void {
  failedLoginBuckets.delete(`acct:${ip}:${usernameKey}`);
}

const asyncHandler =
  (fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void>) =>
  (req: AuthedRequest, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.shortages ? { shortages: err.shortages } : {}),
        });
        return;
      }
      next(err);
    });
  };

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Sessão não iniciada. Inicie sessão para continuar.' });
      return;
    }
    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Sessão expirada ou inválida. Inicie sessão novamente.' });
      return;
    }
    if (await isTokenRevokedInDb(payload.jti)) {
      res.status(401).json({ error: 'Sessão terminada ou revogada. Inicie sessão novamente.' });
      return;
    }
    const db = await loadDbAsync();
    const user = db.users.find((u) => u.id === payload.userId);
    if (!user || !user.active) {
      res.status(401).json({ error: 'Utilizador inativo ou inexistente.' });
      return;
    }
    if (user.tokensValidAfter && payload.iat < user.tokensValidAfter) {
      res.status(401).json({ error: 'A sessão expirou após alteração de credenciais. Inicie sessão novamente.' });
      return;
    }
    req.currentUser = user;
    req.tokenPayload = payload;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.currentUser || req.currentUser.role !== 'ADMIN') {
    res.status(403).json({ error: 'Operação restrita ao Administrador.' });
    return;
  }
  next();
}

function emptyPaymentMap(): Record<PaymentMethod, number> {
  return {
    DINHEIRO: 0,
    MULTICAIXA: 0,
    TRANSFERENCIA: 0,
    SEGURO: 0,
  };
}

function recordFiscalChange(
  db: DatabaseSchema,
  user: StoredUser,
  entry: Omit<FiscalChangeEntry, 'id' | 'timestamp' | 'userId' | 'userName'>
): void {
  if (!Array.isArray(db.settings.fiscalHistory)) {
    db.settings.fiscalHistory = [];
  }
  db.settings.fiscalHistory.unshift({
    id: `fch_${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    userId: user.id,
    userName: user.fullName,
    ...entry,
  });
  if (db.settings.fiscalHistory.length > 500) {
    db.settings.fiscalHistory.length = 500;
  }
}

function parseBatchTaxesInput(
  rawList: unknown,
  db: DatabaseSchema,
  user: StoredUser
): ProductBatchTaxOverride[] {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set<string>();
  const nowIso = new Date().toISOString();
  const parsed: ProductBatchTaxOverride[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const batch = String(item.batch || '').trim();
    if (!batch) {
      throw new HttpError(400, 'Cada exceção fiscal por lote deve indicar o número de lote.');
    }
    const batchKey = batch.toLowerCase();
    if (seen.has(batchKey)) {
      throw new HttpError(409, `O lote "${batch}" está duplicado na configuração fiscal.`);
    }
    seen.add(batchKey);

    const taxRuleId = item.taxRuleId ? String(item.taxRuleId).trim() : undefined;
    if (taxRuleId && !(db.settings.taxRules || []).some((r) => r.id === taxRuleId)) {
      throw new HttpError(400, `Regra fiscal selecionada para o lote "${batch}" não encontrada.`);
    }

    const validated = validateProductTaxInput({
      taxType: item.taxType,
      taxCode: item.taxCode,
      taxRate: item.taxRate,
      taxExemptionCode: item.taxExemptionCode,
      taxExemptionReason: item.taxExemptionReason,
    });

    const priceIncludesTax =
      item.priceIncludesTax === true ? true : item.priceIncludesTax === false ? false : null;
    const fiscalValidationState: ProductFiscalValidationState =
      item.fiscalValidationState === 'VALIDADO_CONTABILISTA'
        ? 'VALIDADO_CONTABILISTA'
        : 'PENDENTE_REVISAO';

    parsed.push({
      batch,
      taxType: validated.taxType,
      taxCode: validated.taxCode,
      taxRate: validated.taxRate,
      taxExemptionCode: validated.taxExemptionCode,
      taxExemptionReason: validated.taxExemptionReason,
      priceIncludesTax,
      fiscalValidationState,
      ...(taxRuleId ? { taxRuleId } : {}),
      updatedAt: nowIso,
      updatedByName: user.fullName,
    });
  }
  return parsed;
}

function formatFiscalSummary(obj: {
  taxCode?: TaxCode;
  taxRate?: number | null;
  taxExemptionCode?: string;
  priceIncludesTax?: boolean | null;
  fiscalValidationState?: ProductFiscalValidationState;
}): string {
  const code = obj.taxCode || 'NAO_CONFIGURADO';
  const rateStr = obj.taxRate !== null && obj.taxRate !== undefined ? `${obj.taxRate}%` : 'S/Taxa';
  const incStr =
    obj.priceIncludesTax === true
      ? 'IVA incl.'
      : obj.priceIncludesTax === false
      ? 'IVA acresc.'
      : 'Herdar loja';
  const exStr = obj.taxExemptionCode ? ` [${obj.taxExemptionCode}]` : '';
  const valStr = obj.fiscalValidationState === 'VALIDADO_CONTABILISTA' ? 'Validado' : 'Pendente';
  return `${code} (${rateStr})${exStr} • ${incStr} • ${valStr}`;
}

function isDateInClosedPeriod(db: DatabaseSchema, date: string) {
  return db.generalClosings.find(
    (gc) => gc.status === 'FECHADO' && date >= gc.startDate && date <= gc.endDate
  );
}

function getOpenCashRegister(db: DatabaseSchema, userId: string): SellerClosing | undefined {
  return db.sellerClosings.find((c) => c.sellerId === userId && c.status === 'ABERTO');
}

function computeRegisterMetrics(db: DatabaseSchema, reg: SellerClosing) {
  const closedCoveredSales = new Set(
    db.sellerClosings
      .filter((c) => c.sellerId === reg.sellerId && c.status !== 'ABERTO' && c.id !== reg.id)
      .flatMap((c) => c.includedSaleIds)
  );
  const closedCoveredReturns = new Set(
    db.sellerClosings
      .filter((c) => c.sellerId === reg.sellerId && c.status !== 'ABERTO' && c.id !== reg.id)
      .flatMap((c) => c.includedReturnIds)
  );

  const regSales = db.sales.filter(
    (s) =>
      (s.type === 'FATURA' || s.type === 'FACTURA_RECIBO' || s.type === 'RECIBO') &&
      (s.cashRegisterId === reg.id ||
        (!reg.openedAt &&
          !s.cashRegisterId &&
          s.sellerId === reg.sellerId &&
          s.date === reg.date &&
          !closedCoveredSales.has(s.id)))
  );

  const regReturns = db.returns.filter(
    (r) =>
      r.cashRegisterId === reg.id ||
      (!reg.openedAt &&
        !r.cashRegisterId &&
        r.originalSellerId === reg.sellerId &&
        r.date === reg.date &&
        !closedCoveredReturns.has(r.id))
  );

  const salesByPayment = emptyPaymentMap();
  let grossSalesTotal = 0;
  for (const s of regSales) {
    salesByPayment[s.paymentMethod] = roundMoney(salesByPayment[s.paymentMethod] + s.totalAmount);
    grossSalesTotal = roundMoney(grossSalesTotal + s.totalAmount);
  }

  let returnsTotal = 0;
  let returnsCashTotal = 0;
  let cancellationsCount = 0;
  let cancellationsTotal = 0;
  for (const r of regReturns) {
    returnsTotal = roundMoney(returnsTotal + r.totalRefund);
    if (r.originalPaymentMethod === 'DINHEIRO') {
      returnsCashTotal = roundMoney(returnsCashTotal + r.totalRefund);
    }
    if (r.type === 'ANULACAO') {
      cancellationsCount += 1;
      cancellationsTotal = roundMoney(cancellationsTotal + r.totalRefund);
    }
  }

  const expectedCashSalesNet = roundMoney(salesByPayment.DINHEIRO - returnsCashTotal);
  const expectedCash = roundMoney(reg.openingBalance + expectedCashSalesNet);
  const expectedTotal = roundMoney(grossSalesTotal - returnsTotal);

  return {
    salesCount: regSales.length,
    salesByPayment,
    grossSalesTotal,
    returnsTotal,
    returnsCashTotal,
    cancellationsCount,
    cancellationsTotal,
    expectedCashSalesNet,
    expectedCash,
    expectedTotal,
    includedSaleIds: regSales.map((s) => s.id),
    includedReturnIds: regReturns.map((r) => r.id),
  };
}

function buildCashRegisterStatus(db: DatabaseSchema, user: StoredUser) {
  const today = todayISO();
  const openReg = getOpenCashRegister(db, user.id);
  const todayRegs = db.sellerClosings.filter((c) => c.date === today && c.sellerId === user.id);
  const closedTodayCount = todayRegs.filter((c) => c.status !== 'ABERTO').length;
  const lastClosedToday = todayRegs.find((c) => c.status !== 'ABERTO') || null;
  const closedPeriod = isDateInClosedPeriod(db, today);
  const requiresOpenRegisterToSell = user.role === 'SELLER' || closedTodayCount > 0;

  let enrichedOpen: (SellerClosing & { expectedCashSalesNet: number }) | null = null;
  if (openReg) {
    const metrics = computeRegisterMetrics(db, openReg);
    enrichedOpen = {
      ...openReg,
      ...metrics,
    };
  }

  return {
    today,
    openRegister: enrichedOpen,
    closedTodayCount,
    totalTodayCount: todayRegs.length,
    maxAllowedPerDay: 2,
    isPeriodClosed: Boolean(closedPeriod),
    closedPeriodRef: closedPeriod?.referenceNumber || null,
    requiresOpenRegisterToSell,
    lastClosedToday,
  };
}

async function startServer() {
  if (IS_STRICT_PROD && !(process.env.DATABASE_URL || '').trim()) {
    throw new Error(
      'Configuração inválida para produção: DATABASE_URL é obrigatória. Configure PostgreSQL persistente antes de iniciar em produção.'
    );
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '15mb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  const dbBoot = await initDb();
  console.log(`Âncora SMS database initialized [${dbBoot.engine}]: ${dbBoot.target}`);
  startDailyBackupScheduler();

  // ==================== HEALTH & BOOTSTRAP INFO ====================
  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      const dbInfo = getDbInfo();
      res.json({
        ok: true,
        app: 'Âncora SMS — Stock Management System',
        database: dbInfo,
        persistentSharedDb: dbInfo.engine === 'postgresql',
        strictProduction: IS_STRICT_PROD,
        usersCount: db.users.length,
        productsCount: db.products.length,
      });
    })
  );

  app.get(
    '/api/auth/bootstrap-info',
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      const dbInfo = getDbInfo();
      const hasDemoUsers = db.users.some((u) => Boolean(u.isDemoData));
      res.json({
        hasDemoUsers,
        needsAdminSetup: db.users.length === 0,
        dbEngine: dbInfo.engine,
        persistentSharedDb: dbInfo.engine === 'postgresql',
        pharmacyName: db.settings.pharmacyName,
      });
    })
  );

  app.post(
    '/api/auth/setup-admin',
    asyncHandler(async (req, res) => {
      const { username, fullName, password } = req.body || {};
      const cleanUsername = String(username || '').trim().toLowerCase();
      const cleanFullName = String(fullName || '').trim();
      const rawPassword = String(password || '');

      if (!cleanUsername || !cleanFullName || rawPassword.length < 8) {
        throw new HttpError(
          400,
          'Indique o nome completo, o utilizador e uma palavra-passe com pelo menos 8 caracteres.'
        );
      }

      const result = await mutateDb((db) => {
        if (db.users.length > 0) {
          throw new HttpError(
            409,
            'O administrador inicial já está configurado. Utilize o início de sessão normal.'
          );
        }
        const cred = hashPassword(rawPassword);
        const adminUser: StoredUser = {
          id: `usr_${crypto.randomUUID().slice(0, 8)}`,
          username: cleanUsername,
          fullName: cleanFullName,
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
          createdAt: new Date().toISOString(),
          passwordHash: cred.hash,
          passwordSalt: cred.salt,
          isDemoData: false,
        };
        db.users.push(adminUser);
        appendAudit(
          db,
          adminUser,
          'ADMINISTRADOR_INICIAL_CONFIGURADO',
          'UTILIZADOR',
          adminUser.id,
          `Administrador inicial ${adminUser.fullName} (${adminUser.username}) configurado no primeiro acesso.`
        );
        return {
          token: signToken(adminUser),
          user: stripUserSecrets(adminUser),
          settings: db.settings,
        };
      });

      res.status(201).json(result);
    })
  );

  // ==================== AUTHENTICATION ====================
  app.post(
    '/api/auth/login',
    asyncHandler(async (req, res) => {
      const { username, password } = req.body || {};
      if (!username || !password) {
        throw new HttpError(400, 'Informe o nome de utilizador e a palavra-passe.');
      }
      const ip = getClientIp(req);
      const userKey = String(username).trim().toLowerCase();
      assertLoginAllowed(ip, userKey, res);

      const result = await mutateDb((db) => {
        const user = db.users.find((u) => u.username.toLowerCase() === userKey);
        if (!user || !verifyPassword(String(password), user.passwordHash, user.passwordSalt)) {
          recordFailedLogin(ip, userKey);
          throw new HttpError(401, 'Utilizador ou palavra-passe incorretos.');
        }
        if (!user.active) {
          recordFailedLogin(ip, userKey);
          throw new HttpError(403, 'Esta conta de utilizador encontra-se desativada.');
        }
        clearLoginFailures(ip, userKey);
        appendAudit(
          db,
          user,
          'INICIO_SESSAO',
          'UTILIZADOR',
          user.id,
          `Início de sessão por ${user.fullName}.`
        );
        return {
          token: signToken(user),
          user: stripUserSecrets(user),
          settings: db.settings,
        };
      });

      res.json(result);
    })
  );

  app.post(
    '/api/auth/switch',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { username, password } = req.body || {};
      if (!username || !password) {
        throw new HttpError(400, 'Para mudar de utilizador, indique o utilizador e a palavra-passe.');
      }
      const ip = getClientIp(req);
      const userKey = String(username).trim().toLowerCase();
      assertLoginAllowed(ip, userKey, res);

      const result = await mutateDb((db) => {
        const target = db.users.find((u) => u.username.toLowerCase() === userKey);
        if (!target || !verifyPassword(String(password), target.passwordHash, target.passwordSalt)) {
          recordFailedLogin(ip, userKey);
          throw new HttpError(401, 'Credenciais inválidas para o utilizador selecionado.');
        }
        if (!target.active) {
          recordFailedLogin(ip, userKey);
          throw new HttpError(403, 'O utilizador selecionado está desativado.');
        }
        clearLoginFailures(ip, userKey);
        appendAudit(
          db,
          target,
          'MUDANCA_UTILIZADOR',
          'UTILIZADOR',
          target.id,
          `Mudança de sessão: ${req.currentUser!.fullName} → ${target.fullName}.`
        );
        return {
          token: signToken(target),
          user: stripUserSecrets(target),
          settings: db.settings,
        };
      });

      if (req.tokenPayload) {
        await revokeTokenInDb(req.tokenPayload.jti, req.currentUser!.id, req.tokenPayload.exp);
      }

      res.json(result);
    })
  );

  app.post('/api/auth/verify-password', requireAuth, (req: AuthedRequest, res) => {
    const { password } = req.body || {};
    if (!password) {
      res.status(400).json({ error: 'Introduza a palavra-passe para desbloquear.' });
      return;
    }
    const user = req.currentUser!;
    const ip = getClientIp(req);
    const userKey = user.username.toLowerCase();
    try {
      assertLoginAllowed(ip, userKey, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (!verifyPassword(String(password), user.passwordHash, user.passwordSalt)) {
      recordFailedLogin(ip, userKey);
      res.status(401).json({ error: 'Palavra-passe incorreta.' });
      return;
    }
    clearLoginFailures(ip, userKey);
    res.json({ ok: true });
  });

  app.post(
    '/api/auth/logout',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const user = req.currentUser!;
      if (req.tokenPayload) {
        await revokeTokenInDb(req.tokenPayload.jti, user.id, req.tokenPayload.exp);
      }
      await mutateDb((db) => {
        appendAudit(
          db,
          user,
          'TERMINO_SESSAO',
          'UTILIZADOR',
          user.id,
          `Sessão terminada e revogada por ${user.fullName}.`
        );
      });
      res.json({ ok: true });
    })
  );

  app.get(
    '/api/auth/me',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const db = await loadDbAsync();
      res.json({
        user: stripUserSecrets(req.currentUser!),
        settings: db.settings,
      });
    })
  );

  app.get(
    '/api/auth/users-directory',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(
        db.users
          .filter((u) => u.active)
          .map((u) => ({
            id: u.id,
            username: u.username,
            fullName: u.fullName,
            role: u.role,
          }))
      );
    })
  );

  // ==================== USERS (ADMIN) ====================
  app.get(
    '/api/users',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const db = await loadDbAsync();
      if (req.currentUser!.role === 'ADMIN') {
        res.json(db.users.map(stripUserSecrets));
        return;
      }
      res.json(
        db.users.map((u) => ({
          id: u.id,
          username: u.username,
          fullName: u.fullName,
          role: u.role,
          active: u.active,
          permissions: u.permissions,
          createdAt: u.createdAt,
        }))
      );
    })
  );

  app.post(
    '/api/users',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { username, fullName, password, role, permissions } = req.body || {};
      if (!username || !fullName || !password) {
        throw new HttpError(400, 'Utilizador, nome completo e palavra-passe são obrigatórios.');
      }
      if (String(password).length < 4) {
        throw new HttpError(400, 'A palavra-passe deve ter pelo menos 4 caracteres.');
      }

      const created = await mutateDb((db) => {
        const cleanUsername = String(username).trim().toLowerCase();
        if (db.users.some((u) => u.username.toLowerCase() === cleanUsername)) {
          throw new HttpError(409, 'Já existe um utilizador com esse identificador.');
        }
        const cred = hashPassword(String(password));
        const userRole = role === 'ADMIN' ? 'ADMIN' : 'SELLER';
        const newUser: StoredUser = {
          id: `usr_${crypto.randomUUID().slice(0, 8)}`,
          username: cleanUsername,
          fullName: String(fullName).trim(),
          role: userRole,
          active: true,
          permissions:
            userRole === 'ADMIN'
              ? {
                  canDiscount: true,
                  maxDiscountPercent: 100,
                  canProcessReturns: true,
                  canCancelSales: true,
                  canViewPurchases: true,
                  canStartInventoryCount: true,
                  canConfigureProductVat: true,
                }
              : {
                  canDiscount: Boolean(permissions?.canDiscount ?? true),
                  maxDiscountPercent: Math.min(100, Math.max(0, Number(permissions?.maxDiscountPercent ?? 5))),
                  canProcessReturns: Boolean(permissions?.canProcessReturns ?? true),
                  canCancelSales: Boolean(permissions?.canCancelSales ?? false),
                  canViewPurchases: Boolean(permissions?.canViewPurchases ?? false),
                  canStartInventoryCount: Boolean(permissions?.canStartInventoryCount ?? true),
                  canConfigureProductVat: Boolean(permissions?.canConfigureProductVat ?? false),
                },
          createdAt: new Date().toISOString(),
          passwordHash: cred.hash,
          passwordSalt: cred.salt,
          isDemoData: false,
        };
        db.users.push(newUser);
        appendAudit(
          db,
          req.currentUser!,
          'UTILIZADOR_CRIADO',
          'UTILIZADOR',
          newUser.id,
          `Utilizador ${newUser.fullName} (${newUser.username}, ${newUser.role}) criado.`
        );
        return stripUserSecrets(newUser);
      });

      res.status(201).json(created);
    })
  );

  app.put(
    '/api/users/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { fullName, role, active, permissions, newPassword } = req.body || {};

      const updated = await mutateDb((db) => {
        const idx = db.users.findIndex((u) => u.id === req.params.id);
        if (idx === -1) {
          throw new HttpError(404, 'Utilizador não encontrado.');
        }
        const target = db.users[idx];

        if (target.id === req.currentUser!.id && active === false) {
          throw new HttpError(400, 'Não pode desativar a sua própria conta enquanto está autenticado.');
        }
        const activeAdmins = db.users.filter((u) => u.role === 'ADMIN' && u.active && u.id !== target.id);
        if (target.role === 'ADMIN' && (active === false || role === 'SELLER') && activeAdmins.length === 0) {
          throw new HttpError(400, 'Deve existir pelo menos um administrador ativo no sistema.');
        }

        if (fullName !== undefined) target.fullName = String(fullName).trim();
        const roleChanged = (role === 'ADMIN' || role === 'SELLER') && role !== target.role;
        if (role === 'ADMIN' || role === 'SELLER') target.role = role;
        const deactivated = active === false && target.active;
        if (typeof active === 'boolean') target.active = active;
        if (permissions) {
          target.permissions = {
            canDiscount: Boolean(permissions.canDiscount),
            maxDiscountPercent: Math.min(100, Math.max(0, Number(permissions.maxDiscountPercent ?? 0))),
            canProcessReturns: Boolean(permissions.canProcessReturns),
            canCancelSales: Boolean(permissions.canCancelSales),
            canViewPurchases: Boolean(permissions.canViewPurchases),
            canStartInventoryCount: Boolean(permissions.canStartInventoryCount),
            canConfigureProductVat:
              target.role === 'ADMIN' ? true : Boolean(permissions.canConfigureProductVat),
          };
        }
        let passwordChanged = false;
        if (newPassword && String(newPassword).trim().length > 0) {
          if (String(newPassword).length < 4) {
            throw new HttpError(400, 'A nova palavra-passe deve ter pelo menos 4 caracteres.');
          }
          const cred = hashPassword(String(newPassword));
          target.passwordHash = cred.hash;
          target.passwordSalt = cred.salt;
          passwordChanged = true;
        }
        if (passwordChanged || deactivated || roleChanged) {
          target.tokensValidAfter = Date.now();
        }
        target.isDemoData = false;

        appendAudit(
          db,
          req.currentUser!,
          'UTILIZADOR_ATUALIZADO',
          'UTILIZADOR',
          target.id,
          `Dados/permissões do utilizador ${target.fullName} atualizados.`
        );
        return stripUserSecrets(target);
      });

      res.json(updated);
    })
  );

  // ==================== PHARMACOLOGICAL CLASSES ====================
  app.get(
    '/api/classes',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(db.classes);
    })
  );

  app.post(
    '/api/classes',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { name, description } = req.body || {};
      if (!name || !String(name).trim()) {
        throw new HttpError(400, 'O nome da classe farmacológica é obrigatório.');
      }

      const item = await mutateDb((db) => {
        if (db.classes.some((c) => c.name.toLowerCase() === String(name).trim().toLowerCase())) {
          throw new HttpError(409, 'Já existe uma classe farmacológica com esse nome.');
        }
        const created = {
          id: `cls_${crypto.randomUUID().slice(0, 8)}`,
          name: String(name).trim(),
          description: String(description || '').trim(),
          active: true,
        };
        db.classes.push(created);
        appendAudit(db, req.currentUser!, 'CLASSE_CRIADA', 'CLASSE', created.id, `Classe "${created.name}" criada.`);
        return created;
      });

      res.status(201).json(item);
    })
  );

  app.put(
    '/api/classes/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { name, description, active } = req.body || {};
      const updated = await mutateDb((db) => {
        const cls = db.classes.find((c) => c.id === req.params.id);
        if (!cls) {
          throw new HttpError(404, 'Classe não encontrada.');
        }
        if (name !== undefined && String(name).trim()) cls.name = String(name).trim();
        if (description !== undefined) cls.description = String(description).trim();
        if (typeof active === 'boolean') cls.active = active;
        appendAudit(db, req.currentUser!, 'CLASSE_ATUALIZADA', 'CLASSE', cls.id, `Classe "${cls.name}" atualizada.`);
        return cls;
      });
      res.json(updated);
    })
  );

  // ==================== PRODUCTS ====================
  app.get(
    '/api/products',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(db.products);
    })
  );

  app.post(
    '/api/products',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const p = req.body || {};
      if (!p.name || !p.code || !p.classId) {
        throw new HttpError(400, 'Nome comercial, código/referência e classe farmacológica são obrigatórios.');
      }
      const purchasePrice = Number(p.purchasePrice ?? 0);
      const salePrice = Number(p.salePrice ?? 0);
      const stock = Number(p.stock ?? 0);
      const minStock = Number(p.minStock ?? 0);
      if (purchasePrice < 0 || salePrice < 0 || stock < 0 || minStock < 0) {
        throw new HttpError(400, 'Preços e quantidades não podem ser negativos.');
      }

      const cleanBarcode =
        p.barcode !== undefined && p.barcode !== null
          ? String(p.barcode).replace(/[\r\n\t\u0000-\u001F\u007F]/g, '').trim()
          : '';
      if (cleanBarcode.length > 64) {
        throw new HttpError(400, 'O código de barras não pode exceder 64 caracteres.');
      }

      const taxInput = validateProductTaxInput({
        taxType: p.taxType,
        taxCode: p.taxCode,
        taxRate: p.taxRate,
        taxExemptionCode: p.taxExemptionCode,
        taxExemptionReason: p.taxExemptionReason,
      });

      const created = await mutateDb((db) => {
        const codeUpper = String(p.code).trim().toUpperCase();
        if (db.products.some((x) => x.code.toUpperCase() === codeUpper)) {
          throw new HttpError(409, `Já existe um produto com o código "${codeUpper}".`);
        }
        if (
          cleanBarcode &&
          db.products.some(
            (x) => x.barcode && x.barcode.trim().toUpperCase() === cleanBarcode.toUpperCase()
          )
        ) {
          throw new HttpError(
            409,
            `O código de barras "${cleanBarcode}" já está associado a outro produto.`
          );
        }

        const taxRuleId = p.taxRuleId ? String(p.taxRuleId).trim() : undefined;
        if (taxRuleId && !(db.settings.taxRules || []).some((r) => r.id === taxRuleId)) {
          throw new HttpError(400, 'Regra fiscal associada não encontrada na tabela de IVA.');
        }

        const priceIncludesTax =
          p.priceIncludesTax === true ? true : p.priceIncludesTax === false ? false : null;
        const fiscalValidationState: ProductFiscalValidationState =
          p.fiscalValidationState === 'VALIDADO_CONTABILISTA'
            ? 'VALIDADO_CONTABILISTA'
            : 'PENDENTE_REVISAO';
        const batchTaxes = parseBatchTaxesInput(p.batchTaxes, db, req.currentUser!);

        const newProduct: Product = {
          id: `prd_${crypto.randomUUID().slice(0, 8)}`,
          code: codeUpper,
          barcode: cleanBarcode,
          name: String(p.name).trim(),
          activeIngredient: String(p.activeIngredient || '').trim(),
          classId: String(p.classId),
          dosageForm: String(p.dosageForm || '').trim(),
          dosage: String(p.dosage || '').trim(),
          unit: String(p.unit || 'Unidade').trim(),
          location: String(p.location || 'Geral').trim(),
          purchasePrice: roundMoney(purchasePrice),
          salePrice: roundMoney(salePrice),
          taxType: taxInput.taxType,
          taxCode: taxInput.taxCode,
          taxRate: taxInput.taxRate,
          taxExemptionCode: taxInput.taxExemptionCode,
          taxExemptionReason: taxInput.taxExemptionReason,
          priceIncludesTax,
          fiscalValidationState,
          ...(taxRuleId ? { taxRuleId } : {}),
          ...(batchTaxes.length > 0 ? { batchTaxes } : {}),
          stock: Math.floor(stock),
          quarantineStock: 0,
          minStock: Math.floor(minStock),
          batch: String(p.batch || '').trim(),
          expiryDate: String(p.expiryDate || '').trim(),
          supplierId: String(p.supplierId || ''),
          active: p.active !== false,
          updatedAt: new Date().toISOString(),
          isDemoData: false,
        };
        db.products.push(newProduct);
        if (newProduct.taxCode !== 'NAO_CONFIGURADO' || batchTaxes.length > 0) {
          recordFiscalChange(db, req.currentUser!, {
            entityType: 'PRODUTO_IVA',
            entityId: newProduct.id,
            entityLabel: `${newProduct.code} — ${newProduct.name}`,
            field: 'Enquadramento inicial de IVA',
            previousValue: 'NOVO_PRODUTO',
            newValue: formatFiscalSummary(newProduct),
            reason: String(p.changeReason || 'Cadastro inicial com enquadramento fiscal').trim(),
          });
        }
        appendAudit(
          db,
          req.currentUser!,
          'PRODUTO_CRIADO',
          'PRODUTO',
          newProduct.id,
          `Produto ${newProduct.code} — ${newProduct.name} cadastrado (stock inicial: ${newProduct.stock}).`
        );
        return newProduct;
      });

      res.status(201).json(created);
    })
  );

  app.put(
    '/api/products/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const p = req.body || {};
      const updated = await mutateDb((db) => {
        const prod = db.products.find((x) => x.id === req.params.id);
        if (!prod) {
          throw new HttpError(404, 'Produto não encontrado.');
        }
        const prevSummary = formatFiscalSummary(prod);
        const prevBatchCount = (prod.batchTaxes || []).length;

        if (p.code !== undefined) {
          const codeUpper = String(p.code).trim().toUpperCase();
          if (db.products.some((x) => x.id !== prod.id && x.code.toUpperCase() === codeUpper)) {
            throw new HttpError(409, `O código "${codeUpper}" já está atribuído a outro produto.`);
          }
          prod.code = codeUpper;
        }
        if (p.barcode !== undefined) {
          const cleanBarcode =
            p.barcode !== null
              ? String(p.barcode).replace(/[\r\n\t\u0000-\u001F\u007F]/g, '').trim()
              : '';
          if (cleanBarcode.length > 64) {
            throw new HttpError(400, 'O código de barras não pode exceder 64 caracteres.');
          }
          if (
            cleanBarcode &&
            db.products.some(
              (x) =>
                x.id !== prod.id &&
                x.barcode &&
                x.barcode.trim().toUpperCase() === cleanBarcode.toUpperCase()
            )
          ) {
            throw new HttpError(
              409,
              `O código de barras "${cleanBarcode}" já está associado a outro produto.`
            );
          }
          prod.barcode = cleanBarcode;
        }
        if (p.name !== undefined) prod.name = String(p.name).trim();
        if (p.activeIngredient !== undefined) prod.activeIngredient = String(p.activeIngredient).trim();
        if (p.classId !== undefined) prod.classId = String(p.classId);
        if (p.dosageForm !== undefined) prod.dosageForm = String(p.dosageForm).trim();
        if (p.dosage !== undefined) prod.dosage = String(p.dosage).trim();
        if (p.unit !== undefined) prod.unit = String(p.unit).trim();
        if (p.location !== undefined) prod.location = String(p.location).trim();
        if (p.purchasePrice !== undefined) {
          if (Number(p.purchasePrice) < 0) {
            throw new HttpError(400, 'O preço de compra não pode ser negativo.');
          }
          prod.purchasePrice = roundMoney(Number(p.purchasePrice));
        }
        if (p.salePrice !== undefined) {
          if (Number(p.salePrice) < 0) {
            throw new HttpError(400, 'O preço de venda não pode ser negativo.');
          }
          prod.salePrice = roundMoney(Number(p.salePrice));
        }
        if (p.minStock !== undefined) prod.minStock = Math.max(0, Math.floor(Number(p.minStock)));
        if (p.batch !== undefined) prod.batch = String(p.batch).trim();
        if (p.expiryDate !== undefined) prod.expiryDate = String(p.expiryDate).trim();
        if (p.supplierId !== undefined) prod.supplierId = String(p.supplierId);
        if (
          p.taxType !== undefined ||
          p.taxCode !== undefined ||
          p.taxRate !== undefined ||
          p.taxExemptionCode !== undefined ||
          p.taxExemptionReason !== undefined
        ) {
          const taxInput = validateProductTaxInput({
            taxType: p.taxType !== undefined ? p.taxType : prod.taxType,
            taxCode: p.taxCode !== undefined ? p.taxCode : prod.taxCode,
            taxRate: p.taxRate !== undefined ? p.taxRate : prod.taxRate,
            taxExemptionCode: p.taxExemptionCode !== undefined ? p.taxExemptionCode : prod.taxExemptionCode,
            taxExemptionReason: p.taxExemptionReason !== undefined ? p.taxExemptionReason : prod.taxExemptionReason,
          });
          prod.taxType = taxInput.taxType;
          prod.taxCode = taxInput.taxCode;
          prod.taxRate = taxInput.taxRate;
          prod.taxExemptionCode = taxInput.taxExemptionCode;
          prod.taxExemptionReason = taxInput.taxExemptionReason;
        }
        if (p.priceIncludesTax !== undefined) {
          prod.priceIncludesTax =
            p.priceIncludesTax === true ? true : p.priceIncludesTax === false ? false : null;
        }
        if (p.fiscalValidationState !== undefined) {
          prod.fiscalValidationState =
            p.fiscalValidationState === 'VALIDADO_CONTABILISTA'
              ? 'VALIDADO_CONTABILISTA'
              : 'PENDENTE_REVISAO';
        }
        if (p.taxRuleId !== undefined) {
          const nextRuleId = p.taxRuleId ? String(p.taxRuleId).trim() : '';
          if (nextRuleId && !(db.settings.taxRules || []).some((r) => r.id === nextRuleId)) {
            throw new HttpError(400, 'Regra fiscal associada não encontrada.');
          }
          prod.taxRuleId = nextRuleId || undefined;
        }
        let batchTaxesChanged = false;
        if (p.batchTaxes !== undefined) {
          const nextBatchTaxes = parseBatchTaxesInput(p.batchTaxes, db, req.currentUser!);
          batchTaxesChanged = JSON.stringify(prod.batchTaxes || []) !== JSON.stringify(nextBatchTaxes);
          prod.batchTaxes = nextBatchTaxes;
        }
        if (typeof p.active === 'boolean') prod.active = p.active;
        prod.updatedAt = new Date().toISOString();
        prod.isDemoData = false;

        const nextSummary = formatFiscalSummary(prod);
        if (prevSummary !== nextSummary) {
          recordFiscalChange(db, req.currentUser!, {
            entityType: 'PRODUTO_IVA',
            entityId: prod.id,
            entityLabel: `${prod.code} — ${prod.name}`,
            field: 'Enquadramento fiscal de produto',
            previousValue: prevSummary,
            newValue: nextSummary,
            reason: String(p.changeReason || 'Atualização cadastral de produto').trim(),
          });
        }
        if (batchTaxesChanged) {
          recordFiscalChange(db, req.currentUser!, {
            entityType: 'LOTE_IVA',
            entityId: prod.id,
            entityLabel: `${prod.code} — ${prod.name}`,
            field: 'Exceções fiscais por lote',
            previousValue: `${prevBatchCount} lote(s)`,
            newValue: `${(prod.batchTaxes || []).length} lote(s)`,
            reason: String(p.changeReason || 'Atualização de IVA por lote').trim(),
          });
        }

        appendAudit(
          db,
          req.currentUser!,
          'PRODUTO_EDITADO',
          'PRODUTO',
          prod.id,
          `Produto ${prod.code} — ${prod.name} atualizado.`
        );
        return prod;
      });
      res.json(updated);
    })
  );

  app.put(
    '/api/products/:id/fiscal',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const user = req.currentUser!;
      if (user.role !== 'ADMIN' && !user.permissions.canConfigureProductVat) {
        throw new HttpError(403, 'Sem permissão para configurar enquadramento fiscal/IVA de produtos.');
      }
      const p = req.body || {};
      const updated = await mutateDb((db) => {
        const prod = db.products.find((x) => x.id === req.params.id);
        if (!prod) {
          throw new HttpError(404, 'Produto não encontrado.');
        }
        const prevSummary = formatFiscalSummary(prod);
        const prevBatchCount = (prod.batchTaxes || []).length;

        const taxInput = validateProductTaxInput({
          taxType: p.taxType !== undefined ? p.taxType : prod.taxType,
          taxCode: p.taxCode !== undefined ? p.taxCode : prod.taxCode,
          taxRate: p.taxRate !== undefined ? p.taxRate : prod.taxRate,
          taxExemptionCode: p.taxExemptionCode !== undefined ? p.taxExemptionCode : prod.taxExemptionCode,
          taxExemptionReason: p.taxExemptionReason !== undefined ? p.taxExemptionReason : prod.taxExemptionReason,
        });
        prod.taxType = taxInput.taxType;
        prod.taxCode = taxInput.taxCode;
        prod.taxRate = taxInput.taxRate;
        prod.taxExemptionCode = taxInput.taxExemptionCode;
        prod.taxExemptionReason = taxInput.taxExemptionReason;

        if (p.priceIncludesTax !== undefined) {
          prod.priceIncludesTax =
            p.priceIncludesTax === true ? true : p.priceIncludesTax === false ? false : null;
        }
        if (p.fiscalValidationState !== undefined) {
          prod.fiscalValidationState =
            p.fiscalValidationState === 'VALIDADO_CONTABILISTA'
              ? 'VALIDADO_CONTABILISTA'
              : 'PENDENTE_REVISAO';
        }
        if (p.taxRuleId !== undefined) {
          const nextRuleId = p.taxRuleId ? String(p.taxRuleId).trim() : '';
          if (nextRuleId && !(db.settings.taxRules || []).some((r) => r.id === nextRuleId)) {
            throw new HttpError(400, 'Regra fiscal associada não encontrada.');
          }
          prod.taxRuleId = nextRuleId || undefined;
        }
        let batchTaxesChanged = false;
        if (p.batchTaxes !== undefined) {
          const nextBatchTaxes = parseBatchTaxesInput(p.batchTaxes, db, user);
          batchTaxesChanged = JSON.stringify(prod.batchTaxes || []) !== JSON.stringify(nextBatchTaxes);
          prod.batchTaxes = nextBatchTaxes;
        }

        prod.updatedAt = new Date().toISOString();

        const nextSummary = formatFiscalSummary(prod);
        const reasonText = String(p.changeReason || 'Revisão fiscal de IVA do produto').trim();
        if (prevSummary !== nextSummary || !batchTaxesChanged) {
          recordFiscalChange(db, user, {
            entityType: 'PRODUTO_IVA',
            entityId: prod.id,
            entityLabel: `${prod.code} — ${prod.name}`,
            field: 'Enquadramento fiscal de produto',
            previousValue: prevSummary,
            newValue: nextSummary,
            reason: reasonText,
          });
        }
        if (batchTaxesChanged) {
          recordFiscalChange(db, user, {
            entityType: 'LOTE_IVA',
            entityId: prod.id,
            entityLabel: `${prod.code} — ${prod.name}`,
            field: 'Exceções fiscais por lote',
            previousValue: `${prevBatchCount} lote(s)`,
            newValue: `${(prod.batchTaxes || []).length} lote(s)`,
            reason: reasonText,
          });
        }

        appendAudit(
          db,
          user,
          'PRODUTO_IVA_ATUALIZADO',
          'PRODUTO',
          prod.id,
          `Enquadramento de IVA do produto ${prod.code} — ${prod.name} atualizado para ${nextSummary}.`
        );
        return prod;
      });
      res.json(updated);
    })
  );

  app.post(
    '/api/products/fiscal/bulk',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const user = req.currentUser!;
      if (user.role !== 'ADMIN' && !user.permissions.canConfigureProductVat) {
        throw new HttpError(403, 'Sem permissão para configurar enquadramento fiscal/IVA de produtos.');
      }
      const p = req.body || {};
      const ids = Array.isArray(p.productIds)
        ? Array.from(new Set(p.productIds.map((x: unknown) => String(x || '').trim()).filter(Boolean)))
        : [];
      if (ids.length === 0) {
        throw new HttpError(400, 'Selecione pelo menos um produto para atribuir o enquadramento fiscal.');
      }
      const taxInput = validateProductTaxInput({
        taxType: p.taxType,
        taxCode: p.taxCode,
        taxRate: p.taxRate,
        taxExemptionCode: p.taxExemptionCode,
        taxExemptionReason: p.taxExemptionReason,
      });

      const result = await mutateDb((db) => {
        const nextRuleId = p.taxRuleId ? String(p.taxRuleId).trim() : '';
        if (nextRuleId && !(db.settings.taxRules || []).some((r) => r.id === nextRuleId)) {
          throw new HttpError(400, 'Regra fiscal associada não encontrada.');
        }
        const now = new Date().toISOString();
        const reasonText = String(p.changeReason || 'Atribuição fiscal de IVA em lote').trim();
        const updatedProducts: Product[] = [];

        for (const id of ids) {
          const prod = db.products.find((x) => x.id === id);
          if (!prod) continue;
          const prevSummary = formatFiscalSummary(prod);
          prod.taxType = taxInput.taxType;
          prod.taxCode = taxInput.taxCode;
          prod.taxRate = taxInput.taxRate;
          prod.taxExemptionCode = taxInput.taxExemptionCode;
          prod.taxExemptionReason = taxInput.taxExemptionReason;
          if (p.priceIncludesTax !== undefined) {
            prod.priceIncludesTax =
              p.priceIncludesTax === true ? true : p.priceIncludesTax === false ? false : null;
          }
          if (p.fiscalValidationState !== undefined) {
            prod.fiscalValidationState =
              p.fiscalValidationState === 'VALIDADO_CONTABILISTA'
                ? 'VALIDADO_CONTABILISTA'
                : 'PENDENTE_REVISAO';
          }
          prod.taxRuleId = nextRuleId || undefined;
          prod.updatedAt = now;
          const nextSummary = formatFiscalSummary(prod);
          recordFiscalChange(db, user, {
            entityType: 'PRODUTO_IVA',
            entityId: prod.id,
            entityLabel: `${prod.code} — ${prod.name}`,
            field: 'Enquadramento fiscal de produto (lote)',
            previousValue: prevSummary,
            newValue: nextSummary,
            reason: reasonText,
          });
          updatedProducts.push(prod);
        }

        if (updatedProducts.length === 0) {
          throw new HttpError(404, 'Nenhum dos produtos selecionados foi encontrado.');
        }

        appendAudit(
          db,
          user,
          'PRODUTO_IVA_LOTE_ATUALIZADO',
          'PRODUTO',
          updatedProducts.map((u) => u.id).join(','),
          `Enquadramento de IVA atualizado em lote para ${updatedProducts.length} produto(s): ${taxInput.taxCode} (${taxInput.taxRate ?? 'S/Taxa'}%).`
        );
        return { updatedCount: updatedProducts.length, products: updatedProducts };
      });
      res.json(result);
    })
  );

  app.patch(
    '/api/products/:id/status',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const updated = await mutateDb((db) => {
        const prod = db.products.find((x) => x.id === req.params.id);
        if (!prod) {
          throw new HttpError(404, 'Produto não encontrado.');
        }
        prod.active = Boolean(req.body?.active);
        prod.updatedAt = new Date().toISOString();
        appendAudit(
          db,
          req.currentUser!,
          prod.active ? 'PRODUTO_ATIVADO' : 'PRODUTO_DESATIVADO',
          'PRODUTO',
          prod.id,
          `Produto ${prod.code} — ${prod.name} ${prod.active ? 'ativado' : 'desativado'}.`
        );
        return prod;
      });
      res.json(updated);
    })
  );

  // ==================== SUPPLIERS ====================
  app.get(
    '/api/suppliers',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(db.suppliers);
    })
  );

  app.post(
    '/api/suppliers',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const s = req.body || {};
      if (!s.name || !String(s.name).trim()) {
        throw new HttpError(400, 'O nome do fornecedor é obrigatório.');
      }

      const created = await mutateDb((db) => {
        const newSupplier = {
          id: `sup_${crypto.randomUUID().slice(0, 8)}`,
          name: String(s.name).trim(),
          nif: String(s.nif || '').trim(),
          phone: String(s.phone || '').trim(),
          email: String(s.email || '').trim(),
          address: String(s.address || '').trim(),
          notes: String(s.notes || '').trim(),
          active: true,
          createdAt: new Date().toISOString(),
          isDemoData: false,
        };
        db.suppliers.push(newSupplier);
        appendAudit(
          db,
          req.currentUser!,
          'FORNECEDOR_CRIADO',
          'FORNECEDOR',
          newSupplier.id,
          `Fornecedor ${newSupplier.name} (NIF: ${newSupplier.nif || 'N/D'}) registado.`
        );
        return newSupplier;
      });

      res.status(201).json(created);
    })
  );

  app.put(
    '/api/suppliers/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const s = req.body || {};
      const updated = await mutateDb((db) => {
        const sup = db.suppliers.find((x) => x.id === req.params.id);
        if (!sup) {
          throw new HttpError(404, 'Fornecedor não encontrado.');
        }
        if (s.name !== undefined && String(s.name).trim()) sup.name = String(s.name).trim();
        if (s.nif !== undefined) sup.nif = String(s.nif).trim();
        if (s.phone !== undefined) sup.phone = String(s.phone).trim();
        if (s.email !== undefined) sup.email = String(s.email).trim();
        if (s.address !== undefined) sup.address = String(s.address).trim();
        if (s.notes !== undefined) sup.notes = String(s.notes).trim();
        if (typeof s.active === 'boolean') sup.active = s.active;
        sup.isDemoData = false;
        appendAudit(db, req.currentUser!, 'FORNECEDOR_EDITADO', 'FORNECEDOR', sup.id, `Fornecedor ${sup.name} atualizado.`);
        return sup;
      });
      res.json(updated);
    })
  );

  // ==================== PURCHASES (STOCK INFLOW) ====================
  app.get(
    '/api/purchases',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      if (req.currentUser!.role !== 'ADMIN' && !req.currentUser!.permissions.canViewPurchases) {
        throw new HttpError(403, 'Sem permissão para consultar compras.');
      }
      const db = await loadDbAsync();
      res.json(db.purchases);
    })
  );

  const processedPurchaseRequests = new Map<string, DatabaseSchema['purchases'][number]>();

  app.post(
    '/api/purchases',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { supplierId, documentNumber, documentDate, items, notes, requestId, pricesIncludeTax } =
        req.body || {};
      if (!supplierId || !documentNumber || !documentDate || !Array.isArray(items) || items.length === 0) {
        throw new HttpError(
          400,
          'Fornecedor, número/data do documento e pelo menos um produto são obrigatórios.'
        );
      }

      const reqKey =
        requestId && String(requestId).trim()
          ? `${req.currentUser!.id}:${String(requestId).trim()}`
          : '';

      const outcome = await mutateDb((db) => {
        if (reqKey && processedPurchaseRequests.has(reqKey)) {
          return { purchase: processedPurchaseRequests.get(reqKey)!, deduplicated: true };
        }

        const supplier = db.suppliers.find((s) => s.id === supplierId);
        if (!supplier) {
          throw new HttpError(404, 'Fornecedor não encontrado.');
        }
        const docNumTrim = String(documentNumber).trim();
        if (
          db.purchases.some(
            (p) => p.supplierId === supplierId && p.documentNumber.toLowerCase() === docNumTrim.toLowerCase()
          )
        ) {
          throw new HttpError(
            409,
            `O documento de compra "${docNumTrim}" já foi registado para este fornecedor.`
          );
        }

        const parsedItems: PurchaseItem[] = [];
        let totalAmount = 0;
        let subtotalBase = 0;

        for (const raw of items) {
          const prod = db.products.find((p) => p.id === raw.productId);
          if (!prod) {
            throw new HttpError(404, `Produto não encontrado (${raw.productId}).`);
          }
          const rawQty = Number(raw.quantity);
          const qty = Math.floor(rawQty);
          const unitCost = roundMoney(Number(raw.unitCost));
          if (!Number.isFinite(rawQty) || qty <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
            throw new HttpError(400, `Quantidade ou custo inválido para ${prod.name}.`);
          }

          const lineBatch = String(raw.batch ?? prod.batch ?? '').trim();
          const effectiveProdTax = resolveEffectiveProductTax(
            prod,
            db.settings,
            lineBatch,
            String(documentDate)
          );

          const hasExplicitTax = raw.taxCode !== undefined;
          const lineTaxSpec = hasExplicitTax
            ? validateProductTaxInput({
                taxType: raw.taxType ?? 'IVA',
                taxCode: raw.taxCode,
                taxRate: raw.taxRate,
                taxExemptionCode: raw.taxExemptionCode,
                taxExemptionReason: raw.taxExemptionReason,
              })
            : {
                taxType: effectiveProdTax.taxType,
                taxCode: effectiveProdTax.taxCode,
                taxRate: effectiveProdTax.taxRate,
                taxExemptionCode: effectiveProdTax.taxExemptionCode,
                taxExemptionReason: effectiveProdTax.taxExemptionReason,
              };

          const lineIncludesTax =
            typeof raw.priceIncludesTax === 'boolean'
              ? raw.priceIncludesTax
              : typeof pricesIncludeTax === 'boolean'
              ? pricesIncludeTax
              : effectiveProdTax.priceIncludesTax;

          const lineGrossInput = roundMoney(qty * unitCost);
          const taxVals = buildLineTaxValues(lineGrossInput, lineTaxSpec, lineIncludesTax);

          subtotalBase = roundMoney(subtotalBase + taxVals.taxableBase);
          totalAmount = roundMoney(totalAmount + taxVals.lineTotalWithTax);
          parsedItems.push({
            productId: prod.id,
            productCode: prod.code,
            productBarcode: prod.barcode || '',
            productName: prod.name,
            quantity: qty,
            unitCost,
            taxType: taxVals.taxType,
            taxCode: taxVals.taxCode,
            taxRate: taxVals.taxRate,
            taxExemptionCode: taxVals.taxExemptionCode,
            taxExemptionReason: taxVals.taxExemptionReason,
            priceIncludesTax: taxVals.priceIncludesTax,
            taxableBase: taxVals.taxableBase,
            taxAmount: taxVals.taxAmount,
            subtotal: taxVals.lineTotalWithTax,
            batch: lineBatch,
            expiryDate: String(raw.expiryDate ?? prod.expiryDate ?? '').trim(),
          });
        }

        for (const item of parsedItems) {
          const prod = db.products.find((p) => p.id === item.productId)!;
          prod.stock += item.quantity;
          prod.purchasePrice = item.unitCost;
          if (item.batch) prod.batch = item.batch;
          if (item.expiryDate) prod.expiryDate = item.expiryDate;
          prod.supplierId = supplier.id;
          prod.updatedAt = new Date().toISOString();
        }

        const internalNumber = allocateDocumentNumber(db, 'PURCHASE', String(documentDate));
        const { taxTotal, taxBreakdown } = aggregateTaxBreakdown(parsedItems);

        const created = {
          id: `pur_${crypto.randomUUID().slice(0, 8)}`,
          internalNumber,
          supplierId: supplier.id,
          supplierName: supplier.name,
          documentNumber: docNumTrim,
          documentDate: String(documentDate),
          items: parsedItems,
          subtotal: subtotalBase,
          taxTotal,
          taxBreakdown,
          pricesIncludeTax:
            typeof pricesIncludeTax === 'boolean' ? pricesIncludeTax : Boolean(db.settings.pricesIncludeTax),
          totalAmount,
          notes: String(notes || '').trim(),
          userId: req.currentUser!.id,
          userName: req.currentUser!.fullName,
          createdAt: new Date().toISOString(),
          isDemoData: false,
        };
        db.purchases.unshift(created);
        appendAudit(
          db,
          req.currentUser!,
          'COMPRA_REGISTADA',
          'COMPRA',
          created.id,
          `Compra ${created.internalNumber} (${supplier.name}, Doc. ${docNumTrim}) confirmada. Stock atualizado em ${parsedItems.length} produto(s).`,
          { subtotalBase, taxTotal, totalAmount, itemsCount: parsedItems.length }
        );

        if (reqKey) {
          processedPurchaseRequests.set(reqKey, created);
          if (processedPurchaseRequests.size > 500) {
            const oldestKey = processedPurchaseRequests.keys().next().value;
            if (oldestKey) processedPurchaseRequests.delete(oldestKey);
          }
        }

        return { purchase: created, deduplicated: false };
      });

      res.status(outcome.deduplicated ? 200 : 201).json(outcome.purchase);
    })
  );

  // ==================== CUSTOMERS ====================
  app.get(
    '/api/customers',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(db.customers);
    })
  );

  app.post(
    '/api/customers',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const c = req.body || {};
      if (!c.name || !String(c.name).trim()) {
        throw new HttpError(400, 'O nome do cliente é obrigatório.');
      }

      const created = await mutateDb((db) => {
        const nifTrim = String(c.nif || '').trim();
        if (nifTrim && db.customers.some((x) => x.nif.toLowerCase() === nifTrim.toLowerCase())) {
          throw new HttpError(409, `Já existe um cliente registado com o NIF ${nifTrim}.`);
        }
        const customer = {
          id: `cus_${crypto.randomUUID().slice(0, 8)}`,
          name: String(c.name).trim(),
          nif: nifTrim,
          phone: String(c.phone || '').trim(),
          email: String(c.email || '').trim(),
          address: String(c.address || '').trim(),
          notes: String(c.notes || '').trim(),
          createdAt: new Date().toISOString(),
          isDemoData: false,
        };
        db.customers.push(customer);
        appendAudit(
          db,
          req.currentUser!,
          'CLIENTE_CRIADO',
          'CLIENTE',
          customer.id,
          `Cliente ${customer.name} (NIF: ${customer.nif || 'N/D'}) cadastrado.`
        );
        return customer;
      });

      res.status(201).json(created);
    })
  );

  app.put(
    '/api/customers/:id',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const c = req.body || {};
      const updated = await mutateDb((db) => {
        const cus = db.customers.find((x) => x.id === req.params.id);
        if (!cus) {
          throw new HttpError(404, 'Cliente não encontrado.');
        }
        if (c.name !== undefined && String(c.name).trim()) cus.name = String(c.name).trim();
        if (c.nif !== undefined) cus.nif = String(c.nif).trim();
        if (c.phone !== undefined) cus.phone = String(c.phone).trim();
        if (c.email !== undefined) cus.email = String(c.email).trim();
        if (c.address !== undefined) cus.address = String(c.address).trim();
        if (c.notes !== undefined) cus.notes = String(c.notes).trim();
        cus.isDemoData = false;
        appendAudit(db, req.currentUser!, 'CLIENTE_EDITADO', 'CLIENTE', cus.id, `Cliente ${cus.name} atualizado.`);
        return cus;
      });
      res.json(updated);
    })
  );

  // ==================== SALES & PROFORMAS ====================
  app.get(
    '/api/sales',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(db.sales);
    })
  );

  app.post(
    '/api/sales',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const {
        type = 'FACTURA_RECIBO',
        customerId = null,
        isCommonConsumer = true,
        paymentMethod = 'DINHEIRO',
        items = [],
        notes = '',
        relatedInvoiceId = null,
        amount = 0,
      } = req.body || {};

      const validTypes: SaleDocumentType[] = [
        'FACTURA',
        'FACTURA_RECIBO',
        'RECIBO',
        'PROFORMA',
        'FATURA',
      ];
      if (!validTypes.includes(type)) {
        throw new HttpError(
          400,
          'Tipo de documento inválido. Valores suportados: Fatura-Recibo (FR), Fatura (FT), Recibo (RC) ou Proforma (PF).'
        );
      }

      const user = req.currentUser!;
      const saleDate = todayISO();
      const agtStatus = getAgtConfigStatus();
      const isFiscalDoc = type !== 'PROFORMA';

      if (type !== 'RECIBO' && (!Array.isArray(items) || items.length === 0)) {
        throw new HttpError(400, 'Adicione pelo menos um produto ao documento.');
      }

      const createdSale = await mutateDb((db) => {
        let activeOpenRegister: SellerClosing | undefined;
        if (isFiscalDoc) {
          const closedPeriod = isDateInClosedPeriod(db, saleDate);
          if (closedPeriod) {
            throw new HttpError(
              409,
              `O período (${closedPeriod.referenceNumber}) encontra-se fechado. Um administrador deve reabrir o período antes de emitir novos documentos fiscais para esta data.`
            );
          }

          activeOpenRegister = getOpenCashRegister(db, user.id);
          const closedTodayCount = db.sellerClosings.filter(
            (c) => c.date === saleDate && c.sellerId === user.id && c.status !== 'ABERTO'
          ).length;
          if ((user.role === 'SELLER' || closedTodayCount > 0) && !activeOpenRegister) {
            throw new HttpError(
              409,
              closedTodayCount > 0
                ? 'O seu caixa já foi fechado. Para voltar a vender ou receber pagamentos, abra primeiro um novo caixa.'
                : 'Ainda não abriu o caixa nesta sessão. Clique em "Abrir caixa" antes de concluir vendas ou recibos.',
              { code: 'CASH_REGISTER_CLOSED' }
            );
          }
        }

        const nowIso = new Date().toISOString();
        const locationOfOperation =
          db.settings.establishmentName?.trim() || db.settings.address?.trim() || 'Sede';

        // 1) RECIBO (RC) - Liquidação total ou parcial de Fatura (FT)
        if (type === 'RECIBO') {
          if (!relatedInvoiceId) {
            throw new HttpError(400, 'Selecione a Fatura (FT) a liquidar pelo Recibo.');
          }
          const inv = db.sales.find((s) => s.id === relatedInvoiceId);
          if (!inv || !isInvoiceSaleType(inv.type)) {
            throw new HttpError(404, 'Fatura associada não encontrada.');
          }
          if (inv.status === 'ANULADA' || inv.status === 'DEVOLVIDA') {
            throw new HttpError(
              409,
              `A fatura ${inv.documentNumber} foi anulada/devolvida e não pode receber recibos.`
            );
          }
          assertFiscalEmissionAllowed(db.settings, inv.items, 'RECIBO');
          const alreadyPaid = inv.paidAmount ?? (inv.type === 'FACTURA' ? 0 : inv.totalAmount);
          const remainingBalance = roundMoney(Math.max(0, inv.totalAmount - alreadyPaid));
          if (remainingBalance <= 0.009) {
            throw new HttpError(409, `A fatura ${inv.documentNumber} já se encontra totalmente liquidada.`);
          }
          const payAmt = roundMoney(Number(amount));
          if (!Number.isFinite(payAmt) || payAmt <= 0) {
            throw new HttpError(400, 'Indique um valor de pagamento positivo para o recibo.');
          }
          if (payAmt > remainingBalance + 0.01) {
            throw new HttpError(
              400,
              `O valor do recibo (${payAmt.toFixed(2)}) excede o saldo em dívida da fatura (${remainingBalance.toFixed(2)}).`
            );
          }
          const settledNow = Math.min(payAmt, remainingBalance);
          inv.paidAmount = roundMoney(alreadyPaid + settledNow);
          inv.paymentStatus = inv.paidAmount >= inv.totalAmount - 0.01 ? 'PAGO' : 'PARCIAL';

          const docNumber = allocateDocumentNumber(db, 'RECIBO', saleDate);
          const fiscalValidationStatus: FiscalValidationStatus = agtStatus.configured
            ? 'PENDENTE_AGT'
            : 'RASCUNHO_NAO_VALIDADO';

          const receiptSale: Sale = {
            id: `sal_${crypto.randomUUID().slice(0, 8)}`,
            documentNumber: docNumber,
            type: 'RECIBO',
            status: 'EMITIDA',
            customerId: inv.customerId,
            customerName: inv.customerName,
            customerNif: inv.customerNif,
            isCommonConsumer: inv.isCommonConsumer,
            paymentMethod,
            items: [],
            subtotal: settledNow,
            discountTotal: 0,
            taxTotal: 0,
            taxBreakdown: [],
            totalAmount: settledNow,
            paidAmount: settledNow,
            paymentStatus: 'PAGO',
            relatedInvoiceId: inv.id,
            relatedInvoiceNumber: inv.documentNumber,
            locationOfOperation,
            issuedAt: nowIso,
            seriesSource: 'INTERNA_NAO_OFICIAL',
            fiscalValidationStatus,
            agtSubmissionHistory: [
              {
                id: `agt_${crypto.randomUUID().slice(0, 8)}`,
                timestamp: nowIso,
                action: agtStatus.configured ? 'CRIADO_RASCUNHO' : 'MODO_RASCUNHO',
                validationStatus: fiscalValidationStatus,
                message: agtStatus.configured
                  ? 'Recibo criado e pronto para submissão à AGT.'
                  : 'Emitido em modo de rascunho interno (credenciais/certificação AGT não configuradas).',
              },
            ],
            notes: String(notes || `Liquidação referente a ${inv.documentNumber}`).trim(),
            sellerId: user.id,
            sellerName: user.fullName,
            date: saleDate,
            time: nowTimeStr(),
            createdAt: nowIso,
            ...(activeOpenRegister ? { cashRegisterId: activeOpenRegister.id } : {}),
            isDemoData: false,
          };

          db.sales.unshift(receiptSale);
          appendAudit(
            db,
            user,
            'RECIBO_EMITIDO',
            'RECIBO',
            receiptSale.id,
            `Recibo ${receiptSale.documentNumber} emitido para liquidação da Fatura ${inv.documentNumber} (${settledNow.toFixed(2)} ${db.settings.currencySymbol}).`,
            { documentNumber: receiptSale.documentNumber, relatedInvoice: inv.documentNumber, settledNow }
          );
          return receiptSale;
        }

        // 2) FACTURA (FT), FACTURA_RECIBO (FR), legacy FATURA, ou PROFORMA (PF)
        let resolvedCustomerName = 'Consumidor Final';
        let resolvedCustomerNif = '999999999';
        let resolvedCustomerId: string | null = null;
        if (!isCommonConsumer && customerId) {
          const cust = db.customers.find((c) => c.id === customerId);
          if (!cust) {
            throw new HttpError(404, 'Cliente selecionado não encontrado.');
          }
          resolvedCustomerId = cust.id;
          resolvedCustomerName = cust.name;
          resolvedCustomerNif = cust.nif || '999999999';
        }

        const requestedTotals = new Map<string, number>();
        for (const line of items) {
          const qty = Math.floor(Number(line.quantity));
          if (!qty || qty <= 0) {
            throw new HttpError(400, 'Todas as quantidades devem ser maiores que zero.');
          }
          requestedTotals.set(line.productId, (requestedTotals.get(line.productId) || 0) + qty);
        }

        const classMap = new Map(db.classes.map((c) => [c.id, c.name]));
        const shortages: Array<{ productId: string; productName: string; requested: number; available: number }> = [];
        const saleItems: SaleItem[] = [];
        const fiscalCheckItems: Array<{
          productName: string;
          taxCode?: TaxCode;
          taxRate?: number | null;
          taxExemptionCode?: string;
          taxExemptionReason?: string;
          ruleError?: string;
        }> = [];
        let subtotal = 0;
        let discountTotal = 0;
        let totalAmount = 0;

        for (const line of items) {
          const prod = db.products.find((p) => p.id === line.productId);
          if (!prod) {
            throw new HttpError(404, 'Um dos produtos selecionados não existe.');
          }
          if (!prod.active) {
            throw new HttpError(400, `O produto "${prod.name}" está inativo e não pode ser vendido.`);
          }

          const qty = Math.floor(Number(line.quantity));
          const disc = Number(line.discountPercent ?? 0);
          if (disc < 0 || disc > 100) {
            throw new HttpError(400, `Desconto inválido em "${prod.name}".`);
          }
          if (disc > 0 && user.role !== 'ADMIN') {
            if (!user.permissions.canDiscount) {
              throw new HttpError(403, 'Não tem permissão para aplicar descontos.');
            }
            if (disc > user.permissions.maxDiscountPercent) {
              throw new HttpError(
                403,
                `Desconto máximo autorizado para o seu perfil é ${user.permissions.maxDiscountPercent}%.`
              );
            }
          }

          const totalReqForProd = requestedTotals.get(prod.id) || qty;
          if (isInvoiceSaleType(type) && totalReqForProd > prod.stock) {
            if (!shortages.some((s) => s.productId === prod.id)) {
              shortages.push({
                productId: prod.id,
                productName: prod.name,
                requested: totalReqForProd,
                available: prod.stock,
              });
            }
          }

          const effectiveBatch = String(line.batch || prod.batch || '').trim();
          const effectiveTax = resolveEffectiveProductTax(prod, db.settings, effectiveBatch, saleDate);

          const grossLine = roundMoney(qty * prod.salePrice);
          const lineDisc = roundMoney((grossLine * disc) / 100);
          const netLine = roundMoney(grossLine - lineDisc);
          const taxVals = buildLineTaxValues(netLine, effectiveTax, effectiveTax.priceIncludesTax);

          subtotal = roundMoney(subtotal + grossLine);
          discountTotal = roundMoney(discountTotal + lineDisc);
          totalAmount = roundMoney(totalAmount + taxVals.lineTotalWithTax);

          fiscalCheckItems.push({
            productName: prod.name,
            taxCode: taxVals.taxCode,
            taxRate: taxVals.taxRate,
            taxExemptionCode: taxVals.taxExemptionCode,
            taxExemptionReason: taxVals.taxExemptionReason,
            ruleError: effectiveTax.ruleError,
          });

          saleItems.push({
            productId: prod.id,
            productCode: prod.code,
            productBarcode: prod.barcode || '',
            productName: prod.name,
            activeIngredient: prod.activeIngredient,
            className: classMap.get(prod.classId) || '',
            dosageForm: prod.dosageForm || '',
            unit: prod.unit,
            batch: effectiveBatch,
            expiryDate: prod.expiryDate,
            quantity: qty,
            returnedQuantity: 0,
            unitPrice: prod.salePrice,
            discountPercent: disc,
            subtotal: taxVals.lineTotalWithTax,
            taxType: taxVals.taxType,
            taxCode: taxVals.taxCode,
            taxRate: taxVals.taxRate,
            taxExemptionCode: taxVals.taxExemptionCode,
            taxExemptionReason: taxVals.taxExemptionReason,
            priceIncludesTax: taxVals.priceIncludesTax,
            taxableBase: taxVals.taxableBase,
            taxAmount: taxVals.taxAmount,
          });
        }

        if (isInvoiceSaleType(type) && shortages.length > 0) {
          throw new HttpError(
            409,
            'Stock insuficiente para concluir a venda faturada. Pode reduzir a quantidade ou emitir uma proforma (sem baixar o stock).',
            { code: 'INSUFFICIENT_STOCK', shortages }
          );
        }

        assertFiscalEmissionAllowed(db.settings, fiscalCheckItems, type);

        if (isInvoiceSaleType(type)) {
          for (const [productId, totalQty] of requestedTotals.entries()) {
            const prod = db.products.find((p) => p.id === productId)!;
            prod.stock -= totalQty;
            prod.updatedAt = nowIso;
          }
        }

        const seriesKind =
          type === 'PROFORMA'
            ? 'PROFORMA'
            : type === 'FACTURA_RECIBO'
            ? 'FACTURA_RECIBO'
            : 'FACTURA';
        const docNumber = allocateDocumentNumber(db, seriesKind, saleDate);
        const { taxTotal, taxBreakdown } = aggregateTaxBreakdown(saleItems);

        const fiscalValidationStatus: FiscalValidationStatus =
          type === 'PROFORMA'
            ? 'NAO_FISCAL_PROFORMA'
            : agtStatus.configured
            ? 'PENDENTE_AGT'
            : 'RASCUNHO_NAO_VALIDADO';

        const isDeferredInvoice = type === 'FACTURA';
        const paymentStatus =
          type === 'PROFORMA' ? undefined : isDeferredInvoice ? ('NAO_PAGO' as const) : ('PAGO' as const);
        const paidAmount = type === 'PROFORMA' ? 0 : isDeferredInvoice ? 0 : totalAmount;

        const newSale: Sale = {
          id: `sal_${crypto.randomUUID().slice(0, 8)}`,
          documentNumber: docNumber,
          type,
          status: type === 'PROFORMA' ? 'PROFORMA' : 'EMITIDA',
          customerId: resolvedCustomerId,
          customerName: resolvedCustomerName,
          customerNif: resolvedCustomerNif,
          isCommonConsumer: !resolvedCustomerId,
          paymentMethod,
          items: saleItems,
          subtotal,
          discountTotal,
          taxTotal,
          taxBreakdown,
          totalAmount,
          paidAmount,
          ...(paymentStatus ? { paymentStatus } : {}),
          locationOfOperation,
          issuedAt: nowIso,
          seriesSource: 'INTERNA_NAO_OFICIAL',
          fiscalValidationStatus,
          agtSubmissionHistory: [
            {
              id: `agt_${crypto.randomUUID().slice(0, 8)}`,
              timestamp: nowIso,
              action: type === 'PROFORMA' ? 'MODO_RASCUNHO' : agtStatus.configured ? 'CRIADO_RASCUNHO' : 'MODO_RASCUNHO',
              validationStatus: fiscalValidationStatus,
              message:
                type === 'PROFORMA'
                  ? 'Documento não fiscal (Proforma).'
                  : agtStatus.configured
                  ? 'Documento criado e pronto para submissão à AGT.'
                  : 'Emitido como rascunho interno sem validação fiscal AGT (credenciais/certificação não configuradas).',
            },
          ],
          notes: String(notes || '').trim(),
          sellerId: user.id,
          sellerName: user.fullName,
          date: saleDate,
          time: nowTimeStr(),
          createdAt: nowIso,
          ...(type !== 'PROFORMA' && !isDeferredInvoice && activeOpenRegister
            ? { cashRegisterId: activeOpenRegister.id }
            : {}),
          isDemoData: false,
        };

        db.sales.unshift(newSale);
        appendAudit(
          db,
          user,
          type === 'PROFORMA' ? 'PROFORMA_EMITIDA' : 'VENDA_FATURADA',
          type === 'PROFORMA' ? 'PROFORMA' : 'VENDA',
          newSale.id,
          `${type} ${newSale.documentNumber} emitida para ${resolvedCustomerName} (${totalAmount.toFixed(2)} ${db.settings.currencySymbol}).`,
          { documentNumber: newSale.documentNumber, type, totalAmount, taxTotal, paymentMethod }
        );
        return newSale;
      });

      res.status(201).json(createdSale);
    })
  );

  app.post(
    '/api/sales/:id/convert-proforma',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const user = req.currentUser!;
      const rawTarget = String(req.body?.targetType || 'FACTURA_RECIBO');
      const targetType: SaleDocumentType =
        rawTarget === 'FACTURA' || rawTarget === 'FATURA' ? rawTarget : 'FACTURA_RECIBO';

      const convertedSale = await mutateDb((db) => {
        const proforma = db.sales.find((s) => s.id === req.params.id);
        if (!proforma || proforma.type !== 'PROFORMA') {
          throw new HttpError(404, 'Proforma não encontrada.');
        }
        if (proforma.status === 'CONVERTIDA' && proforma.convertedToSaleId) {
          throw new HttpError(
            409,
            `Esta proforma já foi convertida na fatura ${proforma.convertedDocumentNumber}.`
          );
        }

        const saleDate = todayISO();
        const closedPeriod = isDateInClosedPeriod(db, saleDate);
        if (closedPeriod) {
          throw new HttpError(409, `O período (${closedPeriod.referenceNumber}) encontra-se fechado.`);
        }

        const activeOpenRegister = getOpenCashRegister(db, user.id);
        const closedTodayCount = db.sellerClosings.filter(
          (c) => c.date === saleDate && c.sellerId === user.id && c.status !== 'ABERTO'
        ).length;
        if ((user.role === 'SELLER' || closedTodayCount > 0) && !activeOpenRegister) {
          throw new HttpError(
            409,
            closedTodayCount > 0
              ? 'O seu caixa já foi fechado. Para faturar esta proforma, abra primeiro um novo caixa.'
              : 'Ainda não abriu o caixa nesta sessão. Clique em "Abrir caixa" antes de converter proformas em fatura.',
            { code: 'CASH_REGISTER_CLOSED' }
          );
        }

        const requestedTotals = new Map<string, number>();
        for (const item of proforma.items) {
          requestedTotals.set(item.productId, (requestedTotals.get(item.productId) || 0) + item.quantity);
        }

        const shortages = [];
        for (const [productId, reqQty] of requestedTotals.entries()) {
          const prod = db.products.find((p) => p.id === productId);
          if (!prod || !prod.active) {
            throw new HttpError(400, 'Um dos produtos da proforma está inativo ou foi removido.');
          }
          if (reqQty > prod.stock) {
            shortages.push({
              productId: prod.id,
              productName: prod.name,
              requested: reqQty,
              available: prod.stock,
            });
          }
        }

        const currentLineChecks: Array<{
          productName: string;
          taxCode?: TaxCode;
          taxRate?: number | null;
          taxExemptionCode?: string;
          taxExemptionReason?: string;
          ruleError?: string;
        }> = [];
        let recomputedTotal = 0;
        const convertedItems: SaleItem[] = proforma.items.map((origItem) => {
          const prod = db.products.find((p) => p.id === origItem.productId)!;
          const effectiveBatch = String(origItem.batch || prod.batch || '').trim();
          const effectiveTax = resolveEffectiveProductTax(prod, db.settings, effectiveBatch, saleDate);
          currentLineChecks.push({
            productName: prod.name,
            taxCode: effectiveTax.taxCode,
            taxRate: effectiveTax.taxRate,
            taxExemptionCode: effectiveTax.taxExemptionCode,
            taxExemptionReason: effectiveTax.taxExemptionReason,
            ruleError: effectiveTax.ruleError,
          });
          const netLine = roundMoney(
            roundMoney(origItem.quantity * origItem.unitPrice) -
              roundMoney((origItem.quantity * origItem.unitPrice * (origItem.discountPercent || 0)) / 100)
          );
          const taxVals = buildLineTaxValues(netLine, effectiveTax, effectiveTax.priceIncludesTax);
          recomputedTotal = roundMoney(recomputedTotal + taxVals.lineTotalWithTax);
          return {
            ...origItem,
            batch: effectiveBatch,
            returnedQuantity: 0,
            subtotal: taxVals.lineTotalWithTax,
            taxType: taxVals.taxType,
            taxCode: taxVals.taxCode,
            taxRate: taxVals.taxRate,
            taxExemptionCode: taxVals.taxExemptionCode,
            taxExemptionReason: taxVals.taxExemptionReason,
            priceIncludesTax: taxVals.priceIncludesTax,
            taxableBase: taxVals.taxableBase,
            taxAmount: taxVals.taxAmount,
          };
        });

        assertFiscalEmissionAllowed(db.settings, currentLineChecks, targetType);
        if (shortages.length > 0) {
          throw new HttpError(409, 'Stock ainda insuficiente para converter a proforma em fatura.', {
            code: 'INSUFFICIENT_STOCK',
            shortages,
          });
        }

        const nowIso = new Date().toISOString();
        for (const [productId, reqQty] of requestedTotals.entries()) {
          const prod = db.products.find((p) => p.id === productId)!;
          prod.stock -= reqQty;
          prod.updatedAt = nowIso;
        }

        const agtStatus = getAgtConfigStatus();
        const seriesKind = targetType === 'FACTURA_RECIBO' ? 'FACTURA_RECIBO' : 'FACTURA';
        const docNumber = allocateDocumentNumber(db, seriesKind, saleDate);
        const paymentMethod: PaymentMethod = req.body?.paymentMethod || proforma.paymentMethod;
        const { taxTotal, taxBreakdown } = aggregateTaxBreakdown(convertedItems);
        const isDeferred = targetType === 'FACTURA';
        const fiscalValidationStatus: FiscalValidationStatus = agtStatus.configured
          ? 'PENDENTE_AGT'
          : 'RASCUNHO_NAO_VALIDADO';

        const converted: Sale = {
          ...proforma,
          id: `sal_${crypto.randomUUID().slice(0, 8)}`,
          documentNumber: docNumber,
          type: targetType,
          status: 'EMITIDA',
          paymentMethod,
          items: convertedItems,
          taxTotal,
          taxBreakdown,
          totalAmount: recomputedTotal,
          paidAmount: isDeferred ? 0 : recomputedTotal,
          paymentStatus: isDeferred ? 'NAO_PAGO' : 'PAGO',
          locationOfOperation: db.settings.establishmentName?.trim() || db.settings.address?.trim() || 'Sede',
          issuedAt: nowIso,
          seriesSource: 'INTERNA_NAO_OFICIAL',
          fiscalValidationStatus,
          agtSubmissionHistory: [
            {
              id: `agt_${crypto.randomUUID().slice(0, 8)}`,
              timestamp: nowIso,
              action: agtStatus.configured ? 'CRIADO_RASCUNHO' : 'MODO_RASCUNHO',
              validationStatus: fiscalValidationStatus,
              message: `Convertida a partir da Proforma ${proforma.documentNumber}.`,
            },
          ],
          sellerId: user.id,
          sellerName: user.fullName,
          date: saleDate,
          time: nowTimeStr(),
          createdAt: nowIso,
          sourceProformaId: proforma.id,
          sourceProformaNumber: proforma.documentNumber,
          ...(!isDeferred && activeOpenRegister ? { cashRegisterId: activeOpenRegister.id } : {}),
          isDemoData: false,
        };

        proforma.status = 'CONVERTIDA';
        proforma.convertedToSaleId = converted.id;
        proforma.convertedDocumentNumber = converted.documentNumber;

        db.sales.unshift(converted);
        appendAudit(
          db,
          user,
          'PROFORMA_CONVERTIDA',
          'VENDA',
          converted.id,
          `Proforma ${proforma.documentNumber} convertida em ${targetType} ${converted.documentNumber}.`
        );
        return converted;
      });

      res.status(201).json(convertedSale);
    })
  );

  // Immutability guard: fiscal documents cannot be deleted (Art. 8.º DP 71/25)
  app.delete(
    '/api/sales/:id',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, _res) => {
      await mutateDb((db) => {
        appendAudit(
          db,
          req.currentUser!,
          'TENTATIVA_ELIMINACAO_DOCUMENTO_BLOQUEADA',
          'VENDA',
          req.params.id,
          `Tentativa de eliminação direta de documento fiscal (${req.params.id}) bloqueada pela regra de imutabilidade (DP 71/25).`
        );
      });
      throw new HttpError(
        403,
        'Documentos emitidos são imutáveis e não podem ser eliminados. Utilize Nota de Crédito (Rectificação) ou Anulação com motivo registado.'
      );
    })
  );

  app.delete(
    '/api/returns/:id',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, _res) => {
      await mutateDb((db) => {
        appendAudit(
          db,
          req.currentUser!,
          'TENTATIVA_ELIMINACAO_DOCUMENTO_BLOQUEADA',
          'DEVOLUCAO',
          req.params.id,
          `Tentativa de eliminação direta de nota de crédito/anulação (${req.params.id}) bloqueada pela regra de imutabilidade (DP 71/25).`
        );
      });
      throw new HttpError(
        403,
        'Notas de Crédito e Anulações são imutáveis e não podem ser eliminadas (conservação obrigatória).'
      );
    })
  );

  // ==================== RETURNS & CANCELLATIONS ====================
  app.get(
    '/api/returns',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(db.returns);
    })
  );

  app.post(
    '/api/returns',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { originalSaleId, type, reason, items, rectificationNature, buyerAcknowledgement } = req.body || {};
      const user = req.currentUser!;

      if (type !== 'DEVOLUCAO' && type !== 'ANULACAO') {
        throw new HttpError(400, 'Tipo de operação inválido.');
      }
      if (type === 'DEVOLUCAO' && user.role !== 'ADMIN' && !user.permissions.canProcessReturns) {
        throw new HttpError(403, 'Não tem permissão para registar devoluções / notas de crédito.');
      }
      if (type === 'ANULACAO' && user.role !== 'ADMIN' && !user.permissions.canCancelSales) {
        throw new HttpError(403, 'Não tem permissão para anular vendas.');
      }
      if (!reason || !String(reason).trim()) {
        throw new HttpError(400, 'O motivo da retificação/anulação é obrigatório.');
      }
      if (!Array.isArray(items) || items.length === 0) {
        throw new HttpError(400, 'Selecione pelo menos um produto para devolver ou anular.');
      }

      const newReturn = await mutateDb((db) => {
        const sale = db.sales.find((s) => s.id === originalSaleId);
        if (!sale) {
          throw new HttpError(404, 'Venda original não encontrada.');
        }
        if (!isInvoiceSaleType(sale.type)) {
          throw new HttpError(400, 'Apenas faturas emitidas (FT/FR) podem ser objeto de retificação ou anulação.');
        }
        if (sale.status === 'ANULADA' || sale.status === 'DEVOLVIDA') {
          throw new HttpError(409, `O documento ${sale.documentNumber} já foi totalmente devolvido ou anulado.`);
        }

        const returnDate = todayISO();
        const closedPeriod = isDateInClosedPeriod(db, returnDate);
        if (closedPeriod) {
          throw new HttpError(
            409,
            `O período (${closedPeriod.referenceNumber}) encontra-se fechado. Um administrador deve reabrir o período para registar devoluções/anulações hoje.`
          );
        }

        const activeOpenRegister = getOpenCashRegister(db, user.id);
        const closedTodayCount = db.sellerClosings.filter(
          (c) => c.date === returnDate && c.sellerId === user.id && c.status !== 'ABERTO'
        ).length;
        if ((user.role === 'SELLER' || closedTodayCount > 0) && !activeOpenRegister) {
          throw new HttpError(
            409,
            closedTodayCount > 0
              ? 'O seu caixa já foi fechado. Abra primeiro um novo caixa antes de registar devoluções ou anulações.'
              : 'Ainda não abriu o caixa nesta sessão. Clique em "Abrir caixa" antes de registar devoluções ou anulações.',
            { code: 'CASH_REGISTER_CLOSED' }
          );
        }

        const returnItems: Array<ReturnItem & { _saleLine: SaleItem }> = [];
        let totalRefund = 0;

        // Track cumulative prior refunds & taxes per product on the original invoice so partial returns never drift by 0.01
        const priorReturnsForSale = db.returns.filter((r) => r.originalSaleId === sale.id);

        for (const reqItem of items) {
          const saleLine = sale.items.find((li) => li.productId === reqItem.productId);
          if (!saleLine) {
            throw new HttpError(400, 'Produto não pertence à venda original.');
          }
          const remaining = saleLine.quantity - (saleLine.returnedQuantity || 0);
          const qty = type === 'ANULACAO' ? remaining : Math.floor(Number(reqItem.quantity));
          if (qty <= 0) {
            continue;
          }
          if (qty > remaining) {
            throw new HttpError(
              409,
              `Quantidade excede o saldo disponível para devolução em "${saleLine.productName}" (restam ${remaining} un.).`
            );
          }
          const condition: 'APT' | 'QUARANTINE' = reqItem.condition === 'QUARANTINE' ? 'QUARANTINE' : 'APT';

          let prevReturnedRefund = 0;
          let prevReturnedTax = 0;
          for (const pr of priorReturnsForSale) {
            for (const pri of pr.items) {
              if (pri.productId === saleLine.productId) {
                prevReturnedRefund = roundMoney(prevReturnedRefund + Number(pri.refundAmount || 0));
                prevReturnedTax = roundMoney(prevReturnedTax + Number(pri.taxAmount || 0));
              }
            }
          }

          const origTotal = roundMoney(saleLine.subtotal);
          const origTax = roundMoney(saleLine.taxAmount ?? 0);
          const ratio = qty / Math.max(1, saleLine.quantity);

          const refundAmount =
            qty === remaining
              ? roundMoney(Math.max(0, origTotal - prevReturnedRefund))
              : roundMoney(origTotal * ratio);
          const lineTaxAmount =
            origTax <= 0
              ? 0
              : qty === remaining
              ? roundMoney(Math.max(0, origTax - prevReturnedTax))
              : roundMoney(origTax * ratio);
          const lineTaxableBase = roundMoney(refundAmount - lineTaxAmount);
          const unitRefundWithTax = roundMoney(refundAmount / Math.max(1, qty));

          totalRefund = roundMoney(totalRefund + refundAmount);

          returnItems.push({
            productId: saleLine.productId,
            productCode: saleLine.productCode,
            productName: saleLine.productName,
            quantity: qty,
            unitPrice: unitRefundWithTax,
            refundAmount,
            condition,
            taxCode: saleLine.taxCode || 'NAO_CONFIGURADO',
            taxRate: saleLine.taxRate ?? null,
            taxExemptionCode: saleLine.taxExemptionCode || '',
            taxExemptionReason: saleLine.taxExemptionReason || '',
            taxableBase: lineTaxableBase,
            taxAmount: lineTaxAmount,
            _saleLine: saleLine,
          });
        }

        if (returnItems.length === 0) {
          throw new HttpError(400, 'Nenhuma quantidade válida selecionada para devolução/anulação.');
        }

        if (type === 'ANULACAO') {
          const hasAnyPartial = sale.items.some((li) => (li.returnedQuantity || 0) > 0);
          if (hasAnyPartial) {
            throw new HttpError(
              409,
              'Esta fatura já possui devoluções parciais. Conclua através de uma devolução dos restantes itens.'
            );
          }
        }

        const cleanItems: ReturnItem[] = returnItems.map(({ _saleLine: _unused, ...rest }) => rest);
        assertFiscalEmissionAllowed(db.settings, cleanItems, 'NC');

        const nowIso = new Date().toISOString();
        for (const ri of returnItems) {
          ri._saleLine.returnedQuantity = (ri._saleLine.returnedQuantity || 0) + ri.quantity;
          const prod = db.products.find((p) => p.id === ri.productId);
          if (prod) {
            if (ri.condition === 'APT') {
              prod.stock += ri.quantity;
            } else {
              prod.quarantineStock = (prod.quarantineStock || 0) + ri.quantity;
            }
            prod.updatedAt = nowIso;
          }
        }

        const allReturned = sale.items.every((li) => (li.returnedQuantity || 0) >= li.quantity);
        if (type === 'ANULACAO') {
          sale.status = 'ANULADA';
        } else {
          sale.status = allReturned ? 'DEVOLVIDA' : 'PARCIALMENTE_DEVOLVIDA';
        }

        // Legal fiscal rectification/cancellation document per AGT FE & SAF-T (AO): Nota de Crédito (NC)
        const docNumber = allocateDocumentNumber(db, 'CREDIT_NOTE', returnDate);
        const internalCancellationRef =
          type === 'ANULACAO' ? allocateDocumentNumber(db, 'CANCELLATION', returnDate) : undefined;

        const { taxTotal, taxBreakdown } = aggregateTaxBreakdown(cleanItems);
        const resolvedNature: 'ANULACAO' | 'RECTIFICACAO' =
          type === 'ANULACAO' || rectificationNature === 'ANULACAO' ? 'ANULACAO' : 'RECTIFICACAO';

        const ackRaw = buyerAcknowledgement && typeof buyerAcknowledgement === 'object' ? buyerAcknowledgement : {};
        const ackConfirmed = Boolean(ackRaw.confirmed);
        const normalizedAck: BuyerAcknowledgement = {
          confirmed: ackConfirmed,
          method: ackRaw.method || 'NAO_REGISTADA',
          reference: String(ackRaw.reference || '').trim(),
          acknowledgedAt: ackConfirmed ? String(ackRaw.acknowledgedAt || nowIso) : undefined,
          notes: String(ackRaw.notes || '').trim(),
          ...(ackConfirmed ? { recordedById: user.id, recordedByName: user.fullName } : {}),
        };

        const agtStatus = getAgtConfigStatus();
        const fiscalValidationStatus: FiscalValidationStatus = agtStatus.configured
          ? 'PENDENTE_AGT'
          : 'RASCUNHO_NAO_VALIDADO';

        const created: SaleReturn = {
          id: `ret_${crypto.randomUUID().slice(0, 8)}`,
          documentNumber: docNumber,
          type,
          rectificationNature: resolvedNature,
          ...(internalCancellationRef ? { internalCancellationRef } : {}),
          seriesSource: 'INTERNA_NAO_OFICIAL',
          originalSaleId: sale.id,
          originalDocumentNumber: sale.documentNumber,
          originalPaymentMethod: sale.paymentMethod,
          originalSellerId: sale.sellerId,
          originalSellerName: sale.sellerName,
          customerName: sale.customerName,
          customerNif: sale.customerNif,
          reason: String(reason).trim(),
          items: cleanItems,
          totalRefund,
          taxTotal,
          taxBreakdown,
          buyerAcknowledgement: normalizedAck,
          fiscalValidationStatus,
          agtSubmissionHistory: [
            {
              id: `agt_${crypto.randomUUID().slice(0, 8)}`,
              timestamp: nowIso,
              action: agtStatus.configured ? 'CRIADO_RASCUNHO' : 'MODO_RASCUNHO',
              validationStatus: fiscalValidationStatus,
              message: agtStatus.configured
                ? `Nota de Crédito (${resolvedNature}) criada e pronta para submissão à AGT.`
                : `Nota de Crédito (${resolvedNature}) emitida como rascunho interno sem validação AGT.`,
            },
          ],
          userId: user.id,
          userName: user.fullName,
          date: returnDate,
          createdAt: nowIso,
          ...(activeOpenRegister ? { cashRegisterId: activeOpenRegister.id } : {}),
          isDemoData: false,
        };

        db.returns.unshift(created);
        appendAudit(
          db,
          user,
          type === 'ANULACAO' ? 'VENDA_ANULADA' : 'DEVOLUCAO_REGISTADA',
          type,
          created.id,
          `${resolvedNature} ${created.documentNumber} ligada à fatura ${sale.documentNumber}. Motivo: ${created.reason}. Prova adquirente: ${ackConfirmed ? 'Registada' : 'Pendente'}.`,
          { totalRefund, taxTotal, rectificationNature: resolvedNature, buyerAcknowledgement: normalizedAck }
        );
        return created;
      });

      res.status(201).json(newReturn);
    })
  );

  app.patch(
    '/api/returns/:id/buyer-acknowledgement',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const user = req.currentUser!;
      if (
        user.role !== 'ADMIN' &&
        !user.permissions.canProcessReturns &&
        !user.permissions.canCancelSales
      ) {
        throw new HttpError(403, 'Sem permissão para registar prova de conhecimento do adquirente.');
      }

      const body = req.body || {};
      const confirmed = Boolean(body.confirmed);
      const method = body.method || (confirmed ? 'ASSINATURA_NIF' : 'NAO_REGISTADA');
      const reference = String(body.reference || '').trim();
      const notes = String(body.notes || '').trim();

      if (confirmed && method === 'NAO_REGISTADA') {
        throw new HttpError(400, 'Selecione o meio da prova de conhecimento do adquirente (ex.: Carta, E-mail, Assinatura/NIF).');
      }

      const updated = await mutateDb((db) => {
        const ret = db.returns.find((r) => r.id === req.params.id);
        if (!ret) {
          throw new HttpError(404, 'Documento de anulação/nota de crédito não encontrado.');
        }
        const nowIso = new Date().toISOString();
        ret.buyerAcknowledgement = {
          confirmed,
          method,
          reference,
          acknowledgedAt: confirmed ? String(body.acknowledgedAt || nowIso) : undefined,
          notes,
          recordedById: user.id,
          recordedByName: user.fullName,
        };

        appendAudit(
          db,
          user,
          'PROVA_ADQUIRENTE_REGISTADA',
          ret.type,
          ret.id,
          `Prova de conhecimento do adquirente atualizada no documento ${ret.documentNumber} (${confirmed ? `Confirmada via ${method}` : 'Pendente'}).`,
          { ...ret.buyerAcknowledgement }
        );
        return ret;
      });

      res.json(updated);
    })
  );

  // ==================== INVENTORY & ADJUSTMENTS ====================
  app.get(
    '/api/inventories',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(db.inventories);
    })
  );

  app.post(
    '/api/inventories',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const user = req.currentUser!;
      if (user.role !== 'ADMIN' && !user.permissions.canStartInventoryCount) {
        throw new HttpError(403, 'Sem permissão para realizar contagens de inventário.');
      }
      const { scope = 'ALL', scopeFilter = '', items, reason = '', notes = '', approveImmediately = false } =
        req.body || {};

      if (!Array.isArray(items) || items.length === 0) {
        throw new HttpError(400, 'O inventário deve conter pelo menos um produto.');
      }

      const session = await mutateDb((db) => {
        const classMap = new Map(db.classes.map((c) => [c.id, c.name]));

        let totalDiscrepancies = 0;
        let totalShortageUnits = 0;
        let totalSurplusUnits = 0;
        const invItems: InventoryItem[] = [];

        for (const raw of items) {
          const prod = db.products.find((p) => p.id === raw.productId);
          if (!prod) continue;
          const counted = Math.max(0, Math.floor(Number(raw.countedQty)));
          const systemQty = prod.stock;
          const difference = counted - systemQty;
          if (difference !== 0) {
            totalDiscrepancies += 1;
            if (difference < 0) totalShortageUnits += Math.abs(difference);
            if (difference > 0) totalSurplusUnits += difference;
          }
          invItems.push({
            productId: prod.id,
            productCode: prod.code,
            productName: prod.name,
            className: classMap.get(prod.classId) || 'Sem classe',
            location: prod.location || 'Geral',
            systemQty,
            countedQty: counted,
            difference,
            beforeQty: systemQty,
            afterQty: systemQty,
            unitCost: prod.purchasePrice,
            differenceValue: roundMoney(difference * prod.purchasePrice),
            notes: String(raw.notes || '').trim(),
          });
        }

        if (totalDiscrepancies > 0 && !String(reason).trim()) {
          throw new HttpError(
            400,
            'Existem diferenças entre o stock do sistema e o físico. Indique o motivo das divergências.'
          );
        }

        const canApproveNow = Boolean(approveImmediately) && user.role === 'ADMIN';
        const refNum = allocateDocumentNumber(db, 'INVENTORY', todayISO());
        const now = new Date().toISOString();

        if (canApproveNow) {
          for (const item of invItems) {
            const prod = db.products.find((p) => p.id === item.productId);
            if (prod) {
              item.beforeQty = prod.stock;
              prod.stock = item.countedQty;
              item.afterQty = prod.stock;
              prod.updatedAt = now;
            }
          }
        }

        const created = {
          id: `inv_${crypto.randomUUID().slice(0, 8)}`,
          referenceNumber: refNum,
          scope,
          scopeFilter: String(scopeFilter || ''),
          status: canApproveNow ? ('APROVADO' as const) : ('PENDENTE_APROVACAO' as const),
          items: invItems,
          totalDiscrepancies,
          totalShortageUnits,
          totalSurplusUnits,
          reason: String(reason || '').trim(),
          notes: String(notes || '').trim(),
          countedById: user.id,
          countedByName: user.fullName,
          countedAt: now,
          ...(canApproveNow
            ? {
                approvedById: user.id,
                approvedByName: user.fullName,
                approvedAt: now,
              }
            : {}),
          isDemoData: false,
        };

        db.inventories.unshift(created);
        appendAudit(
          db,
          user,
          canApproveNow ? 'INVENTARIO_APROVADO' : 'INVENTARIO_SUBMETIDO',
          'INVENTARIO',
          created.id,
          `Inventário ${created.referenceNumber} (${invItems.length} produtos, ${totalDiscrepancies} divergências) ${
            canApproveNow ? 'aprovado e aplicado ao stock.' : 'submetido para aprovação do Administrador.'
          }`,
          { totalDiscrepancies, totalShortageUnits, totalSurplusUnits }
        );
        return created;
      });

      res.status(201).json(session);
    })
  );

  app.post(
    '/api/inventories/:id/approve',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const approved = await mutateDb((db) => {
        const inv = db.inventories.find((i) => i.id === req.params.id);
        if (!inv) {
          throw new HttpError(404, 'Inventário não encontrado.');
        }
        if (inv.status !== 'PENDENTE_APROVACAO') {
          throw new HttpError(409, 'Este inventário já foi processado.');
        }

        const now = new Date().toISOString();
        const adjustmentsSummary: Array<{ product: string; before: number; after: number }> = [];

        for (const item of inv.items) {
          const prod = db.products.find((p) => p.id === item.productId);
          if (prod) {
            item.beforeQty = prod.stock;
            prod.stock = item.countedQty;
            item.afterQty = prod.stock;
            prod.updatedAt = now;
            if (item.beforeQty !== item.afterQty) {
              adjustmentsSummary.push({ product: prod.name, before: item.beforeQty, after: item.afterQty });
            }
          }
        }

        inv.status = 'APROVADO';
        inv.approvedById = req.currentUser!.id;
        inv.approvedByName = req.currentUser!.fullName;
        inv.approvedAt = now;

        appendAudit(
          db,
          req.currentUser!,
          'INVENTARIO_APROVADO',
          'INVENTARIO',
          inv.id,
          `Ajustes de stock do inventário ${inv.referenceNumber} aprovados. Motivo: ${inv.reason || 'Conferência periódica'}.`,
          { adjustmentsSummary }
        );
        return inv;
      });
      res.json(approved);
    })
  );

  app.post(
    '/api/inventories/:id/reject',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const rejected = await mutateDb((db) => {
        const inv = db.inventories.find((i) => i.id === req.params.id);
        if (!inv) {
          throw new HttpError(404, 'Inventário não encontrado.');
        }
        if (inv.status !== 'PENDENTE_APROVACAO') {
          throw new HttpError(409, 'Este inventário já foi processado.');
        }
        inv.status = 'REJEITADO';
        inv.rejectedReason = String(req.body?.reason || 'Contagem rejeitada pelo administrador').trim();
        inv.approvedById = req.currentUser!.id;
        inv.approvedByName = req.currentUser!.fullName;
        inv.approvedAt = new Date().toISOString();

        appendAudit(
          db,
          req.currentUser!,
          'INVENTARIO_REJEITADO',
          'INVENTARIO',
          inv.id,
          `Inventário ${inv.referenceNumber} rejeitado sem alterar stock. Motivo: ${inv.rejectedReason}.`
        );
        return inv;
      });
      res.json(rejected);
    })
  );

  // ==================== CASH REGISTER & CLOSINGS ====================
  app.get(
    '/api/cash-register/current',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const db = await loadDbAsync();
      res.json(buildCashRegisterStatus(db, req.currentUser!));
    })
  );

  app.post(
    '/api/cash-register/open',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const user = req.currentUser!;
      if (req.body?.sellerId && req.body.sellerId !== user.id) {
        throw new HttpError(403, 'Cada vendedor só pode abrir o seu próprio caixa.');
      }

      const rawOpeningBalance = Number(req.body?.openingBalance ?? 0);
      if (!Number.isFinite(rawOpeningBalance) || rawOpeningBalance < 0) {
        throw new HttpError(400, 'O valor inicial em caixa deve ser um número igual ou superior a zero.');
      }
      const openingBalance = roundMoney(rawOpeningBalance);
      const openingNotes = String(req.body?.openingNotes || '').trim();
      const today = todayISO();

      const opened = await mutateDb((db) => {
        const closedPeriod = isDateInClosedPeriod(db, today);
        if (closedPeriod) {
          throw new HttpError(
            409,
            `O período (${closedPeriod.referenceNumber}) encontra-se fechado. Não é possível abrir caixa para hoje.`
          );
        }

        const existingOpen = getOpenCashRegister(db, user.id);
        if (existingOpen) {
          throw new HttpError(
            409,
            'Já existe um caixa aberto para a sua conta. Continue essa sessão ou feche o caixa atual antes de abrir outro.'
          );
        }

        const todayRegs = db.sellerClosings.filter((c) => c.date === today && c.sellerId === user.id);
        if (todayRegs.length >= 2) {
          throw new HttpError(
            409,
            `Limite diário atingido: ${user.fullName} já atingiu o máximo de 2 turnos/caixas permitidos em ${today}.`
          );
        }

        const shiftNumber: 1 | 2 = todayRegs.length === 0 ? 1 : 2;
        const shiftLabel =
          String(req.body?.shiftLabel || '').trim() ||
          (shiftNumber === 1 ? '1º Turno (Manhã)' : '2º Turno (Tarde)');
        const nowIso = new Date().toISOString();

        const created: SellerClosing = {
          id: `cls_vnd_${crypto.randomUUID().slice(0, 8)}`,
          status: 'ABERTO',
          date: today,
          shiftNumber,
          shiftLabel,
          sellerId: user.id,
          sellerName: user.fullName,
          openingBalance,
          openedAt: nowIso,
          openingNotes,
          salesCount: 0,
          salesByPayment: emptyPaymentMap(),
          grossSalesTotal: 0,
          returnsTotal: 0,
          returnsCashTotal: 0,
          cancellationsCount: 0,
          cancellationsTotal: 0,
          expectedCash: openingBalance,
          expectedTotal: 0,
          countedCash: 0,
          difference: 0,
          notes: '',
          includedSaleIds: [],
          includedReturnIds: [],
          closedById: '',
          closedByName: '',
          createdAt: nowIso,
          isDemoData: false,
        };

        db.sellerClosings.unshift(created);
        appendAudit(
          db,
          user,
          'CAIXA_ABERTO',
          'CAIXA',
          created.id,
          `Caixa aberto (${shiftLabel}) por ${user.fullName} com fundo inicial de ${openingBalance.toFixed(2)} ${db.settings.currencySymbol}.`,
          { openingBalance, openingNotes, shiftNumber }
        );
        return created;
      });

      res.status(201).json(opened);
    })
  );

  app.get(
    '/api/closings',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const db = await loadDbAsync();
      res.json({
        sellerClosings:
          req.currentUser!.role === 'ADMIN'
            ? db.sellerClosings
            : db.sellerClosings.filter((c) => c.sellerId === req.currentUser!.id),
        generalClosings: db.generalClosings,
      });
    })
  );

  app.get(
    '/api/closings/preview',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const db = await loadDbAsync();
      const user = req.currentUser!;
      if (req.query.sellerId && String(req.query.sellerId) !== user.id) {
        throw new HttpError(403, 'Cada vendedor só pode consultar e fechar o próprio caixa.');
      }

      const today = todayISO();
      const openReg = getOpenCashRegister(db, user.id);
      const targetDate = openReg?.date || today;
      const todayRegs = db.sellerClosings.filter((c) => c.date === targetDate && c.sellerId === user.id);
      const closedPeriod = isDateInClosedPeriod(db, targetDate);

      if (openReg) {
        const metrics = computeRegisterMetrics(db, openReg);
        res.json({
          hasOpenRegister: true,
          openRegisterId: openReg.id,
          date: openReg.date,
          sellerId: user.id,
          shiftNumber: openReg.shiftNumber,
          shiftLabel: openReg.shiftLabel,
          openingBalance: openReg.openingBalance,
          openedAt: openReg.openedAt || openReg.createdAt,
          openingNotes: openReg.openingNotes || '',
          existingCountToday: todayRegs.length,
          closedTodayCount: todayRegs.filter((c) => c.status !== 'ABERTO').length,
          maxAllowedPerDay: 2,
          isPeriodClosed: Boolean(closedPeriod),
          closedPeriodRef: closedPeriod?.referenceNumber || null,
          ...metrics,
        });
        return;
      }

      res.json({
        hasOpenRegister: false,
        openRegisterId: null,
        date: today,
        sellerId: user.id,
        shiftNumber: todayRegs.length + 1,
        shiftLabel: todayRegs.length === 0 ? '1º Turno (Manhã)' : '2º Turno (Tarde)',
        openingBalance: 0,
        openedAt: null,
        openingNotes: '',
        existingCountToday: todayRegs.length,
        closedTodayCount: todayRegs.filter((c) => c.status !== 'ABERTO').length,
        maxAllowedPerDay: 2,
        isPeriodClosed: Boolean(closedPeriod),
        closedPeriodRef: closedPeriod?.referenceNumber || null,
        salesCount: 0,
        salesByPayment: emptyPaymentMap(),
        grossSalesTotal: 0,
        returnsTotal: 0,
        returnsCashTotal: 0,
        cancellationsCount: 0,
        cancellationsTotal: 0,
        expectedCashSalesNet: 0,
        expectedCash: 0,
        expectedTotal: 0,
      });
    })
  );

  app.post(
    '/api/closings/seller',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const user = req.currentUser!;
      if (req.body?.sellerId && req.body.sellerId !== user.id) {
        throw new HttpError(403, 'Cada vendedor só pode abrir, consultar e fechar o próprio caixa.');
      }

      const rawCountedCash = Number(req.body?.countedCash ?? 0);
      if (!Number.isFinite(rawCountedCash) || rawCountedCash < 0) {
        throw new HttpError(400, 'O valor contado em caixa deve ser igual ou superior a zero.');
      }
      const countedCash = roundMoney(rawCountedCash);
      const closingNotes = String(req.body?.notes || '').trim();

      const closing = await mutateDb((db) => {
        const openReg = getOpenCashRegister(db, user.id);
        if (!openReg) {
          throw new HttpError(
            409,
            'Não existe nenhum caixa aberto para a sua conta. Abra primeiro o caixa antes de efetuar o fecho.'
          );
        }

        const closedPeriod = isDateInClosedPeriod(db, openReg.date);
        if (closedPeriod) {
          throw new HttpError(
            409,
            `O período (${closedPeriod.referenceNumber}) já está fechado. Apenas o Administrador pode efetuar correções.`
          );
        }

        const metrics = computeRegisterMetrics(db, openReg);
        const difference = roundMoney(countedCash - metrics.expectedCash);
        const nowIso = new Date().toISOString();

        openReg.status = 'FECHADO';
        openReg.salesCount = metrics.salesCount;
        openReg.salesByPayment = metrics.salesByPayment;
        openReg.grossSalesTotal = metrics.grossSalesTotal;
        openReg.returnsTotal = metrics.returnsTotal;
        openReg.returnsCashTotal = metrics.returnsCashTotal;
        openReg.cancellationsCount = metrics.cancellationsCount;
        openReg.cancellationsTotal = metrics.cancellationsTotal;
        openReg.expectedCash = metrics.expectedCash;
        openReg.expectedTotal = metrics.expectedTotal;
        openReg.countedCash = countedCash;
        openReg.difference = difference;
        openReg.notes = closingNotes;
        openReg.includedSaleIds = metrics.includedSaleIds;
        openReg.includedReturnIds = metrics.includedReturnIds;
        openReg.closedById = user.id;
        openReg.closedByName = user.fullName;
        openReg.closedAt = nowIso;

        appendAudit(
          db,
          user,
          'FECHO_VENDEDOR',
          'FECHO_CAIXA',
          openReg.id,
          `Caixa fechado (${openReg.shiftLabel}) por ${user.fullName} em ${openReg.date}: inicial ${openReg.openingBalance.toFixed(2)}, esperado ${metrics.expectedCash.toFixed(2)}, contado ${countedCash.toFixed(2)}, diferença ${difference.toFixed(2)}.`,
          {
            openingBalance: openReg.openingBalance,
            expectedCash: metrics.expectedCash,
            countedCash,
            difference,
            salesByPayment: metrics.salesByPayment,
          }
        );
        return openReg;
      });

      res.status(201).json(closing);
    })
  );

  app.post(
    '/api/closings/general',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const startDate = String(req.body?.startDate || todayISO());
      const endDate = String(req.body?.endDate || startDate);
      if (endDate < startDate) {
        throw new HttpError(400, 'A data final deve ser igual ou superior à data inicial.');
      }

      const generalClosing = await mutateDb((db) => {
        const overlap = db.generalClosings.find(
          (gc) => gc.status === 'FECHADO' && !(endDate < gc.startDate || startDate > gc.endDate)
        );
        if (overlap) {
          throw new HttpError(
            409,
            `Já existe um fecho geral fechado que abrange parte deste período (${overlap.referenceNumber}: ${overlap.startDate} a ${overlap.endDate}).`
          );
        }

        const openRegistersInPeriod = db.sellerClosings.filter(
          (c) => c.status === 'ABERTO' && c.date >= startDate && c.date <= endDate
        );
        if (openRegistersInPeriod.length > 0) {
          const names = openRegistersInPeriod.map((c) => c.sellerName).join(', ');
          throw new HttpError(
            409,
            `Existem caixas ainda abertos neste período (${names}). Feche todos os caixas dos vendedores antes de concluir o fecho geral.`
          );
        }

        const periodSellerClosings = db.sellerClosings.filter(
          (c) => c.status !== 'ABERTO' && c.date >= startDate && c.date <= endDate
        );
        const periodSales = db.sales.filter(
          (s) => isInvoiceSaleType(s.type) && s.date >= startDate && s.date <= endDate
        );
        const periodReturns = db.returns.filter(
          (r) => r.date >= startDate && r.date <= endDate
        );

        const salesByPayment = emptyPaymentMap();
        let totalSales = 0;
        for (const s of periodSales) {
          salesByPayment[s.paymentMethod] = roundMoney(salesByPayment[s.paymentMethod] + s.totalAmount);
          totalSales = roundMoney(totalSales + s.totalAmount);
        }

        let returnsTotal = 0;
        let cancellationsCount = 0;
        let cancellationsTotal = 0;
        for (const r of periodReturns) {
          returnsTotal = roundMoney(returnsTotal + r.totalRefund);
          if (r.type === 'ANULACAO') {
            cancellationsCount += 1;
            cancellationsTotal = roundMoney(cancellationsTotal + r.totalRefund);
          }
        }

        const totalExpectedCash = roundMoney(
          periodSellerClosings.reduce((acc, c) => acc + c.expectedCash, 0)
        );
        const totalCountedCash = roundMoney(
          periodSellerClosings.reduce((acc, c) => acc + c.countedCash, 0)
        );
        const totalDifference = roundMoney(totalCountedCash - totalExpectedCash);

        const refNum = allocateDocumentNumber(db, 'GENERAL_CLOSING', endDate);

        const gcId = `fg_${crypto.randomUUID().slice(0, 8)}`;
        for (const sc of periodSellerClosings) {
          sc.generalClosingId = gcId;
        }

        const created = {
          id: gcId,
          referenceNumber: refNum,
          startDate,
          endDate,
          status: 'FECHADO' as const,
          sellerClosingIds: periodSellerClosings.map((c) => c.id),
          salesCount: periodSales.length,
          salesByPayment,
          totalSales,
          returnsTotal,
          cancellationsCount,
          cancellationsTotal,
          totalExpectedCash,
          totalCountedCash,
          totalDifference,
          notes: String(req.body?.notes || '').trim(),
          closedById: req.currentUser!.id,
          closedByName: req.currentUser!.fullName,
          closedAt: new Date().toISOString(),
          corrections: [],
          isDemoData: false,
        };

        db.generalClosings.unshift(created);
        appendAudit(
          db,
          req.currentUser!,
          'FECHO_GERAL',
          'FECHO_GERAL',
          created.id,
          `Fecho geral ${created.referenceNumber} (${startDate} a ${endDate}) fechado.`
        );
        return created;
      });

      res.status(201).json(generalClosing);
    })
  );

  app.post(
    '/api/closings/general/:id/correction',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { action = 'CORRECAO', reason, newTotalCounted } = req.body || {};
      if (!reason || !String(reason).trim()) {
        throw new HttpError(400, 'É obrigatório justificar o motivo da correção/reabertura.');
      }

      const updated = await mutateDb((db) => {
        const gc = db.generalClosings.find((g) => g.id === req.params.id);
        if (!gc) {
          throw new HttpError(404, 'Fecho geral não encontrado.');
        }

        const prevCounted = gc.totalCountedCash;
        if (action === 'REABERTURA') {
          gc.status = 'REABERTO';
        } else if (newTotalCounted !== undefined && !Number.isNaN(Number(newTotalCounted))) {
          gc.totalCountedCash = roundMoney(Number(newTotalCounted));
          gc.totalDifference = roundMoney(gc.totalCountedCash - gc.totalExpectedCash);
        }

        const corr = {
          id: `cor_${crypto.randomUUID().slice(0, 8)}`,
          action: action === 'REABERTURA' ? ('REABERTURA' as const) : ('CORRECAO' as const),
          reason: String(reason).trim(),
          previousTotalCounted: prevCounted,
          newTotalCounted: gc.totalCountedCash,
          userId: req.currentUser!.id,
          userName: req.currentUser!.fullName,
          timestamp: new Date().toISOString(),
        };
        gc.corrections.push(corr);

        appendAudit(
          db,
          req.currentUser!,
          'FECHO_GERAL_CORRECAO',
          'FECHO_GERAL',
          gc.id,
          `${corr.action} no fecho ${gc.referenceNumber}. Motivo: ${corr.reason}.`,
          corr
        );
        return gc;
      });

      res.json(updated);
    })
  );

  // ==================== REPORTS ====================
  app.get(
    '/api/reports',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const db = await loadDbAsync();
      const today = todayISO();
      const startDate = String(req.query.startDate || today);
      const endDate = String(req.query.endDate || today);
      const requestedSellerId = req.query.sellerId ? String(req.query.sellerId) : '';
      const productIdFilter = req.query.productId ? String(req.query.productId) : '';
      const classIdFilter = req.query.classId ? String(req.query.classId) : '';

      const isAdminUser = req.currentUser!.role === 'ADMIN';
      const effectiveSellerId = isAdminUser ? requestedSellerId : req.currentUser!.id;
      const canSeeCosts = isAdminUser || Boolean(req.currentUser!.permissions.canViewPurchases);

      const classMap = new Map(db.classes.map((c) => [c.id, c.name]));
      const productMap = new Map(db.products.map((p) => [p.id, p]));
      const supplierMap = new Map(db.suppliers.map((s) => [s.id, s.name]));

      const matchesItemFilter = (prodId: string) => {
        if (productIdFilter && prodId !== productIdFilter) return false;
        if (classIdFilter) {
          const prod = productMap.get(prodId);
          if (!prod || prod.classId !== classIdFilter) return false;
        }
        return true;
      };

      const filterSalesRange = (sDate: string, eDate: string) => {
        const matched = [];
        for (const s of db.sales) {
          if (!isInvoiceSaleType(s.type)) continue;
          if (s.date < sDate || s.date > eDate) continue;
          if (effectiveSellerId && s.sellerId !== effectiveSellerId) continue;

          const filteredItems = s.items.filter((i) => matchesItemFilter(i.productId));
          if ((productIdFilter || classIdFilter) && filteredItems.length === 0) continue;

          const effectiveTotal =
            productIdFilter || classIdFilter
              ? roundMoney(filteredItems.reduce((acc, i) => acc + i.subtotal, 0))
              : s.totalAmount;

          matched.push({ sale: s, filteredItems, effectiveTotal });
        }
        return matched;
      };

      const filterReturnsRange = (sDate: string, eDate: string) => {
        const matched = [];
        for (const r of db.returns) {
          if (r.date < sDate || r.date > eDate) continue;
          if (effectiveSellerId && r.originalSellerId !== effectiveSellerId) continue;
          const filteredItems = r.items.filter((i) => matchesItemFilter(i.productId));
          if ((productIdFilter || classIdFilter) && filteredItems.length === 0) continue;
          const effectiveRefund =
            productIdFilter || classIdFilter
              ? roundMoney(filteredItems.reduce((acc, i) => acc + i.refundAmount, 0))
              : r.totalRefund;
          matched.push({ ret: r, filteredItems, effectiveRefund });
        }
        return matched;
      };

      const currentSales = filterSalesRange(startDate, endDate);
      const currentReturns = filterReturnsRange(startDate, endDate);

      const startMs = new Date(`${startDate}T00:00:00Z`).getTime();
      const endMs = new Date(`${endDate}T00:00:00Z`).getTime();
      const spanDays = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
      const prevEndDate = new Date(startMs - 86400000).toISOString().slice(0, 10);
      const prevStartDate = new Date(startMs - spanDays * 86400000).toISOString().slice(0, 10);

      const prevSales = filterSalesRange(prevStartDate, prevEndDate);
      const prevReturns = filterReturnsRange(prevStartDate, prevEndDate);

      const bySellerDayMap = new Map<
        string,
        {
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
        }
      >();

      const paymentTotals = emptyPaymentMap();
      let grossTotal = 0;
      let totalUnitsSold = 0;

      const dailySeriesMap = new Map<string, { date: string; sales: number; returns: number; net: number }>();

      for (const entry of currentSales) {
        const { sale, filteredItems, effectiveTotal } = entry;
        const units = filteredItems.reduce((a, i) => a + i.quantity, 0);
        totalUnitsSold += units;
        grossTotal = roundMoney(grossTotal + effectiveTotal);
        paymentTotals[sale.paymentMethod] = roundMoney(paymentTotals[sale.paymentMethod] + effectiveTotal);

        const key = `${sale.date}__${sale.sellerId}`;
        if (!bySellerDayMap.has(key)) {
          bySellerDayMap.set(key, {
            date: sale.date,
            sellerId: sale.sellerId,
            sellerName: sale.sellerName,
            invoicesCount: 0,
            unitsSold: 0,
            grossTotal: 0,
            returnsCount: 0,
            cancellationsCount: 0,
            returnsTotal: 0,
            netTotal: 0,
            byPayment: emptyPaymentMap(),
          });
        }
        const row = bySellerDayMap.get(key)!;
        row.invoicesCount += 1;
        row.unitsSold += units;
        row.grossTotal = roundMoney(row.grossTotal + effectiveTotal);
        row.netTotal = roundMoney(row.grossTotal - row.returnsTotal);
        row.byPayment[sale.paymentMethod] = roundMoney(row.byPayment[sale.paymentMethod] + effectiveTotal);

        if (!dailySeriesMap.has(sale.date)) {
          dailySeriesMap.set(sale.date, { date: sale.date, sales: 0, returns: 0, net: 0 });
        }
        const ds = dailySeriesMap.get(sale.date)!;
        ds.sales = roundMoney(ds.sales + effectiveTotal);
        ds.net = roundMoney(ds.sales - ds.returns);
      }

      let returnsTotal = 0;
      let cancellationsCount = 0;
      for (const entry of currentReturns) {
        const { ret, effectiveRefund } = entry;
        returnsTotal = roundMoney(returnsTotal + effectiveRefund);
        if (ret.type === 'ANULACAO') cancellationsCount += 1;

        const key = `${ret.date}__${ret.originalSellerId}`;
        if (!bySellerDayMap.has(key)) {
          bySellerDayMap.set(key, {
            date: ret.date,
            sellerId: ret.originalSellerId,
            sellerName: ret.originalSellerName,
            invoicesCount: 0,
            unitsSold: 0,
            grossTotal: 0,
            returnsCount: 0,
            cancellationsCount: 0,
            returnsTotal: 0,
            netTotal: 0,
            byPayment: emptyPaymentMap(),
          });
        }
        const row = bySellerDayMap.get(key)!;
        if (ret.type === 'ANULACAO') row.cancellationsCount += 1;
        else row.returnsCount += 1;
        row.returnsTotal = roundMoney(row.returnsTotal + effectiveRefund);
        row.netTotal = roundMoney(row.grossTotal - row.returnsTotal);

        if (!dailySeriesMap.has(ret.date)) {
          dailySeriesMap.set(ret.date, { date: ret.date, sales: 0, returns: 0, net: 0 });
        }
        const ds = dailySeriesMap.get(ret.date)!;
        ds.returns = roundMoney(ds.returns + effectiveRefund);
        ds.net = roundMoney(ds.sales - ds.returns);
      }

      const prevGrossTotal = roundMoney(prevSales.reduce((a, e) => a + e.effectiveTotal, 0));
      const prevReturnsTotal = roundMoney(prevReturns.reduce((a, e) => a + e.effectiveRefund, 0));
      const netTotal = roundMoney(grossTotal - returnsTotal);
      const prevNetTotal = roundMoney(prevGrossTotal - prevReturnsTotal);
      const comparisonDeltaPercent =
        prevNetTotal > 0 ? roundMoney(((netTotal - prevNetTotal) / prevNetTotal) * 100) : netTotal > 0 ? 100 : 0;

      // Aggregate VAT breakdown for the period (separating sales, credit notes/returns, and net)
      const periodTaxMap = new Map<
        string,
        {
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
      >();
      const ensureTaxGroup = (
        taxCodeRaw: TaxCode | undefined,
        taxRateRaw: number | null | undefined,
        exCodeRaw: string | undefined,
        exReasonRaw: string | undefined
      ) => {
        const taxCode: TaxCode = taxCodeRaw || 'NAO_CONFIGURADO';
        const taxRate: number | null =
          taxCode === 'NAO_CONFIGURADO'
            ? null
            : taxCode === 'ISE'
            ? 0
            : taxRateRaw !== null && taxRateRaw !== undefined
            ? Number(taxRateRaw)
            : null;
        const taxExemptionCode = exCodeRaw || '';
        const taxExemptionReason = exReasonRaw || '';
        const key = `${taxCode}|${taxRate ?? 'NULL'}|${taxExemptionCode}|${taxExemptionReason}`;
        if (!periodTaxMap.has(key)) {
          periodTaxMap.set(key, {
            taxCode,
            taxRate,
            taxExemptionCode,
            taxExemptionReason,
            salesBase: 0,
            salesTax: 0,
            salesTotal: 0,
            salesItemsCount: 0,
            returnsBase: 0,
            returnsTax: 0,
            returnsTotal: 0,
            returnsItemsCount: 0,
            netBase: 0,
            netTax: 0,
            netTotal: 0,
          });
        }
        return periodTaxMap.get(key)!;
      };

      let salesTaxableBaseTotal = 0;
      let salesTaxTotal = 0;
      for (const { filteredItems } of currentSales) {
        for (const item of filteredItems) {
          const base = roundMoney(item.taxableBase ?? item.subtotal);
          const tax = roundMoney(item.taxAmount ?? 0);
          const tot = roundMoney(item.subtotal);
          salesTaxableBaseTotal = roundMoney(salesTaxableBaseTotal + base);
          salesTaxTotal = roundMoney(salesTaxTotal + tax);
          const g = ensureTaxGroup(item.taxCode, item.taxRate, item.taxExemptionCode, item.taxExemptionReason);
          g.salesBase = roundMoney(g.salesBase + base);
          g.salesTax = roundMoney(g.salesTax + tax);
          g.salesTotal = roundMoney(g.salesTotal + tot);
          g.salesItemsCount += 1;
        }
      }

      let returnsTaxableBaseTotal = 0;
      let returnsTaxTotal = 0;
      for (const { filteredItems } of currentReturns) {
        for (const item of filteredItems) {
          const base = roundMoney(item.taxableBase ?? item.refundAmount);
          const tax = roundMoney(item.taxAmount ?? 0);
          const tot = roundMoney(item.refundAmount);
          returnsTaxableBaseTotal = roundMoney(returnsTaxableBaseTotal + base);
          returnsTaxTotal = roundMoney(returnsTaxTotal + tax);
          const g = ensureTaxGroup(item.taxCode, item.taxRate, item.taxExemptionCode, item.taxExemptionReason);
          g.returnsBase = roundMoney(g.returnsBase + base);
          g.returnsTax = roundMoney(g.returnsTax + tax);
          g.returnsTotal = roundMoney(g.returnsTotal + tot);
          g.returnsItemsCount += 1;
        }
      }

      for (const g of periodTaxMap.values()) {
        g.netBase = roundMoney(g.salesBase - g.returnsBase);
        g.netTax = roundMoney(g.salesTax - g.returnsTax);
        g.netTotal = roundMoney(g.salesTotal - g.returnsTotal);
      }
      const netTaxableBaseTotal = roundMoney(salesTaxableBaseTotal - returnsTaxableBaseTotal);
      const netTaxTotal = roundMoney(salesTaxTotal - returnsTaxTotal);

      const detailedSales = currentSales
        .map(({ sale, filteredItems, effectiveTotal }) => {
          const { taxTotal: filteredTaxTotal, taxBreakdown: filteredTaxBreakdown } =
            aggregateTaxBreakdown(filteredItems);
          const filteredTaxableBaseTotal = roundMoney(
            filteredItems.reduce((acc, it) => acc + Number(it.taxableBase ?? it.subtotal), 0)
          );
          return {
            id: sale.id,
            documentNumber: sale.documentNumber,
            documentType: sale.type,
            date: sale.date,
            time: sale.time,
            sellerId: sale.sellerId,
            sellerName: sale.sellerName,
            paymentMethod: sale.paymentMethod,
            customerName: sale.customerName,
            status: sale.status,
            subtotal: sale.subtotal,
            discountTotal: sale.discountTotal,
            taxableBaseTotal: filteredTaxableBaseTotal,
            taxTotal: filteredTaxTotal,
            taxBreakdown: filteredTaxBreakdown,
            totalAmount: sale.totalAmount,
            filteredTotal: effectiveTotal,
            items: filteredItems.map((item) => {
              const prod = productMap.get(item.productId);
              const grossLine = roundMoney(item.quantity * item.unitPrice);
              const discountAmount = roundMoney((grossLine * (item.discountPercent || 0)) / 100);
              const resolvedClass =
                item.className || (prod ? classMap.get(prod.classId) || '' : '');
              const resolvedForm = item.dosageForm || prod?.dosageForm || '';
              const resolvedDosage = prod?.dosage || '';
              const resolvedBarcode = item.productBarcode ?? prod?.barcode ?? '';
              return {
                productId: item.productId,
                productName: item.productName,
                productCode: item.productCode,
                productBarcode: String(resolvedBarcode || ''),
                className: resolvedClass,
                dosageForm: resolvedForm,
                dosage: resolvedDosage,
                unit: item.unit || prod?.unit || '',
                quantity: item.quantity,
                returnedQuantity: item.returnedQuantity || 0,
                unitPrice: item.unitPrice,
                discountPercent: item.discountPercent || 0,
                discountAmount,
                taxCode: item.taxCode || 'NAO_CONFIGURADO',
                taxRate: item.taxRate ?? null,
                taxExemptionCode: item.taxExemptionCode || '',
                taxExemptionReason: item.taxExemptionReason || '',
                taxableBase: roundMoney(item.taxableBase ?? item.subtotal),
                taxAmount: roundMoney(item.taxAmount ?? 0),
                subtotal: item.subtotal,
              };
            }),
          };
        })
        .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));

      const warningCutoff = new Date();
      warningCutoff.setDate(warningCutoff.getDate() + (db.settings.expiryWarningDays || 60));
      const warningDateISO = warningCutoff.toISOString().slice(0, 10);

      const stockReport = db.products
        .filter((p) => {
          if (productIdFilter && p.id !== productIdFilter) return false;
          if (classIdFilter && p.classId !== classIdFilter) return false;
          return true;
        })
        .map((p) => {
          const isOut = p.stock <= 0;
          const isLow = p.stock > 0 && p.stock <= p.minStock;
          const isExpired = Boolean(p.expiryDate && p.expiryDate < today);
          const isExpiring = Boolean(p.expiryDate && p.expiryDate >= today && p.expiryDate <= warningDateISO);
          return {
            ...p,
            barcode: p.barcode || '',
            className: classMap.get(p.classId) || '',
            supplierName: p.supplierId ? supplierMap.get(p.supplierId) || '' : '',
            taxCode: p.taxCode || 'NAO_CONFIGURADO',
            taxRate: p.taxRate ?? null,
            taxExemptionCode: p.taxExemptionCode || '',
            taxExemptionReason: p.taxExemptionReason || '',
            purchasePrice: canSeeCosts ? p.purchasePrice : null,
            costValue: canSeeCosts ? roundMoney(p.stock * p.purchasePrice) : null,
            saleValue: roundMoney(p.stock * p.salePrice),
            isOut,
            isLow,
            isExpired,
            isExpiring,
          };
        });

      const filteredInventories = db.inventories.filter(
        (i) => i.countedAt.slice(0, 10) >= startDate && i.countedAt.slice(0, 10) <= endDate
      );

      const enrichedReturnsList = currentReturns.map(({ ret }) => {
        const taxableBaseTotal = roundMoney(
          ret.items.reduce((acc, it) => acc + Number(it.taxableBase ?? it.refundAmount), 0)
        );
        return {
          ...ret,
          taxableBaseTotal,
        };
      });

      const periodPurchases = canSeeCosts
        ? db.purchases.filter((p) => p.documentDate >= startDate && p.documentDate <= endDate)
        : [];
      const purchaseFlatItems = periodPurchases.flatMap((p) => p.items);
      const { taxTotal: purchaseTaxTotal, taxBreakdown: purchaseTaxBreakdown } =
        aggregateTaxBreakdown(purchaseFlatItems);
      const purchaseBaseTotal = roundMoney(
        periodPurchases.reduce(
          (acc, p) =>
            acc +
            (p.subtotal !== undefined
              ? Number(p.subtotal)
              : p.items.reduce((ia, it) => ia + Number(it.taxableBase ?? it.subtotal), 0)),
          0
        )
      );
      const purchaseGrossTotal = roundMoney(periodPurchases.reduce((acc, p) => acc + Number(p.totalAmount), 0));

      res.json({
        filters: {
          startDate,
          endDate,
          prevStartDate,
          prevEndDate,
          spanDays,
          effectiveSellerId,
          canSeeCosts,
        },
        summary: {
          invoicesCount: currentSales.length,
          proformasCount: db.sales.filter(
            (s) =>
              s.type === 'PROFORMA' &&
              s.date >= startDate &&
              s.date <= endDate &&
              (!effectiveSellerId || s.sellerId === effectiveSellerId)
          ).length,
          unitsSold: totalUnitsSold,
          grossTotal,
          returnsTotal,
          cancellationsCount,
          netTotal,
          salesTaxableBaseTotal,
          salesTaxTotal,
          returnsTaxableBaseTotal,
          returnsTaxTotal,
          netTaxableBaseTotal,
          netTaxTotal,
          taxBreakdown: Array.from(periodTaxMap.values()),
          paymentTotals,
          comparison: {
            previousGrossTotal: prevGrossTotal,
            previousReturnsTotal: prevReturnsTotal,
            previousNetTotal: prevNetTotal,
            deltaNet: roundMoney(netTotal - prevNetTotal),
            deltaPercent: comparisonDeltaPercent,
          },
        },
        detailedSales,
        dailyBySeller: Array.from(bySellerDayMap.values()).sort((a, b) =>
          b.date.localeCompare(a.date) || a.sellerName.localeCompare(b.sellerName)
        ),
        dailySeries: Array.from(dailySeriesMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
        returnsList: enrichedReturnsList,
        ...(canSeeCosts
          ? {
              purchasesReport: {
                count: periodPurchases.length,
                baseTotal: purchaseBaseTotal,
                taxTotal: purchaseTaxTotal,
                totalAmount: purchaseGrossTotal,
                taxBreakdown: purchaseTaxBreakdown,
                items: periodPurchases,
              },
            }
          : {}),
        stockReport,
        alerts: {
          outOfStock: stockReport.filter((p) => p.active && p.isOut),
          lowStock: stockReport.filter((p) => p.active && p.isLow),
          expiringSoon: stockReport.filter((p) => p.active && (p.isExpiring || p.isExpired)),
        },
        inventories: filteredInventories,
      });
    })
  );

  // ==================== SETTINGS, AUDIT & BACKUP ====================
  app.get(
    '/api/settings',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(db.settings);
    })
  );

  app.put(
    '/api/settings',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const s = req.body || {};
      const updated = await mutateDb((db) => {
        const prevRegime = db.settings.vatRegime || 'NAO_CONFIGURADO';
        const prevIncludesTax = Boolean(db.settings.pricesIncludeTax);
        const changeReason = String(s.changeReason || 'Atualização das configurações fiscais pelo Administrador').trim();

        if (s.pharmacyName) db.settings.pharmacyName = String(s.pharmacyName).trim();
        if (s.legalName !== undefined) db.settings.legalName = String(s.legalName).trim();
        if (s.establishmentName !== undefined) db.settings.establishmentName = String(s.establishmentName).trim();
        if (s.establishmentCode !== undefined) db.settings.establishmentCode = String(s.establishmentCode).trim();
        if (s.nif !== undefined) db.settings.nif = String(s.nif).trim();
        if (s.phone !== undefined) db.settings.phone = String(s.phone).trim();
        if (s.email !== undefined) db.settings.email = String(s.email).trim();
        if (s.address !== undefined) db.settings.address = String(s.address).trim();
        if (s.city !== undefined) db.settings.city = String(s.city).trim();
        if (s.country !== undefined) db.settings.country = String(s.country).trim();
        if (s.vatRegime !== undefined) {
          const allowedRegimes: VatRegime[] = ['NAO_CONFIGURADO', 'GERAL', 'SIMPLIFICADO', 'EXCLUSAO'];
          if (allowedRegimes.includes(s.vatRegime)) {
            db.settings.vatRegime = s.vatRegime;
          }
        }
        if (typeof s.pricesIncludeTax === 'boolean') db.settings.pricesIncludeTax = s.pricesIncludeTax;
        if (typeof s.agtElectronicInvoicingEnabled === 'boolean') {
          db.settings.agtElectronicInvoicingEnabled = s.agtElectronicInvoicingEnabled;
        }
        if (s.currencySymbol) db.settings.currencySymbol = String(s.currencySymbol).trim();
        if (s.expiryWarningDays !== undefined) {
          db.settings.expiryWarningDays = Math.max(7, Math.floor(Number(s.expiryWarningDays)));
        }
        if (s.series) {
          const cur = db.settings.series;
          const nx = s.series;
          if (nx.seriesYear && Number(nx.seriesYear) >= 2020) cur.seriesYear = Math.floor(Number(nx.seriesYear));
          if (nx.invoicePrefix) cur.invoicePrefix = String(nx.invoicePrefix).trim();
          if (nx.invoiceReciboPrefix) cur.invoiceReciboPrefix = String(nx.invoiceReciboPrefix).trim();
          if (nx.receiptPrefix) cur.receiptPrefix = String(nx.receiptPrefix).trim();
          if (nx.proformaPrefix) cur.proformaPrefix = String(nx.proformaPrefix).trim();
          if (nx.creditNotePrefix) cur.creditNotePrefix = String(nx.creditNotePrefix).trim();
          if (nx.cancellationPrefix) cur.cancellationPrefix = String(nx.cancellationPrefix).trim();
          if (nx.purchasePrefix) cur.purchasePrefix = String(nx.purchasePrefix).trim();
          if (nx.inventoryPrefix) cur.inventoryPrefix = String(nx.inventoryPrefix).trim();
          if (nx.generalClosingPrefix) cur.generalClosingPrefix = String(nx.generalClosingPrefix).trim();
          if (Number(nx.invoiceNext) >= cur.invoiceNext) cur.invoiceNext = Math.floor(Number(nx.invoiceNext));
          if (Number(nx.invoiceReciboNext) >= (cur.invoiceReciboNext || 1))
            cur.invoiceReciboNext = Math.floor(Number(nx.invoiceReciboNext));
          if (Number(nx.receiptNext) >= (cur.receiptNext || 1))
            cur.receiptNext = Math.floor(Number(nx.receiptNext));
          if (Number(nx.proformaNext) >= cur.proformaNext) cur.proformaNext = Math.floor(Number(nx.proformaNext));
          if (Number(nx.creditNoteNext) >= cur.creditNoteNext) cur.creditNoteNext = Math.floor(Number(nx.creditNoteNext));
          if (Number(nx.cancellationNext) >= cur.cancellationNext)
            cur.cancellationNext = Math.floor(Number(nx.cancellationNext));
          if (Number(nx.purchaseNext) >= cur.purchaseNext) cur.purchaseNext = Math.floor(Number(nx.purchaseNext));
        }

        if (db.settings.vatRegime !== prevRegime) {
          recordFiscalChange(db, req.currentUser!, {
            entityType: 'REGIME_IVA',
            entityId: 'vatRegime',
            entityLabel: 'Regime de IVA da Farmácia',
            field: 'vatRegime',
            previousValue: prevRegime,
            newValue: db.settings.vatRegime || 'NAO_CONFIGURADO',
            reason: changeReason,
          });
        }
        if (Boolean(db.settings.pricesIncludeTax) !== prevIncludesTax) {
          recordFiscalChange(db, req.currentUser!, {
            entityType: 'REGIME_IVA',
            entityId: 'pricesIncludeTax',
            entityLabel: 'Modo de cálculo de preços',
            field: 'pricesIncludeTax',
            previousValue: prevIncludesTax ? 'IVA incluído' : 'IVA acrescido',
            newValue: db.settings.pricesIncludeTax ? 'IVA incluído' : 'IVA acrescido',
            reason: changeReason,
          });
        }

        appendAudit(
          db,
          req.currentUser!,
          'CONFIGURACOES_ATUALIZADAS',
          'CONFIGURACOES',
          'settings',
          'Configurações fiscais, gerais e séries de documentos atualizadas.'
        );
        return db.settings;
      });
      res.json(updated);
    })
  );

  // ==================== ADMINISTRABLE VAT RULES & FISCAL HISTORY ====================
  app.get(
    '/api/fiscal/tax-rules',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      res.json(db.settings.taxRules || []);
    })
  );

  app.post(
    '/api/fiscal/tax-rules',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const b = req.body || {};
      const taxCode = String(b.taxCode || '').trim().toUpperCase();
      if (!['NOR', 'INT', 'RED', 'ISE', 'OUT'].includes(taxCode)) {
        throw new HttpError(400, 'Código de imposto AGT inválido. Utilize NOR, INT, RED, ISE ou OUT.');
      }
      const description = String(b.description || '').trim();
      const legalBasis = String(b.legalBasis || '').trim();
      const validFrom = String(b.validFrom || '').trim();
      const validTo = String(b.validTo || '').trim();
      if (!description || !legalBasis || !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
        throw new HttpError(
          400,
          'Descrição, base legal confirmada e data de início de vigência (YYYY-MM-DD) são obrigatórios.'
        );
      }
      if (validTo && (!/^\d{4}-\d{2}-\d{2}$/.test(validTo) || validTo < validFrom)) {
        throw new HttpError(400, 'A data de fim de vigência deve ser igual ou posterior à data de início.');
      }
      const taxInput = validateProductTaxInput({
        taxType: b.taxType || 'IVA',
        taxCode,
        taxRate: b.rate ?? b.taxRate,
        taxExemptionCode: b.exemptionCode ?? b.taxExemptionCode,
        taxExemptionReason: legalBasis,
      });

      const createdRule = await mutateDb((db) => {
        if (!Array.isArray(db.settings.taxRules)) {
          db.settings.taxRules = [];
        }
        const nowIso = new Date().toISOString();
        const rule: TaxRuleEntry = {
          id: `txr_${crypto.randomUUID().slice(0, 8)}`,
          taxType: 'IVA',
          taxCode: taxCode as TaxRuleEntry['taxCode'],
          description,
          rate: Number(taxInput.taxRate ?? 0),
          exemptionCode: taxInput.taxExemptionCode,
          legalBasis,
          validFrom,
          validTo,
          active: b.active !== false,
          confirmedByAccountant: Boolean(b.confirmedByAccountant),
          ...(b.confirmedByAccountant ? { confirmedAt: nowIso } : {}),
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        db.settings.taxRules.push(rule);
        recordFiscalChange(db, req.currentUser!, {
          entityType: 'REGRA_FISCAL',
          entityId: rule.id,
          entityLabel: `${rule.taxCode} — ${rule.description}`,
          field: 'Regra fiscal criada',
          previousValue: 'INEXISTENTE',
          newValue: `${rule.taxCode} (${rule.rate}%) ${rule.exemptionCode || ''} • ${rule.validFrom}${rule.validTo ? ` a ${rule.validTo}` : ''}`.trim(),
          reason: String(b.changeReason || legalBasis).trim(),
        });
        appendAudit(
          db,
          req.currentUser!,
          'REGRA_IVA_CRIADA',
          'CONFIGURACOES',
          rule.id,
          `Regra de IVA criada: ${rule.taxCode} (${rule.rate}%) — ${rule.description}.`
        );
        return rule;
      });

      res.status(201).json(createdRule);
    })
  );

  app.put(
    '/api/fiscal/tax-rules/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const b = req.body || {};
      const updatedRule = await mutateDb((db) => {
        if (!Array.isArray(db.settings.taxRules)) {
          db.settings.taxRules = [];
        }
        const rule = db.settings.taxRules.find((r) => r.id === req.params.id);
        if (!rule) {
          throw new HttpError(404, 'Regra fiscal não encontrada.');
        }
        const prevSnapshot = `${rule.taxCode} (${rule.rate}%) ${rule.exemptionCode || ''} • ativo=${rule.active} • ${rule.validFrom}${rule.validTo ? ` a ${rule.validTo}` : ''}`;

        const nextCode = b.taxCode !== undefined ? String(b.taxCode).trim().toUpperCase() : rule.taxCode;
        if (!['NOR', 'INT', 'RED', 'ISE', 'OUT'].includes(nextCode)) {
          throw new HttpError(400, 'Código de imposto AGT inválido.');
        }
        const nextDesc = b.description !== undefined ? String(b.description).trim() : rule.description;
        const nextLegal = b.legalBasis !== undefined ? String(b.legalBasis).trim() : rule.legalBasis;
        const nextFrom = b.validFrom !== undefined ? String(b.validFrom).trim() : rule.validFrom;
        const nextTo = b.validTo !== undefined ? String(b.validTo).trim() : rule.validTo;
        if (!nextDesc || !nextLegal || !/^\d{4}-\d{2}-\d{2}$/.test(nextFrom)) {
          throw new HttpError(400, 'Descrição, base legal e data de início válidas são obrigatórias.');
        }
        if (nextTo && (!/^\d{4}-\d{2}-\d{2}$/.test(nextTo) || nextTo < nextFrom)) {
          throw new HttpError(400, 'A data de fim de vigência deve ser igual ou posterior à data de início.');
        }

        const taxInput = validateProductTaxInput({
          taxType: b.taxType || rule.taxType || 'IVA',
          taxCode: nextCode,
          taxRate: b.rate !== undefined ? b.rate : b.taxRate !== undefined ? b.taxRate : rule.rate,
          taxExemptionCode:
            b.exemptionCode !== undefined
              ? b.exemptionCode
              : b.taxExemptionCode !== undefined
              ? b.taxExemptionCode
              : rule.exemptionCode,
          taxExemptionReason: nextLegal,
        });

        const nowIso = new Date().toISOString();
        rule.taxCode = nextCode as TaxRuleEntry['taxCode'];
        rule.description = nextDesc;
        rule.rate = Number(taxInput.taxRate ?? 0);
        rule.exemptionCode = taxInput.taxExemptionCode;
        rule.legalBasis = nextLegal;
        rule.validFrom = nextFrom;
        rule.validTo = nextTo;
        if (typeof b.active === 'boolean') rule.active = b.active;
        if (typeof b.confirmedByAccountant === 'boolean') {
          rule.confirmedByAccountant = b.confirmedByAccountant;
          if (b.confirmedByAccountant && !rule.confirmedAt) {
            rule.confirmedAt = nowIso;
          }
        }
        rule.updatedAt = nowIso;

        const nextSnapshot = `${rule.taxCode} (${rule.rate}%) ${rule.exemptionCode || ''} • ativo=${rule.active} • ${rule.validFrom}${rule.validTo ? ` a ${rule.validTo}` : ''}`;
        recordFiscalChange(db, req.currentUser!, {
          entityType: 'REGRA_FISCAL',
          entityId: rule.id,
          entityLabel: `${rule.taxCode} — ${rule.description}`,
          field: 'Regra fiscal atualizada',
          previousValue: prevSnapshot,
          newValue: nextSnapshot,
          reason: String(b.changeReason || 'Atualização administrativa de regra de IVA').trim(),
        });
        appendAudit(
          db,
          req.currentUser!,
          'REGRA_IVA_ATUALIZADA',
          'CONFIGURACOES',
          rule.id,
          `Regra de IVA atualizada: ${rule.taxCode} (${rule.rate}%) — ${rule.description}.`
        );
        return rule;
      });

      res.json(updatedRule);
    })
  );

  app.get(
    '/api/fiscal/history',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const db = await loadDbAsync();
      const history = db.settings.fiscalHistory || [];
      if (req.currentUser!.role !== 'ADMIN' && !req.currentUser!.permissions.canConfigureProductVat) {
        res.json([]);
        return;
      }
      res.json(history);
    })
  );

  // ==================== FISCAL / AGT FE & SAF-T (AO) ====================
  app.get(
    '/api/fiscal/agt/status',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const db = await loadDbAsync();
      const agtStatus = getAgtConfigStatus();
      const unconfiguredProductsCount = db.products.filter(
        (p) => p.active && (!p.taxCode || p.taxCode === 'NAO_CONFIGURADO')
      ).length;
      res.json({
        ...agtStatus,
        vatRegime: db.settings.vatRegime || 'NAO_CONFIGURADO',
        agtElectronicInvoicingEnabled: Boolean(db.settings.agtElectronicInvoicingEnabled),
        unconfiguredProductsCount,
        missingIssuerFields: [
          ...(!db.settings.legalName?.trim() ? ['Denominação legal'] : []),
          ...(!db.settings.nif?.trim() ? ['NIF'] : []),
          ...(!db.settings.address?.trim() ? ['Sede / Domicílio'] : []),
          ...(!db.settings.establishmentName?.trim() ? ['Estabelecimento emissor'] : []),
        ],
      });
    })
  );

  app.get(
    '/api/fiscal/agt/payload/:kind/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const kind = String(req.params.kind).toUpperCase();
      if (kind !== 'SALE' && kind !== 'RETURN') {
        throw new HttpError(400, 'Tipo de documento inválido (use SALE ou RETURN).');
      }
      const db = await loadDbAsync();
      const doc =
        kind === 'SALE'
          ? db.sales.find((s) => s.id === req.params.id)
          : db.returns.find((r) => r.id === req.params.id);
      if (!doc) {
        throw new HttpError(404, 'Documento não encontrado.');
      }
      const payload = buildAgtFeSubmissionPayload(db.settings, doc, kind);
      res.json(payload);
    })
  );

  app.post(
    '/api/fiscal/agt/submit/:kind/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const kind = String(req.params.kind).toUpperCase();
      if (kind !== 'SALE' && kind !== 'RETURN') {
        throw new HttpError(400, 'Tipo de documento inválido (use SALE ou RETURN).');
      }
      const dbRead = await loadDbAsync();
      const targetDoc =
        kind === 'SALE'
          ? dbRead.sales.find((s) => s.id === req.params.id)
          : dbRead.returns.find((r) => r.id === req.params.id);
      if (!targetDoc) {
        throw new HttpError(404, 'Documento não encontrado.');
      }
      if (kind === 'SALE' && (targetDoc as Sale).type === 'PROFORMA') {
        throw new HttpError(400, 'Proformas são documentos não fiscais e não são submetidas para validação fiscal da AGT.');
      }

      const submission = await submitToAgtEndpoint(dbRead.settings, targetDoc, kind);

      const updatedDoc = await mutateDb((db) => {
        const doc =
          kind === 'SALE'
            ? db.sales.find((s) => s.id === req.params.id)
            : db.returns.find((r) => r.id === req.params.id);
        if (!doc) throw new HttpError(404, 'Documento não encontrado.');

        doc.fiscalValidationStatus = submission.validationStatus;
        if (submission.requestId) doc.agtRequestId = submission.requestId;
        if (submission.rejectionReason) {
          doc.agtRejectionReason = submission.rejectionReason;
        } else if (submission.validationStatus === 'VALIDADO_AGT') {
          doc.agtRejectionReason = undefined;
        }
        if (submission.qrCode) doc.agtQrCode = submission.qrCode;
        if (submission.hash) doc.agtHash = submission.hash;
        if (submission.signature) doc.agtSignature = submission.signature;
        if (!Array.isArray(doc.agtSubmissionHistory)) doc.agtSubmissionHistory = [];
        doc.agtSubmissionHistory.push(submission.event);

        appendAudit(
          db,
          req.currentUser!,
          'AGT_SUBMISSAO_TENTATIVA',
          kind === 'SALE' ? 'VENDA' : 'DEVOLUCAO',
          doc.id,
          `Submissão AGT (${doc.documentNumber}): ${submission.event.message}`,
          { validationStatus: submission.validationStatus, requestId: submission.requestId }
        );
        return doc;
      });

      res.json({ submission, document: updatedDoc });
    })
  );

  app.post(
    '/api/fiscal/agt/poll/:kind/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const kind = String(req.params.kind).toUpperCase();
      if (kind !== 'SALE' && kind !== 'RETURN') {
        throw new HttpError(400, 'Tipo de documento inválido.');
      }
      const dbRead = await loadDbAsync();
      const targetDoc =
        kind === 'SALE'
          ? dbRead.sales.find((s) => s.id === req.params.id)
          : dbRead.returns.find((r) => r.id === req.params.id);
      if (!targetDoc) {
        throw new HttpError(404, 'Documento não encontrado.');
      }
      if (!targetDoc.agtRequestId) {
        throw new HttpError(409, 'Este documento ainda não possui requestID atribuído pela AGT.');
      }

      const pollRes = await pollAgtDocumentStatus(dbRead.settings, targetDoc.agtRequestId);
      const updatedDoc = await mutateDb((db) => {
        const doc =
          kind === 'SALE'
            ? db.sales.find((s) => s.id === req.params.id)
            : db.returns.find((r) => r.id === req.params.id);
        if (!doc) throw new HttpError(404, 'Documento não encontrado.');
        doc.fiscalValidationStatus = pollRes.validationStatus;
        if (pollRes.rejectionReason) {
          doc.agtRejectionReason = pollRes.rejectionReason;
        } else if (pollRes.validationStatus === 'VALIDADO_AGT') {
          doc.agtRejectionReason = undefined;
        }
        if (pollRes.qrCode) doc.agtQrCode = pollRes.qrCode;
        if (pollRes.hash) doc.agtHash = pollRes.hash;
        if (pollRes.signature) doc.agtSignature = pollRes.signature;
        if (!Array.isArray(doc.agtSubmissionHistory)) doc.agtSubmissionHistory = [];
        doc.agtSubmissionHistory.push(pollRes.event);

        appendAudit(
          db,
          req.currentUser!,
          'AGT_ESTADO_CONSULTADO',
          kind === 'SALE' ? 'VENDA' : 'DEVOLUCAO',
          doc.id,
          `Consulta de estado AGT (${doc.documentNumber}): ${pollRes.validationStatus}.`
        );
        return doc;
      });

      res.json({ poll: pollRes, document: updatedDoc });
    })
  );

  app.post(
    '/api/fiscal/agt/consultar/:kind/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const kind = String(req.params.kind).toUpperCase();
      if (kind !== 'SALE' && kind !== 'RETURN') {
        throw new HttpError(400, 'Tipo de documento inválido.');
      }
      const dbRead = await loadDbAsync();
      const targetDoc =
        kind === 'SALE'
          ? dbRead.sales.find((s) => s.id === req.params.id)
          : dbRead.returns.find((r) => r.id === req.params.id);
      if (!targetDoc) {
        throw new HttpError(404, 'Documento não encontrado.');
      }
      if (kind === 'SALE' && (targetDoc as Sale).type === 'PROFORMA') {
        throw new HttpError(400, 'Proformas são documentos não fiscais e não são consultadas na AGT.');
      }

      const consultRes = await consultAgtInvoice(dbRead.settings, targetDoc.documentNumber);
      const updatedDoc = await mutateDb((db) => {
        const doc =
          kind === 'SALE'
            ? db.sales.find((s) => s.id === req.params.id)
            : db.returns.find((r) => r.id === req.params.id);
        if (!doc) throw new HttpError(404, 'Documento não encontrado.');
        doc.fiscalValidationStatus = consultRes.validationStatus;
        if (consultRes.rejectionReason) {
          doc.agtRejectionReason = consultRes.rejectionReason;
        } else if (consultRes.validationStatus === 'VALIDADO_AGT') {
          doc.agtRejectionReason = undefined;
        }
        if (consultRes.qrCode) doc.agtQrCode = consultRes.qrCode;
        if (consultRes.hash) doc.agtHash = consultRes.hash;
        if (consultRes.signature) doc.agtSignature = consultRes.signature;
        if (!Array.isArray(doc.agtSubmissionHistory)) doc.agtSubmissionHistory = [];
        doc.agtSubmissionHistory.push(consultRes.event);

        appendAudit(
          db,
          req.currentUser!,
          'AGT_FACTURA_CONSULTADA',
          kind === 'SALE' ? 'VENDA' : 'DEVOLUCAO',
          doc.id,
          `Consulta consultarFactura AGT (${doc.documentNumber}): ${consultRes.event.message}`
        );
        return doc;
      });

      res.json({ consult: consultRes, document: updatedDoc });
    })
  );

  app.post(
    '/api/fiscal/agt/solicitar-serie',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const dbRead = await loadDbAsync();
      const { seriesYear, documentType, establishmentNumber, seriesContingencyIndicator } = req.body || {};
      const result = await requestAgtSeries(dbRead.settings, {
        seriesYear: seriesYear ? Number(seriesYear) : undefined,
        documentType: String(documentType || ''),
        establishmentNumber: establishmentNumber ? String(establishmentNumber) : undefined,
        seriesContingencyIndicator: seriesContingencyIndicator
          ? String(seriesContingencyIndicator)
          : undefined,
      });

      if (result.ok && result.series) {
        await mutateDb((db) => {
          if (!Array.isArray(db.settings.series.agtSeries)) {
            db.settings.series.agtSeries = [];
          }
          db.settings.series.agtSeries.unshift(result.series!);
          appendAudit(
            db,
            req.currentUser!,
            'AGT_SERIE_SOLICITADA',
            'CONFIGURACOES',
            result.series!.seriesCode,
            `Série AGT ${result.series!.seriesCode} (${result.series!.documentType} ${result.series!.seriesYear}, ${result.series!.environment}) obtida via solicitarSerie.`,
            result.series
          );
        });
      }

      res.status(result.ok ? 200 : 400).json(result);
    })
  );

  app.get(
    '/api/fiscal/saft-ao/export',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const today = todayISO();
      const startDate = String(req.query.startDate || `${today.slice(0, 7)}-01`);
      const endDate = String(req.query.endDate || today);
      if (endDate < startDate) {
        throw new HttpError(400, 'A data final deve ser igual ou superior à data inicial.');
      }

      const dbSnap = await mutateDb((db) => {
        appendAudit(
          db,
          req.currentUser!,
          'EXPORTACAO_SAFT_AO',
          'SISTEMA',
          'saft-ao',
          `Exportação SAF-T (AO) 1.01_01 gerada para o período ${startDate} a ${endDate}.`
        );
        return db;
      });

      const result = generateSaftAoXml(dbSnap, startDate, endDate);
      if (String(req.query.format || '').toLowerCase() === 'xml') {
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.xml);
        return;
      }
      res.json(result);
    })
  );

  app.get(
    '/api/audit',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const db = await loadDbAsync();
      const logs =
        req.currentUser!.role === 'ADMIN'
          ? db.auditLogs
          : db.auditLogs.filter((l) => l.userId === req.currentUser!.id);
      res.json(logs.slice(0, 300));
    })
  );

  app.get(
    '/api/backup/export',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const snapshot = await mutateDb((db) => {
        appendAudit(
          db,
          req.currentUser!,
          'COPIA_SEGURANCA_EXPORTADA',
          'SISTEMA',
          'backup',
          'Cópia de segurança completa exportada.'
        );
        return db;
      });
      res.json({
        exportedAt: new Date().toISOString(),
        exportedBy: req.currentUser!.fullName,
        app: 'Âncora SMS — Stock Management System',
        database: snapshot,
      });
    })
  );

  app.post(
    '/api/backup/restore',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const payload = req.body?.database || req.body;
      if (
        !payload ||
        !Array.isArray(payload.users) ||
        !Array.isArray(payload.products) ||
        !Array.isArray(payload.sales) ||
        !payload.settings
      ) {
        throw new HttpError(400, 'Ficheiro de cópia de segurança inválido ou incompatível.');
      }
      const restored = payload as DatabaseSchema;
      appendAudit(
        restored,
        req.currentUser!,
        'COPIA_SEGURANCA_RESTAURADA',
        'SISTEMA',
        'restore',
        `Base de dados restaurada a partir de cópia de segurança por ${req.currentUser!.fullName}.`
      );
      await replaceDbAsync(restored);
      res.json({ ok: true, message: 'Cópia de segurança restaurada com sucesso.' });
    })
  );

  app.post(
    '/api/backup/clear-demo',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      await mutateDb((db) => {
        clearDemoFromDatabase(db, req.currentUser!);
      });
      res.json({
        ok: true,
        message: 'Dados de demonstração removidos. Apenas dados reais e a sua conta foram mantidos.',
      });
    })
  );

  app.post(
    '/api/backup/reset-demo',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      if (IS_PROD) {
        throw new HttpError(403, 'Não é permitido repor dados de demonstração em ambiente de produção.');
      }
      const fresh = createSeedDatabase();
      await replaceDbAsync(fresh);
      res.json({ ok: true, message: 'Dados de demonstração repostos.' });
    })
  );

  app.get(
    '/api/backup/auto/status',
    requireAuth,
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const status = await getBackupConfigStatus();
      res.json(status);
    })
  );

  app.put(
    '/api/backup/auto/config',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = req.body || {};
      const updatedPolicy = await mutateDb((db) => {
        const current = normalizePolicy(db.settings.backupPolicy);
        const nextPolicy = normalizePolicy({
          ...current,
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(body.retentionDays !== undefined ? { retentionDays: Number(body.retentionDays) } : {}),
          ...(body.dailyHourUTC !== undefined ? { dailyHourUTC: Number(body.dailyHourUTC) } : {}),
        });
        db.settings.backupPolicy = nextPolicy;
        appendAudit(
          db,
          req.currentUser!,
          'POLITICA_BACKUP_ATUALIZADA',
          'CONFIGURACOES',
          'backupPolicy',
          `Política de cópias automáticas atualizada (ativo=${nextPolicy.enabled}, retenção=${nextPolicy.retentionDays}d, hora UTC=${nextPolicy.dailyHourUTC}:00).`
        );
        return nextPolicy;
      });
      res.json(updatedPolicy);
    })
  );

  app.post(
    '/api/backup/auto/run',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthedRequest, res) => {
      const result = await runExternalBackup('MANUAL', req.currentUser!);
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    })
  );

  app.post(
    '/api/backup/cron',
    asyncHandler(async (req, res) => {
      const expectedSecret = (process.env.BACKUP_CRON_SECRET || '').trim();
      if (!expectedSecret || expectedSecret.length < 16) {
        res.status(503).json({ ok: false, message: 'BACKUP_CRON_SECRET não configurada no servidor.' });
        return;
      }
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const a = Buffer.from(token, 'utf8');
      const b = Buffer.from(expectedSecret, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ ok: false, message: 'Não autorizado.' });
        return;
      }
      const result = await runExternalBackup('CRON');
      res.status(result.ok ? 200 : 500).json(result);
    })
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Rota da API não encontrada.' });
  });

  // ==================== VITE / STATIC SERVING ====================
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest') || filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
          if (filePath.endsWith('.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
          }
        },
      })
    );
    app.get('*', (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled API error:', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Âncora SMS server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
