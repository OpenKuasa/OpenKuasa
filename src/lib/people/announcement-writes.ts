/**
 * The app's write path for announcements. Like `performance-writes.ts`, every change is one call to a database
 * function and this file only checks an input's shape, makes the call and turns a refusal into a sentence (the same
 * leaf module, `performance-refusals.ts`). The workspace is the context's, never the input's. Nothing typed (a
 * title, a body) is ever logged: only the database's code and the function's name.
 */
import { z } from 'zod';
import { type CapResult, type PeopleWriteContext } from './capabilities';
import {
  type Row,
  call,
  count,
  guid,
  optionalGuid,
  parse,
  text,
} from './performance-rpc';

export type SavedAnnouncement = {
  id: string;
  title: string;
  body: string;
  category: 'general' | 'holiday' | 'benefits' | 'strategy' | 'policy';
  status: 'draft' | 'published';
  /** Null on a draft. */
  published_at: string | null;
  /** Null until it has been changed after publishing. */
  edited_at: string | null;
  /** Null on a draft that has never been published. */
  author_name: string | null;
};

export const saveAnnouncementInput = z.object({
  announcement_id: optionalGuid('The announcement to change, by its id. Leave out to add one.'),
  title: z.string().trim().min(1, 'Give the announcement a title.').max(200, 'Keep the title to 200 characters.'),
  // Kept as typed. A missing or null body is empty text.
  body: z.string().max(5000, 'Keep the text to 5,000 characters.').nullish(),
  category: z.enum(['general', 'holiday', 'benefits', 'strategy', 'policy'], 'Choose a category.'),
  publish: z.boolean().optional(),
});
export const announcementIdInput = z.object({ announcement_id: guid('The announcement, by its id.') });

const categories = ['general', 'holiday', 'benefits', 'strategy', 'policy'] as const;
const nullable = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value : undefined;

function pickAnnouncement(row: Row): SavedAnnouncement | null {
  const id = text(row.id);
  const title = text(row.title);
  const category = categories.find((c) => c === row.category);
  const status = row.status === 'draft' || row.status === 'published' ? row.status : null;
  const published = nullable(row.published_at);
  const edited = nullable(row.edited_at);
  const author = nullable(row.author_name);
  if (!id || !title || typeof row.body !== 'string' || !category || !status) return null;
  if (published === undefined || edited === undefined || author === undefined) return null;
  return { id, title, body: row.body, category, status, published_at: published, edited_at: edited, author_name: author };
}

/**
 * Adds an announcement (no `announcement_id`) or changes one. With `publish` a new one or a draft is published;
 * a published one stays published whatever `publish` says (use {@link unpublishAnnouncement} to pull it back).
 */
export async function saveAnnouncement(
  ctx: PeopleWriteContext,
  input: z.input<typeof saveAnnouncementInput>,
): Promise<CapResult<SavedAnnouncement>> {
  const parsed = parse(saveAnnouncementInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'saveAnnouncement',
    'hr_save_announcement',
    {
      p_org: ctx.orgId,
      p_announcement: v.announcement_id ?? null,
      p_title: v.title,
      p_body: v.body ?? '',
      p_category: v.category,
      p_publish: v.publish ?? false,
    },
    pickAnnouncement,
  );
}

/** Draft to published: everyone in the workspace sees it, as new. */
export async function publishAnnouncement(
  ctx: PeopleWriteContext,
  input: z.infer<typeof announcementIdInput>,
): Promise<CapResult<SavedAnnouncement>> {
  const parsed = parse(announcementIdInput, input);
  if (!parsed.ok) return parsed;
  return call(
    ctx,
    'publishAnnouncement',
    'hr_publish_announcement',
    { p_announcement: parsed.data.announcement_id },
    pickAnnouncement,
  );
}

/** Published to draft: members no longer see it. */
export async function unpublishAnnouncement(
  ctx: PeopleWriteContext,
  input: z.infer<typeof announcementIdInput>,
): Promise<CapResult<SavedAnnouncement>> {
  const parsed = parse(announcementIdInput, input);
  if (!parsed.ok) return parsed;
  return call(
    ctx,
    'unpublishAnnouncement',
    'hr_unpublish_announcement',
    { p_announcement: parsed.data.announcement_id },
    pickAnnouncement,
  );
}

/** Deletes an announcement and everyone's read marks for it. */
export async function deleteAnnouncement(
  ctx: PeopleWriteContext,
  input: z.infer<typeof announcementIdInput>,
): Promise<CapResult<{ id: string }>> {
  const parsed = parse(announcementIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'deleteAnnouncement', 'hr_delete_announcement', { p_announcement: parsed.data.announcement_id }, (row) => {
    const id = text(row.id);
    return id ? { id } : null;
  });
}

/** Marks every announcement unread for the caller, in the context's workspace, as read. Their own marks only. */
export async function markAnnouncementsRead(ctx: PeopleWriteContext): Promise<CapResult<{ marked: number }>> {
  return call(ctx, 'markAnnouncementsRead', 'hr_mark_announcements_read', { p_org: ctx.orgId }, (row) => {
    const marked = count(row.marked);
    return marked === null ? null : { marked };
  });
}

/**
 * The caller's unread count. Zero on any failure and for the demo; never throws, because it runs on every Lekiu
 * page load and the page must not fail over a badge.
 */
export async function unreadAnnouncements(ctx: PeopleWriteContext): Promise<number> {
  try {
    const { data, error } = await ctx.client.rpc('hr_unread_announcements', { p_org: ctx.orgId });
    if (error) {
      console.error('[people-capability] unreadAnnouncements failed:', error.code ?? 'no-code');
      return 0;
    }
    return count(data) ?? 0;
  } catch (error) {
    console.error('[people-capability] unreadAnnouncements failed:', error instanceof Error ? error.name : 'error');
    return 0;
  }
}
