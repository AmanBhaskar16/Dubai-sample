import type { ClientSession, Db } from 'mongodb';
import { badRequest, round2, type Doc } from './core';
import { C } from './indexes.mjs';

export type TaxLine = { label: string; rate: number; chargeType: string; isRecoverable?: boolean };

/**
 * Applies a tax template to a net amount, honouring ERPNext-style charge types:
 *  - ON_NET_TOTAL: rate x net
 *  - ON_PREVIOUS_ROW_AMOUNT: rate x previous row's tax amount
 *  - ON_PREVIOUS_ROW_TOTAL: rate x (net + all tax up to the previous row)
 */
export function applyTemplate(net: number, lines: TaxLine[]) {
  const breakdown: Array<{ label: string; rate: number; chargeType: string; amount: number }> = [];
  let running = net;
  let previousAmount = 0;
  for (const line of lines) {
    const rate = Number(line.rate || 0);
    const base = line.chargeType === 'ON_PREVIOUS_ROW_AMOUNT' ? previousAmount : line.chargeType === 'ON_PREVIOUS_ROW_TOTAL' ? running : net;
    const amount = (base * rate) / 100;
    breakdown.push({ label: line.label, rate, chargeType: line.chargeType, amount: round2(amount) });
    previousAmount = amount;
    running += amount;
  }
  const tax = running - net;
  return { tax, breakdown, effectiveRate: net > 0 ? (tax / net) * 100 : lines.reduce((sum, line) => sum + (line.chargeType === 'ON_NET_TOTAL' ? Number(line.rate || 0) : 0), 0) };
}

type ItemInput = { productId?: string; itemCode?: string; description?: string; quantity: number; unitPrice: number; discount?: number; taxRate?: number; taxTemplateId?: string };

/**
 * Server-side source of truth for line and document totals. Validates that
 * referenced products and tax templates exist and are active; a selected tax
 * template overrides any manually typed rate.
 */
export async function priceItems(db: Db, rawItems: ItemInput[], session?: ClientSession) {
  const productIds = [...new Set(rawItems.map(item => item.productId).filter(Boolean))] as string[];
  const templateIds = [...new Set(rawItems.map(item => item.taxTemplateId).filter(Boolean))] as string[];
  const [products, templates] = await Promise.all([
    productIds.length ? db.collection<Doc>(C.products).find({ _id: { $in: productIds } }, { session }).toArray() : [],
    templateIds.length ? db.collection<Doc>(C.taxTemplates).find({ _id: { $in: templateIds } }, { session }).toArray() : [],
  ]);
  const productMap = new Map(products.map(product => [String(product._id), product]));
  const templateMap = new Map(templates.map(template => [String(template._id), template]));

  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  const items = rawItems.map((item, index) => {
    const product = item.productId ? productMap.get(item.productId) : undefined;
    if (item.productId && !product) throw badRequest(`Line ${index + 1}: product no longer exists. Pick another product.`);
    if (product && product.isActive === false) throw badRequest(`Line ${index + 1}: product "${product.name}" is inactive.`);
    const template = item.taxTemplateId ? templateMap.get(item.taxTemplateId) : undefined;
    if (item.taxTemplateId && !template) throw badRequest(`Line ${index + 1}: tax template no longer exists.`);
    if (template && template.isActive === false) throw badRequest(`Line ${index + 1}: tax template "${template.name}" is inactive.`);

    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    const discount = Number(item.discount || 0);
    const gross = quantity * unitPrice;
    const discountAmount = (gross * discount) / 100;
    const net = gross - discountAmount;
    let taxAmount: number;
    let taxRate: number;
    let taxBreakdown: Array<{ label: string; rate: number; chargeType: string; amount: number }> | undefined;
    if (template) {
      const applied = applyTemplate(net, template.lines || []);
      taxAmount = applied.tax;
      taxRate = round2(applied.effectiveRate);
      taxBreakdown = applied.breakdown;
    } else {
      taxRate = Number(item.taxRate || 0);
      taxAmount = (net * taxRate) / 100;
    }
    subtotal += net;
    discountTotal += discountAmount;
    taxTotal += taxAmount;
    return {
      productId: item.productId || undefined,
      itemCode: item.itemCode || product?.sku || undefined,
      description: item.description || product?.name || item.itemCode || 'Item',
      quantity,
      unitPrice,
      rate: unitPrice,
      discount,
      taxRate,
      taxTemplateId: template ? String(template._id) : undefined,
      taxTemplate: template ? { id: String(template._id), name: template.name, code: template.code } : undefined,
      taxBreakdown,
      netAmount: round2(net),
      taxAmount: round2(taxAmount),
      total: round2(net + taxAmount),
    };
  });
  // Round the components first so subtotal + tax always equals the total and
  // the ledger posting (Dr receivable / Cr revenue + tax) balances to the cent.
  const roundedSubtotal = round2(subtotal);
  const roundedTax = round2(taxTotal);
  const total = round2(roundedSubtotal + roundedTax);
  return { items, subtotal: roundedSubtotal, discount: round2(discountTotal), taxAmount: roundedTax, total, grandTotal: total };
}
