import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import {
  PG_SCHEMA_STATEMENTS,
  readDbFromPgClient,
  readSqliteFileSnapshot,
  writeDbToPgClient,
} from '../server/db.ts';
import type { DatabaseSchema } from '../src/types.ts';

const PG_LOCK_KEY = 78451209;

function parseArgs(argv: string[]) {
  let sqlitePath = process.env.DATABASE_PATH || './data/ancora-sms.sqlite';
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      force = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--sqlite' && argv[i + 1]) {
      sqlitePath = argv[++i];
    } else if (arg.startsWith('--sqlite=')) {
      sqlitePath = arg.slice('--sqlite='.length);
    }
  }

  return { sqlitePath: path.resolve(process.cwd(), sqlitePath), force, dryRun };
}

function summarizeDb(db: DatabaseSchema) {
  return {
    users: db.users.length,
    classes: db.classes.length,
    products: db.products.length,
    suppliers: db.suppliers.length,
    purchases: db.purchases.length,
    customers: db.customers.length,
    sales: db.sales.length,
    returns: db.returns.length,
    inventories: db.inventories.length,
    sellerClosings: db.sellerClosings.length,
    generalClosings: db.generalClosings.length,
    auditLogs: db.auditLogs.length,
  };
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main() {
  const { sqlitePath, force, dryRun } = parseArgs(process.argv.slice(2));
  const databaseUrl = (process.env.DATABASE_URL || '').trim();

  if (!fs.existsSync(sqlitePath)) {
    console.error(`Erro: Ficheiro SQLite de origem não encontrado em: ${sqlitePath}`);
    process.exit(1);
  }

  if (!databaseUrl || (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://'))) {
    console.error(
      'Erro: DATABASE_URL não está configurada ou não é válida (postgres:// / postgresql://). Defina-a nas variáveis de ambiente antes de migrar.'
    );
    process.exit(1);
  }

  console.log('=== Migração SQLite → PostgreSQL (Âncora SMS) ===');
  console.log(`Origem SQLite (intacta): ${sqlitePath}`);
  console.log(`Modo: ${dryRun ? 'SIMULAÇÃO (--dry-run)' : 'MIGRAÇÃO REAL'}`);

  const snapshot = readSqliteFileSnapshot(sqlitePath);
  const srcCounts = summarizeDb(snapshot);
  console.log('Registos encontrados no SQLite:', srcCounts);

  const stamp = timestampSlug();
  const backupDir = path.resolve(process.cwd(), 'backups');

  if (!dryRun) {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const sqliteBackupPath = path.join(backupDir, `ancora-sms.sqlite.${stamp}.bak`);
    const jsonBackupPath = path.join(backupDir, `pre-migration-${stamp}.json`);
    fs.copyFileSync(sqlitePath, sqliteBackupPath);
    fs.writeFileSync(
      jsonBackupPath,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          source: sqlitePath,
          app: 'Âncora SMS — Stock Management System',
          database: snapshot,
        },
        null,
        2
      ),
      'utf-8'
    );
    console.log(`Cópias de segurança prévias criadas:\n  - ${sqliteBackupPath}\n  - ${jsonBackupPath}`);
  }

  const useSsl =
    process.env.DATABASE_SSL === 'true' ||
    databaseUrl.includes('sslmode=require') ||
    (!databaseUrl.includes('localhost') && !databaseUrl.includes('127.0.0.1'));

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: 3,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(${PG_LOCK_KEY})`);

    for (const stmt of PG_SCHEMA_STATEMENTS) {
      await client.query(stmt);
    }

    const existingCountsRes = await client.query(
      `SELECT
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM products) AS products,
        (SELECT COUNT(*)::int FROM sales) AS sales,
        (SELECT COUNT(*)::int FROM purchases) AS purchases`
    );
    const existing = existingCountsRes.rows[0] as {
      users: number;
      products: number;
      sales: number;
      purchases: number;
    };
    const pgHasData =
      existing.users > 0 || existing.products > 0 || existing.sales > 0 || existing.purchases > 0;

    if (pgHasData && !force) {
      await client.query('ROLLBACK');
      console.error(
        `Abortado: A base PostgreSQL de destino já contém dados (users=${existing.users}, products=${existing.products}, sales=${existing.sales}, purchases=${existing.purchases}).`
      );
      console.error(
        'Por segurança, a migração não substitui dados existentes sem confirmação explícita (--force).'
      );
      process.exit(1);
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('Simulação concluída com sucesso. Nenhuma alteração foi escrita no PostgreSQL.');
      return;
    }

    if (pgHasData && force) {
      const pgBefore = await readDbFromPgClient(client);
      const pgBackupPath = path.join(backupDir, `postgres-pre-overwrite-${stamp}.json`);
      fs.writeFileSync(
        pgBackupPath,
        JSON.stringify({ exportedAt: new Date().toISOString(), database: pgBefore }, null, 2),
        'utf-8'
      );
      console.log(`Cópia de segurança do PostgreSQL anterior guardada em: ${pgBackupPath}`);
    }

    await writeDbToPgClient(client, snapshot);

    const verified = await readDbFromPgClient(client);
    const dstCounts = summarizeDb(verified);

    for (const key of Object.keys(srcCounts) as Array<keyof typeof srcCounts>) {
      if (srcCounts[key] !== dstCounts[key]) {
        throw new Error(
          `Divergência de integridade em "${key}": origem=${srcCounts[key]}, destino=${dstCounts[key]}. Transação revertida.`
        );
      }
    }

    await client.query('COMMIT');
    console.log('Migração concluída e verificada no PostgreSQL:', dstCounts);
    console.log(
      `IMPORTANTE: O ficheiro SQLite original (${sqlitePath}) foi mantido intacto. Só o arquive ou remova após confirmar a aplicação em produção.`
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Falha na migração para PostgreSQL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Erro inesperado na migração:', err);
  process.exit(1);
});
