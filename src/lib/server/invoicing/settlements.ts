import type { Db } from 'mongodb';
import {
  ACCOUNTS, EPS, audit, badRequest, conflict, escapeRegex, newId, nextNumber, notFound, nowIso, pageEnvelope,
  paginateParams, postLedger, round2, toApi, todayIso, type Actor, type Doc,
} from './core';
import { C } from './indexes.mjs';
import { assertPosted, invoices } from './invoices';
import { priceItems } from './pricing';
import { creditNoteSchema, parse, paymentEntrySchema, paymentSchema } from './validation';
import { OPEN_STATUSES, POSTED_STATUSES, adjustInvoice, runWorkflow } from './workflow';

const payments = (db: Db) => db.collection<Doc>(C.payments);
const entries = (db: Db) => db.collection<Doc>(C.paymentEntries);
const creditNotes = (db: Db) => db.collection<Doc>(C.creditNotes);

async function lookup(db: Db, collection: string, ids: string[], projection: Doc) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, Doc>();
  const rows = await db.collection<Doc>(collection).find({ _id: { $in: unique } }, { projection }).toArray();
  return new Map(rows.map(row => [String(row._id), toApi(row)]));
}

/* ----------------------------------------------------------------------------
 * Direct payments (one receipt -> one invoice)
 * ------------------------------------------------------------------------- */

export async function listPayments(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url);
  const query: Doc = {};
  for (const key of ['invoiceId', 'customerId', 'status', 'method'] as const) {
    const value = url.searchParams.get(key);
    if (value) query[key] = value;
  }
  const search = url.searchParams.get('search')?.trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ paymentNo: pattern }, { reference: pattern }, { invoiceNo: pattern }];
  }
  const fromDate = url.searchParams.get('fromDate');
  const toDate = url.searchParams.get('toDate');
  if (fromDate || toDate) query.date = { ...(fromDate ? { $gte: fromDate } : {}), ...(toDate ? { $lte: toDate } : {}) };
  const [rows, total] = await Promise.all([
    payments(db).find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    payments(db).countDocuments(query),
  ]);
  const [invoiceMap, customerMap] = await Promise.all([
    lookup(db, C.invoices, rows.map(row => row.invoiceId), { invoiceNo: 1, status: 1, outstandingAmount: 1, currency: 1 }),
    lookup(db, C.customers, rows.map(row => row.customerId), { name: 1, customerNo: 1 }),
  ]);
  return pageEnvelope(rows.map(row => ({ ...toApi(row), invoice: invoiceMap.get(row.invoiceId) || null, customer: customerMap.get(row.customerId) || null })), total, page, limit);
}

export async function getPayment(db: Db, paymentId: string) {
  const payment = await payments(db).findOne({ _id: paymentId });
  if (!payment) throw notFound('Payment');
  const [invoice, customer] = await Promise.all([
    invoices(db).findOne({ _id: payment.invoiceId }, { projection: { invoiceNo: 1, status: 1, outstandingAmount: 1, grandTotal: 1, currency: 1 } }),
    db.collection<Doc>(C.customers).findOne({ _id: payment.customerId }, { projection: { name: 1, customerNo: 1 } }),
  ]);
  return { ...toApi(payment), invoice: toApi(invoice), customer: toApi(customer) };
}

export async function recordPayment(db: Db, actor: Actor, body: unknown) {
  const input = parse(paymentSchema, body);
  const invoice = assertPosted(await invoices(db).findOne({ _id: input.invoiceId }), 'record the payment');
  const outstanding = round2(Number(invoice.outstandingAmount || 0));
  const amount = round2(input.amount);
  if (!OPEN_STATUSES.includes(invoice.status) || outstanding <= EPS) throw conflict(`${invoice.invoiceNo} has no outstanding balance (${invoice.status}).`);
  if (amount > outstanding + EPS) {
    throw badRequest(`Overpayment: ${invoice.currency} ${amount.toFixed(2)} exceeds the outstanding ${invoice.currency} ${outstanding.toFixed(2)} on ${invoice.invoiceNo}. Record the exact balance here, and use a Payment Entry to keep the excess as a customer advance.`);
  }
  const date = input.date || todayIso();
  const paymentId = await runWorkflow(async (session, comp) => {
    const updated = await adjustInvoice(db, session, invoice.id, { paid: amount, reduceOutstanding: amount });
    if (!updated) throw conflict(`${invoice.invoiceNo} changed (another payment or credit was applied). Reload to see the current balance.`);
    comp.add(() => adjustInvoice(db, undefined, invoice.id, { paid: -amount, reduceOutstanding: -amount }));
    const id = newId();
    const paymentNo = await nextNumber(db, 'PAY', session);
    const timestamp = nowIso();
    await payments(db).insertOne({
      _id: id, id, paymentNo, type: 'RECEIVED', status: 'POSTED', invoiceId: invoice.id, invoiceNo: invoice.invoiceNo,
      customerId: invoice.customerId, amount, paidAmount: amount, currency: invoice.currency, date, method: input.method,
      reference: input.reference, notes: input.notes, settlement: amount >= outstanding - EPS ? 'EXACT' : 'PARTIAL',
      createdBy: actor.email, createdAt: timestamp, updatedAt: timestamp,
    }, { session });
    comp.add(() => payments(db).deleteOne({ _id: id }));
    const ledgerIds = await postLedger(db, session, { voucherType: 'PAYMENT', voucherNo: paymentNo, entityId: id, postingDate: date, currency: invoice.currency, customerId: invoice.customerId }, [
      { account: ACCOUNTS.bank, debit: amount, remarks: `Receipt ${paymentNo} for ${invoice.invoiceNo} (${input.method})` },
      { account: ACCOUNTS.receivable, credit: amount, remarks: `Receipt ${paymentNo} for ${invoice.invoiceNo}` },
    ]);
    comp.add(() => db.collection(C.ledger).deleteMany({ _id: { $in: ledgerIds as never[] } }));
    await audit(db, session, actor, { entityType: 'PAYMENT', action: 'PAYMENT', entityId: id, voucher: paymentNo, message: `Payment ${paymentNo} of ${invoice.currency} ${amount.toFixed(2)} applied to ${invoice.invoiceNo}; outstanding now ${Number(updated.outstandingAmount).toFixed(2)}`, statusBefore: invoice.status, statusAfter: updated.status, meta: { invoiceId: invoice.id } });
    return id;
  });
  return getPayment(db, paymentId);
}

export async function cancelPayment(db: Db, actor: Actor, paymentId: string, reason?: string) {
  const payment = await payments(db).findOne({ _id: paymentId });
  if (!payment) throw notFound('Payment');
  if (payment.status === 'CANCELLED') throw conflict(`${payment.paymentNo} is already cancelled.`);
  await runWorkflow(async (session, comp) => {
    const claimed = await payments(db).updateOne({ _id: paymentId, status: 'POSTED' }, { $set: { status: 'CANCELLED', cancelledAt: nowIso(), cancelledBy: actor.email, cancelReason: reason, updatedAt: nowIso() } }, { session });
    if (!claimed.modifiedCount) throw conflict('Payment changed while cancelling. Reload and try again.');
    comp.add(() => payments(db).updateOne({ _id: paymentId }, { $set: { status: 'POSTED' }, $unset: { cancelledAt: '', cancelledBy: '', cancelReason: '' } }));
    const updated = await adjustInvoice(db, session, payment.invoiceId, { paid: -payment.amount, reduceOutstanding: -payment.amount });
    if (!updated) throw conflict('The linked invoice is cancelled or missing; the payment cannot be reversed automatically.');
    comp.add(() => adjustInvoice(db, undefined, payment.invoiceId, { paid: payment.amount, reduceOutstanding: payment.amount }));
    const ledgerIds = await postLedger(db, session, { voucherType: 'PAYMENT_REVERSAL', voucherNo: payment.paymentNo, entityId: paymentId, postingDate: todayIso(), currency: payment.currency, customerId: payment.customerId }, [
      { account: ACCOUNTS.receivable, debit: payment.amount, remarks: `Reversal of ${payment.paymentNo}` },
      { account: ACCOUNTS.bank, credit: payment.amount, remarks: `Reversal of ${payment.paymentNo}` },
    ]);
    comp.add(() => db.collection(C.ledger).deleteMany({ _id: { $in: ledgerIds as never[] } }));
    await audit(db, session, actor, { entityType: 'PAYMENT', action: 'CANCEL', entityId: paymentId, voucher: payment.paymentNo, message: `Cancelled ${payment.paymentNo}; ${payment.invoiceNo} outstanding restored to ${Number(updated.outstandingAmount).toFixed(2)}`, statusBefore: 'POSTED', statusAfter: 'CANCELLED' });
  });
  return getPayment(db, paymentId);
}

/* ----------------------------------------------------------------------------
 * Payment entries (one receipt -> many invoice allocations + advance)
 * ------------------------------------------------------------------------- */

async function decorateEntries(db: Db, rows: Doc[]) {
  const customerMap = await lookup(db, C.customers, rows.map(row => row.customerId), { name: 1, customerNo: 1 });
  const invoiceMap = await lookup(db, C.invoices, rows.flatMap(row => (row.allocations || []).map((allocation: Doc) => allocation.invoiceId)), { invoiceNo: 1, status: 1, outstandingAmount: 1 });
  return rows.map(row => ({
    ...toApi(row),
    customer: customerMap.get(row.customerId) || null,
    allocations: (row.allocations || []).map((allocation: Doc) => ({ ...allocation, invoice: invoiceMap.get(allocation.invoiceId) || null })),
  }));
}

export async function listPaymentEntries(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url, 50);
  const query: Doc = {};
  const status = url.searchParams.get('status');
  if (status) query.status = status;
  const customerId = url.searchParams.get('customerId');
  if (customerId) query.customerId = customerId;
  const [rows, total] = await Promise.all([
    entries(db).find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    entries(db).countDocuments(query),
  ]);
  return pageEnvelope(await decorateEntries(db, rows), total, page, limit);
}

export async function getPaymentEntry(db: Db, entryId: string) {
  const entry = await entries(db).findOne({ _id: entryId });
  if (!entry) throw notFound('Payment entry');
  return (await decorateEntries(db, [entry]))[0];
}

async function validateEntry(db: Db, input: ReturnType<typeof paymentEntrySchema.parse>) {
  const customer = await db.collection<Doc>(C.customers).findOne({ _id: input.customerId });
  if (!customer) throw badRequest('Select a valid customer.');
  const seen = new Set<string>();
  let allocated = 0;
  let currency = input.currency;
  for (const allocation of input.allocations) {
    if (seen.has(allocation.invoiceId)) throw badRequest('Each invoice can be allocated only once per payment entry.');
    seen.add(allocation.invoiceId);
    const invoice = assertPosted(await invoices(db).findOne({ _id: allocation.invoiceId }), 'allocate this receipt');
    if (invoice.customerId !== input.customerId) throw badRequest(`${invoice.invoiceNo} belongs to a different customer.`);
    if (!OPEN_STATUSES.includes(invoice.status)) throw conflict(`${invoice.invoiceNo} is already ${invoice.status}.`);
    if (allocation.allocatedAmount > Number(invoice.outstandingAmount || 0) + EPS) throw badRequest(`Allocation to ${invoice.invoiceNo} exceeds its outstanding ${Number(invoice.outstandingAmount).toFixed(2)}.`);
    currency ??= invoice.currency;
    if (invoice.currency !== currency) throw badRequest(`${invoice.invoiceNo} is in ${invoice.currency}; all allocations must use ${currency}.`);
    allocated += allocation.allocatedAmount;
  }
  allocated = round2(allocated);
  if (allocated > input.paidAmount + EPS) throw badRequest(`Allocated total ${allocated.toFixed(2)} cannot exceed the paid amount ${input.paidAmount.toFixed(2)}.`);
  return {
    currency: currency || customer.currency || 'USD',
    allocations: input.allocations.map(allocation => ({ invoiceId: allocation.invoiceId, allocatedAmount: round2(allocation.allocatedAmount) })),
    allocatedAmount: allocated,
    unallocatedAmount: round2(input.paidAmount - allocated),
  };
}

export async function saveDraftPaymentEntry(db: Db, actor: Actor, body: unknown, entryId?: string) {
  const input = parse(paymentEntrySchema, body);
  const derived = await validateEntry(db, input);
  const timestamp = nowIso();
  const fields = { type: 'RECEIVED', customerId: input.customerId, paidAmount: round2(input.paidAmount), method: input.method, reference: input.reference, notes: input.notes, date: input.date || todayIso(), ...derived, updatedAt: timestamp };
  if (entryId) {
    const existing = await entries(db).findOne({ _id: entryId });
    if (!existing) throw notFound('Payment entry');
    await runWorkflow(async session => {
      const result = await entries(db).updateOne({ _id: entryId, status: 'DRAFT' }, { $set: fields }, { session });
      if (!result.matchedCount) throw conflict(`Only draft payment entries can be edited. ${existing.paymentNo} is ${existing.status}.`);
      await audit(db, session, actor, { entityType: 'PAYMENT_ENTRY', action: 'UPDATE', entityId: entryId, voucher: existing.paymentNo, message: `Updated draft ${existing.paymentNo}: paid ${fields.paidAmount.toFixed(2)}, allocated ${derived.allocatedAmount.toFixed(2)}`, statusBefore: 'DRAFT', statusAfter: 'DRAFT' });
    });
    return getPaymentEntry(db, entryId);
  }
  const id = newId();
  await runWorkflow(async (session, comp) => {
    const paymentNo = await nextNumber(db, 'PE', session);
    await entries(db).insertOne({ _id: id, id, paymentNo, status: 'DRAFT', ...fields, createdBy: actor.email, createdAt: timestamp }, { session });
    comp.add(() => entries(db).deleteOne({ _id: id }));
    await audit(db, session, actor, { entityType: 'PAYMENT_ENTRY', action: 'CREATE', entityId: id, voucher: paymentNo, message: `Drafted ${paymentNo}: paid ${fields.paidAmount.toFixed(2)}, allocated ${derived.allocatedAmount.toFixed(2)}`, statusAfter: 'DRAFT' });
  });
  return getPaymentEntry(db, id);
}

export async function changePaymentEntryStatus(db: Db, actor: Actor, entryId: string, body: Doc) {
  const status = String(body?.status || '').toUpperCase();
  const entry = await entries(db).findOne({ _id: entryId });
  if (!entry) throw notFound('Payment entry');
  if (status === 'SUBMITTED') {
    if (entry.status !== 'DRAFT') throw conflict(`Only draft payment entries can be submitted. ${entry.paymentNo} is ${entry.status}.`);
    const derived = await validateEntry(db, parse(paymentEntrySchema, entry));
    await runWorkflow(async (session, comp) => {
      const claimed = await entries(db).updateOne({ _id: entryId, status: 'DRAFT' }, { $set: { status: 'SUBMITTED', ...derived, submittedAt: nowIso(), submittedBy: actor.email, updatedAt: nowIso() } }, { session });
      if (!claimed.modifiedCount) throw conflict('Payment entry changed while submitting. Reload and try again.');
      comp.add(() => entries(db).updateOne({ _id: entryId }, { $set: { status: 'DRAFT' }, $unset: { submittedAt: '', submittedBy: '' } }));
      const notes: string[] = [];
      for (const allocation of derived.allocations) {
        const updated = await adjustInvoice(db, session, allocation.invoiceId, { paid: allocation.allocatedAmount, reduceOutstanding: allocation.allocatedAmount });
        if (!updated) throw conflict('An allocated invoice changed (paid, credited or cancelled). Edit the allocations and try again.');
        comp.add(() => adjustInvoice(db, undefined, allocation.invoiceId, { paid: -allocation.allocatedAmount, reduceOutstanding: -allocation.allocatedAmount }));
        notes.push(`${updated.invoiceNo} ${allocation.allocatedAmount.toFixed(2)} -> ${updated.status}`);
      }
      const ledgerIds = await postLedger(db, session, { voucherType: 'PAYMENT_ENTRY', voucherNo: entry.paymentNo, entityId: entryId, postingDate: entry.date || todayIso(), currency: derived.currency, customerId: entry.customerId }, [
        { account: ACCOUNTS.bank, debit: entry.paidAmount, remarks: `Receipt ${entry.paymentNo} (${entry.method})` },
        { account: ACCOUNTS.receivable, credit: derived.allocatedAmount, remarks: `Allocated from ${entry.paymentNo}` },
        { account: ACCOUNTS.advances, credit: derived.unallocatedAmount, remarks: `Unallocated advance on ${entry.paymentNo}` },
      ]);
      comp.add(() => db.collection(C.ledger).deleteMany({ _id: { $in: ledgerIds as never[] } }));
      await audit(db, session, actor, { entityType: 'PAYMENT_ENTRY', action: 'SUBMIT', entityId: entryId, voucher: entry.paymentNo, message: `Submitted ${entry.paymentNo}: ${notes.join('; ') || 'no allocations'}; advance ${derived.unallocatedAmount.toFixed(2)}`, statusBefore: 'DRAFT', statusAfter: 'SUBMITTED' });
    });
  } else if (status === 'CANCELLED') {
    if (entry.status === 'CANCELLED') throw conflict(`${entry.paymentNo} is already cancelled.`);
    await runWorkflow(async (session, comp) => {
      const claimed = await entries(db).updateOne({ _id: entryId, status: entry.status }, { $set: { status: 'CANCELLED', cancelledAt: nowIso(), cancelledBy: actor.email, updatedAt: nowIso() } }, { session });
      if (!claimed.modifiedCount) throw conflict('Payment entry changed while cancelling. Reload and try again.');
      comp.add(() => entries(db).updateOne({ _id: entryId }, { $set: { status: entry.status }, $unset: { cancelledAt: '', cancelledBy: '' } }));
      if (entry.status === 'SUBMITTED') {
        for (const allocation of entry.allocations || []) {
          const updated = await adjustInvoice(db, session, allocation.invoiceId, { paid: -allocation.allocatedAmount, reduceOutstanding: -allocation.allocatedAmount });
          if (!updated) throw conflict('An allocated invoice is cancelled or missing; reverse it manually.');
          comp.add(() => adjustInvoice(db, undefined, allocation.invoiceId, { paid: allocation.allocatedAmount, reduceOutstanding: allocation.allocatedAmount }));
        }
        const ledgerIds = await postLedger(db, session, { voucherType: 'PAYMENT_ENTRY_REVERSAL', voucherNo: entry.paymentNo, entityId: entryId, postingDate: todayIso(), currency: entry.currency, customerId: entry.customerId }, [
          { account: ACCOUNTS.bank, credit: entry.paidAmount, remarks: `Reversal of ${entry.paymentNo}` },
          { account: ACCOUNTS.receivable, debit: entry.allocatedAmount, remarks: `Reversal of ${entry.paymentNo}` },
          { account: ACCOUNTS.advances, debit: entry.unallocatedAmount, remarks: `Advance reversal of ${entry.paymentNo}` },
        ]);
        comp.add(() => db.collection(C.ledger).deleteMany({ _id: { $in: ledgerIds as never[] } }));
      }
      await audit(db, session, actor, { entityType: 'PAYMENT_ENTRY', action: 'CANCEL', entityId: entryId, voucher: entry.paymentNo, message: `Cancelled ${entry.paymentNo}${entry.status === 'SUBMITTED' ? ' (allocations and ledger reversed)' : ''}`, statusBefore: entry.status, statusAfter: 'CANCELLED' });
    });
  } else {
    throw badRequest('Status must be SUBMITTED or CANCELLED.');
  }
  return getPaymentEntry(db, entryId);
}

/* ----------------------------------------------------------------------------
 * Credit notes
 * ------------------------------------------------------------------------- */

async function decorateCredits(db: Db, rows: Doc[]) {
  const [invoiceMap, customerMap] = await Promise.all([
    lookup(db, C.invoices, rows.map(row => row.originalInvoiceId), { invoiceNo: 1, status: 1, grandTotal: 1, currency: 1, outstandingAmount: 1 }),
    lookup(db, C.customers, rows.map(row => row.customerId), { name: 1, customerNo: 1 }),
  ]);
  return rows.map(row => ({ ...toApi(row), originalInvoice: invoiceMap.get(row.originalInvoiceId) || null, customer: customerMap.get(row.customerId) || null }));
}

export async function listCreditNotes(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url, 50);
  const query: Doc = {};
  for (const key of ['status', 'customerId', 'originalInvoiceId'] as const) {
    const value = url.searchParams.get(key);
    if (value) query[key] = value;
  }
  const [rows, total] = await Promise.all([
    creditNotes(db).find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    creditNotes(db).countDocuments(query),
  ]);
  return pageEnvelope(await decorateCredits(db, rows), total, page, limit);
}

export async function getCreditNote(db: Db, noteId: string) {
  const note = await creditNotes(db).findOne({ _id: noteId });
  if (!note) throw notFound('Credit note');
  return (await decorateCredits(db, [note]))[0];
}

/**
 * Credit limits: the note may not exceed what is still creditable on the
 * invoice (grand total minus submitted credits), and per product it may not
 * credit more quantity than was invoiced minus quantities already credited.
 */
async function priceCredit(db: Db, invoice: Doc, items: ReturnType<typeof creditNoteSchema.parse>['items'], excludeNoteId?: string) {
  const totals = await priceItems(db, items);
  const submitted = await creditNotes(db).find({ originalInvoiceId: invoice.id, status: 'SUBMITTED', ...(excludeNoteId ? { _id: { $ne: excludeNoteId } } : {}) }).toArray();
  const creditable = round2(Number(invoice.grandTotal || 0) - Number(invoice.creditAmount || 0));
  if (totals.total > creditable + EPS) throw badRequest(`Credit total ${totals.total.toFixed(2)} exceeds the remaining creditable value ${creditable.toFixed(2)} on ${invoice.invoiceNo}.`);
  const invoicedQty = new Map<string, number>();
  for (const item of invoice.items || []) if (item.productId) invoicedQty.set(item.productId, (invoicedQty.get(item.productId) || 0) + Number(item.quantity || 0));
  const creditedQty = new Map<string, number>();
  for (const note of submitted) for (const item of note.items || []) if (item.productId) creditedQty.set(item.productId, (creditedQty.get(item.productId) || 0) + Number(item.quantity || 0));
  const requested = new Map<string, number>();
  for (const item of totals.items) if (item.productId) requested.set(item.productId, (requested.get(item.productId) || 0) + item.quantity);
  for (const [productId, quantity] of requested) {
    if (!invoicedQty.has(productId)) throw badRequest(`A credited product is not on ${invoice.invoiceNo}.`);
    const remaining = (invoicedQty.get(productId) || 0) - (creditedQty.get(productId) || 0);
    if (quantity > remaining + 1e-9) {
      const name = totals.items.find(item => item.productId === productId)?.description || productId;
      throw badRequest(`Cannot credit ${quantity} of "${name}": only ${remaining} remain un-credited on ${invoice.invoiceNo}.`);
    }
  }
  return totals;
}

export async function saveDraftCreditNote(db: Db, actor: Actor, body: unknown, options: { invoiceId?: string; noteId?: string }) {
  const input = parse(creditNoteSchema, body);
  let existing: Doc | null = null;
  if (options.noteId) {
    existing = await creditNotes(db).findOne({ _id: options.noteId });
    if (!existing) throw notFound('Credit note');
    if (existing.status !== 'DRAFT') throw conflict(`Only draft credit notes can be edited. ${existing.creditNoteNo} is ${existing.status}.`);
  }
  const invoiceId = existing?.originalInvoiceId || options.invoiceId;
  const invoice = assertPosted(await invoices(db).findOne({ _id: invoiceId }), 'create a credit note');
  const totals = await priceCredit(db, invoice, input.items, options.noteId);
  const timestamp = nowIso();
  const fields = { reason: input.reason, date: input.date || todayIso(), notes: input.notes, ...totals, currency: invoice.currency, updatedAt: timestamp };
  if (existing) {
    await runWorkflow(async session => {
      const result = await creditNotes(db).updateOne({ _id: existing.id, status: 'DRAFT' }, { $set: fields }, { session });
      if (!result.matchedCount) throw conflict('Credit note changed while saving. Reload and try again.');
      await audit(db, session, actor, { entityType: 'CREDIT_NOTE', action: 'UPDATE', entityId: existing.id, voucher: existing.creditNoteNo, message: `Updated draft ${existing.creditNoteNo} (${totals.total.toFixed(2)})`, statusBefore: 'DRAFT', statusAfter: 'DRAFT' });
    });
    return getCreditNote(db, existing.id);
  }
  const id = newId();
  await runWorkflow(async (session, comp) => {
    const creditNoteNo = await nextNumber(db, 'CN', session);
    await creditNotes(db).insertOne({ _id: id, id, creditNoteNo, status: 'DRAFT', originalInvoiceId: invoice.id, originalInvoiceNo: invoice.invoiceNo, customerId: invoice.customerId, ...fields, createdBy: actor.email, createdAt: timestamp }, { session });
    comp.add(() => creditNotes(db).deleteOne({ _id: id }));
    await audit(db, session, actor, { entityType: 'CREDIT_NOTE', action: 'CREATE', entityId: id, voucher: creditNoteNo, message: `Drafted ${creditNoteNo} against ${invoice.invoiceNo} for ${invoice.currency} ${totals.total.toFixed(2)}`, statusAfter: 'DRAFT' });
  });
  return getCreditNote(db, id);
}

export async function changeCreditNoteStatus(db: Db, actor: Actor, noteId: string, body: Doc) {
  const status = String(body?.status || '').toUpperCase();
  const note = await creditNotes(db).findOne({ _id: noteId });
  if (!note) throw notFound('Credit note');
  if (status === 'SUBMITTED') {
    if (note.status !== 'DRAFT') throw conflict(`Only draft credit notes can be submitted. ${note.creditNoteNo} is ${note.status}.`);
    const invoice = assertPosted(await invoices(db).findOne({ _id: note.originalInvoiceId }), 'submit the credit note');
    const totals = await priceCredit(db, invoice, parse(creditNoteSchema, note).items, noteId);
    await runWorkflow(async (session, comp) => {
      const fresh = await invoices(db).findOne({ _id: invoice.id }, { session });
      if (!fresh || !POSTED_STATUSES.includes(fresh.status)) throw conflict('The original invoice is no longer posted.');
      const applied = round2(Math.min(totals.total, Number(fresh.outstandingAmount || 0)));
      const refundable = round2(totals.total - applied);
      const claimed = await creditNotes(db).updateOne({ _id: noteId, status: 'DRAFT' }, { $set: { ...totals, status: 'SUBMITTED', appliedAmount: applied, refundableAmount: refundable, submittedAt: nowIso(), submittedBy: actor.email, updatedAt: nowIso() } }, { session });
      if (!claimed.modifiedCount) throw conflict('Credit note changed while submitting. Reload and try again.');
      comp.add(() => creditNotes(db).updateOne({ _id: noteId }, { $set: { status: 'DRAFT' }, $unset: { submittedAt: '', submittedBy: '', appliedAmount: '', refundableAmount: '' } }));
      const updated = await adjustInvoice(db, session, invoice.id, { credit: totals.total, reduceOutstanding: applied, maxCreditTotal: true });
      if (!updated) throw conflict(`${invoice.invoiceNo} changed (payment or credit applied). Reload and try again.`);
      comp.add(() => adjustInvoice(db, undefined, invoice.id, { credit: -totals.total, reduceOutstanding: -applied }));
      const ledgerIds = await postLedger(db, session, { voucherType: 'CREDIT_NOTE', voucherNo: note.creditNoteNo, entityId: noteId, postingDate: note.date || todayIso(), currency: invoice.currency, customerId: invoice.customerId }, [
        { account: ACCOUNTS.returns, debit: totals.subtotal, remarks: `${note.creditNoteNo} against ${invoice.invoiceNo}` },
        { account: ACCOUNTS.taxPayable, debit: totals.taxAmount, remarks: `Tax reversal ${note.creditNoteNo}` },
        { account: ACCOUNTS.receivable, credit: applied, remarks: `${note.creditNoteNo} applied to ${invoice.invoiceNo}` },
        { account: ACCOUNTS.advances, credit: refundable, remarks: `${note.creditNoteNo} refundable to customer` },
      ]);
      comp.add(() => db.collection(C.ledger).deleteMany({ _id: { $in: ledgerIds as never[] } }));
      await audit(db, session, actor, { entityType: 'CREDIT_NOTE', action: 'SUBMIT', entityId: noteId, voucher: note.creditNoteNo, message: `Submitted ${note.creditNoteNo} (${totals.total.toFixed(2)}) against ${invoice.invoiceNo}: applied ${applied.toFixed(2)}, refundable ${refundable.toFixed(2)}; invoice now ${updated.status}`, statusBefore: 'DRAFT', statusAfter: 'SUBMITTED' });
    });
  } else if (status === 'CANCELLED') {
    if (note.status === 'CANCELLED') throw conflict(`${note.creditNoteNo} is already cancelled.`);
    await runWorkflow(async (session, comp) => {
      const claimed = await creditNotes(db).updateOne({ _id: noteId, status: note.status }, { $set: { status: 'CANCELLED', cancelledAt: nowIso(), cancelledBy: actor.email, updatedAt: nowIso() } }, { session });
      if (!claimed.modifiedCount) throw conflict('Credit note changed while cancelling. Reload and try again.');
      comp.add(() => creditNotes(db).updateOne({ _id: noteId }, { $set: { status: note.status }, $unset: { cancelledAt: '', cancelledBy: '' } }));
      if (note.status === 'SUBMITTED') {
        const applied = Number(note.appliedAmount || 0);
        const refundable = Number(note.refundableAmount || 0);
        const updated = await adjustInvoice(db, session, note.originalInvoiceId, { credit: -note.grandTotal, reduceOutstanding: -applied });
        if (!updated) throw conflict('The original invoice is cancelled or missing; the credit cannot be reversed automatically.');
        comp.add(() => adjustInvoice(db, undefined, note.originalInvoiceId, { credit: note.grandTotal, reduceOutstanding: applied }));
        const ledgerIds = await postLedger(db, session, { voucherType: 'CREDIT_NOTE_REVERSAL', voucherNo: note.creditNoteNo, entityId: noteId, postingDate: todayIso(), currency: note.currency, customerId: note.customerId }, [
          { account: ACCOUNTS.returns, credit: note.subtotal, remarks: `Reversal of ${note.creditNoteNo}` },
          { account: ACCOUNTS.taxPayable, credit: note.taxAmount, remarks: `Tax reversal of ${note.creditNoteNo}` },
          { account: ACCOUNTS.receivable, debit: applied, remarks: `Reversal of ${note.creditNoteNo}` },
          { account: ACCOUNTS.advances, debit: refundable, remarks: `Reversal of ${note.creditNoteNo}` },
        ]);
        comp.add(() => db.collection(C.ledger).deleteMany({ _id: { $in: ledgerIds as never[] } }));
      }
      await audit(db, session, actor, { entityType: 'CREDIT_NOTE', action: 'CANCEL', entityId: noteId, voucher: note.creditNoteNo, message: `Cancelled ${note.creditNoteNo}${note.status === 'SUBMITTED' ? ' (invoice balance and ledger restored)' : ''}`, statusBefore: note.status, statusAfter: 'CANCELLED' });
    });
  } else {
    throw badRequest('Status must be SUBMITTED or CANCELLED.');
  }
  return getCreditNote(db, noteId);
}
