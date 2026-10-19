import { CreditCard, Landmark, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { requireAccess } from '@/lib/auth/viewer';

type Method = {
  id: string;
  icon: 'card' | 'bank';
  label: string;
  detail: string;
  default: boolean;
};

const METHODS: Method[] = [
  {
    id: 'visa',
    icon: 'card',
    label: 'Visa •••• 4242',
    detail: 'Expires 08/27',
    default: true,
  },
  {
    id: 'mastercard',
    icon: 'card',
    label: 'Mastercard •••• 5589',
    detail: 'Expires 11/26',
    default: false,
  },
  {
    id: 'fpx',
    icon: 'bank',
    label: 'FPX — Maybank',
    detail: 'Current account',
    default: false,
  },
];

const STATES = [
  { value: 'selangor', label: 'Selangor' },
  { value: 'kl', label: 'WP Kuala Lumpur' },
  { value: 'johor', label: 'Johor' },
  { value: 'penang', label: 'Penang' },
];

export default async function PaymentMethodsPage() {
  await requireAccess('manage-billing');

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Payment methods</h1>
          <p className="text-sm text-muted-foreground">
            How you pay for OpenKuasa.
          </p>
        </div>
        <Button size="sm">
          <Plus className="size-4" />
          Add method
        </Button>
      </div>

      <div className="space-y-6">
        <div className="space-y-3">
          {METHODS.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-4 rounded-xl border bg-card p-4 shadow-sm"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">
                  {m.icon === 'card' ? (
                    <CreditCard className="size-5 text-muted-foreground" />
                  ) : (
                    <Landmark className="size-5 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{m.label}</p>
                    {m.default ? <Badge>Default</Badge> : null}
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {m.detail}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {m.default ? null : (
                  <Button variant="ghost" size="sm">
                    Set default
                  </Button>
                )}
                <Button variant="ghost" size="sm">
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Billing contact</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="billing-email">Billing email</Label>
              <Input
                id="billing-email"
                type="email"
                defaultValue="billing@openkuasa.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="receipt-name">Name on receipts</Label>
              <Input id="receipt-name" defaultValue="Rimba Ventures Sdn Bhd" />
            </div>
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Receipts and tax invoices are sent to this email.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Billing address</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="address">Address</Label>
              <Input id="address" placeholder="Street, building, unit" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="city">City</Label>
              <Input id="city" defaultValue="Kuala Lumpur" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="state">State</Label>
              <Select defaultValue="kl">
                <SelectTrigger id="state" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="postcode">Postcode</Label>
              <Input id="postcode" defaultValue="50088" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sst-no">Tax / SST no</Label>
              <Input id="sst-no" defaultValue="W10-1808-12345678" />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button>Save changes</Button>
        </div>
      </div>
    </div>
  );
}
