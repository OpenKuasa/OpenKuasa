import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReachWriteContext,
  createForm,
  createFormInput,
  deleteForm,
  deleteFormInput,
  setFormStatus,
  setFormStatusInput,
  updateForm,
  updateFormInput,
} from '@/lib/reach/capabilities';

const ID = '11111111-1111-4111-8111-111111111111';

type Call = { table: string; op: string; values?: Record<string, unknown>; filters: Record<string, unknown>; columns?: string };

/**
 * A stand-in Supabase client that records what a capability asked for and
 * answers with a canned `{ data, error }`.
 */
function fakeClient(answer: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: '', filters: {} };
      calls.push(call);
      const builder = {
        insert(values: Record<string, unknown>) { call.op = 'insert'; call.values = values; return builder; },
        update(values: Record<string, unknown>) { call.op = 'update'; call.values = values; return builder; },
        delete() { call.op = 'delete'; return builder; },
        eq(column: string, value: unknown) { call.filters[column] = value; return builder; },
        select(columns: string) { call.columns = columns; return builder; },
        single: async () => answer,
        maybeSingle: async () => answer,
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies ReachWriteContext, calls };
}

const row = {
  id: ID, name: 'Raya Promo', category: 'Promotions', slug: 'raya-promo', channel: null,
  status: 'draft', views_count: 0, submissions_count: 0, created_at: 'now', updated_at: 'now',
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

describe('form capability schemas', () => {
  const first = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, value: unknown) =>
    schema.safeParse(value).error?.issues[0]?.message;

  it('asks for a name in words a person can act on', () => {
    expect(first(createFormInput, { name: '  ' })).toBe('Enter a name for the form.');
    expect(first(createFormInput, {})).toBe('Enter a name for the form.');
  });
  it('explains a link that is not allowed', () => {
    const message = 'Use only lower-case letters, numbers and hyphens in the short name, such as raya-promo.';
    expect(first(createFormInput, { name: 'x y', slug: 'Raya Promo' })).toBe(message);
    expect(first(createFormInput, { name: 'x y', slug: 'a' })).toBe(message);
    expect(first(updateFormInput, { id: ID, slug: 'no_underscores' })).toBe(message);
  });
  it('accepts a link with a leading slash, or none at all', () => {
    expect(createFormInput.safeParse({ name: 'x y', slug: '/raya-promo' }).success).toBe(true);
    expect(createFormInput.safeParse({ name: 'x y', slug: '' }).success).toBe(true);
    expect(createFormInput.safeParse({ name: 'x y' }).success).toBe(true);
  });
  it('defaults to a draft with no category and no channel', () => {
    expect(createFormInput.parse({ name: 'x y' })).toMatchObject({ status: 'draft', category: null, channel: null });
  });
  it('knows the three statuses and nothing else', () => {
    for (const status of ['draft', 'active', 'paused']) {
      expect(setFormStatusInput.safeParse({ id: ID, status }).success).toBe(true);
    }
    expect(first(setFormStatusInput, { id: ID, status: 'archived' })).toBe('Choose a status: draft, active or paused.');
  });
  it('treats an id that is not an id as a form that is gone', () => {
    expect(first(deleteFormInput, { id: 'form_1' })).toBe('That form no longer exists.');
    expect(first(updateFormInput, { id: 'nope', name: 'x' })).toBe('That form no longer exists.');
  });
  it('asks for a consent sentence of 1 to 300 characters', () => {
    expect(first(createFormInput, { name: 'x y', consent_text: '   ' })).toBe('Enter the sentence visitors tick to agree.');
    expect(first(updateFormInput, { id: ID, consent_text: 'c'.repeat(301) }))
      .toBe('Keep the consent sentence to 300 characters or fewer.');
    expect(updateFormInput.safeParse({ id: ID, consent_text: 'c'.repeat(300) }).success).toBe(true);
    // Left out, a new form takes the database's default.
    expect(createFormInput.parse({ name: 'x y' })).not.toHaveProperty('consent_text');
  });
  it('has no place for the counters or the workspace', () => {
    const parsed = updateFormInput.parse({ id: ID, name: 'x', views_count: 9, submissions_count: 9, org_id: 'other' });
    expect(parsed).not.toHaveProperty('views_count');
    expect(parsed).not.toHaveProperty('submissions_count');
    expect(parsed).not.toHaveProperty('org_id');
  });
});

describe('createForm', () => {
  it('writes to the caller workspace and never sends the counters or an id', async () => {
    const { ctx, calls } = fakeClient({ data: row, error: null });
    const res = await createForm(ctx, {
      name: ' Raya Promo ', category: 'Promotions', slug: '/raya-promo', status: 'active',
      // @ts-expect-error org_id and the counters are not part of the input.
      org_id: 'someone-else', views_count: 50,
    });
    expect(res).toEqual({ ok: true, data: row });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: 'forms', op: 'insert' });
    expect(calls[0].values).toEqual({
      org_id: 'org-1', name: 'Raya Promo', category: 'Promotions', slug: 'raya-promo', channel: null, status: 'active',
    });
  });
  it('leaves the consent sentence to the database default unless one is given', async () => {
    const { ctx, calls } = fakeClient({ data: row, error: null });
    await createForm(ctx, { name: 'Raya Promo' });
    expect(calls[0].values).not.toHaveProperty('consent_text');
    const own = fakeClient({ data: row, error: null });
    await createForm(own.ctx, { name: 'Raya Promo', consent_text: '  {workspace} may call me.  ' });
    expect(own.calls[0].values).toMatchObject({ consent_text: '{workspace} may call me.' });
  });
  it('derives the link from the name when none is given', async () => {
    const { ctx, calls } = fakeClient({ data: row, error: null });
    await createForm(ctx, { name: 'Free Consultation 2026' });
    expect(calls[0].values).toMatchObject({ slug: 'free-consultation-2026', status: 'draft', category: null });
    const again = fakeClient({ data: row, error: null });
    await createForm(again.ctx, { name: 'Newsletter', slug: '', category: '  ' });
    expect(again.calls[0].values).toMatchObject({ slug: 'newsletter', category: null });
  });
  it('stops before any query when the name cannot make a link', async () => {
    const { ctx, calls } = fakeClient({ data: row, error: null });
    const res = await createForm(ctx, { name: '!!!' });
    expect(res).toEqual({
      ok: false,
      error: 'Use only lower-case letters, numbers and hyphens in the short name, such as raya-promo.',
    });
    expect(calls).toHaveLength(0);
  });
  it('says the link is taken on a unique violation', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: '23505', message: 'duplicate key' } });
    expect(await createForm(ctx, { name: 'Raya Promo' })).toEqual({ ok: false, error: 'Another form already uses that short name.' });
  });
  it('hides any other database error behind the general message', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: '42501', message: 'permission denied for table forms' } });
    const res = await createForm(ctx, { name: 'Raya Promo' });
    expect(res).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});

describe('updateForm', () => {
  it('updates only what was sent, scoped to the id and the workspace', async () => {
    const { ctx, calls } = fakeClient({ data: row, error: null });
    const res = await updateForm(ctx, { id: ID, name: 'New name', slug: '/new-link', category: '' });
    expect(res.ok).toBe(true);
    expect(calls[0]).toMatchObject({ table: 'forms', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    const { updated_at, ...sent } = calls[0].values!;
    expect(sent).toEqual({ name: 'New name', slug: 'new-link', category: null });
    expect(typeof updated_at).toBe('string');
  });
  it('derives an emptied link from the name sent with it', async () => {
    const { ctx, calls } = fakeClient({ data: row, error: null });
    await updateForm(ctx, { id: ID, name: 'Event RSVP', slug: '' });
    expect(calls[0].values).toMatchObject({ slug: 'event-rsvp' });
    const alone = fakeClient({ data: row, error: null });
    expect(await updateForm(alone.ctx, { id: ID, slug: '' })).toMatchObject({ ok: false });
    expect(alone.calls).toHaveLength(0);
  });
  it('saves a changed consent sentence, trimmed', async () => {
    const { ctx, calls } = fakeClient({ data: row, error: null });
    expect((await updateForm(ctx, { id: ID, consent_text: ' I agree {workspace} may email me. ' })).ok).toBe(true);
    expect(calls[0].values).toEqual({
      consent_text: 'I agree {workspace} may email me.',
      updated_at: expect.any(String),
    });
  });
  it('has nothing to do when only the id is sent', async () => {
    const { ctx, calls } = fakeClient({ data: row, error: null });
    expect(await updateForm(ctx, { id: ID })).toEqual({ ok: false, error: 'Nothing to update.' });
    expect(calls).toHaveLength(0);
  });
  it('says the form is gone when no row matched', async () => {
    const { ctx } = fakeClient({ data: null, error: null });
    expect(await updateForm(ctx, { id: ID, name: 'x' })).toEqual({ ok: false, error: 'That form no longer exists.' });
  });
  it('says the link is taken on a unique violation', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: '23505' } });
    expect(await updateForm(ctx, { id: ID, slug: 'newsletter' })).toEqual({ ok: false, error: 'Another form already uses that short name.' });
  });
});

describe('setFormStatus', () => {
  it('changes the status and nothing else', async () => {
    const { ctx, calls } = fakeClient({ data: { ...row, status: 'paused' }, error: null });
    const res = await setFormStatus(ctx, { id: ID, status: 'paused' });
    expect(res).toMatchObject({ ok: true, data: { status: 'paused' } });
    const { updated_at, ...sent } = calls[0].values!;
    expect(sent).toEqual({ status: 'paused' });
    expect(updated_at).toBeTruthy();
  });
});

describe('deleteForm', () => {
  it('deletes by id inside the workspace', async () => {
    const { ctx, calls } = fakeClient({ data: { id: ID }, error: null });
    expect(await deleteForm(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ table: 'forms', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('says the form is gone when no row matched', async () => {
    const { ctx } = fakeClient({ data: null, error: null });
    expect(await deleteForm(ctx, { id: ID })).toEqual({ ok: false, error: 'That form no longer exists.' });
  });
});
