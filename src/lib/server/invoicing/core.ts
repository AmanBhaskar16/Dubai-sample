import { randomUUID } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { C } from './indexes.mjs';

// Documents are schemaless at the driver level; shapes are enforced by the
// zod validators in validation.ts before anything is written.
// Every document uses a string UUID as `_id` (mirrored in `id`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any> & { _id?: string };

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const conflict = (message: string) => new HttpError(409, message);

export const newId = () => randomUUID();
export const nowIso = () => new Date().toISOString();
export const todayIso = () => new Date().toISOString().slice(0, 10);
export const round2 = (value: number) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
export const EPS = 0.005;

/** Strip Mongo's `_id`; every document also carries the same value as `id`. */
export function toApi<T extends Doc | null | undefined>(doc: T): T {
  if (!doc) return doc;
  const { _id, ...rest } = doc as Doc;
  return { id: rest.id ?? _id, ...rest } as unknown as T;
}

export function addDays(dateIso: string, days: number) {
  const date = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string) {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  return Math.floor((to - from) / 86400000);
}

/**
 * Atomic, gap-tolerant document numbering: one counter document per prefix
 * and year, incremented with `$inc` so concurrent requests never get the same
 * number. Unique indexes on the number fields back this up.
 */
export async function nextNumber(db: Db, prefix: string, session?: ClientSession) {
  const year = String(new Date().getFullYear()).slice(-2);
  const key = `${prefix}-${year}`;
  const counter = await db.collection<{ _id: string; seq: number }>(C.counters).findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 }, $setOnInsert: { prefix, year } },
    { upsert: true, returnDocument: 'after', session },
  );
  return `${prefix}-${year}-${String(counter?.seq ?? 1).padStart(5, '0')}`;
}

export type Actor = { email: string; role: string };

export function actorFrom(request: Request): Actor {
  const email = (request.headers.get('x-actor-email') || '').trim().slice(0, 200);
  return { email: /^[^\s@]+@[^\s@]+$/.test(email) ? email : 'system@local', role: (request.headers.get('x-actor-role') || 'USER').slice(0, 40) };
}

export async function audit(
  db: Db,
  session: ClientSession | undefined,
  actor: Actor,
  entry: { entityType: string; action: string; entityId: string; voucher?: string; message: string; statusBefore?: string; statusAfter?: string; meta?: Doc },
) {
  const id = newId();
  await db.collection(C.auditLogs).insertOne(
    { _id: id as never, id, ...entry, actorEmail: actor.email, actorRole: actor.role, createdAt: nowIso() },
    { session },
  );
  return id;
}

export const ACCOUNTS = {
  bank: { code: '1000', name: 'Bank' },
  receivable: { code: '1100', name: 'Accounts Receivable' },
  taxPayable: { code: '2100', name: 'Tax Payable' },
  advances: { code: '2200', name: 'Customer Advances' },
  revenue: { code: '4000', name: 'Sales Revenue' },
  returns: { code: '4100', name: 'Sales Returns' },
} as const;

export type LedgerLine = { account: { code: string; name: string }; debit?: number; credit?: number; remarks: string };

/**
 * Posts a balanced journal. Throws if debits and credits differ so a bug can
 * never write a one-sided entry.
 */
export async function postLedger(
  db: Db,
  session: ClientSession | undefined,
  voucher: { voucherType: string; voucherNo: string; entityId: string; postingDate: string; currency: string; customerId?: string },
  lines: LedgerLine[],
) {
  const rows = lines
    .map(line => ({ ...line, debit: round2(line.debit || 0), credit: round2(line.credit || 0) }))
    .filter(line => line.debit > 0 || line.credit > 0);
  const debit = round2(rows.reduce((sum, row) => sum + row.debit, 0));
  const credit = round2(rows.reduce((sum, row) => sum + row.credit, 0));
  if (Math.abs(debit - credit) > EPS) throw new HttpError(500, `Unbalanced ledger posting for ${voucher.voucherNo}`);
  if (!rows.length) return [];
  const createdAt = nowIso();
  const docs = rows.map(row => {
    const id = newId();
    return {
      _id: id as never, id, ...voucher, postingDate: voucher.postingDate.slice(0, 10),
      account: row.account, accountId: `${row.account.code} - ${row.account.name}`,
      debit: row.debit, credit: row.credit, remarks: row.remarks, createdAt,
    };
  });
  await db.collection(C.ledger).insertMany(docs, { session });
  return docs.map(doc => doc.id);
}

/**
 * Undo stack for the standalone-MongoDB path (no transactions). Each step
 * registers how to revert itself; on failure the steps are reverted in
 * reverse order. With a replica set the transaction makes this a no-op.
 */
export class Compensator {
  private steps: Array<() => Promise<unknown>> = [];
  constructor(private enabled: boolean) {}
  add(undo: () => Promise<unknown>) {
    if (this.enabled) this.steps.push(undo);
  }
  async rollback() {
    for (const undo of this.steps.reverse()) {
      try { await undo(); } catch (error) { console.error('[invoicing] compensation step failed', (error as Error)?.message); }
    }
    this.steps = [];
  }
}

export function isDuplicateKey(error: unknown) {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function paginateParams(url: URL, defaultLimit = 20) {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') || 1)) || 1);
  const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('limit') || defaultLimit)) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export function pageEnvelope<T>(items: T[], total: number, page: number, limit: number) {
  return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
