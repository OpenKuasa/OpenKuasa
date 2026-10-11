import { Bell, FileText, Megaphone, PieChart } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { DonutStat } from '@/components/charts';
import { AnnouncementDialog } from '@/components/people/announcement-form';
import { AnnouncementRowControls } from '@/components/people/announcement-row-controls';
import { MarkAnnouncementsRead, UnreadMark } from '@/components/people/mark-announcements-read';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Badge } from '@/components/ui/badge';
import { buildAnnouncementsModel } from '@/lib/people/company';
import {
  announcementMarks,
  announcementsScreenControls,
  visibleAnnouncements,
} from '@/lib/people/reviews-announcements';
import { LOAD_FAILED, Muted, StatusPill, loadPeople } from './parts';

/**
 * Company-wide posts. Every member of the workspace reads the same published rows; owners and admins also get
 * drafts, listed first, and the controls to write, publish, pull back and delete. Unread posts are marked "New"; the
 * mark-read component (browser only, never in the demo) clears them once the list is on screen.
 */
export default async function AnnouncementsScreen() {
  const { model, viewer } = await loadPeople('announcements', async (data, now, ctx) =>
    buildAnnouncementsModel(await data.listAnnouncements(), now, ctx.viewer),
  );
  const dash = '—';
  const show = announcementsScreenControls(viewer, model !== null, model?.unread ?? 0);
  const posts = model ? visibleAnnouncements(model) : [];

  return (
    <ScreenContainer>
      <PageHeader
        title="Announcements"
        subtitle="Company-wide updates for your team."
        actions={show.write ? <AnnouncementDialog /> : null}
      />
      {show.markRead ? <MarkAnnouncementsRead /> : null}

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat
            label="Announcements"
            value={model ? model.total : dash}
            delta={model?.drafts ? `${model.drafts} ${model.drafts === 1 ? 'draft' : 'drafts'} not counted` : undefined}
            deltaTone="flat"
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat label="This month" value={model ? model.thisMonth : dash} />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-4">
          <BentoStat label="Categories" value={model ? model.categories : dash} />
        </BentoCard>

        <BentoCard
          title="By category"
          subtitle="Across all published announcements"
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
          subtitle={model?.drafts !== null && model?.drafts !== undefined ? 'Drafts first, then newest' : 'Newest first'}
          icon={Megaphone}
          className="col-span-2 md:col-span-8"
        >
          {!model ? (
            LOAD_FAILED
          ) : posts.length === 0 ? (
            <Muted>No announcements yet</Muted>
          ) : (
            <ul className="divide-y">
              {posts.map((post) => {
                const marks = announcementMarks(post);
                return (
                  <li key={post.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {post.draft ? <FileText className="size-4" aria-hidden /> : post.author.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{post.title}</h3>
                        {marks.includes('Draft') ? <StatusPill tone="pending">Draft</StatusPill> : null}
                        {post.draft ? null : <UnreadMark unread={marks.includes('New')} />}
                        <Badge variant="secondary" className="shrink-0">
                          {post.category}
                        </Badge>
                      </div>
                      <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{post.body}</p>
                      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <Bell className="size-3.5" />
                        <span>{post.draft ? 'Not published yet' : post.author}</span>
                        {post.draft ? null : (
                          <>
                            <span aria-hidden>·</span>
                            <span>{post.when}</span>
                          </>
                        )}
                        {marks.includes('edited') ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>edited</span>
                          </>
                        ) : null}
                      </div>
                      {show.write ? (
                        <AnnouncementRowControls
                          announcement={{
                            id: post.id,
                            title: post.title,
                            body: post.body,
                            category_key: post.category_key,
                            draft: post.draft,
                          }}
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
