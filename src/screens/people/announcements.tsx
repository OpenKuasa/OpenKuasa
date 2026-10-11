import { Bell, Megaphone, PieChart, Plus } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { DonutStat } from '@/components/charts';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Badge } from '@/components/ui/badge';
import { buildAnnouncementsModel } from '@/lib/people/company';
import { LOAD_FAILED, LaterButton, Muted, loadPeople } from './parts';

/** Company-wide posts. Every member of the workspace reads the same rows. */
export default async function AnnouncementsScreen() {
  const { model } = await loadPeople('announcements', async (data, now, ctx) =>
    buildAnnouncementsModel(await data.listAnnouncements(), now, ctx.viewer),
  );
  const dash = '—';

  return (
    <ScreenContainer>
      <PageHeader
        title="Announcements"
        subtitle="Company-wide updates for your team."
        actions={
          <LaterButton size="sm" icon={Plus}>
            New Announcement
          </LaterButton>
        }
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat label="Announcements" value={model ? model.total : dash} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat label="This month" value={model ? model.thisMonth : dash} />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-4">
          <BentoStat label="Categories" value={model ? model.categories : dash} />
        </BentoCard>

        <BentoCard
          title="By category"
          subtitle="Across all announcements"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.byCategory.length === 0 ? (
            <Muted>No announcements yet</Muted>
          ) : (
            <DonutStat data={model.byCategory} height={240} centerValue={String(model.total)} centerLabel="posts" />
          )}
        </BentoCard>

        <BentoCard
          title="Latest announcements"
          subtitle="Newest first"
          icon={Megaphone}
          className="col-span-2 md:col-span-8"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.list.length === 0 ? (
            <Muted>No announcements yet</Muted>
          ) : (
            <ul className="divide-y">
              {model.list.map((post) => (
                <li key={post.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {post.author.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{post.title}</h3>
                      <Badge variant="secondary" className="shrink-0">
                        {post.category}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{post.body}</p>
                    <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <Bell className="size-3.5" />
                      <span>{post.author}</span>
                      <span aria-hidden>·</span>
                      <span>{post.when}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
