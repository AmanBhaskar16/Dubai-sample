import type { Db } from 'mongodb';
import { EPS, daysBetween, escapeRegex, pageEnvelope, paginateParams, round2, toApi, todayIso, type Doc } from './core';
import { C } from './indexes.mjs';
import { decorateInvoices } from './invoices';
import { OPEN_STATUSES, POSTED_STATUSES } from './workflow';

/**
 * All reports read persisted, posted invoices (never drafts or cancelled).
 * Amounts are summed in document currency; pass `currency` to restrict a
 * report to one currency when invoices are issued in several.
 */
async function postedInvoices(db: Db, url: URL, extra: Doc = {}) {
  const query: Doc = { status: { $in: POSTED_STATUSES }, ...extra };
  const fromDate = url.searchParams.get('fromDate');
  const toDate = url.searchParams.get('toDate');
  if (fromDate || toDate) query.date = { ...(fromDate ? { $gte: fromDate.slice(0, 10) } : {}), ...(toDate ? { $lte: toDate.slice(0, 10) } : {}) };
  const customerId = url.searchParams.get('customerId');
  if (customerId) query.customerId = customerId;
  const currency = url.searchParams.get('currency');
  if (currency) query.currency = currency.toUpperCase();
  const search = url.searchParams.get('search')?.trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const customers = await db.collection<Doc>(C.customers).find({ name: pattern }, { projection: { _id: 1 } }).limit(200).toArray();
    query.$or = [{ invoiceNo: pattern }, { 'items.description': pattern }, { 'items.itemCode': pattern }, { customerId: { $in: customers.map(row => row._id) } }];
  }
  return db.collection<Doc>(C.invoices).find(query).sort({ date: 1 }).toArray();
}

function currencies(rows: Doc[]) {
  return [...new Set(rows.map(row => row.currency).filter(Boolean))];
}

export async function agingReport(db: Db, url: URL) {
  const asOf = (url.searchParams.get('asOfDate') || todayIso()).slice(0, 10);
  const rows = (await postedInvoices(db, url, { status: { $in: OPEN_STATUSES }, outstandingAmount: { $gt: EPS } }))
    .filter(row => String(row.date || '') <= asOf);
  const decorated = await decorateInvoices(db, rows);
  const grouped = new Map<string, Doc>();
  for (const invoice of decorated) {
    const key = `${invoice.customerId}:${invoice.currency}`;
    const row = grouped.get(key) || { id: key, customerId: invoice.customerId, customerName: invoice.customer?.name || '-', currency: invoice.currency, invoiceCount: 0, current: 0, days0To30: 0, days31To60: 0, days61To90: 0, days90Plus: 0, totalOutstanding: 0, oldestDueDate: invoice.dueDate };
    const daysLate = invoice.dueDate ? daysBetween(invoice.dueDate, asOf) : 0;
    const amount = Number(invoice.outstandingAmount || 0);
    const bucket = daysLate <= 0 ? 'current' : daysLate <= 30 ? 'days0To30' : daysLate <= 60 ? 'days31To60' : daysLate <= 90 ? 'days61To90' : 'days90Plus';
    row[bucket] = round2(row[bucket] + amount);
    row.invoiceCount += 1;
    row.totalOutstanding = round2(row.totalOutstanding + amount);
    if (invoice.dueDate && (!row.oldestDueDate || invoice.dueDate < row.oldestDueDate)) row.oldestDueDate = invoice.dueDate;
    grouped.set(key, row);
  }
  const data = [...grouped.values()].sort((a, b) => b.totalOutstanding - a.totalOutstanding);
  const totals = data.reduce((sum, row) => ({
    invoiceCount: sum.invoiceCount + row.invoiceCount,
    current: round2(sum.current + row.current), days0To30: round2(sum.days0To30 + row.days0To30), days31To60: round2(sum.days31To60 + row.days31To60),
    days61To90: round2(sum.days61To90 + row.days61To90), days90Plus: round2(sum.days90Plus + row.days90Plus), totalOutstanding: round2(sum.totalOutstanding + row.totalOutstanding),
  }), { invoiceCount: 0, current: 0, days0To30: 0, days31To60: 0, days61To90: 0, days90Plus: 0, totalOutstanding: 0 });
  return { success: true, data, totals: { ...totals, asOfDate: asOf, currencies: currencies(rows) } };
}

export async function outstandingReport(db: Db, url: URL) {
  const today = todayIso();
  const rows = await postedInvoices(db, url, { status: { $in: OPEN_STATUSES }, outstandingAmount: { $gt: EPS } });
  let data = (await decorateInvoices(db, rows)).map((invoice): Doc => {
    const daysOverdue = invoice.dueDate ? Math.max(0, daysBetween(invoice.dueDate, today)) : 0;
    return { ...invoice, daysOverdue, paymentStatus: Number(invoice.amountPaid || 0) > EPS || Number(invoice.creditAmount || 0) > EPS ? 'PARTIAL' : 'UNPAID' };
  });
  if (url.searchParams.get('overdue') === 'true') data = data.filter(row => row.daysOverdue > 0);
  data.sort((a, b) => b.daysOverdue - a.daysOverdue);
  const totals = {
    invoiceCount: data.length,
    outstandingAmount: round2(data.reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0)),
    overdueOutstanding: round2(data.filter(row => row.daysOverdue > 0).reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0)),
    amountPaid: round2(data.reduce((sum, row) => sum + Number(row.amountPaid || 0), 0)),
    currencies: currencies(rows),
  };
  return { success: true, data: { rows: data }, totals };
}

export async function revenueReport(db: Db, url: URL, kind: 'period' | 'customer') {
  const rows = await postedInvoices(db, url);
  const decorated = await decorateInvoices(db, rows);
  const groupBy = url.searchParams.get('groupBy') || 'month';
  const grouped = new Map<string, Doc>();
  for (const invoice of decorated) {
    const date = String(invoice.date || '').slice(0, 10);
    const [year, month] = date.split('-').map(Number);
    const period = groupBy === 'year' ? String(year) : groupBy === 'quarter' ? `${year} Q${Math.floor((month - 1) / 3) + 1}` : date.slice(0, 7);
    const key = kind === 'customer' ? `${invoice.customerId}:${invoice.currency}` : `${period}:${invoice.currency}`;
    const row = grouped.get(key) || { id: key, customerId: kind === 'customer' ? invoice.customerId : undefined, customerName: kind === 'customer' ? invoice.customer?.name || '-' : undefined, period: kind === 'period' ? period : undefined, currency: invoice.currency, invoiceCount: 0, subtotal: 0, taxAmount: 0, grossRevenue: 0, creditAmount: 0, revenue: 0, amountPaid: 0, outstandingAmount: 0, lastInvoiceDate: date };
    row.invoiceCount += 1;
    row.subtotal = round2(row.subtotal + Number(invoice.subtotal || 0));
    row.taxAmount = round2(row.taxAmount + Number(invoice.taxAmount || 0));
    row.grossRevenue = round2(row.grossRevenue + Number(invoice.grandTotal || 0));
    row.creditAmount = round2(row.creditAmount + Number(invoice.creditAmount || 0));
    row.revenue = round2(row.grossRevenue - row.creditAmount);
    row.amountPaid = round2(row.amountPaid + Number(invoice.amountPaid || 0));
    row.outstandingAmount = round2(row.outstandingAmount + Number(invoice.outstandingAmount || 0));
    if (date > row.lastInvoiceDate) row.lastInvoiceDate = date;
    grouped.set(key, row);
  }
  const data = [...grouped.values()].map((row): Doc => ({ ...row, averageInvoiceValue: row.invoiceCount ? round2(row.revenue / row.invoiceCount) : 0 }));
  if (kind === 'customer') data.sort((a, b) => b.revenue - a.revenue); else data.sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const totals = {
    periodCount: kind === 'period' ? new Set(data.map(row => row.period)).size : 0,
    customerCount: kind === 'customer' ? new Set(data.map(row => row.customerId)).size : 0,
    invoiceCount: data.reduce((sum, row) => sum + row.invoiceCount, 0),
    revenue: round2(data.reduce((sum, row) => sum + row.revenue, 0)),
    creditAmount: round2(data.reduce((sum, row) => sum + row.creditAmount, 0)),
    outstandingAmount: round2(data.reduce((sum, row) => sum + row.outstandingAmount, 0)),
    currencies: currencies(rows),
  };
  return { success: true, data: { rows: data }, totals };
}

export async function revenueByItemReport(db: Db, url: URL) {
  const rows = await postedInvoices(db, url);
  const invoiceIds = rows.map(row => row._id);
  const credits = invoiceIds.length ? await db.collection<Doc>(C.creditNotes).find({ status: 'SUBMITTED', originalInvoiceId: { $in: invoiceIds } }).toArray() : [];
  const grouped = new Map<string, Doc & { invoiceIds: Set<string>; customerIds: Set<string> }>();
  const keyOf = (item: Doc, currency: string) => `${item.productId || item.itemCode || item.description || 'unmatched'}:${currency}`;
  const ensure = (item: Doc, currency: string) => {
    const key = keyOf(item, currency);
    const existing = grouped.get(key);
    if (existing) return existing;
    const row = { id: key, productId: item.productId, sku: item.itemCode || '-', name: item.description || 'Item', currency, quantity: 0, creditedQuantity: 0, netAmount: 0, taxAmount: 0, creditAmount: 0, revenue: 0, invoiceIds: new Set<string>(), customerIds: new Set<string>() };
    grouped.set(key, row);
    return row;
  };
  for (const invoice of rows) for (const item of invoice.items || []) {
    const row = ensure(item, invoice.currency);
    const net = Number(item.netAmount ?? Number(item.quantity || 0) * Number(item.unitPrice || 0) * (1 - Number(item.discount || 0) / 100));
    const tax = Number(item.taxAmount ?? (net * Number(item.taxRate || 0)) / 100);
    row.quantity += Number(item.quantity || 0);
    row.netAmount = round2(row.netAmount + net);
    row.taxAmount = round2(row.taxAmount + tax);
    row.invoiceIds.add(String(invoice._id));
    row.customerIds.add(invoice.customerId);
  }
  for (const note of credits) for (const item of note.items || []) {
    const row = ensure(item, note.currency);
    row.creditedQuantity += Number(item.quantity || 0);
    row.creditAmount = round2(row.creditAmount + Number(item.total || 0));
  }
  const data = [...grouped.values()].map(({ invoiceIds, customerIds, ...row }): Doc => ({
    ...row, revenue: round2(row.netAmount + row.taxAmount - row.creditAmount), averageRate: row.quantity ? round2(row.netAmount / row.quantity) : 0,
    invoiceCount: invoiceIds.size, customerCount: customerIds.size,
  })).sort((a, b) => b.revenue - a.revenue);
  return {
    success: true, data: { rows: data },
    totals: { itemCount: data.length, quantity: data.reduce((sum, row) => sum + row.quantity, 0), revenue: round2(data.reduce((sum, row) => sum + row.revenue, 0)), taxAmount: round2(data.reduce((sum, row) => sum + row.taxAmount, 0)), creditAmount: round2(data.reduce((sum, row) => sum + row.creditAmount, 0)), currencies: currencies(rows) },
  };
}

export async function listLedger(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url, 100);
  const query: Doc = {};
  const fromDate = url.searchParams.get('fromDate');
  const toDate = url.searchParams.get('toDate');
  if (fromDate || toDate) query.postingDate = { ...(fromDate ? { $gte: fromDate } : {}), ...(toDate ? { $lte: toDate } : {}) };
  const voucherType = url.searchParams.get('voucherType');
  if (voucherType) query.voucherType = voucherType;
  const account = url.searchParams.get('account');
  if (account) query['account.code'] = account;
  const currency = url.searchParams.get('currency');
  if (currency) query.currency = currency.toUpperCase();
  const search = url.searchParams.get('search')?.trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ voucherNo: pattern }, { remarks: pattern }];
  }
  const ledger = db.collection<Doc>(C.ledger);
  const [rows, total, [sums]] = await Promise.all([
    ledger.find(query).sort({ postingDate: -1, createdAt: -1 }).skip(skip).limit(limit).toArray(),
    ledger.countDocuments(query),
    ledger.aggregate<{ debit: number; credit: number }>([{ $match: query }, { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } }]).toArray(),
  ]);
  return { success: true, data: pageEnvelope(rows.map(toApi), total, page, limit), totals: { debit: round2(sums?.debit || 0), credit: round2(sums?.credit || 0) } };
}

export async function listAuditLogs(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url, 100);
  const query: Doc = {};
  for (const key of ['entityType', 'action', 'entityId'] as const) {
    const value = url.searchParams.get(key);
    if (value) query[key] = value;
  }
  const fromDate = url.searchParams.get('fromDate');
  const toDate = url.searchParams.get('toDate');
  // createdAt is an ISO timestamp; compare on the date prefix range.
  if (fromDate || toDate) query.createdAt = { ...(fromDate ? { $gte: fromDate } : {}), ...(toDate ? { $lt: `${toDate}T99` } : {}) };
  const search = url.searchParams.get('search')?.trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ actorEmail: pattern }, { message: pattern }, { voucher: pattern }];
  }
  const logs = db.collection<Doc>(C.auditLogs);
  const [rows, total] = await Promise.all([
    logs.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    logs.countDocuments(query),
  ]);
  return pageEnvelope(rows.map(toApi), total, page, limit);
}
