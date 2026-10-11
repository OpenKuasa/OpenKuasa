import { Receipt } from 'lucide-react';
import { BentoCard, BentoGrid } from '@/components/bento/bento';
import { PayslipDetail } from '@/components/people/payslip-detail';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NO_PAYSLIPS_TEXT, readOwnPayslips } from '@/lib/people/my-payslips';
import { centsToRinggit } from '@/lib/people/payroll-forms';
import { LOAD_FAILED, Muted, NotLinkedCard, loadPeople } from './parts';

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
