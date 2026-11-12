'use client';

import { ReportWorkbench } from '@/components/invoicing/ReportWorkbench';
import { formatCurrency, formatDate } from '@/lib/utils';

function bucket(value: number, currency: string, className = '') {
  return <span className={`block rounded px-2 py-1 text-right ${className}`}>{formatCurrency(Number(value || 0), currency)}</span>;
}

export default function AgingReportPage() {
  return (
    <ReportWorkbench
      title="Accounts Receivable Aging"
      description="Customer-wise outstanding balances split by overdue risk buckets."
      endpoint="/invoices/aging-report"
      keyField="id"
      filters={{ customer: true, asOf: true, currency: true }}
      kpis={[
        { key: 'invoiceCount', label: 'Open Invoices' },
        { key: 'totalOutstanding', label: 'Outstanding', money: true },
        { key: 'days61To90', label: '61-90 Days', money: true },
        { key: 'days90Plus', label: '90+ Days', money: true },
      ]}
      columns={[
        { key: 'customerName', header: 'Customer' },
        { key: 'currency', header: 'Currency' },
        { key: 'invoiceCount', header: 'Invoices' },
        { key: 'current', header: 'Current', render: (row: any) => bucket(row.current, row.currency) },
        { key: 'days0To30', header: '0-30', render: (row: any) => bucket(row.days0To30, row.currency, 'bg-yellow-50') },
        { key: 'days31To60', header: '31-60', render: (row: any) => bucket(row.days31To60, row.currency, 'bg-orange-50') },
        { key: 'days61To90', header: '61-90', render: (row: any) => bucket(row.days61To90, row.currency, 'bg-red-50 text-[#9f3a38]') },
        { key: 'days90Plus', header: '90+', render: (row: any) => bucket(row.days90Plus, row.currency, 'bg-red-100 font-semibold text-[#8f2d2a]') },
        { key: 'totalOutstanding', header: 'Total', render: (row: any) => <span className="font-semibold">{formatCurrency(Number(row.totalOutstanding || 0), row.currency)}</span> },
        { key: 'oldestDueDate', header: 'Oldest Due', render: (row: any) => row.oldestDueDate ? formatDate(row.oldestDueDate) : '-' },
      ]}
    />
  );
}
