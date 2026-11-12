import type { Db } from 'mongodb';
import {
  addDays, audit, badRequest, conflict, escapeRegex, isDuplicateKey, newId, nextNumber, notFound, nowIso,
  pageEnvelope, paginateParams, toApi, todayIso, type Actor, type Doc,
} from './core';
import { C } from './indexes.mjs';
import { insertDraftInvoice, invoiceDetail, invoices, submitInvoice } from './invoices';
import { priceItems } from './pricing';
import {
  customerSchema, deliveryNoteSchema, invoiceCreateSchema, parse, printFormatSchema, productSchema, SALES_ORDER_STATUSES,
  salesOrderSchema, subscriptionSchema, taxTemplateSchema, warehouseSchema,
} from './validation';
import { runWorkflow } from './workflow';

const col = (db: Db, name: string) => db.collection<Doc>(name);
const PROTECTED_KEYS = ['_id', 'id', 'createdAt', 'createdBy', 'customerNo', 'status'];
function clean(input: Doc) {
  const out: Doc = {};
  for (const [key, value] of Object.entries(input)) if (!PROTECTED_KEYS.includes(key) && value !== undefined) out[key] = value;
  return out;
}

function duplicateMessage(error: unknown, message: string): never {
  if (isDuplicateKey(error)) throw conflict(message);
  throw error;
}

async function byIds(db: Db, collection: string, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, Doc>();
  const rows = await col(db, collection).find({ _id: { $in: unique } }).toArray();
  return new Map(rows.map(row => [String(row._id), toApi(row)]));
}

/* ----------------------------------------------------------------------------
 * Master data used by invoicing: customers, products, warehouses, sales orders
 * ------------------------------------------------------------------------- */

export async function listCustomers(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url);
  const query: Doc = {};
  if (url.searchParams.get('includeInactive') !== 'true') query.isActive = { $ne: false };
  const search = url.searchParams.get('search')?.trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ name: pattern }, { customerNo: pattern }, { email: pattern }];
  }
  const [rows, total] = await Promise.all([
    col(db, C.customers).find(query).sort({ name: 1 }).skip(skip).limit(limit).toArray(),
    col(db, C.customers).countDocuments(query),
  ]);
  return pageEnvelope(rows.map(toApi), total, page, limit);
}

export async function saveCustomer(db: Db, actor: Actor, body: unknown, customerId?: string) {
  const timestamp = nowIso();
  if (customerId) {
    const existing = await col(db, C.customers).findOne({ _id: customerId });
    if (!existing) throw notFound('Customer');
    const input = clean(parse(customerSchema, { ...toApi(existing), ...(body as Doc) }));
    await col(db, C.customers).updateOne({ _id: customerId }, { $set: { ...input, updatedAt: timestamp } });
    return toApi(await col(db, C.customers).findOne({ _id: customerId }));
  }
  const input = clean(parse(customerSchema, body));
  const id = newId();
  const customerNo = await nextNumber(db, 'CUS');
  await col(db, C.customers).insertOne({ _id: id, id, customerNo, ...input, isActive: input.isActive ?? true, createdBy: actor.email, createdAt: timestamp, updatedAt: timestamp });
  return toApi(await col(db, C.customers).findOne({ _id: id }));
}

export async function listProducts(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url);
  const query: Doc = {};
  if (url.searchParams.get('isActive') !== 'false' && url.searchParams.get('includeInactive') !== 'true') query.isActive = { $ne: false };
  const search = (url.searchParams.get('search') || url.searchParams.get('q'))?.trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ name: pattern }, { sku: pattern }];
  }
  const [rows, total] = await Promise.all([
    col(db, C.products).find(query).sort({ name: 1 }).skip(skip).limit(limit).toArray(),
    col(db, C.products).countDocuments(query),
  ]);
  const templates = await byIds(db, C.taxTemplates, rows.map(row => row.defaultTaxTemplateId));
  const items = rows.map(row => ({ ...toApi(row), defaultTaxTemplate: row.defaultTaxTemplateId ? templates.get(row.defaultTaxTemplateId) || null : null }));
  return pageEnvelope(items, total, page, limit);
}

export async function saveProduct(db: Db, body: unknown, productId?: string) {
  const timestamp = nowIso();
  if (productId) {
    const existing = await col(db, C.products).findOne({ _id: productId });
    if (!existing) throw notFound('Product');
    const input = clean(parse(productSchema, { ...toApi(existing), ...(body as Doc) }));
    if (input.defaultTaxTemplateId && !(await col(db, C.taxTemplates).findOne({ _id: input.defaultTaxTemplateId }))) throw badRequest('Default tax template not found.');
    try { await col(db, C.products).updateOne({ _id: productId }, { $set: { ...input, updatedAt: timestamp } }); } catch (error) { duplicateMessage(error, `SKU "${input.sku}" is already used by another product.`); }
    return toApi(await col(db, C.products).findOne({ _id: productId }));
  }
  const input = clean(parse(productSchema, body));
  if (input.defaultTaxTemplateId && !(await col(db, C.taxTemplates).findOne({ _id: input.defaultTaxTemplateId }))) throw badRequest('Default tax template not found.');
  const id = newId();
  const sku = input.sku || (await nextNumber(db, 'SKU'));
  try {
    await col(db, C.products).insertOne({ _id: id, id, ...input, sku, isActive: input.isActive ?? true, createdAt: timestamp, updatedAt: timestamp });
  } catch (error) { duplicateMessage(error, `SKU "${sku}" already exists.`); }
  return toApi(await col(db, C.products).findOne({ _id: id }));
}

export async function listWarehouses(db: Db) {
  return (await col(db, C.warehouses).find({}).sort({ name: 1 }).toArray()).map(toApi);
}

export async function saveWarehouse(db: Db, body: unknown, warehouseId?: string) {
  const timestamp = nowIso();
  if (warehouseId) {
    const existing = await col(db, C.warehouses).findOne({ _id: warehouseId });
    if (!existing) throw notFound('Warehouse');
    const input = clean(parse(warehouseSchema, { ...toApi(existing), ...(body as Doc) }));
    try { await col(db, C.warehouses).updateOne({ _id: warehouseId }, { $set: { ...input, updatedAt: timestamp } }); } catch (error) { duplicateMessage(error, 'Warehouse code already exists.'); }
    return toApi(await col(db, C.warehouses).findOne({ _id: warehouseId }));
  }
  const input = clean(parse(warehouseSchema, body));
  const id = newId();
  try { await col(db, C.warehouses).insertOne({ _id: id, id, ...input, isActive: input.isActive ?? true, createdAt: timestamp, updatedAt: timestamp }); } catch (error) { duplicateMessage(error, 'Warehouse code already exists.'); }
  return toApi(await col(db, C.warehouses).findOne({ _id: id }));
}

export async function softDelete(db: Db, collection: string, recordId: string, what: string) {
  const result = await col(db, collection).updateOne({ _id: recordId }, { $set: { isActive: false, updatedAt: nowIso() } });
  if (!result.matchedCount) throw notFound(what);
  return { id: recordId, isActive: false };
}

async function decorateOrders(db: Db, rows: Doc[]) {
  const customers = await byIds(db, C.customers, rows.map(row => row.customerId));
  return rows.map(row => ({ ...toApi(row), customer: customers.get(row.customerId) || null }));
}

export async function listSalesOrders(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url);
  const query: Doc = {};
  const status = url.searchParams.get('status');
  if (status) query.status = status;
  const [rows, total] = await Promise.all([
    col(db, C.salesOrders).find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    col(db, C.salesOrders).countDocuments(query),
  ]);
  return pageEnvelope(await decorateOrders(db, rows), total, page, limit);
}

export async function getSalesOrder(db: Db, orderId: string) {
  const order = await col(db, C.salesOrders).findOne({ _id: orderId });
  if (!order) throw notFound('Sales order');
  return (await decorateOrders(db, [order]))[0];
}

export async function saveSalesOrder(db: Db, actor: Actor, body: unknown, orderId?: string) {
  const input = parse(salesOrderSchema, body);
  const customer = await col(db, C.customers).findOne({ _id: input.customerId });
  if (!customer || customer.isActive === false) throw badRequest('Select a valid active customer.');
  const totals = await priceItems(db, input.items);
  const timestamp = nowIso();
  if (orderId) {
    const result = await col(db, C.salesOrders).updateOne({ _id: orderId, status: { $in: ['DRAFT', 'CONFIRMED', 'ON_HOLD'] } }, { $set: { ...input, ...totals, updatedAt: timestamp } });
    if (!result.matchedCount) throw conflict('Only draft, confirmed or on-hold sales orders can be edited.');
    return getSalesOrder(db, orderId);
  }
  const id = newId();
  const orderNo = await nextNumber(db, 'SO');
  await col(db, C.salesOrders).insertOne({ _id: id, id, orderNo, status: 'DRAFT', ...input, ...totals, createdBy: actor.email, createdAt: timestamp, updatedAt: timestamp } as Doc);
  return getSalesOrder(db, id);
}

export async function setSalesOrderStatus(db: Db, orderId: string, body: Doc) {
  const status = String(body?.status || '').toUpperCase();
  if (!(SALES_ORDER_STATUSES as readonly string[]).includes(status)) throw badRequest('Invalid sales order status.');
  const result = await col(db, C.salesOrders).updateOne({ _id: orderId, status: { $nin: ['CANCELLED', 'CLOSED'] } }, { $set: { status, updatedAt: nowIso() } });
  if (!result.matchedCount) throw conflict('Sales order not found, or it is already closed/cancelled.');
  return getSalesOrder(db, orderId);
}

function orderItemsForInvoice(items: Doc[]) {
  return items.map(item => ({ productId: item.productId, itemCode: item.itemCode, description: item.description, quantity: item.quantity, unitPrice: item.unitPrice ?? item.rate ?? 0, discount: item.discount || 0, taxRate: item.taxRate || 0, taxTemplateId: item.taxTemplateId }));
}

export async function invoiceFromSalesOrder(db: Db, actor: Actor, orderId: string) {
  const order = await col(db, C.salesOrders).findOne({ _id: orderId });
  if (!order) throw notFound('Sales order');
  if (['DRAFT', 'CANCELLED'].includes(order.status)) throw conflict(`Confirm sales order ${order.orderNo} before invoicing it.`);
  const existing = await invoices(db).findOne({ salesOrderLock: orderId });
  if (existing) throw conflict(`${order.orderNo} is already invoiced as ${existing.invoiceNo}. Cancel that invoice to re-invoice.`);
  const input = parse(invoiceCreateSchema, { customerId: order.customerId, date: todayIso(), currency: order.currency, notes: order.notes, terms: order.terms, reference: order.orderNo, items: orderItemsForInvoice(order.items || []) });
  try {
    const doc = await runWorkflow(async (session, comp) => {
      const created = await insertDraftInvoice(db, session, actor, input, { salesOrderId: orderId }, 'CREATE_FROM_SALES_ORDER');
      comp.add(() => invoices(db).deleteOne({ _id: created.id }));
      return created;
    });
    return invoiceDetail(db, doc.id);
  } catch (error) { duplicateMessage(error, `${order.orderNo} was invoiced by another request.`); }
}

/* ----------------------------------------------------------------------------
 * Delivery notes
 * ------------------------------------------------------------------------- */

async function decorateDeliveries(db: Db, rows: Doc[]) {
  const [customers, orders, warehouses] = await Promise.all([
    byIds(db, C.customers, rows.map(row => row.customerId)),
    byIds(db, C.salesOrders, rows.map(row => row.salesOrderId)),
    byIds(db, C.warehouses, rows.map(row => row.warehouseId)),
  ]);
  return rows.map(row => {
    const order = orders.get(row.salesOrderId);
    const warehouse = warehouses.get(row.warehouseId);
    return { ...toApi(row), customer: customers.get(row.customerId) || null, salesOrder: order ? { id: order.id, orderNo: order.orderNo, status: order.status } : null, warehouse: warehouse ? { id: warehouse.id, name: warehouse.name, code: warehouse.code } : null };
  });
}

export async function listDeliveryNotes(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url, 50);
  const query: Doc = {};
  const status = url.searchParams.get('status');
  if (status) query.status = status;
  const [rows, total] = await Promise.all([
    col(db, C.deliveryNotes).find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    col(db, C.deliveryNotes).countDocuments(query),
  ]);
  return pageEnvelope(await decorateDeliveries(db, rows), total, page, limit);
}

export async function getDeliveryNote(db: Db, noteId: string) {
  const note = await col(db, C.deliveryNotes).findOne({ _id: noteId });
  if (!note) throw notFound('Delivery note');
  return (await decorateDeliveries(db, [note]))[0];
}

async function validateDelivery(db: Db, input: ReturnType<typeof deliveryNoteSchema.parse>) {
  const customer = await col(db, C.customers).findOne({ _id: input.customerId });
  if (!customer || customer.isActive === false) throw badRequest('Select a valid active customer.');
  if (input.warehouseId) {
    const warehouse = await col(db, C.warehouses).findOne({ _id: input.warehouseId });
    if (!warehouse || warehouse.isActive === false) throw badRequest('Select a valid active warehouse.');
  }
  if (input.salesOrderId) {
    const order = await col(db, C.salesOrders).findOne({ _id: input.salesOrderId });
    if (!order) throw badRequest('Linked sales order not found.');
    if (order.customerId !== input.customerId) throw badRequest('The delivery customer must match the sales order customer.');
  }
  const products = await byIds(db, C.products, input.items.map(item => item.productId));
  const items = input.items.map((item, index) => {
    const product = products.get(item.productId);
    if (!product || product.isActive === false) throw badRequest(`Line ${index + 1}: select a valid active product.`);
    return { ...item, itemCode: item.itemCode || product.sku, description: item.description || product.name };
  });
  return { customer, items };
}

export async function saveDeliveryNote(db: Db, actor: Actor, body: unknown, noteId?: string) {
  const input = parse(deliveryNoteSchema, body);
  const { customer, items } = await validateDelivery(db, input);
  const timestamp = nowIso();
  const fields = { ...input, items, currency: customer.currency || 'USD', updatedAt: timestamp };
  if (noteId) {
    const existing = await col(db, C.deliveryNotes).findOne({ _id: noteId });
    if (!existing) throw notFound('Delivery note');
    await runWorkflow(async session => {
      const result = await col(db, C.deliveryNotes).updateOne({ _id: noteId, status: 'DRAFT' }, { $set: fields }, { session });
      if (!result.matchedCount) throw conflict(`Only draft delivery notes can be edited. ${existing.deliveryNo} is ${existing.status}.`);
      await audit(db, session, actor, { entityType: 'DELIVERY_NOTE', action: 'UPDATE', entityId: noteId, voucher: existing.deliveryNo, message: `Updated draft ${existing.deliveryNo} (${items.length} item(s))`, statusBefore: 'DRAFT', statusAfter: 'DRAFT' });
    });
    return getDeliveryNote(db, noteId);
  }
  const id = newId();
  await runWorkflow(async (session, comp) => {
    const deliveryNo = await nextNumber(db, 'DN', session);
    await col(db, C.deliveryNotes).insertOne({ _id: id, id, deliveryNo, status: 'DRAFT', ...fields, createdBy: actor.email, createdAt: timestamp } as Doc, { session });
    comp.add(() => col(db, C.deliveryNotes).deleteOne({ _id: id }));
    await audit(db, session, actor, { entityType: 'DELIVERY_NOTE', action: 'CREATE', entityId: id, voucher: deliveryNo, message: `Drafted ${deliveryNo} for ${customer.name} (${items.length} item(s))`, statusAfter: 'DRAFT' });
  });
  return getDeliveryNote(db, id);
}

export async function deliveryFromSalesOrder(db: Db, actor: Actor, orderId: string) {
  const order = await col(db, C.salesOrders).findOne({ _id: orderId });
  if (!order) throw notFound('Sales order');
  if (['DRAFT', 'CANCELLED', 'CLOSED'].includes(order.status)) throw conflict(`Sales order ${order.orderNo} must be confirmed before delivery.`);
  const stockItems = (order.items || []).filter((item: Doc) => item.productId);
  if (!stockItems.length) throw badRequest(`${order.orderNo} has no product lines to deliver.`);
  const input = parse(deliveryNoteSchema, {
    customerId: order.customerId, salesOrderId: orderId, date: todayIso(), notes: `From ${order.orderNo}`,
    items: stockItems.map((item: Doc) => ({ productId: item.productId, itemCode: item.itemCode, description: item.description, quantity: item.quantity, unitPrice: item.unitPrice ?? item.rate, taxRate: item.taxRate, taxTemplateId: item.taxTemplateId, discount: item.discount })),
  });
  const { items } = await validateDelivery(db, input);
  const id = newId();
  await runWorkflow(async (session, comp) => {
    const deliveryNo = await nextNumber(db, 'DN', session);
    const timestamp = nowIso();
    await col(db, C.deliveryNotes).insertOne({ _id: id, id, deliveryNo, status: 'DRAFT', ...input, items, currency: order.currency, createdBy: actor.email, createdAt: timestamp, updatedAt: timestamp } as Doc, { session });
    comp.add(() => col(db, C.deliveryNotes).deleteOne({ _id: id }));
    await audit(db, session, actor, { entityType: 'DELIVERY_NOTE', action: 'CREATE_FROM_SALES_ORDER', entityId: id, voucher: deliveryNo, message: `Drafted ${deliveryNo} from ${order.orderNo}`, statusAfter: 'DRAFT' });
  });
  return getDeliveryNote(db, id);
}

export async function setDeliveryStatus(db: Db, actor: Actor, noteId: string, body: Doc) {
  const status = String(body?.status || '').toUpperCase();
  const note = await col(db, C.deliveryNotes).findOne({ _id: noteId });
  if (!note) throw notFound('Delivery note');
  const allowed: Record<string, string[]> = { SUBMITTED: ['DRAFT'], CANCELLED: ['DRAFT', 'SUBMITTED'] };
  if (!allowed[status]) throw badRequest('Status must be SUBMITTED or CANCELLED. INVOICED is set by creating an invoice.');
  if (note.status === 'INVOICED') throw conflict(`${note.deliveryNo} is invoiced (${note.invoiceNo}). Cancel the invoice first.`);
  if (!allowed[status].includes(note.status)) throw conflict(`Cannot move ${note.deliveryNo} from ${note.status} to ${status}.`);
  if (status === 'SUBMITTED') await validateDelivery(db, parse(deliveryNoteSchema, note));
  await runWorkflow(async session => {
    const result = await col(db, C.deliveryNotes).updateOne({ _id: noteId, status: note.status }, { $set: { status, [`${status.toLowerCase()}At`]: nowIso(), updatedAt: nowIso() } }, { session });
    if (!result.modifiedCount) throw conflict('Delivery note changed. Reload and try again.');
    await audit(db, session, actor, { entityType: 'DELIVERY_NOTE', action: status === 'SUBMITTED' ? 'SUBMIT' : 'CANCEL', entityId: noteId, voucher: note.deliveryNo, message: `${note.deliveryNo} ${status.toLowerCase()}`, statusBefore: note.status, statusAfter: status });
  });
  return getDeliveryNote(db, noteId);
}

export async function invoiceFromDeliveryNote(db: Db, actor: Actor, noteId: string) {
  const note = await col(db, C.deliveryNotes).findOne({ _id: noteId });
  if (!note) throw notFound('Delivery note');
  if (note.status === 'INVOICED') throw conflict(`${note.deliveryNo} is already invoiced as ${note.invoiceNo}.`);
  if (note.status !== 'SUBMITTED') throw conflict(`Submit ${note.deliveryNo} before creating an invoice from it.`);
  const products = await byIds(db, C.products, (note.items || []).map((item: Doc) => item.productId));
  const order = note.salesOrderId ? await col(db, C.salesOrders).findOne({ _id: note.salesOrderId }) : null;
  const customer = await col(db, C.customers).findOne({ _id: note.customerId });
  const items = (note.items || []).map((item: Doc) => {
    const product = products.get(item.productId);
    return {
      productId: item.productId, itemCode: item.itemCode || product?.sku, description: item.description || product?.name, quantity: item.quantity,
      unitPrice: item.unitPrice ?? product?.salePrice ?? 0, discount: item.discount || 0,
      taxTemplateId: item.taxTemplateId || product?.defaultTaxTemplateId || undefined, taxRate: item.taxRate ?? product?.taxRate ?? 0,
    };
  });
  const input = parse(invoiceCreateSchema, {
    customerId: note.customerId, date: todayIso(), currency: order?.currency || note.currency || customer?.currency || 'USD',
    reference: note.deliveryNo, shipmentReference: note.deliveryNo, notes: note.notes, items,
  });
  try {
    const doc = await runWorkflow(async (session, comp) => {
      const invoice = await insertDraftInvoice(db, session, actor, input, { deliveryNoteId: noteId, salesOrderId: note.salesOrderId }, 'CREATE_FROM_DELIVERY_NOTE');
      comp.add(() => invoices(db).deleteOne({ _id: invoice.id }));
      const claimed = await col(db, C.deliveryNotes).updateOne({ _id: noteId, status: 'SUBMITTED' }, { $set: { status: 'INVOICED', invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, invoicedAt: nowIso(), updatedAt: nowIso() } }, { session });
      if (!claimed.modifiedCount) throw conflict(`${note.deliveryNo} was invoiced or changed by another request.`);
      return invoice;
    });
    return invoiceDetail(db, doc.id);
  } catch (error) { duplicateMessage(error, `${note.deliveryNo} is already invoiced.`); }
}

/* ----------------------------------------------------------------------------
 * Tax templates and print formats
 * ------------------------------------------------------------------------- */

export async function listTaxTemplates(db: Db, url: URL) {
  const query: Doc = {};
  if (url.searchParams.get('isActive') === 'true') query.isActive = { $ne: false };
  return (await col(db, C.taxTemplates).find(query).sort({ isDefault: -1, name: 1 }).toArray()).map(row => ({
    ...toApi(row), totalRate: (row.lines || []).filter((line: Doc) => line.chargeType === 'ON_NET_TOTAL').reduce((sum: number, line: Doc) => sum + Number(line.rate || 0), 0),
  }));
}

export async function saveTaxTemplate(db: Db, actor: Actor, body: unknown, templateId?: string) {
  const existing = templateId ? await col(db, C.taxTemplates).findOne({ _id: templateId }) : null;
  if (templateId && !existing) throw notFound('Tax template');
  const input = parse(taxTemplateSchema, existing ? { ...toApi(existing), ...(body as Doc) } : body);
  if (input.isDefault && !input.isActive) throw badRequest('An inactive template cannot be the default.');
  const id = existing?.id || newId();
  const timestamp = nowIso();
  try {
    await runWorkflow(async session => {
      if (input.isDefault) await col(db, C.taxTemplates).updateMany({ _id: { $ne: id }, isDefault: true }, { $set: { isDefault: false, updatedAt: timestamp } }, { session });
      if (existing) await col(db, C.taxTemplates).updateOne({ _id: id }, { $set: { ...input, updatedAt: timestamp } }, { session });
      else await col(db, C.taxTemplates).insertOne({ _id: id, id, ...input, createdBy: actor.email, createdAt: timestamp, updatedAt: timestamp }, { session });
      await audit(db, session, actor, { entityType: 'TAX_TEMPLATE', action: existing ? 'UPDATE' : 'CREATE', entityId: id, voucher: input.code, message: `${existing ? 'Updated' : 'Created'} tax template ${input.code} (${input.lines.map(line => `${line.label} ${line.rate}%`).join(', ')})${input.isActive ? '' : ' - inactive'}` });
    });
  } catch (error) { duplicateMessage(error, `Tax template code "${input.code}" already exists.`); }
  return toApi(await col(db, C.taxTemplates).findOne({ _id: id }));
}

export async function listPrintFormats(db: Db, url: URL) {
  const query: Doc = {};
  const docType = url.searchParams.get('docType');
  if (docType) query.docType = docType;
  if (url.searchParams.get('isActive') === 'true') query.isActive = { $ne: false };
  return (await col(db, C.printFormats).find(query).sort({ docType: 1, isDefault: -1, name: 1 }).toArray()).map(toApi);
}

export async function savePrintFormat(db: Db, actor: Actor, body: unknown, formatId?: string) {
  const existing = formatId ? await col(db, C.printFormats).findOne({ _id: formatId }) : null;
  if (formatId && !existing) throw notFound('Print format');
  const patch = (body || {}) as Doc;
  const input = parse(printFormatSchema, existing ? { ...toApi(existing), ...patch, template: { ...(existing.template || {}), ...(patch.template || {}) } } : body);
  if (input.isDefault && !input.isActive) throw badRequest('Enable the format before making it the default.');
  const id = existing?.id || newId();
  const timestamp = nowIso();
  const doc = { ...input, title: input.template.title, updatedAt: timestamp };
  try {
    await runWorkflow(async session => {
      if (input.isDefault) await col(db, C.printFormats).updateMany({ _id: { $ne: id }, docType: input.docType, isDefault: true }, { $set: { isDefault: false, updatedAt: timestamp } }, { session });
      if (existing) await col(db, C.printFormats).updateOne({ _id: id }, { $set: doc }, { session });
      else await col(db, C.printFormats).insertOne({ _id: id, id, ...doc, createdBy: actor.email, createdAt: timestamp }, { session });
      await audit(db, session, actor, { entityType: 'PRINT_FORMAT', action: existing ? 'UPDATE' : 'CREATE', entityId: id, voucher: input.name, message: `${existing ? 'Updated' : 'Created'} print format "${input.name}"${input.isDefault ? ' (default)' : ''}${input.isActive ? '' : ' (disabled)'}` });
    });
  } catch (error) { duplicateMessage(error, `A ${input.docType} print format named "${input.name}" already exists.`); }
  return toApi(await col(db, C.printFormats).findOne({ _id: id }));
}

/* ----------------------------------------------------------------------------
 * Subscriptions (recurring invoices)
 * ------------------------------------------------------------------------- */

export function advanceDate(dateIso: string, frequency: string) {
  if (frequency === 'WEEKLY') return addDays(dateIso, 7);
  const date = new Date(`${dateIso}T00:00:00Z`);
  const day = date.getUTCDate();
  const months = frequency === 'QUARTERLY' ? 3 : frequency === 'YEARLY' ? 12 : 1;
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay)); // 31 Jan -> 28/29 Feb, not 3 Mar
  return date.toISOString().slice(0, 10);
}

async function decorateSubscriptions(db: Db, rows: Doc[]) {
  const customers = await byIds(db, C.customers, rows.map(row => row.customerId));
  return rows.map(row => {
    const customer = customers.get(row.customerId);
    return { ...toApi(row), customer: customer ? { id: customer.id, name: customer.name } : null };
  });
}

export async function listSubscriptions(db: Db, url: URL) {
  const { page, limit, skip } = paginateParams(url, 50);
  const [rows, total] = await Promise.all([
    col(db, C.subscriptions).find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    col(db, C.subscriptions).countDocuments({}),
  ]);
  return pageEnvelope(await decorateSubscriptions(db, rows), total, page, limit);
}

export async function saveSubscription(db: Db, actor: Actor, body: unknown, subscriptionId?: string) {
  const existing = subscriptionId ? await col(db, C.subscriptions).findOne({ _id: subscriptionId }) : null;
  if (subscriptionId && !existing) throw notFound('Subscription');
  const input = parse(subscriptionSchema, existing ? { ...toApi(existing), ...(body as Doc) } : body);
  const customer = await col(db, C.customers).findOne({ _id: input.customerId });
  if (!customer || customer.isActive === false) throw badRequest('Select a valid active customer.');
  const totals = await priceItems(db, input.items);
  const id = existing?.id || newId();
  const timestamp = nowIso();
  await runWorkflow(async session => {
    if (existing) await col(db, C.subscriptions).updateOne({ _id: id }, { $set: { ...input, items: totals.items, amount: totals.total, updatedAt: timestamp } }, { session });
    else await col(db, C.subscriptions).insertOne({ _id: id, id, ...input, items: totals.items, amount: totals.total, generatedInvoices: [], createdBy: actor.email, createdAt: timestamp, updatedAt: timestamp }, { session });
    const toggled = existing && Object.keys((body || {}) as Doc).length === 1 && 'isActive' in ((body || {}) as Doc);
    await audit(db, session, actor, { entityType: 'SUBSCRIPTION', action: existing ? (toggled ? (input.isActive ? 'RESUME' : 'PAUSE') : 'UPDATE') : 'CREATE', entityId: id, voucher: input.name, message: `${existing ? (toggled ? (input.isActive ? 'Resumed' : 'Paused') : 'Updated') : 'Created'} ${input.frequency.toLowerCase()} subscription "${input.name}" for ${customer.name}; next run ${input.nextRunDate}` });
  });
  return (await decorateSubscriptions(db, [await col(db, C.subscriptions).findOne({ _id: id }) as Doc]))[0];
}

/**
 * Generates invoices for every due run. Idempotent: each run is first claimed
 * by advancing `nextRunDate` with a compare-and-set, and the invoice carries a
 * unique `subscriptionRunKey`, so concurrent or repeated runs never duplicate.
 */
export async function runDueSubscriptions(db: Db, actor: Actor, asOf = todayIso()) {
  const due = await col(db, C.subscriptions).find({ isActive: { $ne: false }, nextRunDate: { $lte: asOf } }).toArray();
  const generated: Doc[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  for (const subscription of due) {
    for (let guard = 0; guard < 60; guard += 1) {
      const current = await col(db, C.subscriptions).findOne({ _id: subscription._id });
      if (!current || current.isActive === false || current.nextRunDate > asOf) break;
      if (current.endDate && current.nextRunDate > current.endDate) {
        await col(db, C.subscriptions).updateOne({ _id: current._id, nextRunDate: current.nextRunDate }, { $set: { isActive: false, completedAt: nowIso() } });
        break;
      }
      const runDate = current.nextRunDate;
      const next = advanceDate(runDate, current.frequency);
      const claim = await col(db, C.subscriptions).updateOne({ _id: current._id, nextRunDate: runDate }, { $set: { nextRunDate: next, lastRunDate: runDate, updatedAt: nowIso() } });
      if (!claim.modifiedCount) { skipped += 1; break; }
      try {
        const customer = await col(db, C.customers).findOne({ _id: current.customerId });
        const input = parse(invoiceCreateSchema, {
          customerId: current.customerId, date: runDate, dueDate: addDays(runDate, Number(customer?.paymentTerms ?? 30)), currency: current.currency,
          notes: current.notes, terms: current.terms, reference: `${current.name} (${runDate})`, items: current.items,
        });
        const invoice = await runWorkflow(async (session, comp) => {
          const created = await insertDraftInvoice(db, session, actor, input, { subscriptionId: current.id, subscriptionRunKey: `${current.id}:${runDate}` }, 'CREATE_FROM_SUBSCRIPTION');
          comp.add(() => invoices(db).deleteOne({ _id: created.id }));
          return created;
        });
        let status = 'DRAFT';
        if (current.autoSubmit) {
          try {
            await runWorkflow((session, comp) => submitInvoice(db, session, actor, invoice.id, comp));
            status = 'SUBMITTED';
          } catch (error) {
            warnings.push(`${invoice.invoiceNo} left as draft: ${(error as Error).message}`);
          }
        }
        await col(db, C.subscriptions).updateOne({ _id: current._id }, { $push: { generatedInvoices: { runDate, invoiceId: invoice.id, invoice: { id: invoice.id, invoiceNo: invoice.invoiceNo }, status, createdAt: nowIso() } } as Doc });
        generated.push({ id: invoice.id, invoiceNo: invoice.invoiceNo, subscription: current.name, runDate, status });
      } catch (error) {
        if (isDuplicateKey(error)) { skipped += 1; continue; } // run already invoiced earlier
        // Release the claim so the run is retried next time.
        await col(db, C.subscriptions).updateOne({ _id: current._id, nextRunDate: next }, { $set: { nextRunDate: runDate } });
        warnings.push(`${current.name} (${runDate}): ${(error as Error).message}`);
        break;
      }
    }
  }
  if (generated.length || warnings.length) {
    await audit(db, undefined, actor, { entityType: 'SUBSCRIPTION', action: 'RUN_DUE', entityId: 'run-due', voucher: asOf, message: `Recurring run generated ${generated.length} invoice(s)${warnings.length ? `; ${warnings.length} warning(s)` : ''}`, meta: { invoices: generated.map(row => row.invoiceNo), warnings } });
  }
  const message = generated.length
    ? `Generated ${generated.length} invoice(s): ${generated.map(row => row.invoiceNo).join(', ')}`
    : 'No subscriptions were due';
  return { message: warnings.length ? `${message}. ${warnings.join(' | ')}` : message, data: { generated: generated.length, invoices: generated, skipped, warnings } };
}
