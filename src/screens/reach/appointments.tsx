import { CalendarDays } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { AppointmentsTable } from '@/components/reach/appointments-table';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import type { Appointment } from '@/lib/reach/types';
import { loadReachData } from './parts';

export default async function AppointmentsScreen() {
  const [data, viewer] = await Promise.all([loadReachData(), getViewer()]);
  const appts: Appointment[] = await data.listAppointments();
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');

  const now = new Date().getTime();
  const upcoming = appts.filter(
    (a) => a.status === 'scheduled' && new Date(a.scheduled_at).getTime() >= now,
  ).length;
  const completed = appts.filter((a) => a.status === 'completed').length;
  const noShows = appts.filter((a) => a.status === 'no_show').length;
  const attended = completed + noShows;
  const showRate = attended === 0 ? null : Math.round((completed / attended) * 100);

  return (
    <ScreenContainer>
      <PageHeader
        title="Appointments"
        subtitle="Book, reschedule and track appointments with your contacts."
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Total" value={String(appts.length)} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Upcoming" value={String(upcoming)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Completed" value={String(completed)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Show-rate" value={showRate === null ? '—' : `${showRate}%`} />
        </BentoCard>

        <BentoCard
          title="Appointments"
          subtitle="Soonest first"
          icon={CalendarDays}
          className="col-span-2 md:col-span-12"
        >
          <AppointmentsTable appointments={appts} canEdit={canEdit} />
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
