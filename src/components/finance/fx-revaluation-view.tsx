'use client';

import { Fragment, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Coins, Download, History, Send, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { downloadCsv } from '@/components/finance/download-csv';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import { csvFileName } from '@/lib/finance/csv';
import { money, rm } from '@/lib/finance/format';
import { longDate } from '@/lib/finance/fx-rates';
import { FX_REVALUATION_MESSAGES, type RevaluationItem, type RevaluationRun } from '@/lib/finance/fx-revaluation';
import {
  type RateRow,
  WORKING_OUT,
  closingRateLabel,
  emptyNote,
  farRatesQuestion,
  groupItems,
  itemNote,
  mergeRateRows,
  postBlock,
  postPayload,
  postQuestion,
  previewRates,
  rateRowNotes,
  rateRowsFrom,
  rateShown,
  ratesMatch,
  revaluationCsv,
  revaluationTotals,
  shortDay,
  withRowTyped,
  withTypedRates,
} from '@/lib/finance/fx-revaluation-views';
import { type FinResult, READ_FAILED } from '@/lib/finance/result';
import { addDays } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type FxRevaluationActions = {
  /** Any member: what a run for the month end would post, at the rates sent (BNM's where none is). */
  preview: (input: unknown) => Promise<FinResult<RevaluationItem[]>>;
  /** An owner or admin only; absent for everyone else, who see no Post button and no rate boxes. */
  post?: (input: unknown) => Promise<FinResult<{ id: string; revaluation_no: string }>>;
};

/** Said under the header to a member: they read every revaluation and preview a month end, and are told who posts. */
export const FX_MEMBER_NOTE = 'An owner or admin posts revaluations.';

const SUBTITLE = 'Foreign-currency balances at a month end, in ringgit. Posted on the month end and reversed the next day.';

/** How long typing in a rate box waits before the server works the figures out at it. */
const PREVIEW_AFTER_MS = 500;

/** A gain or loss in ringgit with its sign: "+RM 168.00", "−RM 302.40". */
function signed(n: number | null): string {
  if (n === null) return '—';
  if (n === 0) return rm(0);
  return `${n > 0 ? '+' : '−'}${rm(Math.abs(n))}`;
}

function ringgit(n: number | null): string {
  return n === null ? '—' : rm(n);
}

function GainCell({ gain, className }: { gain: number | null; className?: string }) {
  return (
    <TableCell
      className={cn(
        'whitespace-nowrap text-right font-medium tabular-nums',
        gain !== null && gain > 0 && 'text-emerald-600',
        gain !== null && gain < 0 && 'text-red-600',
        className,
      )}
    >
      {signed(gain)}
    </TableCell>
  );
}

/** The items of a preview (or of a posted run), grouped by kind, every figure in its own column. */
function ItemsTable({ items, label, posted = false }: { items: RevaluationItem[]; label: string; posted?: boolean }) {
  const groups = groupItems(items);
  const columns = 11;
  return (
    <div className="overflow-x-auto">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead>Reference</TableHead>
            <TableHead>Party</TableHead>
            <TableHead>Currency</TableHead>
            <TableHead className="text-right">Foreign balance</TableHead>
            <TableHead className="text-right">Rate</TableHead>
            <TableHead className="text-right">Carried</TableHead>
            <TableHead className="text-right">Revalued</TableHead>
            <TableHead className="text-right">Difference</TableHead>
            <TableHead className="text-right">Earlier runs</TableHead>
            <TableHead className="text-right">{posted ? 'Posted' : 'To post'}</TableHead>
            <TableHead className="text-right">Gain or loss</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => (
            <Fragment key={group.kind}>
              <TableRow className="bg-muted/20">
                <TableCell colSpan={columns - 1} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </TableCell>
                <GainCell gain={group.gain} className="text-xs" />
              </TableRow>
              {group.items.map((item) => {
                const note = itemNote(item);
                return (
                  <TableRow key={`${item.kind}-${item.item_id}`}>
                    {/* A long name wraps; it is never cut off behind a tooltip. */}
                    <TableCell className="min-w-28 max-w-56 whitespace-normal break-words font-medium">
                      {item.reference}
                      {note ? <span className="block text-xs font-normal text-muted-foreground">{note}</span> : null}
                    </TableCell>
                    <TableCell className="min-w-24 max-w-56 whitespace-normal break-words text-muted-foreground">{item.party ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{item.currency}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{money(item.foreign_balance, item.currency)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {item.foreign_balance === 0 ? '—' : rateShown(item.rate_text, item.currency)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(item.carried_myr)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{ringgit(item.revalued_myr)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{ringgit(item.difference)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{rm(item.earlier_myr)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{ringgit(item.posted_myr)}</TableCell>
                    <GainCell gain={item.gain} />
                  </TableRow>
                );
              })}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One closing rate: a box for an owner or admin, the figure as text for everyone else; BNM's notes under it. */
function RateField({ row, periodEnd, editable, disabled, onTyped }: { row: RateRow; periodEnd: string; editable: boolean; disabled: boolean; onTyped: (text: string) => void }) {
  const id = `fx-closing-${row.currency}`;
  const notes = rateRowNotes(row, periodEnd);
  return (
    <div className="space-y-1.5">
      {editable ? (
        <>
          <Label htmlFor={id}>{closingRateLabel(row.currency)}</Label>
          <Input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            className="w-40 text-right tabular-nums"
            aria-describedby={`${id}-notes`}
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            value={row.fields.rate}
            onChange={(e) => onTyped(e.target.value)}
          />
        </>
      ) : (
        <>
          <p className="text-sm font-medium">{closingRateLabel(row.currency)}</p>
          <p className="text-lg font-semibold tabular-nums">{row.fields.rate || '—'}</p>
        </>
      )}
      <div id={`${id}-notes`} role="status" className="space-y-1">
        {notes.map((line) => (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * FX Revaluation: a month end's foreign-currency items (open foreign invoices and bills, foreign bank and cash
 * accounts) revalued at a closing rate per currency, as a preview from the database, with the posted runs and a
 * CSV file of each. Every member reads it and can preview another month end. An owner or admin (`actions.post`)
 * also types closing rates and posts: a typed rate is worked out in the browser at once and by the server half a
 * second later, and only the server's figures (its digest) can be posted. A ringgit-only workspace is told there is
 * nothing to revalue and shows no figure and no field.
 */
export function FxRevaluationView({
  monthEnds,
  periodEnd: initialPeriodEnd,
  items: initialItems,
  itemsError = null,
  runs,
  postedBy = {},
  actions,
  memberNote = false,
  ringgitOnly = false,
}: {
  /** The month ends offered, newest first (never one after today in Malaysia). */
  monthEnds: string[];
  /** The month end shown first. */
  periodEnd: string;
  /** Its preview; null when it could not be worked out (`itemsError` says why). */
  items: RevaluationItem[] | null;
  itemsError?: string | null;
  /** The posted runs, newest month end first; null when they could not be read. */
  runs: RevaluationRun[] | null;
  /** Who posted each run, by user id, as far as the workspace's profiles say. */
  postedBy?: Record<string, string>;
  /** Absent for the sample, which only reads. */
  actions?: FxRevaluationActions;
  /** True for a member: the line under the header says who posts. */
  memberNote?: boolean;
  /** Nothing foreign has ever been in the books. */
  ringgitOnly?: boolean;
}) {
  const [periodEnd, setPeriodEnd] = useState(initialPeriodEnd);
  const [preview, setPreview] = useState<{ periodEnd: string; items: RevaluationItem[] } | null>(
    initialItems ? { periodEnd: initialPeriodEnd, items: initialItems } : null,
  );
  const [rows, setRows] = useState<RateRow[]>(() => (initialItems ? rateRowsFrom(initialItems, initialPeriodEnd) : []));
  const [loadError, setLoadError] = useState<string | null>(itemsError);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [posted, setPosted] = useState<{ number: string; periodEnd: string } | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posting = useFinanceAction();
  const post = actions?.post;
  const runList = runs ?? [];

  /**
   * Asks the server for the month end at these rates (none: BNM's). Only the newest question's answer is kept; the
   * boxes keep what was typed in them meanwhile, take the rate of a newly needed currency, and drop one no longer
   * needed. A new month end starts the boxes again from its answer.
   */
  const ask = (end: string, rates: Record<string, unknown> | undefined, fresh: boolean) => {
    if (!actions) return;
    const id = ++request.current;
    setLoading(true);
    actions.preview({ period_end: end, rates }).then(
      (result) => {
        if (id !== request.current) return;
        setLoading(false);
        if (!result.ok) {
          setLoadError(result.error);
          return;
        }
        setLoadError(null);
        setPreview({ periodEnd: end, items: result.data });
        setRows((current) => (fresh ? rateRowsFrom(result.data, end) : mergeRateRows(current, rateRowsFrom(result.data, end))));
      },
      () => {
        if (id !== request.current) return;
        setLoading(false);
        setLoadError(READ_FAILED);
      },
    );
  };

  const stopWaiting = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const chooseMonth = (end: string) => {
    stopWaiting();
    posting.clear();
    setConfirming(false);
    setNotice(null);
    setPosted(null);
    setPeriodEnd(end);
    ask(end, undefined, true);
  };

  const typeRate = (currency: string, text: string) => {
    const next = withRowTyped(rows, currency, text);
    setRows(next);
    setConfirming(false);
    setNotice(null);
    posting.clear();
    stopWaiting();
    // An answer still on its way is for rates no longer in the boxes: it is dropped, so it cannot replace the
    // preview with figures at those rates after the boxes went back to the preview's own.
    request.current += 1;
    setLoading(false);
    const rates = previewRates(next);
    if (rates && preview && preview.periodEnd === periodEnd && !ratesMatch(preview.items, next)) {
      timer.current = setTimeout(() => ask(periodEnd, rates, false), PREVIEW_AFTER_MS);
    }
  };

  const current = preview && preview.periodEnd === periodEnd ? preview : null;
  const shown = current ? withTypedRates(current.items, rows) : null;
  const totals = shown ? revaluationTotals(shown) : null;
  const blocked = shown ? postBlock(shown, rows, periodEnd, runList) : null;
  const canPress = !!post && shown !== null && blocked === null && !loading && !posting.pending;

  const pressPost = () => {
    posting.clear();
    const far = farRatesQuestion(rows);
    if (far) {
      setRows(far.rows);
      setNotice(far.question);
      return;
    }
    setNotice(null);
    setConfirming(true);
  };

  const confirmPost = () => {
    if (!post || !shown) return;
    const payload = postPayload(periodEnd, shown);
    if (!payload) return;
    const end = periodEnd;
    const again = previewRates(rows) ?? undefined;
    posting.run(
      async () => {
        const result = await post(payload);
        // The figures moved under the page: show the new ones, and say so.
        if (!result.ok && result.error === FX_REVALUATION_MESSAGES.changed) {
          setConfirming(false);
          ask(end, again, false);
        }
        return result;
      },
      (data) => {
        setConfirming(false);
        setPosted({ number: data.revaluation_no, periodEnd: end });
        // What is left to post at this month end is now nothing (the history refreshes with the page).
        ask(end, again, false);
      },
    );
  };

  const header = (
    <PageHeader
      title="FX Revaluation"
      subtitle={memberNote ? `${SUBTITLE} ${FX_MEMBER_NOTE}` : SUBTITLE}
      actions={
        ringgitOnly ? undefined : (
          <>
            <Select value={periodEnd} onValueChange={chooseMonth} disabled={!actions || posting.pending || monthEnds.length < 2}>
              <SelectTrigger className="w-48" aria-label="Month end">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {monthEnds.map((end) => (
                  <SelectItem key={end} value={end}>
                    {longDate(end)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {post ? (
              <Button size="sm" disabled={!canPress || confirming} onClick={pressPost}>
                <Send className="size-4" />
                Post revaluation
              </Button>
            ) : null}
          </>
        )
      }
    />
  );

  if (ringgitOnly) {
    return (
      <ScreenContainer>
        {header}
        <BentoGrid>
          <BentoCard className="col-span-2 md:col-span-12">
            <p className="py-6 text-center text-sm text-muted-foreground">{emptyNote(null)}</p>
          </BentoCard>
        </BentoGrid>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      {header}

      <BentoGrid>
        {posted ? (
          <SavedNoteCard
            title="FX revaluation posted"
            subtitle={posted.number}
            href="/finance/journals"
            linkLabel="See it in the general ledger"
            onClose={() => setPosted(null)}
          >
            {`${posted.number} is dated ${shortDay(posted.periodEnd)} and reversed on ${shortDay(addDays(posted.periodEnd, 1))}.`}
          </SavedNoteCard>
        ) : null}

        {post && confirming && shown ? (
          <BentoCard className="col-span-2 md:col-span-12" title="Post this revaluation?" icon={Send}>
            <p className="text-sm">{postQuestion(periodEnd)}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={posting.pending} onClick={confirmPost}>
                {posting.pending ? 'Posting…' : 'Post FX revaluation'}
              </Button>
              <Button size="sm" variant="outline" disabled={posting.pending} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </BentoCard>
        ) : null}

        {posting.error || notice ? (
          <div className="col-span-2 md:col-span-12">
            <p role="alert" className="text-sm text-destructive">
              {posting.error ?? notice}
            </p>
          </div>
        ) : null}

        {current === null ? (
          <BentoCard className="col-span-2 md:col-span-12">
            {loadError && !loading ? (
              <p role="alert" className="py-6 text-center text-sm text-destructive">
                {loadError}
              </p>
            ) : (
              <p role="status" className="py-6 text-center text-sm text-muted-foreground">
                {`Working out the figures for ${longDate(periodEnd)}…`}
              </p>
            )}
          </BentoCard>
        ) : shown && shown.length === 0 ? (
          <BentoCard className="col-span-2 md:col-span-12">
            <p className="py-6 text-center text-sm text-muted-foreground">{emptyNote(periodEnd)}</p>
          </BentoCard>
        ) : shown && totals ? (
          <>
            <BentoCard tone="primary" className="col-span-1 md:col-span-3">
              <BentoStat
                label="Unrealised gain or loss"
                value={signed(totals.netGain)}
                delta={`${totals.toPost} of ${totals.lines} to post`}
                deltaTone="flat"
                onPrimary
              />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat label="Revalued (MYR)" value={rm(totals.revaluedMyr)} delta="owed to you and held, less owed" deltaTone="flat" />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat
                label="Currencies"
                value={String(totals.currencies.length)}
                delta={totals.currencies.length ? totals.currencies.join(' · ') : 'no rate needed'}
                deltaTone="flat"
              />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat label="Items" value={String(totals.lines)} delta={`at ${shortDay(periodEnd)}`} deltaTone="flat" />
            </BentoCard>

            {rows.length > 0 ? (
              <BentoCard
                title="Closing rates"
                subtitle={`Bank Negara Malaysia's 5 pm selling rate on or before ${longDate(periodEnd)}, unless typed`}
                icon={TrendingUp}
                className="col-span-2 md:col-span-12"
              >
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {rows.map((row) => (
                    <RateField
                      key={row.currency}
                      row={row}
                      periodEnd={periodEnd}
                      editable={!!post}
                      disabled={posting.pending}
                      onTyped={(text) => typeRate(row.currency, text)}
                    />
                  ))}
                </div>
              </BentoCard>
            ) : null}

            {post && blocked ? (
              <div className="col-span-2 md:col-span-12">
                <p role="status" className="text-sm text-muted-foreground">
                  {loading ? WORKING_OUT : blocked}
                </p>
              </div>
            ) : null}

            <BentoCard
              title="Items"
              subtitle={`Foreign-currency items in the books at ${longDate(periodEnd)}`}
              icon={Coins}
              flush
              className="col-span-2 md:col-span-12"
            >
              <ItemsTable items={shown} label={`Items at ${longDate(periodEnd)}`} />
              {loadError ? (
                <p role="alert" className="border-t px-4 py-3 text-sm text-destructive">
                  {loadError}
                </p>
              ) : null}
            </BentoCard>
          </>
        ) : null}

        <BentoCard title="Posted revaluations" subtitle="Each is dated its month end and reversed the next day" icon={History} flush className="col-span-2 md:col-span-12">
          {runs === null ? (
            <p role="alert" className="px-4 pb-4 text-sm text-destructive">
              Posted revaluations could not be loaded. Please try again.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table aria-label="Posted revaluations">
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>No.</TableHead>
                    <TableHead>Month end</TableHead>
                    <TableHead>Posted by</TableHead>
                    <TableHead>Posted on</TableHead>
                    <TableHead className="text-right">Gain or loss</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Lines and export</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runList.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        No revaluations posted yet.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {runList.map((run) => {
                    const open = openRun === run.id;
                    return (
                      <Fragment key={run.id}>
                        <TableRow>
                          <TableCell className="whitespace-nowrap font-medium">{run.revaluation_no}</TableCell>
                          <TableCell className="whitespace-nowrap">{shortDay(run.period_end)}</TableCell>
                          <TableCell className="min-w-24 max-w-56 whitespace-normal break-words text-muted-foreground">
                            {(run.posted_by && postedBy[run.posted_by]) || '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{shortDay(run.posted_at.slice(0, 10))}</TableCell>
                          <GainCell gain={run.net_gain} />
                          <TableCell className="whitespace-nowrap text-right">
                            <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpenRun(open ? null : run.id)}>
                              {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                              {`${run.lines.length} ${run.lines.length === 1 ? 'line' : 'lines'}`}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => downloadCsv(csvFileName(`fx-revaluation-${run.revaluation_no}`, localIsoDate(new Date())), revaluationCsv(run))}
                            >
                              <Download className="size-4" />
                              Export
                            </Button>
                          </TableCell>
                        </TableRow>
                        {open ? (
                          <TableRow>
                            <TableCell colSpan={6} className="bg-muted/10 p-0">
                              <ItemsTable items={run.lines} label={`${run.revaluation_no} lines`} posted />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
