import { z } from 'zod';
import { badRequest } from './core';

const blankToUndefined = (value: unknown) => (value === '' || value === null ? undefined : value);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'must be a date (YYYY-MM-DD)')
  .refine(value => !Number.isNaN(Date.parse(value.slice(0, 10))), 'must be a valid date')
  .transform(value => value.slice(0, 10));
const optionalDate = z.preprocess(blankToUndefined, isoDate.optional());
const text = (max = 200) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const requiredText = (label: string, max = 200) => z.string({ error: `${label} is required` }).trim().min(1, `${label} is required`).max(max);
const id = (label: string) => z.string({ error: `${label} is required` }).trim().min(1, `${label} is required`).max(100);
const optionalId = z.preprocess(blankToUndefined, z.string().trim().max(100).optional());
const money = (label: string) => z.coerce.number({ error: `${label} must be a number` }).finite();
const optionalNonNegative = (label: string) => z.preprocess(blankToUndefined, z.coerce.number().finite().min(0, `${label} cannot be negative`).optional());
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code');

export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'CREDIT_CARD', 'CHEQUE', 'ONLINE'] as const;

export const lineItemSchema = z.object({
  productId: optionalId,
  itemCode: text(100),
  description: text(500),
  quantity: money('Quantity').refine(value => value > 0, 'Quantity must be greater than zero'),
  unitPrice: money('Unit price').min(0, 'Unit price cannot be negative'),
  discount: z.preprocess(blankToUndefined, money('Discount').min(0, 'Discount cannot be negative').max(100, 'Discount cannot exceed 100%').default(0)),
  taxRate: z.preprocess(blankToUndefined, money('Tax rate').min(0, 'Tax rate cannot be negative').max(100, 'Tax rate cannot exceed 100%').default(0)),
  taxTemplateId: optionalId,
}).refine(item => item.productId || item.itemCode || item.description, 'Each line needs a product, item code or description');

const items = z.array(lineItemSchema, { error: 'Line items are required' }).min(1, 'Add at least one line item').max(300, 'Too many line items');

const invoiceFields = {
  customerId: id('Customer'),
  date: isoDate,
  dueDate: optionalDate,
  currency,
  reference: text(),
  customerPoNo: text(),
  shipmentReference: text(),
  countryOfOrigin: text(100),
  countryOfDestination: text(100),
  portOfLoading: text(150),
  portOfDischarge: text(150),
  incoterms: text(30),
  grossWeight: optionalNonNegative('Gross weight'),
  netWeight: optionalNonNegative('Net weight'),
  packageCount: z.preprocess(blankToUndefined, z.coerce.number().int('Packages must be a whole number').min(0, 'Packages cannot be negative').optional()),
  notes: text(2000),
  terms: text(2000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  items,
};

function checkInvoiceRules(value: { date?: string; dueDate?: string; grossWeight?: number; netWeight?: number }, ctx: z.RefinementCtx) {
  if (value.date && value.dueDate && value.dueDate < value.date) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Due date cannot be before the invoice date' });
  if (value.grossWeight != null && value.netWeight != null && value.netWeight > value.grossWeight) ctx.addIssue({ code: 'custom', path: ['netWeight'], message: 'Net weight cannot exceed gross weight' });
}

export const invoiceCreateSchema = z.object(invoiceFields).superRefine(checkInvoiceRules);
export const invoiceUpdateSchema = z.object(invoiceFields).partial().superRefine(checkInvoiceRules);

export const paymentSchema = z.object({
  invoiceId: id('Invoice'),
  amount: z.coerce.number({ error: 'Amount must be a number' }).finite().refine(value => value > 0, 'Payment amount must be greater than zero'),
  date: z.preprocess(blankToUndefined, isoDate.optional()),
  method: z.enum(PAYMENT_METHODS, { error: 'Select a valid payment method' }).default('BANK_TRANSFER'),
  reference: text(),
  notes: text(1000),
});

export const paymentEntrySchema = z.object({
  customerId: id('Customer'),
  paidAmount: z.coerce.number({ error: 'Paid amount must be a number' }).finite().refine(value => value > 0, 'Paid amount must be greater than zero'),
  method: z.enum(PAYMENT_METHODS, { error: 'Select a valid payment method' }).default('BANK_TRANSFER'),
  reference: text(),
  notes: text(1000),
  date: z.preprocess(blankToUndefined, isoDate.optional()),
  currency: z.preprocess(blankToUndefined, currency.optional()),
  allocations: z.array(z.object({
    invoiceId: id('Allocation invoice'),
    allocatedAmount: z.coerce.number().finite().refine(value => value > 0, 'Allocated amount must be greater than zero'),
  })).max(100).default([]),
});

export const CREDIT_REASONS = ['SALES_RETURN', 'RATE_ADJUSTMENT', 'DISCOUNT', 'TAX_CORRECTION', 'FULL_REVERSAL', 'OTHER'] as const;
export const creditNoteSchema = z.object({
  reason: z.enum(CREDIT_REASONS).default('OTHER'),
  date: z.preprocess(blankToUndefined, isoDate.optional()),
  notes: text(2000),
  items,
});

export const deliveryNoteSchema = z.object({
  customerId: id('Customer'),
  salesOrderId: optionalId,
  warehouseId: optionalId,
  date: isoDate,
  postingDate: optionalDate,
  notes: text(2000),
  items: z.array(z.object({
    productId: id('Product'),
    itemCode: text(100),
    description: text(500),
    quantity: money('Quantity').refine(value => value > 0, 'Quantity must be greater than zero'),
    unitPrice: z.preprocess(blankToUndefined, money('Unit price').min(0).optional()),
    taxRate: z.preprocess(blankToUndefined, money('Tax rate').min(0).max(100).optional()),
    taxTemplateId: optionalId,
    discount: z.preprocess(blankToUndefined, money('Discount').min(0).max(100).optional()),
  })).min(1, 'Add at least one product to deliver').max(300),
});

export const taxTemplateSchema = z.object({
  name: requiredText('Template name'),
  code: requiredText('Template code', 50).transform(value => value.toUpperCase()),
  scope: z.enum(['ITEM', 'INVOICE', 'BOTH', 'SALES']).default('BOTH'),
  description: text(1000),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  lines: z.array(z.object({
    label: requiredText('Tax row label', 50),
    rate: z.coerce.number().finite().min(0, 'Tax rate cannot be negative').max(100, 'Tax rate cannot exceed 100%'),
    chargeType: z.enum(['ON_NET_TOTAL', 'ON_PREVIOUS_ROW_AMOUNT', 'ON_PREVIOUS_ROW_TOTAL']).default('ON_NET_TOTAL'),
    isRecoverable: z.boolean().default(false),
  })).min(1, 'Add at least one tax row').max(10),
}).superRefine((value, ctx) => {
  if (value.lines[0] && value.lines[0].chargeType !== 'ON_NET_TOTAL') ctx.addIssue({ code: 'custom', path: ['lines', 0, 'chargeType'], message: 'The first tax row must be charged on net total' });
});

export const PRINT_DOC_TYPES = ['SALES_INVOICE', 'CREDIT_NOTE', 'PAYMENT_ENTRY'] as const;
export const printFormatSchema = z.object({
  name: requiredText('Format name', 120),
  docType: z.enum(PRINT_DOC_TYPES).default('SALES_INVOICE'),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  footer: text(1000),
  template: z.object({
    title: text(80),
    sections: z.array(z.string().max(40)).max(20).optional(),
    showLogo: z.boolean().default(true),
    showHsnSummary: z.boolean().default(true),
    showAmountInWords: z.boolean().default(true),
    showPaymentTerms: z.boolean().default(true),
  }).default({ showLogo: true, showHsnSummary: true, showAmountInWords: true, showPaymentTerms: true }),
});

export const FREQUENCIES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export const subscriptionSchema = z.object({
  name: requiredText('Subscription name', 150),
  customerId: id('Customer'),
  frequency: z.enum(FREQUENCIES).default('MONTHLY'),
  startDate: isoDate,
  nextRunDate: isoDate,
  endDate: optionalDate,
  currency,
  autoSubmit: z.boolean().default(false),
  isActive: z.boolean().default(true),
  notes: text(2000),
  terms: text(2000),
  items,
}).superRefine((value, ctx) => {
  if (value.nextRunDate < value.startDate) ctx.addIssue({ code: 'custom', path: ['nextRunDate'], message: 'Next run date cannot be before the start date' });
  if (value.endDate && value.endDate < value.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date cannot be before the start date' });
});

export const customerSchema = z.object({
  name: requiredText('Customer name', 200),
  email: z.preprocess(blankToUndefined, z.string().trim().email('Enter a valid email').max(200).optional()),
  phone: text(50),
  address: text(500),
  city: text(100),
  state: text(100),
  country: text(100),
  postalCode: text(20),
  taxId: text(50),
  currency: z.preprocess(blankToUndefined, currency.default('USD')),
  creditLimit: z.preprocess(blankToUndefined, z.coerce.number().finite().min(0, 'Credit limit cannot be negative').default(0)),
  paymentTerms: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(365).default(30)),
  notes: text(2000),
  isActive: z.boolean().optional(),
}).passthrough();

export const productSchema = z.object({
  name: requiredText('Product name', 200),
  sku: z.preprocess(blankToUndefined, z.string().trim().max(60).optional()),
  description: text(1000),
  salePrice: z.preprocess(blankToUndefined, z.coerce.number().finite().min(0, 'Sale price cannot be negative').default(0)),
  taxRate: z.preprocess(blankToUndefined, z.coerce.number().finite().min(0).max(100).default(0)),
  defaultTaxTemplateId: optionalId,
  type: z.preprocess(blankToUndefined, z.string().max(30).default('PRODUCT')),
  isActive: z.boolean().optional(),
}).passthrough();

export const warehouseSchema = z.object({
  name: requiredText('Warehouse name', 150),
  code: z.preprocess(blankToUndefined, z.string().trim().max(30).optional()),
  address: text(500),
  isActive: z.boolean().optional(),
}).passthrough();

export const SALES_ORDER_STATUSES = ['DRAFT', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'ON_HOLD', 'CLOSED', 'CANCELLED'] as const;
export const salesOrderSchema = z.object({
  customerId: id('Customer'),
  date: isoDate,
  deliveryDate: optionalDate,
  currency,
  notes: text(2000),
  terms: text(2000),
  items,
});

export function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
    const message = issue.code === 'custom' || /required|must|cannot|Add|Select|Enter|Each/.test(issue.message) ? issue.message : `${path}${issue.message}`;
    throw badRequest(message, result.error.issues.map(item => ({ path: item.path.join('.'), message: item.message })));
  }
  return result.data;
}
