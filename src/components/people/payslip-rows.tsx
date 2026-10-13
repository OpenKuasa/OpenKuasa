import type { ReactNode } from 'react';
import {
  type DetailLine,
  PROPOSED_NOTE,
  type PayslipDetailModel,
  payslipDetailModel,
} from '@/lib/people/payroll';
import { centsToRinggit } from '@/lib/people/payroll-forms';
import type { Payslip } from '@/lib/people/types';

const money = 'whitespace-nowrap text-right tabular-nums';

function Row({ label, children, strong = false }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? 'font-semibold' : ''}`}>
      <span>{label}</span>
      <span className={money}>{children}</span>
    </div>
  );
}

/** The small "set by HR" mark, shared so the read-only and editing views say it the same way. */
export function SetByHrMark() {
  return (
    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">set by HR</span>
  );
}

/** What an editing view can slot in. Everything is optional: with none, the layout is the read-only payslip. */
export type PayslipSlots = {
  /** Controls under one line (only called for a line an owner added). */
  lineControls?: (line: DetailLine) => ReactNode;
  /** Under gross pay: the "Add line" control. */
  addLine?: ReactNode;
  /** Replaces the read-only row of one of the four figures. */
  figure?: (figure: PayslipDetailModel['figures'][number]) => ReactNode;
  /** After the totals. */
  footer?: ReactNode;
};

function Line({ line, controls }: { line: DetailLine; controls: ReactNode }) {
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-4">
        <span>
          {line.label}
          {line.system_note ? <span className="ml-2 text-xs text-muted-foreground">{line.system_note}</span> : null}
        </span>
        <span className={money}>{centsToRinggit(line.signed_cents)}</span>
      </div>
      {controls}
    </li>
  );
}

/**
 * One payslip, as recorded: basic, each line, gross, the four proposed figures, the deduction lines, total
 * deductions and net. Every number is the payslip's own. Pure markup: it imports nothing that edits, so both
 * the read-only `PayslipDetail` and the Payroll screen's `PayslipEditor` are this one layout, and cannot drift.
 */
export function PayslipLayout({ payslip, slots = {} }: { payslip: Payslip; slots?: PayslipSlots }) {
  const m = payslipDetailModel(payslip);
  // A paid payslip is settled: its figures are no longer proposals, and who set them is HR's business.
  const paid = payslip.status === 'paid';
  const controlsFor = (line: DetailLine) => (line.editable ? (slots.lineControls?.(line) ?? null) : null);
  return (
    <div className="space-y-5 text-sm">
      <section aria-label="Earnings" className="space-y-2">
        <Row label="Basic pay">{centsToRinggit(m.basic_cents)}</Row>
        {m.pay_lines.length > 0 ? (
          <ul className="space-y-2 border-l pl-3">
            {m.pay_lines.map((line) => (
              <Line key={line.id} line={line} controls={controlsFor(line)} />
            ))}
          </ul>
        ) : null}
        <div className="border-t pt-2">
          <Row label="Gross pay" strong>
            {centsToRinggit(m.gross_cents)}
          </Row>
        </div>
        {slots.addLine ? <div>{slots.addLine}</div> : null}
      </section>

      <section aria-label={paid ? 'Deductions' : 'Proposed deductions'} className="space-y-2">
        <h3 className="font-semibold">{paid ? 'Deductions' : 'Proposed deductions'}</h3>
        {paid ? null : <p className="text-xs text-muted-foreground">{PROPOSED_NOTE}</p>}
        <div className="space-y-1">
          {m.figures.map((f) =>
            slots.figure ? (
              <div key={f.field}>{slots.figure(f)}</div>
            ) : (
              <Row
                key={f.field}
                label={
                  <>
                    {f.label}
                    {f.set_by_hr && !paid ? (
                      <span className="ml-2">
                        <SetByHrMark />
                      </span>
                    ) : null}
                  </>
                }
              >
                {centsToRinggit(f.amount_cents)}
              </Row>
            ),
          )}
        </div>
      </section>

      {m.deduction_lines.length > 0 ? (
        <section aria-label="Other deductions" className="space-y-2">
          <h3 className="font-semibold">Other deductions</h3>
          <ul className="space-y-2 border-l pl-3">
            {m.deduction_lines.map((line) => (
              <Line key={line.id} line={line} controls={controlsFor(line)} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Totals" className="space-y-1 border-t pt-3">
        <Row label="Total deductions">{centsToRinggit(m.deductions_cents)}</Row>
        <Row label="Net pay" strong>
          {centsToRinggit(m.net_cents)}
        </Row>
      </section>

      {slots.footer ?? null}
    </div>
  );
}
