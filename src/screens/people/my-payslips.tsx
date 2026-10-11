import { Receipt } from 'lucide-react';
import { BentoCard, BentoGrid } from '@/components/bento/bento';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NO_PAYSLIPS_TEXT, payslipBreakdown, readOwnPayslips } from '@/lib/people/my-payslips';
import { centsToRinggit } from '@/lib/people/payroll-forms';
import type { Payslip } from '@/lib/people/types';
import { LOAD_FAILED, Muted, NotLinkedCard, loadPeople } from './parts';

// Replaced by PayslipDetail from payslip-detail.tsx when Task 3 lands (coordinator)
function PayslipDetail({ payslip }: { payslip: Payslip; editable: boolean }) {
  return (
    <dl className="divide-y text-sm">
      {payslipBreakdown(payslip).map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-3 py-2">
          <dt className={row.key === 'gross' || row.key === 'net' ? 'font-semibold' : 'text-muted-foreground'}>{row.label}</dt>
          <dd className="tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The signed-in employee's own paid payslips, newest first. A draft is never read, so never shown. */
export default async function MyPayslipsScreen() {
  const { model } = await loadPeople('my-payslips', async (data, _now, ctx) => ({
    linked: ctx.viewer.employeeId !== null,
    payslips: await readOwnPayslips(data, ctx.viewer),
  }));

  return (
    <ScreenContainer>
      <PageHeader title="My Payslips" subtitle="Your payslips, once payroll for the month is paid." />
      <BentoGrid>
        {model === null ? (
          <BentoCard title="Payslips" icon={Receipt} className="col-span-2 md:col-span-12">
            {LOAD_FAILED}
          </BentoCard>
        ) : !model.linked ? (
          <NotLinkedCard />
        ) : model.payslips.length === 0 ? (
          <BentoCard title="Payslips" icon={Receipt} className="col-span-2 md:col-span-12">
            <Muted>{NO_PAYSLIPS_TEXT}</Muted>
          </BentoCard>
        ) : (
          model.payslips.map((slip) => (
            <BentoCard
              key={slip.id}
              title={slip.label}
              subtitle={`Net pay ${centsToRinggit(slip.net_cents)}`}
              icon={Receipt}
              className="col-span-2 md:col-span-6"
            >
              <PayslipDetail payslip={slip} editable={false} />
            </BentoCard>
          ))
        )}
      </BentoGrid>
    </ScreenContainer>
  );
}
