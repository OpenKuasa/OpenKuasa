'use server';

import {
  deleteAnnouncement,
  markAnnouncementsRead,
  publishAnnouncement,
  saveAnnouncement,
  unpublishAnnouncement,
} from '@/lib/people/announcement-writes';
import { ANNOUNCEMENT_PATHS, asAdmin, asMember, changed, refused } from './performance-guards';

// Every action passes its input to the write path, which validates it. The workspace is always the session's.

/**
 * Marks every announcement that is unread for the signed-in person as read. Their own marks only; no employee
 * record is needed, and the demo has none. Called when the Announcements page is opened by someone who is not
 * just looking at it for someone else, so an owner opening the page marks it for themselves and nobody else.
 */
export async function markAnnouncementsReadAction() {
  const guard = await asMember('announcement-actions', false);
  if (refused(guard)) return guard;
  return changed(await markAnnouncementsRead(guard.ctx), ANNOUNCEMENT_PATHS);
}

// ---- Owner or admin -----------------------------------------------------------------------

export async function saveAnnouncementAction(input: unknown) {
  const guard = await asAdmin('announcement-actions');
  if (refused(guard)) return guard;
  return changed(await saveAnnouncement(guard.ctx, input as never), ANNOUNCEMENT_PATHS);
}

export async function publishAnnouncementAction(input: unknown) {
  const guard = await asAdmin('announcement-actions');
  if (refused(guard)) return guard;
  return changed(await publishAnnouncement(guard.ctx, input as never), ANNOUNCEMENT_PATHS);
}

export async function unpublishAnnouncementAction(input: unknown) {
  const guard = await asAdmin('announcement-actions');
  if (refused(guard)) return guard;
  return changed(await unpublishAnnouncement(guard.ctx, input as never), ANNOUNCEMENT_PATHS);
}

export async function deleteAnnouncementAction(input: unknown) {
  const guard = await asAdmin('announcement-actions');
  if (refused(guard)) return guard;
  return changed(await deleteAnnouncement(guard.ctx, input as never), ANNOUNCEMENT_PATHS);
}
