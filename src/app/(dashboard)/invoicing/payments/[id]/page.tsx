'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/StatusBadge';
import api from '@/lib/api';
import { Payment } from '@/types';
import { formatCurrency, formatDate } from '@/lib/utils';
import { showApiError, showApiSuccess } from '@/lib/apiError';

type PaymentDetail = Payment;

export default function PaymentDetailPage() {
  const params = useParams<{ id: string }>();
  const [payment, setPayment] = useState<PaymentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [isCancelling, setIsCancelling] = useState(false);

  const load = useCallback(() => api
    .get(`/payments/${params.id}`)
    .then((res) => { setPayment(res.data?.data); setLoadError(''); })
    .catch((err) => {
      setLoadError(err?.response?.data?.message || 'Failed to load payment details');
      showApiError(err, 'Failed to load payment details');
    })
    .finally(() => setIsLoading(false)), [params.id]);

  useEffect(() => { void load(); }, [load]);

  const cancelPayment = async () => {
    if (!payment || isCancelling) return;
    setIsCancelling(true);
    try {
      await api.patch(`/payments/${payment.id}/status`, { status: 'CANCELLED', reason: reason || undefined });
      showApiSuccess(`Payment ${payment.paymentNo} cancelled and invoice balance restored`);
      setCancelOpen(false);
      setReason('');
      load();
    } catch (err: any) {
      showApiError(err, 'Failed to cancel payment');
    } finally {
      setIsCancelling(false);
    }
  };

  if (loadError && !payment) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" asChild><Link href="/invoicing/payments"><ArrowLeft className="mr-2 h-4 w-4" />Back to payments</Link></Button>
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">{loadError}</div>
      </div>
    );
  }

  if (isLoading || !payment) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-12" />
        ))}
      </div>
    );
  }

  const status = payment.status || 'POSTED';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/invoicing/payments">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to payments
          </Link>
        </Button>
        {status === 'POSTED' && (
          <Button variant="destructive" size="sm" onClick={() => setCancelOpen(true)}>
            <Ban className="mr-2 h-4 w-4" />
            Cancel Payment
          </Button>
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">{payment.paymentNo} <StatusBadge status={status} /></CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <Info label="Type" value={payment.type} />
          <Info label="Customer" value={payment.customer?.name || payment.customerId || '-'} />
          <Info
            label="Invoice"
            value={`${payment.invoice?.invoiceNo || payment.invoiceId || '-'}${payment.invoice?.status ? ` (${payment.invoice.status})` : ''}`}
            href={payment.invoiceId ? `/invoicing/sales-invoices/${payment.invoiceId}` : undefined}
          />
          <Info label="Invoice Outstanding" value={payment.invoice ? formatCurrency(Number(payment.invoice.outstandingAmount || 0), payment.currency) : '-'} />
          <Info label="Date" value={formatDate(payment.date)} />
          <Info label="Amount" value={formatCurrency(payment.amount, payment.currency)} />
          <Info label="Method" value={payment.method.replace('_', ' ')} />
          <Info label="Reference" value={payment.reference || '-'} />
          <Info label="Notes" value={payment.notes || '-'} />
          {status === 'CANCELLED' && <Info label="Cancelled" value={`${payment.cancelledAt ? formatDate(payment.cancelledAt) : ''}${payment.cancelReason ? ` - ${payment.cancelReason}` : ''}` || '-'} />}
        </CardContent>
      </Card>

      <Dialog open={cancelOpen} onOpenChange={(open) => { setCancelOpen(open); if (!open) setReason(''); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancel payment {payment.paymentNo}?</DialogTitle></DialogHeader>
          <p className="text-sm text-[#6b7280]">
            The invoice outstanding balance is restored and reversal entries are posted to the ledger. The payment stays in the list as Cancelled.
          </p>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (optional), e.g. cheque bounced" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCancelOpen(false)}>Keep Payment</Button>
            <Button variant="destructive" onClick={cancelPayment} disabled={isCancelling}>{isCancelling ? 'Cancelling...' : 'Cancel Payment'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Info({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="rounded-md border border-[#e5e2dc] bg-[#f8faf9] px-3 py-2">
      <p className="text-xs font-medium uppercase text-[#7c8591]">{label}</p>
      {href ? (
        <Link href={href} className="mt-1 block text-sm font-medium text-[#1674c4] hover:underline">
          {value}
        </Link>
      ) : (
        <p className="mt-1 text-sm font-medium text-[#1f2937]">{value}</p>
      )}
    </div>
  );
}
