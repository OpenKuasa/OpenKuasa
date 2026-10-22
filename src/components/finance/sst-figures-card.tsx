'use client';

import { type FormEvent, useId, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { rm } from '@/lib/finance/format';
import type { FinResult } from '@/lib/finance/result';
import { type SstReturnType, type SstTypedFigures, sstCards } from '@/lib/finance/sst-return';

export type SaveSstFigures = (input: unknown) => Promise<FinResult<null>>;

type BoxKey = 'cards_11e' | 'deduction_13b' | 'deduction_13c' | 'bad_debt_13d' | 'adjustment_13a';
type Box = { key: BoxKey; figure: keyof SstTypedFigures; label: string; cards?: boolean };

const BAD_DEBT: Box = { key: 'bad_debt_13d', figure: 'badDebt13d', label: '13(d) Bad debt relief (approved) (RM)' };

/** The boxes of each return, in form order. 13(d) is on both. */
const BOXES: Record<SstReturnType, Box[]> = {
  service: [
    { key: 'cards_11e', figure: 'cards11e', label: '11(e) Credit and charge cards (number)', cards: true },
    { key: 'deduction_13c', figure: 'deduction13c', label: '13(c) Approved service tax deduction (RM)' },
    BAD_DEBT,
  ],
  sales: [
    { key: 'deduction_13b', figure: 'deduction13b', label: '13(b) Sales tax deduction (RM)' },
    { key: 'adjustment_13a', figure: 'adjustment13a', label: '13A Adjustment to the sales tax deduction (RM)' },
    BAD_DEBT,
  ],
};

export const SST_FIGURES_FILED_NOTE = 'This return is marked filed. Undo the mark to change its figures.';
const MEMBER_NOTE = 'Only an owner or admin can change the typed-in figures.';

type Form = Partial<Record<BoxKey, string>>;

/** A box's starting text: blank for 0, so the placeholder shows; an amount with its two decimals. */
const textOf = (box: Box, figures: SstTypedFigures) => {
  const v = figures[box.figure];
  if (v === 0) return '';
  return box.cards ? String(v) : v.toFixed(2);
};

/**
 * What Save sends: the whole return, every box of its type as typed ('' for an empty one, saved as 0), and none
 * of the other type's boxes. The server reads and checks the text.
 */
export function sstFiguresPayload(type: SstReturnType, periodStart: string, form: Form): Record<string, string> {
  const payload: Record<string, string> = { type, period_start: periodStart };
  for (const box of BOXES[type]) payload[box.key] = form[box.key] ?? '';
  return payload;
}

/**
 * The SST-02 figures Bendahara cannot work out (#222 stage 5), for the shown return and period: 11(e) cards,
 * 13(c) and 13(d) on the service return; 13(b), 13A and 13(d) on the sales return. They come from Customs' own
 * approvals, so they are typed in. `save` is given only to an owner or admin outside the demo; without it the
 * figures are text. While the return is marked filed the boxes are locked.
 */
export function SstFiguresCard({
  type,
  periodStart,
  figures,
  filed,
  save,
}: {
  type: SstReturnType;
  periodStart: string;
  figures: SstTypedFigures;
  filed: boolean;
  save?: SaveSstFigures;
}) {
  return (
    <BentoCard
      title="Typed-in figures"
      subtitle="From Customs' approvals and your own records"
      icon={ClipboardList}
      className="col-span-2 md:col-span-12"
    >
      {save ? (
        <FiguresForm type={type} periodStart={periodStart} figures={figures} filed={filed} save={save} />
      ) : (
        <FiguresText type={type} figures={figures} filed={filed} />
      )}
    </BentoCard>
  );
}

function FiguresText({ type, figures, filed }: { type: SstReturnType; figures: SstTypedFigures; filed: boolean }) {
  return (
    <div className="space-y-3">
      <dl className="divide-y text-sm">
        {BOXES[type].map((b) => (
          <div key={b.key} className="flex gap-3 py-2">
            <dt className="min-w-0 flex-1 text-muted-foreground">{b.label}</dt>
            <dd className="shrink-0 text-right font-medium tabular-nums">
              {b.cards ? sstCards(figures[b.figure]) : rm(figures[b.figure])}
            </dd>
          </div>
        ))}
      </dl>
      {filed ? <p className="text-xs text-muted-foreground">{SST_FIGURES_FILED_NOTE}</p> : null}
      <p className="text-xs text-muted-foreground">{MEMBER_NOTE}</p>
    </div>
  );
}

function FiguresForm({
  type,
  periodStart,
  figures,
  filed,
  save,
}: {
  type: SstReturnType;
  periodStart: string;
  figures: SstTypedFigures;
  filed: boolean;
  save: SaveSstFigures;
}) {
  const id = useId();
  const [form, setForm] = useState<Form>(() => Object.fromEntries(BOXES[type].map((b) => [b.key, textOf(b, figures)])));
  const [saved, setSaved] = useState(false);
  const action = useFinanceAction();
  const locked = filed || action.pending;

  const edit = (key: BoxKey, value: string) => {
    setSaved(false);
    action.clear();
    setForm((f) => ({ ...f, [key]: value }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // An earlier "Saved." never shows beside this attempt's refusal or lost answer.
    setSaved(false);
    const payload = sstFiguresPayload(type, periodStart, form);
    action.run(() => save(payload), () => setSaved(true));
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {filed ? <p className="text-sm text-muted-foreground">{SST_FIGURES_FILED_NOTE}</p> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {BOXES[type].map((b) => (
          <div key={b.key} className="space-y-1.5">
            <Label htmlFor={`${id}-${b.key}`}>{b.label}</Label>
            <Input
              id={`${id}-${b.key}`}
              value={form[b.key] ?? ''}
              inputMode={b.cards ? 'numeric' : 'decimal'}
              autoComplete="off"
              placeholder={b.cards ? '0' : '0.00'}
              disabled={locked}
              onChange={(e) => edit(b.key, e.target.value)}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={locked}>
          {action.pending ? 'Saving…' : 'Save'}
        </Button>
        {saved ? <span className="text-sm text-muted-foreground">Saved.</span> : null}
        {action.error ? (
          <p role="alert" className="text-sm text-destructive">
            {action.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
