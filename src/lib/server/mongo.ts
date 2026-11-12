import { MongoClient, type ClientSession, type Db } from 'mongodb';
import { ensureInvoicingIndexes } from './invoicing/indexes.mjs';

/**
 * Shared MongoDB connection for the Route Handlers.
 *
 * - Reads MONGODB_URI (required) and MONGODB_DB (optional) from the server
 *   environment only. The URI is never logged or returned to the browser.
 * - The client promise is cached on globalThis so `next dev` hot reloads and
 *   concurrent requests reuse one connection pool.
 * - A failed connection clears the cache so the next request retries instead
 *   of being stuck on a rejected promise.
 */

export class DatabaseUnavailableError extends Error {
  status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

type MongoCache = {
  client?: Promise<MongoClient>;
  ready?: Promise<{ db: Db; transactions: boolean }>;
};

const globalForMongo = globalThis as typeof globalThis & { __invoicingMongo?: MongoCache };
const cache: MongoCache = (globalForMongo.__invoicingMongo ??= {});

function databaseName(uri: string) {
  if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
  try {
    const parsed = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
    const fromPath = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (fromPath) return fromPath;
  } catch {
    // fall through to the default name
  }
  return 'wms_desk';
}

async function connect(): Promise<{ db: Db; transactions: boolean }> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new DatabaseUnavailableError('Database is not configured. Set MONGODB_URI in .env.local and restart the server.');
  }
  cache.client ??= new MongoClient(uri, {
    appName: 'wms-desk-invoicing',
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
    maxPoolSize: 20,
  }).connect();
  let client: MongoClient;
  try {
    client = await cache.client;
  } catch {
    cache.client = undefined;
    throw new DatabaseUnavailableError('Could not connect to MongoDB. Check MONGODB_URI, network access and that the server is running.');
  }
  const db = client.db(databaseName(uri));
  // Transactions need a replica set or sharded cluster. Atlas always is one;
  // a plain local `mongod` is standalone and must use the fallback path.
  const hello = await db.admin().command({ hello: 1 }).catch(() => ({} as Record<string, unknown>));
  const transactions = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  await ensureInvoicingIndexes(db);
  return { db, transactions };
}

async function ready() {
  if (!cache.ready) {
    cache.ready = connect().catch((error) => {
      cache.ready = undefined;
      throw error instanceof DatabaseUnavailableError
        ? error
        : new DatabaseUnavailableError('MongoDB is unavailable. The request was not saved.');
    });
  }
  return cache.ready;
}

export async function getDb(): Promise<Db> {
  return (await ready()).db;
}

export async function supportsTransactions(): Promise<boolean> {
  return (await ready()).transactions;
}

/**
 * Runs `work` inside a multi-document transaction when the deployment supports
 * it. On a standalone server it runs without one; callers then rely on
 * conditional atomic updates plus explicit compensation (see `Compensator`).
 */
export async function withOptionalTransaction<T>(work: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
  const { transactions } = await ready();
  if (!transactions) return work(undefined);
  const client = await cache.client!;
  const session = client.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result as T;
  } finally {
    await session.endSession();
  }
}
