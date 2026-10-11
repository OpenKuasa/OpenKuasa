import type { ReactNode } from 'react';
import { monthYearLabel } from '@/lib/people/dates';
import { type DetailLine, PROPOSED_NOTE, payslipDetailModel } from '@/lib/people/payroll';
import { centsToRinggit } from '@/lib/people/payroll-forms';
import type { Payslip } from '@/lib/people/types';
import { PayslipLineForm, RemoveLine, RemovePayslip } from './payslip-line-form';
import { StatutoryFigure } from './statutory-field';

const money = 'whitespace-nowrap text-right tabular-nums';

function Row({ label, children, strong = false }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? 'font-semibold' : ''}`}>
      <span>{label}</span>
      <span className={money}>{children}</span>
    </div>
  );
}

function Line({ line, payslipId, editable }: { line: DetailLine; payslipId: string; editable: boolean }) {
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-4">
        <span>
          {line.label}
          {line.system_note ? <span className="ml-2 text-xs text-muted-foreground">{line.system_note}</span> : null}
        </span>
        <span className={money}>{centsToRinggit(line.signed_cents)}</span>
      </div>
      {editable && line.editable && line.kind !== 'unpaid' ? (
        <div className="flex flex-wrap items-center gap-2 [&>div]:basis-full">
          <PayslipLineForm
            payslipId={payslipId}
            line={{ id: line.id, kind: line.kind === 'earning' ? 'earning' : 'deduction', label: line.label, amount_cents: line.amount_cents }}
          />
          <RemoveLine lineId={line.id} label={line.label} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * One payslip, as recorded: basic, each line, gross, the four proposed figures, the deduction lines and net.
 * With `editable: false` (a paid run, the demo, or an employee reading their own) it renders no control of any
 * kind. With `editable: true` it adds, on a draft: add, edit and remove an HR line, type over or reset a
 * statutory figure, and remove the payslip. Every number is the payslip's own; nothing is added up here.
 *
 * Not a client component, so a member's page can import it; the controls live in child components that are
 * only rendered when `editable` is true.
 */
export function PayslipDetail({ payslip, editable }: { payslip: Payslip; editable: boolean }) {
  const m = payslipDetailModel(payslip);
  const monthText = monthYearLabel(payslip.period_month);
  return (
    <div className="space-y-5 text-sm">
      <section aria-label="Earnings" className="space-y-2">
        <Row label="Basic pay">{centsToRinggit(m.basic_cents)}</Row>
        {m.pay_lines.length > 0 ? (
          <ul className="space-y-2 border-l pl-3">
            {m.pay_lines.map((line) => (
              <Line key={line.id} line={line} payslipId={payslip.id} editable={editable} />
            ))}
          </ul>
        ) : null}
        <div className="border-t pt-2">
          <Row label="Gross pay" strong>
            {centsToRinggit(m.gross_cents)}
          </Row>
        </div>
        {editable ? (
          <div>
            <PayslipLineForm payslipId={payslip.id} />
          </div>
        ) : null}
      </section>

      <section aria-label="Proposed deductions" className="space-y-2">
        <h3 className="font-semibold">Proposed deductions</h3>
        <p className="text-xs text-muted-foreground">{PROPOSED_NOTE}</p>
        {editable ? (
          <div className="space-y-2">
            {m.figures.map((f) => (
              <StatutoryFigure
                key={f.field}
                payslipId={payslip.id}
                field={f.field}
                label={f.label}
                amountCents={f.amount_cents}
                setByHr={f.set_by_hr}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {m.figures.map((f) => (
              <Row
                key={f.field}
                label={
                  <>
                    {f.label}
                    {f.set_by_hr ? (
                      <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
                        set by HR
                      </span>
                    ) : null}
                  </>
                }
              >
                {centsToRinggit(f.amount_cents)}
              </Row>
            ))}
          </div>
        )}
      </section>

      {m.deduction_lines.length > 0 ? (
        <section aria-label="Other deductions" className="space-y-2">
          <h3 className="font-semibold">Other deductions</h3>
          <ul className="space-y-2 border-l pl-3">
            {m.deduction_lines.map((line) => (
              <Line key={line.id} line={line} payslipId={payslip.id} editable={editable} />
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

      {editable ? (
        <RemovePayslip payslipId={payslip.id} employeeName={payslip.employee_name} monthText={monthText} />
      ) : null}
    </div>
  );
}
