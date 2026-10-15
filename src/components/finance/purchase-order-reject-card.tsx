'use client';

import { type FormEvent, useId, useState } from 'react';
import { X } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { PurchaseOrderLines } from '@/components/finance/purchase-order-approve-card';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PURCHASE_ORDER_MESSAGES, type PurchaseOrderDetail } from '@/lib/finance/purchase-orders';
import type { FinResult } from '@/lib/finance/result';

export type DecidePurchaseOrder = (input: unknown) => Promise<FinResult<{ id: string }>>;

/**
 * Shows an order awaiting approval with its lines, and sends it back to draft
 * with the reason the person gives, which the raiser then sees under the
 * order's status. An empty reason is refused here, before any call.
 */
export function PurchaseOrderRejectCard({
  order,
  decide,
  onClose,
}: {
  order: PurchaseOrderDetail;
  decide: DecidePurchaseOrder;
  onClose: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const save = useFinanceAction();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    if (reason.trim() === '') {
      save.fail(PURCHASE_ORDER_MESSAGES.reason);
      return;
    }
    save.run(() => decide({ id: order.id, approve: false, reason: reason.trim() }), onClose);
  };

  return (
    <BentoCard
      title="Reject purchase order"
      subtitle={`${order.po_no ?? 'The order'} to ${order.supplier_name}: it goes back to draft`}
      icon={X}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="md:col-span-12">
          <PurchaseOrderLines order={order} />
        </div>
        <div className="space-y-1.5 md:col-span-8">
          <Label htmlFor={`${id}-reason`}>Reason</Label>
          <Input
            id={`${id}-reason`}
            value={reason}
            maxLength={200}
            placeholder="Why is it being sent back?"
            autoComplete="off"
            required
            autoFocus
            data-finance-focus
            onChange={(e) => {
              save.clear();
              setReason(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" variant="destructive" disabled={save.pending}>
            {save.pending ? 'Rejecting…' : 'Reject'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
