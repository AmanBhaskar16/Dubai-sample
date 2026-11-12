#!/usr/bin/env node
/**
 * Invoicing database CLI.
 *
 *   npm run db:setup                 create indexes + collection validators
 *   npm run db:seed                  insert demo master data (idempotent, never overwrites)
 *   npm run db:migrate-json [file]   import legacy data/invoice-demo.json (never overwrites)
 *   npm run db:status                show document counts per collection
 *
 * Reads MONGODB_URI / MONGODB_DB from the environment, or from .env.local /
 * .env in the project root. The URI is never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { C, ensureInvoicingIndexes } from '../src/lib/server/invoicing/indexes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['.env.local', '.env']) {
  const full = path.join(root, file);
  if (existsSync(full) && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(full); } catch { /* ignore malformed env file */ }
  }
}

const [command = 'help', ...args] = process.argv.slice(2);
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const positional = args.filter(arg => !arg.startsWith('--'));

function dbName(uri) {
  if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
  try {
    const name = decodeURIComponent(new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace(/^\//, ''));
    if (name) return name;
  } catch { /* default below */ }
  return 'wms_desk';
}

async function withDb(work) {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Add it to .env.local (see .env.example) and re-run.');
    process.exit(1);
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'wms-desk-invoicing-cli' });
  try {
    await client.connect();
    const db = client.db(dbName(uri));
    console.log(`Connected to database "${db.databaseName}".`);
    await work(db);
  } catch (error) {
    console.error(`Failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ setup */
const VALIDATORS = {
  [C.invoices]: {
    bsonType: 'object',
    required: ['_id', 'invoiceNo', 'customerId', 'status', 'currency', 'items', 'grandTotal'],
    properties: {
      invoiceNo: { bsonType: 'string' },
      status: { enum: ['DRAFT', 'SUBMITTED', 'PARTIAL', 'PAID', 'CREDITED', 'CANCELLED', 'SENT', 'OVERDUE'] },
      currency: { bsonType: 'string', minLength: 3, maxLength: 3 },
      items: { bsonType: 'array' },
      grandTotal: { bsonType: ['double', 'int', 'long', 'decimal'], minimum: 0 },
      outstandingAmount: { bsonType: ['double', 'int', 'long', 'decimal'], minimum: 0 },
    },
  },
  [C.payments]: {
    bsonType: 'object',
    required: ['_id', 'paymentNo', 'invoiceId', 'amount', 'status'],
    properties: { amount: { bsonType: ['double', 'int', 'long', 'decimal'], minimum: 0, exclusiveMinimum: true }, status: { enum: ['POSTED', 'CANCELLED'] } },
  },
  [C.ledger]: {
    bsonType: 'object',
    required: ['_id', 'voucherType', 'voucherNo', 'account', 'debit', 'credit', 'postingDate'],
    properties: { debit: { bsonType: ['double', 'int', 'long', 'decimal'], minimum: 0 }, credit: { bsonType: ['double', 'int', 'long', 'decimal'], minimum: 0 } },
  },
};

async function setup(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name));
  for (const [name, schema] of Object.entries(VALIDATORS)) {
    try {
      // "moderate": legacy documents that predate the rules are not blocked, new/valid ones are enforced.
      if (existing.has(name)) await db.command({ collMod: name, validator: { $jsonSchema: schema }, validationLevel: 'moderate', validationAction: 'error' });
      else await db.createCollection(name, { validator: { $jsonSchema: schema }, validationLevel: 'moderate', validationAction: 'error' });
      console.log(`  validator applied: ${name}`);
    } catch (error) {
      console.warn(`  validator skipped for ${name} (${error.codeName || error.message}). The API still validates every write.`);
    }
  }
  await ensureInvoicingIndexes(db);
  console.log('  indexes ensured for:', Object.values(C).filter(name => name !== C.counters).join(', '));
  const hello = await db.admin().command({ hello: 1 }).catch(() => ({}));
  const transactions = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  console.log(transactions
    ? '  transactions: supported (replica set / cluster) - workflows run in multi-document transactions.'
    : '  transactions: NOT supported (standalone mongod) - workflows use guarded updates with compensation. Use a replica set for production.');
}

/* ------------------------------------------------------------------- seed */
async function upsertAll(collection, docs) {
  let inserted = 0;
  for (const doc of docs) {
    const result = await collection.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
    if (result.upsertedCount) inserted += 1;
  }
  return { inserted, skipped: docs.length - inserted };
}

async function seed(db) {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    console.error('Refusing to seed with NODE_ENV=production. Set SEED_ALLOW_PRODUCTION=true to override (existing records are still never overwritten).');
    process.exitCode = 1;
    return;
  }
  await ensureInvoicingIndexes(db);
  const t = now();
  const base = { isActive: true, createdAt: t, updatedAt: t, seeded: true };
  const withId = doc => ({ _id: doc.id, ...base, ...doc });
  const taxTemplates = [
    withId({ id: 'seed-tax-uae-vat-5', code: 'UAE-VAT-5', name: 'UAE VAT 5% (Standard)', scope: 'BOTH', isDefault: true, description: 'Standard-rated UAE VAT on domestic supplies.', lines: [{ label: 'VAT', rate: 5, chargeType: 'ON_NET_TOTAL', isRecoverable: false }] }),
    withId({ id: 'seed-tax-uae-export-0', code: 'UAE-EXPORT-0', name: 'UAE Export (Zero Rated)', scope: 'BOTH', isDefault: false, description: 'Zero-rated exports outside the GCC.', lines: [{ label: 'VAT', rate: 0, chargeType: 'ON_NET_TOTAL', isRecoverable: false }] }),
  ];
  const results = {
    [C.taxTemplates]: await upsertAll(db.collection(C.taxTemplates), taxTemplates),
    [C.printFormats]: await upsertAll(db.collection(C.printFormats), [
      withId({ id: 'seed-pf-commercial', name: 'Commercial Export Invoice', docType: 'SALES_INVOICE', isDefault: true, title: 'COMMERCIAL INVOICE', footer: 'Thank you for your business. Goods sold under the stated Incoterms.', template: { title: 'COMMERCIAL INVOICE', sections: ['letterhead', 'customer', 'items', 'taxes', 'totals', 'terms', 'footer'], showLogo: true, showHsnSummary: true, showAmountInWords: true, showPaymentTerms: true } }),
      withId({ id: 'seed-pf-tax-invoice', name: 'UAE Tax Invoice', docType: 'SALES_INVOICE', isDefault: false, title: 'TAX INVOICE', footer: 'This is a computer generated tax invoice.', template: { title: 'TAX INVOICE', sections: ['letterhead', 'customer', 'items', 'taxes', 'totals', 'footer'], showLogo: true, showHsnSummary: true, showAmountInWords: false, showPaymentTerms: false } }),
    ]),
    [C.customers]: await upsertAll(db.collection(C.customers), [
      withId({ id: 'seed-cust-001', customerNo: 'CUS-SEED-001', name: 'Atlantic Imports LLC', email: 'ap@atlantic-imports.example', address: '120 Harbor Way', city: 'New York', country: 'United States', currency: 'USD', creditLimit: 50000, paymentTerms: 30 }),
      withId({ id: 'seed-cust-002', customerNo: 'CUS-SEED-002', name: 'Gulf Retail Trading FZE', email: 'accounts@gulfretail.example', address: 'JAFZA South, Warehouse 14', city: 'Dubai', country: 'United Arab Emirates', currency: 'AED', creditLimit: 0, paymentTerms: 15, taxId: '100000000000003' }),
      withId({ id: 'seed-cust-003', customerNo: 'CUS-SEED-003', name: 'Rhein Logistics GmbH', email: 'billing@rhein.example', address: 'Hafenstrasse 8', city: 'Hamburg', country: 'Germany', currency: 'EUR', creditLimit: 20000, paymentTerms: 45 }),
    ]),
    [C.products]: await upsertAll(db.collection(C.products), [
      withId({ id: 'seed-prod-001', sku: 'SEED-PAL-001', name: 'Euro Pallet (1200x800)', description: 'Heat-treated wooden pallet', salePrice: 18.5, taxRate: 5, defaultTaxTemplateId: 'seed-tax-uae-vat-5', type: 'PRODUCT' }),
      withId({ id: 'seed-prod-002', sku: 'SEED-CTN-002', name: 'Export Carton 5-ply', description: 'Double-wall export carton', salePrice: 2.4, taxRate: 0, defaultTaxTemplateId: 'seed-tax-uae-export-0', type: 'PRODUCT' }),
      withId({ id: 'seed-prod-003', sku: 'SEED-STR-003', name: 'Stretch Film Roll', description: '500mm x 23 micron', salePrice: 9.75, taxRate: 5, defaultTaxTemplateId: 'seed-tax-uae-vat-5', type: 'PRODUCT' }),
      withId({ id: 'seed-svc-004', sku: 'SEED-SVC-004', name: 'Warehousing Service (per pallet/month)', description: 'Storage service', salePrice: 35, taxRate: 5, defaultTaxTemplateId: 'seed-tax-uae-vat-5', type: 'SERVICE' }),
    ]),
    [C.warehouses]: await upsertAll(db.collection(C.warehouses), [
      withId({ id: 'seed-wh-001', code: 'JAFZA-01', name: 'JAFZA Main Warehouse', address: 'Jebel Ali Free Zone, Dubai' }),
    ]),
  };
  // Only one default tax template / print format may exist; keep an existing default if the user already had one.
  for (const [name, filter, id] of [[C.taxTemplates, {}, 'seed-tax-uae-vat-5'], [C.printFormats, { docType: 'SALES_INVOICE' }, 'seed-pf-commercial']]) {
    const otherDefault = await db.collection(name).findOne({ ...filter, isDefault: true, _id: { $ne: id } });
    if (otherDefault) await db.collection(name).updateOne({ _id: id, seeded: true }, { $set: { isDefault: false } });
  }
  for (const [name, result] of Object.entries(results)) console.log(`  ${name}: ${result.inserted} inserted, ${result.skipped} already present (left unchanged)`);
  console.log('Seed complete. Documents (invoices, payments, ...) are created through the app so the ledger stays consistent.');
}

/* ---------------------------------------------------------- migrate-json */
const LEGACY_MAP = {
  customers: C.customers, products: C.products, invoices: C.invoices, payments: C.payments, creditNotes: C.creditNotes,
  deliveryNotes: C.deliveryNotes, paymentEntries: C.paymentEntries, taxTemplates: C.taxTemplates, printFormats: C.printFormats,
  ledger: C.ledger, subscriptions: C.subscriptions, auditLogs: C.auditLogs, salesOrders: C.salesOrders, warehouses: C.warehouses,
};
const NUMBER_FIELDS = { [C.invoices]: 'invoiceNo', [C.payments]: 'paymentNo', [C.paymentEntries]: 'paymentNo', [C.creditNotes]: 'creditNoteNo', [C.deliveryNotes]: 'deliveryNo', [C.customers]: 'customerNo', [C.salesOrders]: 'orderNo' };

function normalizeLegacy(collection, row) {
  const doc = { ...row, _id: String(row.id), id: String(row.id), migratedFromJson: true };
  if (collection === C.invoices) {
    const total = Number(doc.grandTotal ?? doc.total ?? 0);
    doc.grandTotal = total;
    doc.amountPaid = Number(doc.amountPaid || 0);
    doc.creditAmount = Number(doc.creditAmount || 0);
    doc.outstandingAmount = ['DRAFT', 'CANCELLED'].includes(doc.status) ? (doc.status === 'DRAFT' ? total : 0) : Math.max(0, Math.round((total - doc.amountPaid - doc.creditAmount) * 100) / 100);
    // Legacy statuses (SENT/OVERDUE/SUBMITTED with payments) -> balance-derived status.
    if (!['DRAFT', 'CANCELLED'].includes(doc.status)) {
      doc.legacyStatus = doc.status;
      doc.status = doc.outstandingAmount <= 0.005 ? (doc.amountPaid > 0.005 ? 'PAID' : 'CREDITED') : (doc.amountPaid > 0.005 || doc.creditAmount > 0.005 ? 'PARTIAL' : 'SUBMITTED');
    }
    if (!doc.currency) doc.currency = 'USD';
    doc.items = Array.isArray(doc.items) ? doc.items : [];
    delete doc.customer; delete doc.payments;
  }
  if (collection === C.payments && !doc.status) doc.status = 'POSTED';
  if (collection === C.payments) delete doc.invoice;
  if (collection === C.deliveryNotes || collection === C.paymentEntries) delete doc.customer;
  return doc;
}

async function migrateJson(db) {
  const file = path.resolve(root, positional[0] || 'data/invoice-demo.json');
  if (!existsSync(file)) {
    console.log(`No legacy file at ${path.relative(root, file)} - nothing to migrate.`);
    return;
  }
  const legacy = JSON.parse(readFileSync(file, 'utf8'));
  const dryRun = flags.has('--dry-run');
  await ensureInvoicingIndexes(db);
  const counters = new Map();
  for (const [key, collection] of Object.entries(LEGACY_MAP)) {
    const rows = Array.isArray(legacy[key]) ? legacy[key].filter(row => row && row.id) : [];
    if (!rows.length) continue;
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const doc = normalizeLegacy(collection, row);
      const numberField = NUMBER_FIELDS[collection];
      const match = numberField && typeof doc[numberField] === 'string' ? doc[numberField].match(/^([A-Z]+)-(\d{2})-(\d+)$/) : null;
      if (match) {
        const counterKey = `${match[1]}-${match[2]}`;
        counters.set(counterKey, Math.max(counters.get(counterKey) || 0, Number(match[3])));
      }
      if (dryRun) { inserted += 1; continue; }
      try {
        const result = await db.collection(collection).updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
        if (result.upsertedCount) inserted += 1; else skipped += 1;
      } catch (error) {
        skipped += 1;
        console.warn(`  ${collection} ${doc.id}: skipped (${error.code === 11000 ? 'duplicate number/code already in MongoDB' : error.message})`);
      }
    }
    console.log(`  ${collection}: ${inserted} ${dryRun ? 'would be inserted' : 'inserted'}, ${skipped} skipped (already present)`);
  }
  // Move counters forward so new numbers never collide with migrated ones.
  for (const [key, seq] of counters) {
    if (!dryRun) await db.collection(C.counters).updateOne({ _id: key }, { $max: { seq }, $setOnInsert: { prefix: key.split('-')[0], year: key.split('-')[1] } }, { upsert: true });
    console.log(`  counter ${key} >= ${seq}`);
  }
  console.log(dryRun ? 'Dry run only - nothing was written.' : `Migration complete. The JSON file was left untouched; archive ${path.relative(root, file)} once you have checked the data in the app. It is no longer read by the API.`);
}

async function status(db) {
  for (const name of Object.values(C)) console.log(`  ${name.padEnd(20)} ${await db.collection(name).estimatedDocumentCount()}`);
}

const commands = { setup, seed, 'migrate-json': migrateJson, status };
if (!commands[command]) {
  console.log('Usage: node scripts/invoicing-db.mjs <setup|seed|migrate-json [file] [--dry-run]|status>');
  process.exit(command === 'help' ? 0 : 1);
}
await withDb(commands[command]);
