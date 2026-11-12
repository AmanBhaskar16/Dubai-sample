#!/usr/bin/env node
/**
 * End-to-end API verification for the Invoicing module.
 *
 *   npm run dev                                   # in one terminal (MONGODB_URI set in .env.local)
 *   npm run verify:invoicing -- --yes             # in another terminal
 *
 * Options: --base=http://localhost:3000/api/v1   --pdf-out=./tmp/verify-invoice.pdf
 *
 * It WRITES test records (customers/products/invoices... tagged "VERIFY-<run>")
 * through the public API, so only run it against a development database. It
 * never deletes or edits records it did not create.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || true]; }));
if (!args.yes && process.env.VERIFY_ALLOW_WRITES !== 'true') {
  console.error('This script creates test records through the API. Re-run with --yes against a development database.');
  process.exit(1);
}
const BASE = String(args.base || process.env.VERIFY_BASE_URL || 'http://localhost:3000/api/v1').replace(/\/$/, '');
const RUN = `VERIFY-${Date.now().toString(36).toUpperCase()}`;
const HEADERS = { 'Content-Type': 'application/json', 'x-actor-email': 'verify@local.test', 'x-actor-role': 'QA' };
const today = new Date().toISOString().slice(0, 10);
const addDays = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const addMonths = (date, months) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };

let passed = 0;
const failures = [];
async function call(method, route, body) {
  const response = await fetch(`${BASE}/${route}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: payload, headers: response.headers };
}
const data = res => res.body?.data;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.006;
async function expectOk(name, promise, status = [200, 201]) {
  const res = await promise;
  check(name, status.includes(res.status), { status: res.status, message: res.body?.message });
  return res;
}

async function main() {
  console.log(`Verifying ${BASE} (run tag ${RUN})\n`);

  console.log('Health');
  const health = await call('GET', 'health');
  check('health reports MongoDB storage', health.status === 200 && health.body.storage === 'mongodb', health.body);
  if (health.status !== 200) { console.log('\nAPI/DB not healthy - aborting.'); process.exit(1); }
  console.log(`  (database "${health.body.database}", transactions: ${health.body.transactions})`);

  console.log('\nSetup: tax templates, print formats, customer, products');
  const vat = data(await expectOk('create VAT 5% template', call('POST', 'invoicing/tax-templates', { name: `${RUN} VAT 5%`, code: `${RUN}-VAT5`, scope: 'BOTH', lines: [{ label: 'VAT', rate: 5, chargeType: 'ON_NET_TOTAL' }] })));
  const compound = data(await expectOk('create compound template (10% + 10% of tax)', call('POST', 'invoicing/tax-templates', { name: `${RUN} Compound`, code: `${RUN}-CMP`, lines: [{ label: 'Duty', rate: 10, chargeType: 'ON_NET_TOTAL' }, { label: 'Cess', rate: 10, chargeType: 'ON_PREVIOUS_ROW_AMOUNT' }] })));
  check('duplicate tax template code rejected (409)', (await call('POST', 'invoicing/tax-templates', { name: 'dup', code: `${RUN}-VAT5`, lines: [{ label: 'VAT', rate: 5 }] })).status === 409);
  check('invalid tax rate rejected (400)', (await call('POST', 'invoicing/tax-templates', { name: 'bad', code: `${RUN}-BAD`, lines: [{ label: 'VAT', rate: 150 }] })).status === 400);
  const format = data(await expectOk('create print format', call('POST', 'invoicing/print-formats', { name: `${RUN} Export Format`, docType: 'SALES_INVOICE', footer: `${RUN} FOOTER TEXT`, template: { title: `${RUN} PROFORMA`, showLogo: false, showHsnSummary: true, showAmountInWords: true, showPaymentTerms: true } })));
  const disabledFormat = data(await expectOk('create disabled print format', call('POST', 'invoicing/print-formats', { name: `${RUN} Disabled`, docType: 'SALES_INVOICE', isActive: false, template: { title: 'X' } })));
  const customer = data(await expectOk('create customer', call('POST', 'customers', { name: `${RUN} Customer LLC`, email: 'verify@example.com', currency: 'USD', creditLimit: 100000, paymentTerms: 30, city: 'Dubai', country: 'United Arab Emirates' })));
  const lowLimit = data(await expectOk('create low-credit-limit customer', call('POST', 'customers', { name: `${RUN} Small Buyer`, currency: 'USD', creditLimit: 50, paymentTerms: 15 })));
  const productA = data(await expectOk('create product A (default VAT)', call('POST', 'inventory/products', { name: `${RUN} Pallet`, sku: `${RUN}-A`, salePrice: 100, taxRate: 5, defaultTaxTemplateId: vat.id })));
  const productB = data(await expectOk('create product B', call('POST', 'inventory/products', { name: `${RUN} Carton`, sku: `${RUN}-B`, salePrice: 50, taxRate: 0 })));
  check('duplicate SKU rejected (409)', (await call('POST', 'inventory/products', { name: 'dup', sku: `${RUN}-A` })).status === 409);
  const search = data(await call('GET', `products/search?q=${encodeURIComponent(RUN)}`));
  check('product search returns both products with default template', Array.isArray(search) && search.length === 2 && search.some(p => p.defaultTaxTemplate?.id === vat.id), search);

  console.log('\nInvoice validation');
  const line = (product, quantity, extra = {}) => ({ productId: product.id, description: product.name, quantity, unitPrice: product.salePrice, ...extra });
  check('missing customer -> 400', (await call('POST', 'invoices', { date: today, currency: 'USD', items: [line(productA, 1)] })).status === 400);
  check('zero quantity -> 400', (await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', items: [line(productA, 0)] })).status === 400);
  check('no items -> 400', (await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', items: [] })).status === 400);
  check('due date before date -> 400', (await call('POST', 'invoices', { customerId: customer.id, date: today, dueDate: addDays(today, -1), currency: 'USD', items: [line(productA, 1)] })).status === 400);
  check('net weight > gross weight -> 400', (await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', grossWeight: 10, netWeight: 12, items: [line(productA, 1)] })).status === 400);
  check('invalid currency -> 400', (await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'US', items: [line(productA, 1)] })).status === 400);
  check('discount > 100% -> 400', (await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', items: [line(productA, 1, { discount: 120 })] })).status === 400);

  console.log('\nDraft -> edit -> submit');
  const created = await expectOk('create draft invoice', call('POST', 'invoices', {
    customerId: customer.id, date: today, dueDate: addDays(today, 30), currency: 'USD', customerPoNo: `${RUN}-PO`, shipmentReference: `${RUN}-BKG`,
    countryOfOrigin: 'United Arab Emirates', countryOfDestination: 'United States', portOfLoading: 'Jebel Ali', incoterms: 'FOB', grossWeight: 120, netWeight: 100, packageCount: 4,
    status: 'PAID', amountPaid: 9999, // must be ignored (mass assignment)
    items: [line(productA, 2, { discount: 10, taxTemplateId: vat.id, taxRate: 99 }), line(productB, 1, { taxRate: 0 })],
  }));
  let invoice = data(created);
  // A: 2 x 100 - 10% = 180 net, VAT 5% from template (manual 99% ignored) = 9; B: 50 net, 0 tax.
  check('server totals: subtotal 230, tax 9, total 239', invoice && near(invoice.subtotal, 230) && near(invoice.taxAmount, 9) && near(invoice.grandTotal, 239), invoice && { subtotal: invoice.subtotal, tax: invoice.taxAmount, total: invoice.grandTotal });
  check('status/amountPaid not mass-assignable', invoice?.status === 'DRAFT' && invoice?.amountPaid === 0);
  check('invoice number format INV-YY-NNNNN', /^INV-\d{2}-\d{5}$/.test(invoice?.invoiceNo || ''), invoice?.invoiceNo);
  const edited = data(await expectOk('edit draft (qty 3 for product B, compound tax on A)', call('PATCH', `invoices/${invoice.id}`, { items: [line(productA, 2, { discount: 10, taxTemplateId: compound.id }), line(productB, 3)] })));
  // A: 180 net, duty 18 + cess 1.8 = 19.8; B: 150. total = 330 + 19.8 = 349.8
  check('compound tax template applied (total 349.80)', near(edited?.grandTotal, 349.8) && near(edited?.taxAmount, 19.8), edited && { total: edited.grandTotal, tax: edited.taxAmount });
  const reread = data(await call('GET', `invoices/${invoice.id}`));
  check('edit persisted (re-read from DB)', near(reread?.grandTotal, 349.8) && reread?.items?.length === 2);
  const paymentOnDraft = await call('POST', 'payments', { invoiceId: invoice.id, amount: 10, method: 'CASH' });
  check('payment on draft rejected with "Submit" hint (409)', paymentOnDraft.status === 409 && /submit/i.test(paymentOnDraft.body.message), paymentOnDraft.body);
  const openBefore = data(await call('GET', `invoices?status=OPEN&customerId=${customer.id}&limit=100`));
  check('draft not listed as payable (status=OPEN)', !openBefore.items.some(row => row.id === invoice.id));
  const drafts = data(await call('GET', `invoices?status=DRAFT&customerId=${customer.id}`));
  check('draft listed under status=DRAFT', drafts.items.some(row => row.id === invoice.id));
  const submitted = await expectOk('submit invoice', call('PATCH', `invoices/${invoice.id}/status`, { status: 'SUBMITTED' }));
  invoice = data(submitted);
  check('submitted: status SUBMITTED, outstanding = total', invoice.status === 'SUBMITTED' && near(invoice.outstandingAmount, 349.8));
  check('double submit rejected (409)', (await call('PATCH', `invoices/${invoice.id}/status`, { status: 'SUBMITTED' })).status === 409);
  check('edit after submit rejected (409)', (await call('PATCH', `invoices/${invoice.id}`, { notes: 'x' })).status === 409);
  const invoiceLedger = data(await call('GET', `invoicing/ledger?search=${invoice.invoiceNo}&limit=50`));
  const ar = invoiceLedger.items.find(row => row.account.code === '1100' && row.voucherType === 'SALES_INVOICE');
  check('ledger: Dr AR 349.80, Cr revenue 330, Cr tax 19.80', near(ar?.debit, 349.8) && invoiceLedger.items.some(row => row.account.code === '4000' && near(row.credit, 330)) && invoiceLedger.items.some(row => row.account.code === '2100' && near(row.credit, 19.8)), invoiceLedger.items.map(r => [r.account.code, r.debit, r.credit]));
  const openAfter = data(await call('GET', `invoices?status=OPEN&customerId=${customer.id}&limit=100`));
  check('submitted invoice now payable (status=OPEN)', openAfter.items.some(row => row.id === invoice.id));

  console.log('\nCredit limit');
  const big = data(await call('POST', 'invoices', { customerId: lowLimit.id, date: today, currency: 'USD', items: [line(productB, 2)] }));
  const limitRes = await call('PATCH', `invoices/${big.id}/status`, { status: 'SUBMITTED' });
  check('submit over credit limit rejected (400)', limitRes.status === 400 && /credit limit/i.test(limitRes.body.message), limitRes.body);
  check('draft cancel allowed', (await call('PATCH', `invoices/${big.id}/status`, { status: 'CANCELLED' })).status === 200);

  console.log('\nPayments: partial, over, exact, cancel');
  const partial = await expectOk('partial payment 100', call('POST', 'payments', { invoiceId: invoice.id, amount: 100, method: 'BANK_TRANSFER', reference: `${RUN}-UTR1`, date: today }));
  check('invoice PARTIAL, outstanding 249.80', data(partial)?.invoice?.status === 'PARTIAL' && near(data(partial)?.invoice?.outstandingAmount, 249.8), data(partial)?.invoice);
  const over = await call('POST', 'payments', { invoiceId: invoice.id, amount: 300, method: 'CASH' });
  check('overpayment rejected (400)', over.status === 400 && /overpayment/i.test(over.body.message), over.body);
  check('zero payment rejected (400)', (await call('POST', 'payments', { invoiceId: invoice.id, amount: 0, method: 'CASH' })).status === 400);
  check('bad method rejected (400)', (await call('POST', 'payments', { invoiceId: invoice.id, amount: 1, method: 'BITCOIN' })).status === 400);
  const exact = await expectOk('exact payment of balance 249.80', call('POST', 'payments', { invoiceId: invoice.id, amount: 249.8, method: 'CHEQUE' }));
  check('invoice PAID, outstanding 0', data(exact)?.invoice?.status === 'PAID' && near(data(exact)?.invoice?.outstandingAmount, 0));
  check('payment on paid invoice rejected (409)', (await call('POST', 'payments', { invoiceId: invoice.id, amount: 1, method: 'CASH' })).status === 409);
  const listed = data(await call('GET', `payments?invoiceId=${invoice.id}`));
  check('payments listed with invoice link', listed.items.length === 2 && listed.items.every(p => p.invoice?.invoiceNo === invoice.invoiceNo));
  const cancelPay = await expectOk('cancel the exact payment', call('PATCH', `payments/${data(exact).id}/status`, { status: 'CANCELLED', reason: 'cheque bounced' }));
  check('cancel restores outstanding 249.80 / PARTIAL', data(cancelPay)?.status === 'CANCELLED' && near(data(cancelPay)?.invoice?.outstandingAmount, 249.8) && data(cancelPay)?.invoice?.status === 'PARTIAL', data(cancelPay)?.invoice);
  check('double cancel rejected (409)', (await call('PATCH', `payments/${data(exact).id}/status`, { status: 'CANCELLED' })).status === 409);

  console.log('\nConcurrency: parallel payments never overpay');
  const conc = data(await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', items: [line(productB, 2)] }));
  await call('PATCH', `invoices/${conc.id}/status`, { status: 'SUBMITTED' });
  const parallel = await Promise.all(Array.from({ length: 6 }, () => call('POST', 'payments', { invoiceId: conc.id, amount: 50, method: 'CASH' })));
  const concAfter = data(await call('GET', `invoices/${conc.id}`));
  check('exactly 2 of 6 parallel 50.00 payments accepted on a 100.00 invoice', parallel.filter(r => r.status === 201).length === 2, parallel.map(r => r.status));
  check('outstanding is 0, amountPaid 100 (no lost update)', near(concAfter.outstandingAmount, 0) && near(concAfter.amountPaid, 100) && concAfter.status === 'PAID', { outstanding: concAfter.outstandingAmount, paid: concAfter.amountPaid });
  const numbers = parallel.filter(r => r.status === 201).map(r => data(r).paymentNo);
  check('payment numbers unique', new Set(numbers).size === numbers.length, numbers);
  const parallelDrafts = await Promise.all(Array.from({ length: 8 }, () => call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', items: [line(productB, 1)] })));
  const draftNos = parallelDrafts.map(r => data(r)?.invoiceNo);
  check('8 parallel invoice creates get 8 unique numbers', parallelDrafts.every(r => r.status === 201) && new Set(draftNos).size === 8, draftNos);

  console.log('\nPayment entries: allocation + advance');
  const inv3 = data(await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', items: [line(productA, 2, { taxTemplateId: vat.id })] })); // 210
  await call('PATCH', `invoices/${inv3.id}/status`, { status: 'SUBMITTED' });
  check('allocation above invoice balance rejected (400)', (await call('POST', 'payments/entries', { customerId: customer.id, paidAmount: 500, method: 'BANK_TRANSFER', allocations: [{ invoiceId: inv3.id, allocatedAmount: 300 }] })).status === 400);
  check('allocation above paid amount rejected (400)', (await call('POST', 'payments/entries', { customerId: customer.id, paidAmount: 100, allocations: [{ invoiceId: inv3.id, allocatedAmount: 150 }] })).status === 400);
  check('allocation to other customer invoice rejected (400)', (await call('POST', 'payments/entries', { customerId: lowLimit.id, paidAmount: 100, allocations: [{ invoiceId: inv3.id, allocatedAmount: 50 }] })).status === 400);
  const draftAlloc = data(await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', items: [line(productB, 1)] }));
  check('allocation to draft invoice rejected with Submit hint (409)', (await call('POST', 'payments/entries', { customerId: customer.id, paidAmount: 100, allocations: [{ invoiceId: draftAlloc.id, allocatedAmount: 50 }] })).status === 409);
  const entry = data(await expectOk('draft payment entry 300 (alloc 150)', call('POST', 'payments/entries', { customerId: customer.id, paidAmount: 300, method: 'BANK_TRANSFER', reference: `${RUN}-PE`, allocations: [{ invoiceId: inv3.id, allocatedAmount: 150 }] })));
  const entryEdited = data(await expectOk('edit draft entry: alloc 200', call('PUT', `payments/entries/${entry.id}`, { customerId: customer.id, paidAmount: 300, method: 'BANK_TRANSFER', allocations: [{ invoiceId: inv3.id, allocatedAmount: 200 }] })));
  check('entry amounts: allocated 200, advance 100', near(entryEdited.allocatedAmount, 200) && near(entryEdited.unallocatedAmount, 100));
  const entrySubmitted = data(await expectOk('submit payment entry', call('PATCH', `payments/entries/${entry.id}/status`, { status: 'SUBMITTED' })));
  const inv3After = data(await call('GET', `invoices/${inv3.id}`));
  check('invoice reconciled: outstanding 10, PARTIAL, allocation visible', entrySubmitted.status === 'SUBMITTED' && near(inv3After.outstandingAmount, 10) && inv3After.status === 'PARTIAL' && inv3After.paymentAllocations?.length === 1, { o: inv3After.outstandingAmount, s: inv3After.status });
  const peLedger = data(await call('GET', `invoicing/ledger?search=${entry.paymentNo}`));
  check('ledger: Dr bank 300, Cr AR 200, Cr advances 100', peLedger.items.some(r => r.account.code === '1000' && near(r.debit, 300)) && peLedger.items.some(r => r.account.code === '1100' && near(r.credit, 200)) && peLedger.items.some(r => r.account.code === '2200' && near(r.credit, 100)));
  check('edit submitted entry rejected (409)', (await call('PUT', `payments/entries/${entry.id}`, { customerId: customer.id, paidAmount: 10 })).status === 409);
  check('re-submit rejected (409)', (await call('PATCH', `payments/entries/${entry.id}/status`, { status: 'SUBMITTED' })).status === 409);
  await expectOk('cancel submitted entry', call('PATCH', `payments/entries/${entry.id}/status`, { status: 'CANCELLED' }));
  check('entry cancel restores invoice outstanding 210', near(data(await call('GET', `invoices/${inv3.id}`)).outstandingAmount, 210));

  console.log('\nCredit notes');
  const cnTooMuch = await call('POST', `invoicing/credit-notes/from-invoice/${inv3.id}`, { reason: 'SALES_RETURN', items: [line(productA, 3, { taxTemplateId: vat.id })] });
  check('credit qty above invoiced qty rejected (400)', cnTooMuch.status === 400, cnTooMuch.body);
  check('credit note on draft invoice rejected (409)', (await call('POST', `invoicing/credit-notes/from-invoice/${draftAlloc.id}`, { items: [line(productB, 1)] })).status === 409);
  const cn = data(await expectOk('draft credit note: return 1 unit (105.00)', call('POST', `invoicing/credit-notes/from-invoice/${inv3.id}`, { reason: 'SALES_RETURN', date: today, items: [line(productA, 1, { taxTemplateId: vat.id })] })));
  check('credit note total 105', near(cn.grandTotal, 105) && /^CN-\d{2}-\d{5}$/.test(cn.creditNoteNo), cn.grandTotal);
  await expectOk('edit draft credit note (still 1 unit, note text)', call('PUT', `invoicing/credit-notes/${cn.id}`, { reason: 'SALES_RETURN', notes: 'damaged', items: [line(productA, 1, { taxTemplateId: vat.id })] }));
  const cnSubmitted = data(await expectOk('submit credit note', call('PATCH', `invoicing/credit-notes/${cn.id}/status`, { status: 'SUBMITTED' })));
  const inv3Credited = data(await call('GET', `invoices/${inv3.id}`));
  check('invoice outstanding 105, creditAmount 105, PARTIAL', near(inv3Credited.outstandingAmount, 105) && near(inv3Credited.creditAmount, 105) && inv3Credited.status === 'PARTIAL', inv3Credited);
  check('credit applied 105 / refundable 0', near(cnSubmitted.appliedAmount, 105) && near(cnSubmitted.refundableAmount, 0));
  const cn2 = data(await call('POST', `invoicing/credit-notes/from-invoice/${inv3.id}`, { reason: 'SALES_RETURN', items: [line(productA, 1, { taxTemplateId: vat.id })] }));
  await call('POST', 'payments', { invoiceId: inv3.id, amount: 50, method: 'CASH' }); // outstanding 55
  const cn2Sub = data(await expectOk('submit 2nd credit (105) when only 55 outstanding', call('PATCH', `invoicing/credit-notes/${cn2.id}/status`, { status: 'SUBMITTED' })));
  check('excess credit becomes refundable 50, invoice PAID', near(cn2Sub.appliedAmount, 55) && near(cn2Sub.refundableAmount, 50) && data(await call('GET', `invoices/${inv3.id}`)).status === 'PAID', cn2Sub);
  const cn3 = await call('POST', `invoicing/credit-notes/from-invoice/${inv3.id}`, { items: [line(productA, 1, { taxTemplateId: vat.id })] });
  check('third credit beyond invoiced quantity/value rejected (400)', cn3.status === 400, cn3.body);
  await expectOk('cancel 2nd credit note', call('PATCH', `invoicing/credit-notes/${cn2.id}/status`, { status: 'CANCELLED' }));
  const inv3Restored = data(await call('GET', `invoices/${inv3.id}`));
  check('credit cancel restores outstanding 55 / PARTIAL', near(inv3Restored.outstandingAmount, 55) && inv3Restored.status === 'PARTIAL', inv3Restored);

  console.log('\nSales order -> delivery note -> invoice');
  const warehouse = data(await expectOk('create warehouse', call('POST', 'inventory/warehouses', { name: `${RUN} WH`, code: `${RUN}-WH` })));
  const order = data(await expectOk('create sales order', call('POST', 'sales/orders', { customerId: customer.id, date: today, currency: 'USD', items: [line(productA, 4, { taxTemplateId: vat.id }), line(productB, 2)] })));
  check('delivery from draft order rejected (409)', (await call('POST', `delivery-notes/from-sales-order/${order.id}`)).status === 409);
  await expectOk('confirm sales order', call('PUT', `sales/orders/${order.id}/status`, { status: 'CONFIRMED' }));
  const dnFromOrder = data(await expectOk('delivery note from sales order', call('POST', `delivery-notes/from-sales-order/${order.id}`)));
  check('delivery note copies 2 order lines', dnFromOrder.items?.length === 2 && dnFromOrder.salesOrder?.orderNo === order.orderNo);
  const dn = data(await expectOk('manual delivery note draft', call('POST', 'delivery-notes', { customerId: customer.id, warehouseId: warehouse.id, date: today, items: [{ productId: productA.id, quantity: 3 }] })));
  await expectOk('edit draft delivery note (qty 5)', call('PUT', `delivery-notes/${dn.id}`, { customerId: customer.id, warehouseId: warehouse.id, date: today, items: [{ productId: productA.id, quantity: 5 }] }));
  check('invoice from draft delivery note rejected (409)', (await call('POST', `invoices/from-delivery-note/${dn.id}`)).status === 409);
  await expectOk('submit delivery note', call('PATCH', `delivery-notes/${dn.id}/status`, { status: 'SUBMITTED' }));
  const dnParallel = await Promise.all([1, 2, 3].map(() => call('POST', `invoices/from-delivery-note/${dn.id}`)));
  const dnCreated = dnParallel.filter(r => r.status === 201);
  check('3 parallel conversions create exactly 1 invoice', dnCreated.length === 1, dnParallel.map(r => r.status));
  const dnInvoice = data(dnCreated[0]);
  check('converted invoice: 5 x 100 + VAT = 525, linked to note', dnInvoice && near(dnInvoice.grandTotal, 525) && dnInvoice.deliveryNoteId === dn.id, dnInvoice && dnInvoice.grandTotal);
  const dnAfter = data(await call('GET', `delivery-notes/${dn.id}`));
  check('delivery note INVOICED with invoice number', dnAfter.status === 'INVOICED' && dnAfter.invoiceNo === dnInvoice.invoiceNo);
  check('cancel invoiced delivery note rejected (409)', (await call('PATCH', `delivery-notes/${dn.id}/status`, { status: 'CANCELLED' })).status === 409);
  await call('PATCH', `invoices/${dnInvoice.id}/status`, { status: 'CANCELLED' });
  check('cancelling the invoice frees the delivery note (SUBMITTED)', data(await call('GET', `delivery-notes/${dn.id}`)).status === 'SUBMITTED');
  check('delivery note can be re-invoiced after cancel', (await call('POST', `invoices/from-delivery-note/${dn.id}`)).status === 201);
  const soInvoice = await expectOk('invoice from sales order', call('POST', `invoices/from-sales-order/${order.id}`));
  check('sales order invoice total 520 (400+20 VAT + 100)', near(data(soInvoice)?.grandTotal, 520), data(soInvoice)?.grandTotal);
  check('duplicate invoice from same sales order rejected (409)', (await call('POST', `invoices/from-sales-order/${order.id}`)).status === 409);

  console.log('\nCancel / amend');
  const toCancel = data(await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', items: [line(productB, 1)] }));
  await call('PATCH', `invoices/${toCancel.id}/status`, { status: 'SUBMITTED' });
  check('cancel paid/partial invoice rejected (409)', (await call('PATCH', `invoices/${inv3.id}/status`, { status: 'CANCELLED' })).status === 409);
  const cancelled = data(await expectOk('cancel submitted invoice', call('PATCH', `invoices/${toCancel.id}/status`, { status: 'CANCELLED', reason: 'wrong buyer' })));
  check('cancelled invoice outstanding 0', cancelled.status === 'CANCELLED' && near(cancelled.outstandingAmount, 0));
  const reversal = data(await call('GET', `invoicing/ledger?search=${toCancel.invoiceNo}&voucherType=INVOICE_REVERSAL`));
  check('reversal posted: Cr AR 50', reversal.items.some(r => r.account.code === '1100' && near(r.credit, 50)));
  const amended = data(await expectOk('amend cancelled invoice', call('POST', `invoices/${toCancel.id}/amend`)));
  check('amended draft has new number and link', amended.status === 'DRAFT' && amended.invoiceNo !== toCancel.invoiceNo && amended.amendedFromId === toCancel.id);
  check('second amend rejected (409)', (await call('POST', `invoices/${toCancel.id}/amend`)).status === 409);

  console.log('\nSubscriptions (recurring invoices)');
  const start = addMonths(today, -2);
  const sub = data(await expectOk('create monthly subscription starting 2 months ago', call('POST', 'invoicing/subscriptions', { name: `${RUN} Retainer`, customerId: customer.id, frequency: 'MONTHLY', startDate: start, nextRunDate: start, currency: 'USD', autoSubmit: true, items: [line(productB, 1)] })));
  check('subscription stores priced amount 50', near(sub.amount, 50));
  const runs = await Promise.all([1, 2, 3].map(() => call('POST', 'invoicing/subscriptions/run-due')));
  const subAfter = data(await call('GET', `invoicing/subscriptions/${sub.id}`));
  const generated = subAfter.generatedInvoices || [];
  check('3 concurrent run-due calls generated exactly 3 runs (no duplicates)', generated.length === 3 && new Set(generated.map(g => g.runDate)).size === 3, generated.map(g => g.runDate));
  check('run-due responses all 200', runs.every(r => r.status === 200), runs.map(r => r.status));
  check('next run moved into the future', subAfter.nextRunDate > today, subAfter.nextRunDate);
  const subInvoices = data(await call('GET', `invoices?customerId=${customer.id}&search=${encodeURIComponent(`${RUN} Retainer`)}&limit=50`));
  check('generated invoices auto-submitted', subInvoices.items.length === 3 && subInvoices.items.every(row => row.status === 'SUBMITTED'), subInvoices.items.map(r => r.status));
  const rerun = data(await call('POST', 'invoicing/subscriptions/run-due'));
  check('re-running generates nothing new for this subscription', !rerun.invoices.some(row => row.subscription === `${RUN} Retainer`));
  await expectOk('pause subscription', call('PATCH', `invoicing/subscriptions/${sub.id}`, { isActive: false }));

  console.log('\nTax template / print format effects');
  await expectOk('disable compound template', call('DELETE', `invoicing/tax-templates/${compound.id}`));
  const usesDisabled = await call('POST', 'invoices', { customerId: customer.id, date: today, currency: 'USD', items: [line(productA, 1, { taxTemplateId: compound.id })] });
  check('invoice with disabled template rejected (400)', usesDisabled.status === 400, usesDisabled.body);
  const pdf = await call('GET', `invoices/${invoice.id}/pdf?printFormatId=${format.id}`);
  const pdfText = Buffer.isBuffer(pdf.body) ? pdf.body.toString('latin1') : '';
  check('PDF returned as application/pdf', pdf.status === 200 && (pdf.headers.get('content-type') || '').includes('application/pdf') && pdfText.startsWith('%PDF-'), pdf.status);
  check('PDF contains invoice number, customer, format title & footer', pdfText.includes(invoice.invoiceNo) && pdfText.includes(`${RUN} Customer LLC`) && pdfText.includes(`${RUN} PROFORMA`) && pdfText.includes(`${RUN} FOOTER TEXT`));
  check('PDF contains saved totals and export fields', pdfText.includes('349.80') && pdfText.includes(`${RUN}-BKG`) && pdfText.includes('FOB') && pdfText.includes('Amount in words'));
  check('PDF letterhead hidden when format Logo is OFF', !pdfText.includes('Your Company Name') && !pdfText.includes('INVOICE_SELLER_NAME'));
  const pdfDefault = await call('GET', `invoices/${invoice.id}/pdf`);
  check('PDF without format falls back to default/system layout', pdfDefault.status === 200 && !pdfDefault.body.toString('latin1').includes(`${RUN} PROFORMA`));
  check('PDF with disabled format rejected (400)', (await call('GET', `invoices/${invoice.id}/pdf?printFormatId=${disabledFormat.id}`)).status === 400);
  const pdfOut = path.resolve(String(args['pdf-out'] || 'tmp/verify-invoice.pdf'));
  mkdirSync(path.dirname(pdfOut), { recursive: true });
  writeFileSync(pdfOut, pdf.body);
  console.log(`  (PDF saved to ${pdfOut})`);

  console.log('\nReports');
  const outstanding = await call('GET', `invoicing/reports/outstanding?customerId=${customer.id}`);
  const openInvoices = data(await call('GET', `invoices?status=OPEN&customerId=${customer.id}&limit=500`)).items;
  const expectedOutstanding = openInvoices.reduce((sum, row) => sum + Number(row.outstandingAmount), 0);
  check('outstanding report total = sum of open invoice balances', near(outstanding.body.totals.outstandingAmount, expectedOutstanding) && outstanding.body.totals.invoiceCount === openInvoices.length, { report: outstanding.body.totals, expected: expectedOutstanding });
  const aging = await call('GET', `invoices/aging-report?customerId=${customer.id}&asOfDate=${today}`);
  check('aging total = outstanding total', near(aging.body.totals.totalOutstanding, expectedOutstanding), aging.body.totals);
  const agingFuture = await call('GET', `invoicing/reports/aging?customerId=${customer.id}&asOfDate=${addDays(today, 45)}`);
  check('aging as-of +45 days moves 30-day invoices into 0-30 bucket', agingFuture.body.totals.days0To30 > 0, agingFuture.body.totals);
  const revenue = await call('GET', `invoicing/reports/revenue-by-customer?customerId=${customer.id}`);
  const posted = data(await call('GET', `invoices?customerId=${customer.id}&limit=500`)).items.filter(row => ['SUBMITTED', 'PARTIAL', 'PAID', 'CREDITED'].includes(row.status));
  const expectedRevenue = posted.reduce((sum, row) => sum + Number(row.grandTotal) - Number(row.creditAmount || 0), 0);
  check('revenue-by-customer = posted totals - credits', near(revenue.body.totals.revenue, expectedRevenue), { report: revenue.body.totals.revenue, expected: expectedRevenue });
  const revenueFuture = await call('GET', `invoicing/reports/revenue-by-period?customerId=${customer.id}&fromDate=${addDays(today, 1)}`);
  check('date filter excludes everything after today', revenueFuture.body.totals.invoiceCount === 0);
  const byItem = await call('GET', `invoicing/reports/revenue-by-item?customerId=${customer.id}`);
  check('revenue-by-item subtracts credited item amounts', byItem.body.data.rows.some(row => row.productId === productA.id && row.creditAmount > 0));

  console.log('\nLedger balance & audit log');
  const ledgerAll = await call('GET', 'invoicing/ledger?limit=1');
  check('whole ledger balances (debits = credits)', near(ledgerAll.body.totals.debit, ledgerAll.body.totals.credit), ledgerAll.body.totals);
  const auditRows = data(await call('GET', `invoicing/audit-logs?entityId=${invoice.id}&limit=50`)).items;
  const actions = new Set(auditRows.map(row => row.action));
  check('audit has CREATE, UPDATE, SUBMIT for the invoice', ['CREATE', 'UPDATE', 'SUBMIT'].every(action => actions.has(action)), [...actions]);
  check('audit records actor email', auditRows.every(row => row.actorEmail === 'verify@local.test'));
  const payAudit = data(await call('GET', `invoicing/audit-logs?entityType=PAYMENT&search=${invoice.invoiceNo}`)).items;
  check('audit has PAYMENT and CANCEL events for payments', payAudit.some(row => row.action === 'PAYMENT') && payAudit.some(row => row.action === 'CANCEL'));
  const cancelAudit = data(await call('GET', `invoicing/audit-logs?entityId=${toCancel.id}`)).items;
  check('audit has CANCEL for the cancelled invoice', cancelAudit.some(row => row.action === 'CANCEL' && row.statusAfter === 'CANCELLED'));

  console.log('\nPagination & errors');
  const page1 = data(await call('GET', `invoices?customerId=${customer.id}&limit=5&page=1`));
  const page2 = data(await call('GET', `invoices?customerId=${customer.id}&limit=5&page=2`));
  check('pagination returns distinct pages and totals', page1.items.length === 5 && page2.items.length > 0 && !page2.items.some(row => page1.items.some(other => other.id === row.id)) && page1.total === page2.total && page1.totalPages >= 2);
  check('unknown invoice -> 404', (await call('GET', 'invoices/does-not-exist')).status === 404);
  check('unknown route -> 404', (await call('GET', 'invoicing/nope')).status === 404);
  const badJson = await fetch(`${BASE}/invoices`, { method: 'POST', headers: HEADERS, body: '{bad json' });
  check('invalid JSON -> 400', badJson.status === 400);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('Failed checks:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch(error => { console.error('Verification crashed:', error); process.exit(1); });
