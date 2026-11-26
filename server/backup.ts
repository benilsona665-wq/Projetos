import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { appendAudit, loadDbAsync, mutateDb } from './db.ts';
import type { BackupPolicySettings, StoredUser } from '../src/types.ts';

export interface ExternalBackupConfigStatus {
  storageConfigured: boolean;
  missingRequirements: string[];
  providerHost: string;
  bucket: string;
  prefix: string;
  region: string;
  encryptionEnabled: boolean;
  cronEndpointConfigured: boolean;
  policy: BackupPolicySettings;
}

interface S3BackupSettings {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  encryptionKey: string;
}

function readS3Env(): S3BackupSettings | null {
  const endpoint = (process.env.BACKUP_S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  const bucket = (process.env.BACKUP_S3_BUCKET || '').trim();
  const accessKeyId = (process.env.BACKUP_S3_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.BACKUP_S3_SECRET_ACCESS_KEY || '').trim();
  const region = (process.env.BACKUP_S3_REGION || 'auto').trim() || 'auto';
  const prefix = (process.env.BACKUP_S3_PREFIX || 'ancora-sms/backups')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  const encryptionKey = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  return { endpoint, region, bucket, prefix, accessKeyId, secretAccessKey, encryptionKey };
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function encodeS3Path(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

async function signedS3Request(params: {
  cfg: S3BackupSettings;
  method: 'GET' | 'PUT' | 'DELETE';
  objectKey?: string;
  query?: Record<string, string>;
  body?: Buffer;
  contentType?: string;
}): Promise<Response> {
  const { cfg, method, objectKey, query, body, contentType } = params;
  const endpointUrl = new URL(cfg.endpoint);
  const host = endpointUrl.host;
  const basePath = endpointUrl.pathname.replace(/\/+$/, '');
  const bucketPath = `/${encodeURIComponent(cfg.bucket)}`;
  const keyPath = objectKey ? `/${encodeS3Path(objectKey)}` : '';
  const canonicalUri = `${basePath}${bucketPath}${keyPath}`;

  const sortedQuery = Object.entries(query || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body || Buffer.alloc(0));

  const headersToSign: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) {
    headersToSign['content-type'] = contentType;
  }

  const signedHeaderKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headersToSign[k]}\n`).join('');
  const signedHeaders = signedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    sortedQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, cfg.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const targetUrl = `${cfg.endpoint}${bucketPath}${keyPath}${sortedQuery ? `?${sortedQuery}` : ''}`;
  const reqHeaders: Record<string, string> = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: authorization,
  };
  if (contentType) {
    reqHeaders['Content-Type'] = contentType;
  }

  return fetch(targetUrl, {
    method,
    headers: reqHeaders,
    body: body ? new Uint8Array(body) : undefined,
  });
}

function encryptBackupBuffer(plainGzip: Buffer, encryptionKey: string): Buffer {
  const key = crypto.createHash('sha256').update(encryptionKey, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainGzip), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from('ANCORA1', 'ascii');
  return Buffer.concat([header, iv, tag, encrypted]);
}

function parseS3ListKeys(xmlText: string): Array<{ key: string; lastModifiedMs: number }> {
  const results: Array<{ key: string; lastModifiedMs: number }> = [];
  const blockRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const keyMatch = /<Key>([^<]+)<\/Key>/.exec(block);
    const modMatch = /<LastModified>([^<]+)<\/LastModified>/.exec(block);
    if (keyMatch) {
      const lastModifiedMs = modMatch ? Date.parse(modMatch[1]) : 0;
      results.push({
        key: keyMatch[1],
        lastModifiedMs: Number.isFinite(lastModifiedMs) ? lastModifiedMs : 0,
      });
    }
  }
  return results;
}

async function pruneOldBackups(
  cfg: S3BackupSettings,
  retentionDays: number
): Promise<{ deletedCount: number }> {
  const listRes = await signedS3Request({
    cfg,
    method: 'GET',
    query: {
      'list-type': '2',
      prefix: `${cfg.prefix}/`,
    },
  });
  if (!listRes.ok) {
    return { deletedCount: 0 };
  }
  const xml = await listRes.text();
  const objects = parseS3ListKeys(xml);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  for (const obj of objects) {
    if (obj.lastModifiedMs > 0 && obj.lastModifiedMs < cutoffMs) {
      const delRes = await signedS3Request({
        cfg,
        method: 'DELETE',
        objectKey: obj.key,
      });
      if (delRes.ok) {
        deletedCount++;
      }
    }
  }
  return { deletedCount };
}

export function normalizePolicy(policy?: BackupPolicySettings): BackupPolicySettings {
  const envRetention = Number(process.env.BACKUP_RETENTION_DAYS) || 30;
  const envHour = Number(process.env.BACKUP_SCHEDULE_HOUR_UTC);
  return {
    enabled: policy?.enabled ?? process.env.BACKUP_ENABLED === 'true',
    retentionDays: Math.max(1, Math.min(365, Math.floor(policy?.retentionDays ?? envRetention))),
    dailyHourUTC: Math.max(
      0,
      Math.min(23, Math.floor(policy?.dailyHourUTC ?? (Number.isFinite(envHour) ? envHour : 2)))
    ),
    lastRunAt: policy?.lastRunAt,
    lastStatus: policy?.lastStatus || 'NEVER',
    lastError: policy?.lastError,
    lastBackupKey: policy?.lastBackupKey,
  };
}

function listMissingBackupRequirements(): string[] {
  const missing: string[] = [];
  const endpoint = (process.env.BACKUP_S3_ENDPOINT || '').trim();
  const bucket = (process.env.BACKUP_S3_BUCKET || '').trim();
  const accessKeyId = (process.env.BACKUP_S3_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.BACKUP_S3_SECRET_ACCESS_KEY || '').trim();

  if (!endpoint) {
    missing.push('BACKUP_S3_ENDPOINT (endereço do armazenamento S3/R2/GCS)');
  } else {
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        missing.push('BACKUP_S3_ENDPOINT com protocolo http:// ou https:// válido');
      }
    } catch {
      missing.push('BACKUP_S3_ENDPOINT com URL válido');
    }
  }
  if (!bucket) missing.push('BACKUP_S3_BUCKET (nome do bucket externo)');
  if (!accessKeyId) missing.push('BACKUP_S3_ACCESS_KEY_ID (chave de acesso)');
  if (!secretAccessKey) missing.push('BACKUP_S3_SECRET_ACCESS_KEY (chave secreta de acesso)');
  return missing;
}

export async function getBackupConfigStatus(): Promise<ExternalBackupConfigStatus> {
  const db = await loadDbAsync();
  const cfg = readS3Env();
  const missingRequirements = listMissingBackupRequirements();
  let providerHost = '';
  if (cfg) {
    try {
      providerHost = new URL(cfg.endpoint).host;
    } catch {
      providerHost = '';
    }
  }
  return {
    storageConfigured: Boolean(cfg),
    missingRequirements,
    providerHost,
    bucket: cfg?.bucket || '',
    prefix: cfg?.prefix || '',
    region: cfg?.region || '',
    encryptionEnabled: Boolean(cfg?.encryptionKey),
    cronEndpointConfigured: Boolean((process.env.BACKUP_CRON_SECRET || '').trim()),
    policy: normalizePolicy(db.settings.backupPolicy),
  };
}

let backupInProgress = false;

export async function runExternalBackup(
  trigger: 'MANUAL' | 'SCHEDULED' | 'CRON',
  actingUser?: StoredUser
): Promise<{
  ok: boolean;
  key?: string;
  bytes?: number;
  encrypted?: boolean;
  prunedCount?: number;
  message: string;
}> {
  if (backupInProgress) {
    return {
      ok: false,
      message: 'Já existe uma cópia de segurança externa em execução.',
    };
  }

  const cfg = readS3Env();
  if (!cfg) {
    const errMsg =
      'Armazenamento externo não configurado no servidor (BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID e BACKUP_S3_SECRET_ACCESS_KEY).';
    await mutateDb((db) => {
      const current = normalizePolicy(db.settings.backupPolicy);
      db.settings.backupPolicy = {
        ...current,
        lastRunAt: new Date().toISOString(),
        lastStatus: 'ERROR',
        lastError: errMsg,
      };
    }).catch(() => {});
    return { ok: false, message: errMsg };
  }

  backupInProgress = true;
  try {
    const db = await loadDbAsync();
    const policy = normalizePolicy(db.settings.backupPolicy);
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

    const payload = JSON.stringify({
      exportedAt: now.toISOString(),
      trigger,
      app: 'Âncora SMS — Stock Management System',
      database: db,
    });
    const gzipped = zlib.gzipSync(Buffer.from(payload, 'utf-8'), { level: 9 });
    const encrypted = Boolean(cfg.encryptionKey);
    const uploadBody = encrypted ? encryptBackupBuffer(gzipped, cfg.encryptionKey) : gzipped;
    const ext = encrypted ? 'json.gz.enc' : 'json.gz';
    const objectKey = `${cfg.prefix}/ancora-sms-backup-${stamp}.${ext}`;

    const putRes = await signedS3Request({
      cfg,
      method: 'PUT',
      objectKey,
      body: uploadBody,
      contentType: 'application/octet-stream',
    });

    if (!putRes.ok) {
      const text = await putRes.text().catch(() => '');
      throw new Error(`Falha ao enviar cópia para o armazenamento externo (HTTP ${putRes.status}): ${text.slice(0, 200)}`);
    }

    const { deletedCount } = await pruneOldBackups(cfg, policy.retentionDays).catch(() => ({
      deletedCount: 0,
    }));

    await mutateDb((draft) => {
      const current = normalizePolicy(draft.settings.backupPolicy);
      draft.settings.backupPolicy = {
        ...current,
        lastRunAt: now.toISOString(),
        lastStatus: 'SUCCESS',
        lastError: undefined,
        lastBackupKey: objectKey,
      };
      appendAudit(
        draft,
        actingUser || { id: 'system', username: 'sistema', fullName: 'Sistema (Backup Automático)' },
        'COPIA_SEGURANCA_EXTERNA',
        'SISTEMA',
        objectKey,
        `Cópia de segurança externa concluída (${trigger}, ${uploadBody.length} bytes, retenção ${current.retentionDays}d).`,
        { trigger, encrypted, prunedCount: deletedCount }
      );
    });

    return {
      ok: true,
      key: objectKey,
      bytes: uploadBody.length,
      encrypted,
      prunedCount: deletedCount,
      message: `Cópia de segurança enviada com sucesso (${deletedCount} antiga(s) removida(s) pela política de retenção).`,
    };
  } catch (err: any) {
    const errMsg = err?.message || 'Erro desconhecido na cópia de segurança externa.';
    await mutateDb((draft) => {
      const current = normalizePolicy(draft.settings.backupPolicy);
      draft.settings.backupPolicy = {
        ...current,
        lastRunAt: new Date().toISOString(),
        lastStatus: 'ERROR',
        lastError: errMsg,
      };
    }).catch(() => {});
    return { ok: false, message: errMsg };
  } finally {
    backupInProgress = false;
  }
}

let schedulerTimer: NodeJS.Timeout | null = null;

export function startDailyBackupScheduler(): void {
  if (schedulerTimer) return;

  const checkAndRun = async () => {
    try {
      const status = await getBackupConfigStatus();
      if (!status.storageConfigured || !status.policy.enabled) return;

      const now = new Date();
      const todayUTC = now.toISOString().slice(0, 10);
      const currentHourUTC = now.getUTCHours();

      if (currentHourUTC < status.policy.dailyHourUTC) return;
      if (status.policy.lastRunAt && status.policy.lastRunAt.slice(0, 10) === todayUTC && status.policy.lastStatus === 'SUCCESS') {
        return;
      }

      const res = await runExternalBackup('SCHEDULED');
      if (res.ok) {
        console.log(`Âncora SMS: cópia diária automática concluída (${res.key}).`);
      } else {
        console.error('Âncora SMS: falha na cópia diária automática:', res.message);
      }
    } catch (err) {
      console.error('Âncora SMS: erro no agendador de cópias:', err);
    }
  };

  // Check every 30 minutes while server process is active
  schedulerTimer = setInterval(checkAndRun, 30 * 60 * 1000);
  schedulerTimer.unref?.();
}
