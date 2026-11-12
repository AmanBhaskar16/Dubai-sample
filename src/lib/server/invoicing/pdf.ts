import type { Db } from 'mongodb';
import { badRequest, round2, type Doc } from './core';
import { C } from './indexes.mjs';
import { invoiceDetail } from './invoices';

/**
 * Dependency-free PDF writer (PDF 1.4, standard Helvetica fonts, A4).
 * Content streams are uncompressed so the generated text can be verified
 * with any PDF text extractor.
 */
class PdfDoc {
  private pages: string[][] = [];
  private current: string[] = [];
  readonly width = 595;
  readonly height = 842;
  readonly margin = 40;
  y = 0;

  constructor() { this.newPage(); }

  newPage() {
    this.current = [];
    this.pages.push(this.current);
    this.y = this.height - this.margin;
  }

  ensure(space: number) {
    if (this.y - space < this.margin + 30) this.newPage();
  }

  text(x: number, y: number, value: string, size = 9, bold = false) {
    this.current.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escape(value)}) Tj ET`);
  }

  /** Approximate Helvetica width; digits are 0.556 em, average text ~0.5 em. */
  measure(value: string, size: number) {
    let units = 0;
    for (const char of value) units += /[0-9.,]/.test(char) ? 0.556 : /[A-Z]/.test(char) ? 0.667 : char === ' ' ? 0.278 : 0.5;
    return units * size;
  }

  right(xRight: number, y: number, value: string, size = 9, bold = false) {
    this.text(xRight - this.measure(value, size), y, value, size, bold);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5) {
    this.current.push(`${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  fillRect(x: number, y: number, w: number, h: number, gray = 0.93) {
    this.current.push(`${gray} g ${x} ${y} ${w} ${h} re f 0 g`);
  }

  /** Wraps text to a width; returns the lines. */
  wrap(value: string, size: number, maxWidth: number) {
    const words = String(value || '').split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (this.measure(candidate, size) > maxWidth && line) { lines.push(line); line = word; } else line = candidate;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  build(footerText: (page: number, total: number) => string) {
    const total = this.pages.length;
    this.pages.forEach((page, index) => {
      const footer = footerText(index + 1, total);
      page.push(`BT /F1 7 Tf ${this.margin} 22 Td (${escape(footer)}) Tj ET`);
    });
    const objects: string[] = [];
    const add = (body: string) => { objects.push(body); return objects.length; };
    const catalog = add('');
    const pagesObj = add('');
    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pageIds: number[] = [];
    for (const page of this.pages) {
      const stream = `${page.join('\n')}\n`;
      const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentId} 0 R >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info << /Producer (WMS Desk Invoicing) >> >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }
}

function escape(value: string) {
  // WinAnsi covers Latin-1; anything else is transliterated or replaced.
  return String(value ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .replace(/[\\()]/g, '\\$&');
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) parts.push(rest < 20 ? ONES[rest] : `${TENS[Math.floor(rest / 10)]}${rest % 10 ? `-${ONES[rest % 10]}` : ''}`);
  return parts.join(' ');
}
export function amountInWords(amount: number, currency: string) {
  const whole = Math.floor(round2(amount));
  const cents = Math.round((round2(amount) - whole) * 100);
  const scales = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];
  const chunks: string[] = [];
  let remaining = whole;
  let scale = 0;
  while (remaining > 0 && scale < scales.length) {
    const chunk = remaining % 1000;
    if (chunk) chunks.unshift(`${belowThousand(chunk)}${scales[scale] ? ` ${scales[scale]}` : ''}`);
    remaining = Math.floor(remaining / 1000);
    scale += 1;
  }
  const words = chunks.join(' ') || 'Zero';
  return `${currency} ${words}${cents ? ` and ${String(cents).padStart(2, '0')}/100` : ''} Only`;
}

const money = (value: unknown) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function resolvePrintFormat(db: Db, printFormatId?: string | null) {
  const formats = db.collection<Doc>(C.printFormats);
  if (printFormatId) {
    const format = await formats.findOne({ _id: printFormatId });
    if (!format) throw badRequest('Selected print format no longer exists.');
    if (format.isActive === false) throw badRequest(`Print format "${format.name}" is disabled. Enable it or pick another format.`);
    if (format.docType !== 'SALES_INVOICE') throw badRequest(`Print format "${format.name}" is for ${format.docType}, not sales invoices.`);
    return format;
  }
  return formats.findOne({ docType: 'SALES_INVOICE', isDefault: true, isActive: { $ne: false } });
}

export async function renderInvoicePdf(db: Db, invoiceId: string, printFormatId?: string | null) {
  const invoice = await invoiceDetail(db, invoiceId);
  const format = await resolvePrintFormat(db, printFormatId);
  const template: Doc = { showLogo: true, showHsnSummary: true, showAmountInWords: true, showPaymentTerms: true, ...(format?.template || {}) };
  const title = String(template.title || format?.title || 'COMMERCIAL INVOICE').toUpperCase();
  const customer: Doc = invoice.customer || {};
  const currency = invoice.currency || 'USD';
  const pdf = new PdfDoc();
  const left = pdf.margin;
  const right = pdf.width - pdf.margin;

  // Letterhead
  if (template.showLogo !== false) {
    pdf.fillRect(left, pdf.y - 34, right - left, 40, 0.94);
    pdf.text(left + 10, pdf.y - 12, process.env.INVOICE_SELLER_NAME || 'Your Company Name', 13, true);
    pdf.text(left + 10, pdf.y - 26, process.env.INVOICE_SELLER_ADDRESS || 'Set INVOICE_SELLER_NAME / INVOICE_SELLER_ADDRESS in .env.local', 8);
    if (process.env.INVOICE_SELLER_TAX_ID) pdf.right(right - 10, pdf.y - 26, `TRN: ${process.env.INVOICE_SELLER_TAX_ID}`, 8);
    pdf.y -= 52;
  }
  pdf.text(left, pdf.y, title, 16, true);
  const statusLabel = invoice.status === 'DRAFT' ? 'DRAFT - NOT A VALID TAX DOCUMENT' : invoice.status === 'CANCELLED' ? 'CANCELLED' : String(invoice.status);
  pdf.right(right, pdf.y, statusLabel, 9, true);
  pdf.y -= 22;

  // Header blocks
  const meta: Array<[string, string]> = [
    ['Invoice No', invoice.invoiceNo],
    ['Invoice Date', String(invoice.date || '').slice(0, 10)],
    ['Due Date', String(invoice.dueDate || '-').slice(0, 10)],
    ['Currency', currency],
    ['Customer PO', invoice.customerPoNo || '-'],
    ['Reference', invoice.reference || '-'],
  ];
  const billTo = [customer.name || '-', customer.customerNo ? `Customer No: ${customer.customerNo}` : '', customer.address || '', [customer.city, customer.country].filter(Boolean).join(', '), customer.email || '', customer.taxId ? `Tax ID: ${customer.taxId}` : ''].filter(Boolean);
  const top = pdf.y;
  pdf.text(left, top, 'BILL TO', 8, true);
  billTo.forEach((line, index) => pdf.text(left, top - 13 - index * 11, line, 9, index === 0));
  meta.forEach(([label, value], index) => {
    pdf.text(330, top - index * 12, label, 8, true);
    pdf.text(420, top - index * 12, String(value), 9);
  });
  pdf.y = top - Math.max(billTo.length * 11 + 16, meta.length * 12 + 6);

  // Shipment / export block
  const shipment: Array<[string, unknown]> = [
    ['Shipment Ref', invoice.shipmentReference], ['Incoterms', invoice.incoterms], ['Origin', invoice.countryOfOrigin], ['Destination', invoice.countryOfDestination],
    ['Port of Loading', invoice.portOfLoading], ['Port of Discharge', invoice.portOfDischarge], ['Packages', invoice.packageCount],
    ['Gross Wt (kg)', invoice.grossWeight], ['Net Wt (kg)', invoice.netWeight],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '') as Array<[string, unknown]>;
  if (shipment.length) {
    pdf.line(left, pdf.y, right, pdf.y);
    pdf.y -= 12;
    pdf.text(left, pdf.y, 'SHIPMENT DETAILS', 8, true);
    pdf.y -= 12;
    shipment.forEach(([label, value], index) => {
      const column = index % 3;
      const x = left + column * 172;
      pdf.text(x, pdf.y, `${label}:`, 8, true);
      pdf.text(x + 72, pdf.y, String(value), 8);
      if (column === 2 || index === shipment.length - 1) pdf.y -= 11;
    });
    pdf.y -= 4;
  }

  // Items table
  const cols = { item: left + 4, qty: 330, rate: 395, tax: 440, amount: right - 4 };
  const header = () => {
    pdf.fillRect(left, pdf.y - 4, right - left, 16, 0.88);
    pdf.text(cols.item, pdf.y, '#  Item / Description', 8, true);
    pdf.right(cols.qty, pdf.y, 'Qty', 8, true);
    pdf.right(cols.rate, pdf.y, 'Rate', 8, true);
    pdf.right(cols.tax + 25, pdf.y, 'Disc/Tax', 8, true);
    pdf.right(cols.amount, pdf.y, `Amount (${currency})`, 8, true);
    pdf.y -= 18;
  };
  pdf.ensure(40);
  header();
  (invoice.items || []).forEach((item: Doc, index: number) => {
    const description = `${index + 1}.  ${item.itemCode ? `[${item.itemCode}] ` : ''}${item.description || 'Item'}`;
    const lines = pdf.wrap(description, 8.5, cols.qty - cols.item - 50);
    pdf.ensure(lines.length * 11 + 6);
    if (pdf.y > pdf.height - pdf.margin - 5) header();
    pdf.text(cols.item, pdf.y, lines[0], 8.5);
    pdf.right(cols.qty, pdf.y, String(item.quantity), 8.5);
    pdf.right(cols.rate, pdf.y, money(item.unitPrice), 8.5);
    pdf.right(cols.tax + 25, pdf.y, `${Number(item.discount || 0) ? `${item.discount}% / ` : ''}${item.taxRate}%`, 8);
    pdf.right(cols.amount, pdf.y, money(item.total), 8.5);
    lines.slice(1).forEach((line, lineIndex) => pdf.text(cols.item + 14, pdf.y - 11 * (lineIndex + 1), line, 8.5));
    pdf.y -= lines.length * 11 + 3;
    pdf.line(left, pdf.y + 4, right, pdf.y + 4, 0.2);
  });

  // Totals
  pdf.ensure(110);
  pdf.y -= 6;
  const totals: Array<[string, number, boolean?]> = [
    ['Subtotal (net of discount)', invoice.subtotal],
    ['Discount', invoice.discount],
    ['Tax', invoice.taxAmount],
    ['Grand Total', invoice.grandTotal ?? invoice.total, true],
  ];
  if (Number(invoice.amountPaid || 0) > 0) totals.push(['Paid', invoice.amountPaid]);
  if (Number(invoice.creditAmount || 0) > 0) totals.push(['Credited', invoice.creditAmount]);
  if (invoice.status !== 'DRAFT') totals.push(['Balance Due', invoice.outstandingAmount, true]);
  totals.forEach(([label, value, strong]) => {
    pdf.text(350, pdf.y, label, 9, Boolean(strong));
    pdf.right(right - 4, pdf.y, `${currency} ${money(value)}`, 9, Boolean(strong));
    pdf.y -= 13;
  });

  if (template.showAmountInWords !== false) {
    pdf.y -= 4;
    const words = pdf.wrap(`Amount in words: ${amountInWords(Number(invoice.grandTotal ?? invoice.total ?? 0), currency)}`, 8.5, right - left);
    words.forEach(line => { pdf.ensure(12); pdf.text(left, pdf.y, line, 8.5, true); pdf.y -= 11; });
  }

  // Tax summary (by rate / template)
  if (template.showHsnSummary !== false) {
    const summary = new Map<string, { taxable: number; tax: number }>();
    for (const item of invoice.items || []) {
      const key = item.taxTemplate?.code ? `${item.taxTemplate.code} (${item.taxRate}%)` : `${item.taxRate}%`;
      const row = summary.get(key) || { taxable: 0, tax: 0 };
      row.taxable += Number(item.netAmount ?? item.quantity * item.unitPrice * (1 - Number(item.discount || 0) / 100));
      row.tax += Number(item.taxAmount ?? 0);
      summary.set(key, row);
    }
    pdf.ensure(30 + summary.size * 11);
    pdf.y -= 8;
    pdf.text(left, pdf.y, 'TAX SUMMARY', 8, true);
    pdf.right(300, pdf.y, 'Taxable', 8, true);
    pdf.right(380, pdf.y, 'Tax', 8, true);
    pdf.y -= 11;
    for (const [key, row] of summary) {
      pdf.text(left, pdf.y, key, 8.5);
      pdf.right(300, pdf.y, money(row.taxable), 8.5);
      pdf.right(380, pdf.y, money(row.tax), 8.5);
      pdf.y -= 11;
    }
  }

  if (template.showPaymentTerms !== false) {
    pdf.y -= 6;
    const terms = [`Payment due by ${String(invoice.dueDate || '-').slice(0, 10)}.`, invoice.terms ? `Terms: ${invoice.terms}` : ''].filter(Boolean).join(' ');
    pdf.wrap(terms, 8.5, right - left).forEach(line => { pdf.ensure(12); pdf.text(left, pdf.y, line, 8.5); pdf.y -= 11; });
  }
  if (invoice.notes) pdf.wrap(`Notes: ${invoice.notes}`, 8.5, right - left).forEach(line => { pdf.ensure(12); pdf.text(left, pdf.y, line, 8.5); pdf.y -= 11; });
  if (format?.footer) {
    pdf.y -= 8;
    pdf.wrap(format.footer, 8.5, right - left).forEach(line => { pdf.ensure(12); pdf.text(left, pdf.y, line, 8.5); pdf.y -= 11; });
  }

  const bytes = pdf.build((page, total) => `${invoice.invoiceNo} | ${format ? `Format: ${format.name}` : 'System default format'} | Page ${page} of ${total}`);
  return { bytes, filename: `${String(invoice.invoiceNo).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`, format: format ? format.name : 'System default' };
}
