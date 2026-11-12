import type { ClientSession, Db } from 'mongodb';
import { supportsTransactions, withOptionalTransaction } from '../mongo';
import { Compensator, EPS, nowIso, type Doc } from './core';
import { C } from './indexes.mjs';

/**
 * Runs a multi-document workflow atomically.
 * Replica set / Atlas: one MongoDB transaction (all-or-nothing).
 * Standalone mongod: no transactions exist, so every state change is a
 * guarded conditional update and registers an undo step; on error the undo
 * steps run in reverse. This keeps balances consistent in practice, but it is
 * not crash-proof - use a replica set in production (see README-INVOICING).
 */
export async function runWorkflow<T>(work: (session: ClientSession | undefined, comp: Compensator) => Promise<T>): Promise<T> {
  const transactional = await supportsTransactions();
  const comp = new Compensator(!transactional);
  try {
    return await withOptionalTransaction(session => work(session, comp));
  } catch (error) {
    await comp.rollback();
    throw error;
  }
}

/** Statuses an invoice can be in while money can still be applied to it. */
export const OPEN_STATUSES = ['SUBMITTED', 'PARTIAL'];
/** Statuses that represent a posted (non-draft, non-cancelled) invoice. */
export const POSTED_STATUSES = ['SUBMITTED', 'PARTIAL', 'PAID', 'CREDITED'];

/** Aggregation stage that derives the invoice status from its balances. */
const deriveStatus = {
  $set: {
    status: {
      $cond: [
        { $lte: ['$outstandingAmount', EPS] },
        { $cond: [{ $gt: ['$amountPaid', EPS] }, 'PAID', 'CREDITED'] },
        { $cond: [{ $or: [{ $gt: ['$amountPaid', EPS] }, { $gt: ['$creditAmount', EPS] }] }, 'PARTIAL', 'SUBMITTED'] },
      ],
    },
  },
};

/**
 * Atomically adjusts an invoice's paid / credited / outstanding balances and
 * re-derives its status in a single pipeline update. The filter guarantees an
 * application can never exceed the outstanding balance (no lost updates even
 * without transactions). Returns the updated invoice or null if the guard
 * failed.
 */
export async function adjustInvoice(
  db: Db,
  session: ClientSession | undefined,
  invoiceId: string,
  change: { paid?: number; credit?: number; reduceOutstanding?: number; maxCreditTotal?: boolean },
) {
  const paid = change.paid || 0;
  const credit = change.credit || 0;
  const reduce = change.reduceOutstanding || 0;
  const filter: Doc = { _id: invoiceId, status: { $in: reduce > 0 ? OPEN_STATUSES : POSTED_STATUSES } };
  if (reduce > 0) filter.outstandingAmount = { $gte: reduce - EPS };
  if (change.maxCreditTotal && credit > 0) {
    filter.$expr = { $lte: [{ $add: [{ $ifNull: ['$creditAmount', 0] }, credit] }, { $add: ['$grandTotal', EPS] }] };
  }
  return db.collection<Doc>(C.invoices).findOneAndUpdate(
    filter,
    [
      {
        $set: {
          amountPaid: { $round: [{ $add: [{ $ifNull: ['$amountPaid', 0] }, paid] }, 2] },
          creditAmount: { $round: [{ $add: [{ $ifNull: ['$creditAmount', 0] }, credit] }, 2] },
          outstandingAmount: { $round: [{ $max: [0, { $subtract: [{ $ifNull: ['$outstandingAmount', 0] }, reduce] }] }, 2] },
          updatedAt: nowIso(),
        },
      },
      deriveStatus,
    ],
    { returnDocument: 'after', session },
  );
}
