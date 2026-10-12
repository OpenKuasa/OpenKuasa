import { monthYearLabel } from '@/lib/people/dates';
import type { Payslip } from '@/lib/people/types';
import { PayslipLineForm, RemoveLine, RemovePayslip } from './payslip-line-form';
import { PayslipLayout } from './payslip-rows';
import { StatutoryFigure } from './statutory-field';

/**
 * A draft payslip with its controls: add, edit and remove an owner's line, type over or reset a statutory
 * figure, remove the payslip. Only the Payroll screen imports this; a member's page never does.
 */
export function PayslipEditor({ payslip }: { payslip: Payslip }) {
  return (
    <PayslipLayout
      payslip={payslip}
      slots={{
        lineControls: (line) => (
          <div className="flex flex-wrap items-center gap-2 [&>div]:basis-full">
            <PayslipLineForm
              payslipId={payslip.id}
              line={{
                id: line.id,
                kind: line.kind === 'earning' ? 'earning' : 'deduction',
                label: line.label,
                amount_cents: line.amount_cents,
              }}
            />
            <RemoveLine lineId={line.id} label={line.label} />
          </div>
        ),
        addLine: <PayslipLineForm payslipId={payslip.id} />,
        figure: (f) => (
          <StatutoryFigure
            payslipId={payslip.id}
            field={f.field}
            label={f.label}
            amountCents={f.amount_cents}
            setByHr={f.set_by_hr}
          />
        ),
        footer: (
          <RemovePayslip
            payslipId={payslip.id}
            employeeName={payslip.employee_name}
            monthText={monthYearLabel(payslip.period_month)}
          />
        ),
      }}
    />
  );
}
