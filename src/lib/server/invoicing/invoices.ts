import type { ClientSession, Db } from 'mongodb';
import {
  ACCOUNTS, Compensator, EPS, HttpError, addDays, audit, badRequest, conflict, escapeRegex, isDuplicateKey, newId, nextNumber,
  notFound, nowIso, pageEnvelope, paginateParams, postLedger, round2, toApi, todayIso, type Actor, type Doc,
} from './core';
import { C } from './indexes.mjs';
import { priceItems } from './pricing';
import { invoiceCreateSchema, invoiceUpdateSchema, parse } from './validation';
import { OPEN_STATUSES, POSTED_STATUSES, runWorkflow } from './workflow';

export const invoices = (db: Db) => db.collection<Doc>(C.invoices);

export function isOverdue(invoice: Doc, asOf = todayIso()) {
  return OPEN_STATUSES.includes(invoice.status) && Number(invoice.outstandingAmount || 0) > EPS && !!invoice.dueDate && String(invoice.dueDate).slice(0, 10) < asOf;
}

async function customersById(db: Db, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, Doc>();
  const rows = await db.collection<Doc>(C.customers).find({ _id: { $in: unique } }).toArray();
  return new Map(rows.map(row => [String(row._id), toApi(row)]));
}

/** List view: invoice + customer summary + derived overdue flag. */
export async function decorateInvoices(db: Db, rows: Doc[]): Promise<Doc[]> {
  const customers = await customersById(db, rows.map(row => row.customerId));
  return rows.map(row => {
    const customer = customers.get(row.customerId);
    return { ...toApi(row), customer: customer ? { id: customer.id, name: customer.name, customerNo: customer.customerNo, email: customer.email, currency: customer.currency } : null, isOverdue: isOverdue(row) };
  });
}

/** Detail view: adds full customer, payments, allocations and credit notes. */
export async function invoiceDetail(db: Db, invoiceId: string): Promise<Doc> {
  const invoice = await invoices(db).findOne({ _id: invoiceId });
  if (!invoice) throw notFound('Invoice');
  const [decorated] = await decorateInvoices(db, [invoice]);
  const [customer, payments, entries, creditNotes] = await Promise.all([
    db.collection<Doc>(C.customers).findOne({ _id: invoice.customerId }),
    db.collection<Doc>(C.payments).find({ invoiceId }).sort({ createdAt: -1 }).toArray(),
    db.collection<Doc>(C.paymentEntries).find({ 'allocations.invoiceId': invoiceId, status: { $in: ['SUBMITTED', 'CANCELLED'] } }).sort({ createdAt: -1 }).toArray(),
    db.collection<Doc>(C.creditNotes).find({ originalInvoiceId: invoiceId }).sort({ createdAt: -1 }).toArray(),
  ]);
  const paymentAllocations = entries.flatMap(entry => (entry.allocations || [])
    .filter((allocation: Doc) => allocation.invoiceId === invoiceId)
    .map((allocation: Doc) => ({ ...allocation, paymentEntry: { id: entry.id, paymentNo: entry.paymentNo, date: entry.date, method: entry.method, reference: entry.reference, status: entry.status } })));
  return {
    ...decorated,
    customer: toApi(customer),
    payments: payments.map(toApi),
    paymentAllocations,
    creditNotes: creditNotes.map(note => ({ id: note.id, creditNoteNo: note.creditNoteNo, status: note.status, grandTotal: note.grandTotal, date: note.date })),
  };
}

export async function listInvoices(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url);
  const query: Doc = {};
  const and: Doc[] = [];
  const status = url.searchParams.get('status');
  const today = todayIso();
  if (status === 'OVERDUE') and.push({ status: { $in: OPEN_STATUSES }, outstandingAmount: { $gt: EPS }, dueDate: { $lt: today } });
  else if (status === 'OPEN' || status === 'UNPAID') and.push({ status: { $in: OPEN_STATUSES }, outstandingAmount: { $gt: EPS } });
  else if (status) and.push({ status });
  const savedFilter = url.searchParams.get('savedFilter');
  if (savedFilter === 'not_cancelled') and.push({ status: { $ne: 'CANCELLED' } });
  if (savedFilter === 'outstanding') and.push({ outstandingAmount: { $gt: EPS }, status: { $in: OPEN_STATUSES } });
  const customerId = url.searchParams.get('customerId');
  if (customerId) and.push({ customerId });
  const createdOn = url.searchParams.get('createdOn');
  if (createdOn) and.push({ date: createdOn.slice(0, 10) });
  const tag = url.searchParams.get('tag');
  if (tag) and.push({ tags: tag });
  if (url.searchParams.get('hasTags') === 'true') and.push({ 'tags.0': { $exists: true } });
  const search = url.searchParams.get('search')?.trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const matchingCustomers = await db.collection<Doc>(C.customers).find({ name: pattern }, { projection: { _id: 1 } }).limit(200).toArray();
    and.push({ $or: [{ invoiceNo: pattern }, { reference: pattern }, { customerPoNo: pattern }, { customerId: { $in: matchingCustomers.map(row => row._id) } }] });
  }
  if (and.length) query.$and = and;
  const [rows, total] = await Promise.all([
    invoices(db).find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    invoices(db).countDocuments(query),
  ]);
  return pageEnvelope(await decorateInvoices(db, rows), total, page, limit);
}

async function activeCustomer(db: Db, customerId: string, session?: ClientSession) {
  const customer = await db.collection<Doc>(C.customers).findOne({ _id: customerId }, { session });
  if (!customer) throw badRequest('Select a valid customer.');
  if (customer.isActive === false) throw badRequest(`Customer "${customer.name}" is inactive.`);
  return customer;
}

type InvoiceSource = { deliveryNoteId?: string; salesOrderId?: string; subscriptionId?: string; subscriptionRunKey?: string; amendedFromId?: string };

/** Creates a DRAFT invoice from already-validated input. */
export async function insertDraftInvoice(
  db: Db, session: ClientSession | undefined, actor: Actor,
  input: ReturnType<typeof invoiceCreateSchema.parse>, source: InvoiceSource = {}, auditAction = 'CREATE',
) {
  await activeCustomer(db, input.customerId, session);
  const totals = await priceItems(db, input.items, session);
  const id = newId();
  const invoiceNo = await nextNumber(db, 'INV', session);
  const timestamp = nowIso();
  const doc: Doc = {
    _id: id, id, invoiceNo, ...input, ...totals, ...source,
    ...(source.deliveryNoteId ? { deliveryNoteLock: source.deliveryNoteId } : {}),
    ...(source.salesOrderId && auditAction === 'CREATE_FROM_SALES_ORDER' ? { salesOrderLock: source.salesOrderId } : {}),
    status: 'DRAFT', amountPaid: 0, creditAmount: 0, outstandingAmount: totals.total,
    createdBy: actor.email, createdAt: timestamp, updatedAt: timestamp,
  };
  await invoices(db).insertOne(doc, { session });
  await audit(db, session, actor, {
    entityType: 'SALES_INVOICE', action: auditAction, entityId: id, voucher: invoiceNo,
    message: `${auditAction === 'CREATE' ? 'Created' : auditAction.replaceAll('_', ' ').toLowerCase()} draft ${invoiceNo} for ${input.currency} ${totals.total.toFixed(2)}`,
    statusAfter: 'DRAFT',
  });
  return doc;
}

export async function createInvoice(db: Db, actor: Actor, body: unknown) {
  const input = parse(invoiceCreateSchema, body);
  const doc = await runWorkflow(async (session, comp) => {
    const created = await insertDraftInvoice(db, session, actor, input);
    comp.add(() => invoices(db).deleteOne({ _id: created.id }));
    return created;
  });
  return invoiceDetail(db, doc.id);
}

export async function updateDraftInvoice(db: Db, actor: Actor, invoiceId: string, body: unknown) {
  const existing = await invoices(db).findOne({ _id: invoiceId });
  if (!existing) throw notFound('Invoice');
  if (existing.status !== 'DRAFT') throw conflict(`Only draft invoices can be edited. ${existing.invoiceNo} is ${existing.status}.`);
  const patch = parse(invoiceUpdateSchema, body);
  const merged = { ...existing, ...patch };
  if (merged.dueDate && merged.date && merged.dueDate < merged.date) throw badRequest('Due date cannot be before the invoice date');
  if (merged.grossWeight != null && merged.netWeight != null && merged.netWeight > merged.grossWeight) throw badRequest('Net weight cannot exceed gross weight');
  if (patch.customerId) await activeCustomer(db, patch.customerId);
  const totals = await priceItems(db, patch.items || existing.items || []);
  const set: Doc = { ...patch, ...totals, outstandingAmount: totals.total, updatedAt: nowIso(), updatedBy: actor.email };
  const unset: Doc = {};
  // Explicitly cleared optional numeric/text fields arrive as '' -> undefined.
  for (const key of ['dueDate', 'grossWeight', 'netWeight', 'packageCount', 'reference', 'customerPoNo', 'shipmentReference', 'portOfDischarge', 'incoterms', 'notes', 'terms'] as const) {
    if (body && typeof body === 'object' && key in (body as Doc) && (patch as Doc)[key] === undefined) { unset[key] = ''; delete set[key]; }
  }
  for (const key of Object.keys(set)) if (set[key] === undefined) delete set[key];
  await runWorkflow(async session => {
    const result = await invoices(db).updateOne({ _id: invoiceId, status: 'DRAFT' }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { session });
    if (!result.matchedCount) throw conflict('The invoice was submitted or cancelled by someone else. Reload and try again.');
    await audit(db, session, actor, { entityType: 'SALES_INVOICE', action: 'UPDATE', entityId: invoiceId, voucher: existing.invoiceNo, message: `Updated draft ${existing.invoiceNo} (total ${existing.currency} ${totals.total.toFixed(2)})`, statusBefore: 'DRAFT', statusAfter: 'DRAFT' });
  });
  return invoiceDetail(db, invoiceId);
}

/** DRAFT -> SUBMITTED: locks the document, sets the receivable, posts the ledger. */
export async function submitInvoice(db: Db, session: ClientSession | undefined, actor: Actor, invoiceId: string, comp?: Compensator) {
  const invoice = await invoices(db).findOne({ _id: invoiceId }, { session });
  if (!invoice) throw notFound('Invoice');
  if (invoice.status !== 'DRAFT') throw conflict(`Only draft invoices can be submitted. ${invoice.invoiceNo} is ${invoice.status}.`);
  if (!invoice.items?.length) throw badRequest('Add line items before submitting this invoice.');
  if (!(Number(invoice.grandTotal) > 0)) throw badRequest('Invoice total must be greater than zero to submit.');
  const customer = await activeCustomer(db, invoice.customerId, session);
  // Re-price so a template/product change since drafting is reflected.
  const totals = await priceItems(db, invoice.items, session);
  const creditLimit = Number(customer.creditLimit || 0);
  if (creditLimit > 0) {
    const [open] = await invoices(db).aggregate<{ total: number }>([
      { $match: { customerId: invoice.customerId, status: { $in: OPEN_STATUSES }, currency: invoice.currency } },
      { $group: { _id: null, total: { $sum: '$outstandingAmount' } } },
    ], { session }).toArray();
    const exposure = round2((open?.total || 0) + totals.total);
    if (exposure > creditLimit + EPS) {
      throw badRequest(`Credit limit exceeded for ${customer.name}: open balance ${round2(open?.total || 0).toFixed(2)} + this invoice ${totals.total.toFixed(2)} > limit ${creditLimit.toFixed(2)} ${invoice.currency}.`);
    }
  }
  const dueDate = invoice.dueDate || addDays(invoice.date || todayIso(), Number(customer.paymentTerms ?? 30));
  const submittedAt = nowIso();
  const result = await invoices(db).updateOne(
    { _id: invoiceId, status: 'DRAFT' },
    { $set: { ...totals, status: 'SUBMITTED', dueDate, amountPaid: 0, creditAmount: 0, outstandingAmount: totals.total, submittedAt, submittedBy: actor.email, updatedAt: submittedAt } },
    { session },
  );
  if (!result.modifiedCount) throw conflict('The invoice changed while submitting. Reload and try again.');
  comp?.add(() => invoices(db).updateOne({ _id: invoiceId, status: 'SUBMITTED' }, { $set: { status: 'DRAFT', updatedAt: nowIso() }, $unset: { submittedAt: '', submittedBy: '' } }));
  const ledgerIds = await postLedger(db, session, { voucherType: 'SALES_INVOICE', voucherNo: invoice.invoiceNo, entityId: invoiceId, postingDate: invoice.date || todayIso(), currency: invoice.currency, customerId: invoice.customerId }, [
    { account: ACCOUNTS.receivable, debit: totals.total, remarks: `Invoice ${invoice.invoiceNo} - ${customer.name}` },
    { account: ACCOUNTS.revenue, credit: totals.subtotal, remarks: `Invoice ${invoice.invoiceNo}` },
    { account: ACCOUNTS.taxPayable, credit: totals.taxAmount, remarks: `Output tax on ${invoice.invoiceNo}` },
  ]);
  comp?.add(() => db.collection(C.ledger).deleteMany({ _id: { $in: ledgerIds as never[] } }));
  await audit(db, session, actor, { entityType: 'SALES_INVOICE', action: 'SUBMIT', entityId: invoiceId, voucher: invoice.invoiceNo, message: `Submitted ${invoice.invoiceNo} for ${invoice.currency} ${totals.total.toFixed(2)}, due ${dueDate}`, statusBefore: 'DRAFT', statusAfter: 'SUBMITTED' });
}

export async function cancelInvoice(db: Db, session: ClientSession | undefined, actor: Actor, invoiceId: string, reason?: string, comp?: Compensator) {
  const invoice = await invoices(db).findOne({ _id: invoiceId }, { session });
  if (!invoice) throw notFound('Invoice');
  if (invoice.status === 'CANCELLED') throw conflict(`${invoice.invoiceNo} is already cancelled.`);
  if (invoice.status !== 'DRAFT' && invoice.status !== 'SUBMITTED') {
    throw conflict(`${invoice.invoiceNo} has payments or credits applied (${invoice.status}). Cancel those payments, or issue a credit note, instead of cancelling the invoice.`);
  }
  const cancelledAt = nowIso();
  const result = await invoices(db).updateOne(
    { _id: invoiceId, status: invoice.status, amountPaid: { $not: { $gt: EPS } } },
    { $set: { status: 'CANCELLED', outstandingAmount: 0, cancelledAt, cancelledBy: actor.email, cancelReason: reason, updatedAt: cancelledAt }, $unset: { deliveryNoteLock: '', salesOrderLock: '' } },
    { session },
  );
  if (!result.modifiedCount) throw conflict('The invoice changed while cancelling. Reload and try again.');
  comp?.add(() => invoices(db).updateOne({ _id: invoiceId, status: 'CANCELLED' }, {
    $set: { status: invoice.status, outstandingAmount: invoice.outstandingAmount, updatedAt: nowIso(), ...(invoice.deliveryNoteLock ? { deliveryNoteLock: invoice.deliveryNoteLock } : {}), ...(invoice.salesOrderLock ? { salesOrderLock: invoice.salesOrderLock } : {}) },
    $unset: { cancelledAt: '', cancelledBy: '', cancelReason: '' },
  }));
  if (invoice.status === 'SUBMITTED') {
    const reversalIds = await postLedger(db, session, { voucherType: 'INVOICE_REVERSAL', voucherNo: invoice.invoiceNo, entityId: invoiceId, postingDate: todayIso(), currency: invoice.currency, customerId: invoice.customerId }, [
      { account: ACCOUNTS.receivable, credit: invoice.grandTotal, remarks: `Reversal of ${invoice.invoiceNo}` },
      { account: ACCOUNTS.revenue, debit: invoice.subtotal, remarks: `Reversal of ${invoice.invoiceNo}` },
      { account: ACCOUNTS.taxPayable, debit: invoice.taxAmount, remarks: `Tax reversal of ${invoice.invoiceNo}` },
    ]);
    comp?.add(() => db.collection(C.ledger).deleteMany({ _id: { $in: reversalIds as never[] } }));
  }
  if (invoice.deliveryNoteId) {
    await db.collection(C.deliveryNotes).updateOne({ _id: invoice.deliveryNoteId, invoiceId }, { $set: { status: 'SUBMITTED', updatedAt: cancelledAt }, $unset: { invoiceId: '', invoiceNo: '' } }, { session });
  }
  await audit(db, session, actor, { entityType: 'SALES_INVOICE', action: 'CANCEL', entityId: invoiceId, voucher: invoice.invoiceNo, message: `Cancelled ${invoice.invoiceNo}${reason ? `: ${reason}` : ''}${invoice.status === 'SUBMITTED' ? ' (ledger reversed)' : ''}`, statusBefore: invoice.status, statusAfter: 'CANCELLED' });
}

export async function changeInvoiceStatus(db: Db, actor: Actor, invoiceId: string, body: Doc) {
  const status = String(body?.status || '').toUpperCase();
  if (status === 'SUBMITTED') await runWorkflow((session, comp) => submitInvoice(db, session, actor, invoiceId, comp));
  else if (status === 'CANCELLED') await runWorkflow((session, comp) => cancelInvoice(db, session, actor, invoiceId, typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined, comp));
  else throw badRequest('Status must be SUBMITTED or CANCELLED. Paid/partial statuses are set by payments and credit notes.');
  return invoiceDetail(db, invoiceId);
}

export async function amendInvoice(db: Db, actor: Actor, invoiceId: string) {
  const original = await invoices(db).findOne({ _id: invoiceId });
  if (!original) throw notFound('Invoice');
  if (original.status !== 'CANCELLED') throw conflict('Only cancelled invoices can be amended.');
  if (original.amendedToId) throw conflict(`${original.invoiceNo} was already amended. Open the amended draft instead.`);
  const input = parse(invoiceCreateSchema, {
    ...original, items: (original.items || []).map((item: Doc) => ({ ...item, taxTemplateId: item.taxTemplateId })),
    dueDate: original.dueDate && original.dueDate >= todayIso() ? original.dueDate : undefined, date: todayIso(),
  });
  try {
    const doc = await runWorkflow(async (session, comp) => {
      const amended = await insertDraftInvoice(db, session, actor, input, {
        amendedFromId: original.id, salesOrderId: original.salesOrderId, deliveryNoteId: undefined,
      }, 'AMEND');
      comp.add(() => invoices(db).deleteOne({ _id: amended.id }));
      await invoices(db).updateOne({ _id: invoiceId }, { $set: { amendedToId: amended.id, amendedToNo: amended.invoiceNo, updatedAt: nowIso() } }, { session });
      return amended;
    });
    return invoiceDetail(db, doc.id);
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict(`${original.invoiceNo} was already amended.`);
    throw error;
  }
}

export async function customerOutstanding(db: Db, customerId: string) {
  const rows = await invoices(db).find({ customerId, status: { $in: OPEN_STATUSES }, outstandingAmount: { $gt: EPS } }).sort({ dueDate: 1 }).toArray();
  return { outstandingAmount: round2(rows.reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0)), invoices: await decorateInvoices(db, rows) };
}

export function assertPosted(invoice: Doc | null, action: string) {
  if (!invoice) throw notFound('Invoice');
  if (invoice.status === 'DRAFT') throw new HttpError(409, `${invoice.invoiceNo} is still a draft. Submit the invoice first, then ${action}.`, { code: 'INVOICE_DRAFT', invoiceId: invoice.id });
  if (invoice.status === 'CANCELLED') throw conflict(`${invoice.invoiceNo} is cancelled.`);
  if (!POSTED_STATUSES.includes(invoice.status)) throw conflict(`${invoice.invoiceNo} is ${invoice.status}.`);
  return invoice;
}
