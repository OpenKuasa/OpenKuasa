import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERFORMANCE_REFUSALS } from '@/lib/people/performance-refusals';
import {
  deleteAnnouncement,
  markAnnouncementsRead,
  publishAnnouncement,
  saveAnnouncement,
  unpublishAnnouncement,
  unreadAnnouncements,
} from '@/lib/people/announcement-writes';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = '99999999-9999-4999-8999-999999999999';
const ANN = '55555555-5555-4555-8555-555555555555';
const ctxOf = (client: never) => ({ client, orgId: ORG });
const GENERIC = 'That change could not be saved. Please try again.';

afterEach(() => vi.restoreAllMocks());

const annJson = (over: Record<string, unknown> = {}) => ({
  id: ANN, title: 'Town hall', body: 'Friday.', category: 'general', status: 'draft', published_at: null,
  edited_at: null, author_name: null, ...over,
});

describe('saveAnnouncement', () => {
  it('adds a draft: the workspace from the context, a null id, a trimmed title and the body as typed', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_announcement': { data: annJson() } });
    const result = await saveAnnouncement(ctxOf(client), {
      title: '  Town hall ', body: ' Friday.\n', category: 'general', publish: false, org_id: 'someone-else',
    } as never);
    expect(result).toEqual({ ok: true, data: annJson() });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('hr_save_announcement');
    expect(calls[0].args).toEqual({
      p_org: ORG, p_announcement: null, p_title: 'Town hall', p_body: ' Friday.\n', p_category: 'general', p_publish: false,
    });
  });

  it('publishes on save, and sends publish as false when it is left out', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_save_announcement': { data: annJson({ status: 'published', published_at: '2026-10-12T02:00:00+00:00', author_name: 'Siti' }) },
    });
    const published = await saveAnnouncement(ctxOf(client), { title: 'x', body: 'y', category: 'policy', publish: true });
    expect(published).toMatchObject({ ok: true, data: { status: 'published', author_name: 'Siti' } });
    await saveAnnouncement(ctxOf(client), { title: 'x', body: 'y', category: 'policy' } as never);
    expect(calls.map((c) => c.args?.p_publish)).toEqual([true, false]);
  });

  it('changes one by its id, and reads an empty id as none', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_announcement': { data: annJson() } });
    await saveAnnouncement(ctxOf(client), { announcement_id: ANN, title: 'x', body: '', category: 'holiday', publish: false });
    await saveAnnouncement(ctxOf(client), { announcement_id: '', title: 'x', body: '', category: 'holiday', publish: false });
    expect(calls.map((c) => c.args?.p_announcement)).toEqual([ANN, null]);
  });

  it('accepts a missing or null body as empty text', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_announcement': { data: annJson({ body: '' }) } });
    await saveAnnouncement(ctxOf(client), { title: 'x', category: 'general', publish: false } as never);
    await saveAnnouncement(ctxOf(client), { title: 'x', body: null, category: 'general', publish: false } as never);
    expect(calls.map((c) => c.args?.p_body)).toEqual(['', '']);
  });

  it('refuses a bad announcement before calling', async () => {
    const { client, calls } = fakeSupabase();
    const good = { title: 'x', body: 'y', category: 'general', publish: false };
    for (const patch of [
      { title: '   ' }, { title: 'x'.repeat(201) }, { body: 'x'.repeat(5001) }, { category: 'news' },
      { category: undefined }, { announcement_id: 9 }, { announcement_id: 'nope' }, { publish: 'yes' },
    ]) {
      expect((await saveAnnouncement(ctxOf(client), { ...good, ...patch } as never)).ok, JSON.stringify(patch)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('answers the announcement codes with their sentences', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_save_announcement': { error: { message: 'ANN_BAD_INPUT' } } });
    expect(await saveAnnouncement(ctxOf(client), { title: 'x', body: '', category: 'general', publish: false })).toEqual({
      ok: false, error: PERFORMANCE_REFUSALS.ANN_BAD_INPUT,
    });
  });
});

describe('publish, pull back and delete', () => {
  it('call the function with the announcement id alone and hand back its reply', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_publish_announcement': { data: annJson({ status: 'published', published_at: '2026-10-12T02:00:00+00:00', author_name: 'Siti' }) },
      'rpc.hr_unpublish_announcement': { data: annJson() },
      'rpc.hr_delete_announcement': { data: { id: ANN } },
    });
    expect(await publishAnnouncement(ctxOf(client), { announcement_id: ANN })).toMatchObject({
      ok: true, data: { id: ANN, status: 'published', published_at: '2026-10-12T02:00:00+00:00' },
    });
    expect(await unpublishAnnouncement(ctxOf(client), { announcement_id: ANN })).toMatchObject({
      ok: true, data: { status: 'draft', published_at: null },
    });
    expect(await deleteAnnouncement(ctxOf(client), { announcement_id: ANN })).toEqual({ ok: true, data: { id: ANN } });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['hr_publish_announcement', { p_announcement: ANN }],
      ['hr_unpublish_announcement', { p_announcement: ANN }],
      ['hr_delete_announcement', { p_announcement: ANN }],
    ]);
  });

  it('refuse a missing, non-text or malformed id without calling', async () => {
    const { client, calls } = fakeSupabase();
    for (const input of [{}, { announcement_id: null }, { announcement_id: 4 }, { announcement_id: 'x' }]) {
      expect((await publishAnnouncement(ctxOf(client), input as never)).ok).toBe(false);
      expect((await unpublishAnnouncement(ctxOf(client), input as never)).ok).toBe(false);
      expect((await deleteAnnouncement(ctxOf(client), input as never)).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('turn the draft and published refusals into their sentences', async () => {
    const { client } = fakeSupabase({
      'rpc.hr_publish_announcement': { error: { message: 'ANN_NOT_DRAFT' } },
      'rpc.hr_unpublish_announcement': { error: { message: 'ANN_NOT_PUBLISHED' } },
      'rpc.hr_delete_announcement': { error: { message: 'ANN_NOT_FOUND' } },
    });
    expect(await publishAnnouncement(ctxOf(client), { announcement_id: ANN })).toEqual({
      ok: false, error: 'That announcement is already published.',
    });
    expect(await unpublishAnnouncement(ctxOf(client), { announcement_id: ANN })).toEqual({
      ok: false, error: 'That announcement is still a draft.',
    });
    expect(await deleteAnnouncement(ctxOf(client), { announcement_id: ANN })).toEqual({
      ok: false, error: 'That announcement could not be found.',
    });
  });

  it('answer an unknown error generically and never log the title or body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_save_announcement': { error: { code: '40001', message: 'could not serialize' } } });
    const result = await saveAnnouncement(ctxOf(client), { title: 'SECRET TITLE', body: 'SECRET BODY', category: 'general', publish: true });
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET/);
    expect(JSON.stringify(log.mock.calls)).toContain('saveAnnouncement');
  });

  it('treat a reply that is not an announcement as a failed save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_publish_announcement': { data: { id: ANN, status: 'archived' } } });
    expect(await publishAnnouncement(ctxOf(client), { announcement_id: ANN })).toEqual({ ok: false, error: GENERIC });
  });
});

describe('markAnnouncementsRead', () => {
  it('marks for the caller in the workspace of the context and says how many', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_mark_announcements_read': { data: { marked: 3 } } });
    expect(await markAnnouncementsRead(ctxOf(client))).toEqual({ ok: true, data: { marked: 3 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('hr_mark_announcements_read');
    expect(calls[0].args).toEqual({ p_org: ORG });
  });

  it('turns a refusal into a sentence and a malformed reply into a failed save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = fakeSupabase({ 'rpc.hr_mark_announcements_read': { error: { message: 'ANN_NOT_ALLOWED' } } });
    expect(await markAnnouncementsRead(ctxOf(refused.client))).toEqual({ ok: false, error: PERFORMANCE_REFUSALS.ANN_NOT_ALLOWED });
    const odd = fakeSupabase({ 'rpc.hr_mark_announcements_read': { data: { marked: -1 } } });
    expect(await markAnnouncementsRead(ctxOf(odd.client))).toEqual({ ok: false, error: GENERIC });
  });
});

describe('unreadAnnouncements', () => {
  it('returns the count the database gives', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_unread_announcements': { data: 4 } });
    expect(await unreadAnnouncements(ctxOf(client))).toBe(4);
    expect(calls[0].fn).toBe('hr_unread_announcements');
    expect(calls[0].args).toEqual({ p_org: ORG });
  });

  it('is zero on an error, on no data and on anything that is not a count', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const reply of [
      { error: { message: 'boom' } }, { data: null }, { data: '3' }, { data: -2 }, { data: 1.5 }, { data: { n: 1 } },
    ]) {
      const { client } = fakeSupabase({ 'rpc.hr_unread_announcements': reply });
      expect(await unreadAnnouncements(ctxOf(client)), JSON.stringify(reply)).toBe(0);
    }
  });

  it('never throws, even when the call itself does, and logs nothing but the name of the error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = {
      rpc: async () => {
        throw new TypeError('SECRET network text');
      },
    } as never;
    await expect(unreadAnnouncements({ client, orgId: ORG })).resolves.toBe(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
});
