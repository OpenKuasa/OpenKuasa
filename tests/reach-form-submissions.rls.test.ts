import { beforeAll, expect, test, type TestContext } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, beforeCleanup } from './helpers/live-workspaces';
import {
  formSubmissionsMissing,
  formSubmissionsSkipReason,
} from './helpers/form-submissions-table';
import { createSupabaseReachData } from '@/lib/reach/supabase';
import { deleteFormSubmission } from '@/lib/reach/capabilities';
import { getPublicForm, recordFormView, submitPublicForm } from '@/lib/reach/public-forms';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

async function signedIn() {
  const c = client();
  const { error } = await signInAnon(c);
  expect(error, error?.message).toBeNull();
  return c;
}

async function ownedOrg(c: SupabaseClient, name: string) {
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

type Owned = Awaited<ReturnType<typeof ownedOrg>>;
let owner: Owned;
let other: Owned;
/** Someone who is not signed in: what a visitor to a public form is. */
const visitor = client();
/** True until the public lead forms migration has been applied to the database. */
let migrationMissing = false;

const ORG_NAME = 'Public Forms Kedai Sdn Bhd';
const UNKNOWN = '00000000-0000-4000-8000-00000000dead';

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const first = await signedIn();
  migrationMissing = await formSubmissionsMissing(first);
  if (migrationMissing) {
    console.warn(formSubmissionsSkipReason);
    await first.auth.signOut();
    return;
  }
  owner = await ownedOrg(first, ORG_NAME);
  other = await ownedOrg(await signedIn(), 'Public Forms Other Sdn Bhd');
});
// If the cleanup cannot delete the workspaces (no key, migration not applied), they must not keep
// active public forms, so this pauses the forms this file created, first inside the helper's cleanup,
// while the owners' sessions are still valid (nothing signs them out earlier).
beforeCleanup(async () => {
  for (const org of [owner, other]) {
    if (!org) continue;
    await org.c.from('forms').update({ status: 'paused' }).eq('org_id', org.orgId);
  }
});

/** Skips a test, visibly, while the migration is not there yet. */
function needsMigration(ctx: TestContext) {
  if (migrationMissing) ctx.skip(formSubmissionsSkipReason);
}

const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const email = (prefix: string) => `${unique(prefix)}@example.com`;

async function makeForm(org: Owned, name: string, status: 'draft' | 'active' | 'paused' = 'active') {
  const { data, error } = await org.c
    .from('forms')
    .insert({ org_id: org.orgId, name, slug: unique('pf'), status })
    .select('id')
    .single();
  expect(error, error?.message).toBeNull();
  return data!.id as string;
}

const submit = (formId: string, fields: { name?: string | null; email?: string | null; phone?: string | null; message?: string | null; honeypot?: string }) =>
  visitor.rpc('submit_public_form', {
    p_form_id: formId,
    p_name: fields.name === undefined ? 'Siti Aisyah' : fields.name,
    p_email: fields.email === undefined ? email('visitor') : fields.email,
    p_phone: fields.phone ?? null,
    p_message: fields.message ?? null,
    p_honeypot: fields.honeypot ?? null,
  });

const counters = async (formId: string) => {
  const { data, error } = await owner.c.from('forms').select('views_count, submissions_count').eq('id', formId).single();
  expect(error, error?.message).toBeNull();
  return data!;
};
const submissionsOf = async (formId: string) => {
  const { data, error } = await owner.c
    .from('form_submissions')
    .select('id, org_id, form_id, contact_id, payload, created_at')
    .eq('form_id', formId)
    .order('created_at', { ascending: true });
  expect(error, error?.message).toBeNull();
  return data ?? [];
};

testWithSupabase('a visitor who is not signed in cannot read or write forms, submissions or contacts', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Denied');
  for (const table of ['forms', 'form_submissions', 'crm_contacts']) {
    const read = await visitor.from(table).select('id').limit(1);
    expect(read.error?.code, `select ${table}`).toBe('42501');
  }
  const ins = await visitor.from('form_submissions').insert({ org_id: owner.orgId, form_id: formId, payload: {} });
  expect(ins.error?.code).toBe('42501');
  const contact = await visitor.from('crm_contacts').insert({ org_id: owner.orgId, first_name: 'Anon' });
  expect(contact.error?.code).toBe('42501');
  const upd = await visitor.from('forms').update({ views_count: 99 }).eq('id', formId);
  expect(upd.error?.code).toBe('42501');
  const del = await visitor.from('form_submissions').delete().eq('form_id', formId);
  expect(del.error?.code).toBe('42501');
});

testWithSupabase('the public lookup gives the form name, the workspace name and "accepting", and nothing else', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Raya Promo');
  const { data, error } = await visitor.rpc('get_public_form', { p_form_id: formId });
  expect(error, error?.message).toBeNull();
  expect(data).toEqual([{ form_name: 'Raya Promo', org_name: ORG_NAME, accepting: true }]);
  expect(Object.keys(data[0]).sort()).toEqual(['accepting', 'form_name', 'org_name']);
  // Through the module the page uses.
  expect(await getPublicForm(visitor, formId)).toEqual({ accepting: true, name: 'Raya Promo', orgName: ORG_NAME });
});

testWithSupabase('a draft or paused form is "not accepting" with no names; an unknown form is nothing at all', async (ctx) => {
  needsMigration(ctx);
  for (const status of ['draft', 'paused'] as const) {
    const formId = await makeForm(owner, `Hidden ${status}`, status);
    const { data, error } = await visitor.rpc('get_public_form', { p_form_id: formId });
    expect(error, error?.message).toBeNull();
    expect(data, status).toEqual([{ form_name: null, org_name: null, accepting: false }]);
    expect(await getPublicForm(visitor, formId)).toEqual({ accepting: false });

    const refused = await submit(formId, {});
    expect(refused.data, status).toBe('closed');
    expect(await submissionsOf(formId)).toHaveLength(0);
    expect((await counters(formId)).submissions_count).toBe(0);
  }
  const unknown = await visitor.rpc('get_public_form', { p_form_id: UNKNOWN });
  expect(unknown.error).toBeNull();
  expect(unknown.data).toEqual([]);
  expect(await getPublicForm(visitor, UNKNOWN)).toBeNull();
  expect((await submit(UNKNOWN, {})).data).toBe('not_found');
});

testWithSupabase('a submission is recorded, makes a contact and moves the count', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Free Consultation');
  const address = email('Siti.Aisyah');
  const res = await submit(formId, { name: '  Siti   Nur  Aisyah ', email: `  ${address.toUpperCase()} `, phone: ' 012 345 6789 ', message: 'Call me after 5pm.' });
  expect(res.error, res.error?.message).toBeNull();
  // One word, and no ids.
  expect(res.data).toBe('ok');

  const subs = await submissionsOf(formId);
  expect(subs).toHaveLength(1);
  expect(subs[0].org_id).toBe(owner.orgId);
  expect(subs[0].payload).toEqual({
    name: 'Siti Nur Aisyah', email: address.toLowerCase(), phone: '012 345 6789', message: 'Call me after 5pm.',
  });
  expect(Object.keys(subs[0]).sort()).toEqual(['contact_id', 'created_at', 'form_id', 'id', 'org_id', 'payload']);

  const contact = await owner.c.from('crm_contacts').select('*').eq('id', subs[0].contact_id).single();
  expect(contact.error, contact.error?.message).toBeNull();
  expect(contact.data).toMatchObject({
    org_id: owner.orgId,
    first_name: 'Siti',
    last_name: 'Nur Aisyah',
    email: address.toLowerCase(),
    phone: '012 345 6789',
    country: null,
    source: 'Lead form: Free Consultation',
    status: 'lead',
    lead_score: 0,
    owner_user_id: null,
    tags: ['lead-form'],
  });
  expect((await counters(formId)).submissions_count).toBe(1);

  // A single name has no last name; empty optional fields are stored as null.
  const single = email('madonna');
  expect((await submit(formId, { name: 'Madonna', email: single })).data).toBe('ok');
  const madonna = await owner.c.from('crm_contacts').select('first_name, last_name, phone').eq('email', single).single();
  expect(madonna.data).toEqual({ first_name: 'Madonna', last_name: null, phone: null });
  const second = (await submissionsOf(formId))[1];
  expect(second.payload).toEqual({ name: 'Madonna', email: single, phone: null, message: null });
  expect((await counters(formId)).submissions_count).toBe(2);
});

testWithSupabase('a repeat email links to the existing contact, leaves it as it was, and still counts', async (ctx) => {
  needsMigration(ctx);
  const first = await makeForm(owner, 'Newsletter');
  const second = await makeForm(owner, 'Event RSVP');
  const address = email('repeat');

  expect((await submit(first, { name: 'Faiz Hakim', email: address, phone: '011' })).data).toBe('ok');
  expect((await submit(second, { name: 'Somebody Else', email: address.toUpperCase(), phone: '999' })).data).toBe('ok');

  const contacts = await owner.c.from('crm_contacts').select('id, first_name, last_name, phone, source').eq('email', address);
  expect(contacts.data).toHaveLength(1);
  // The second submission did not rewrite the contact.
  expect(contacts.data![0]).toMatchObject({ first_name: 'Faiz', last_name: 'Hakim', phone: '011', source: 'Lead form: Newsletter' });

  const a = await submissionsOf(first);
  const b = await submissionsOf(second);
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0].contact_id).toBe(contacts.data![0].id);
  expect(b[0].contact_id).toBe(contacts.data![0].id);
  expect((await counters(first)).submissions_count).toBe(1);
  expect((await counters(second)).submissions_count).toBe(1);

  // A contact the workspace added by hand, with capitals in the email, is matched too.
  const typed = email('Typed.By.Hand');
  const byHand = await owner.c
    .from('crm_contacts')
    .insert({ org_id: owner.orgId, first_name: 'Typed', email: typed, phone: '000' })
    .select('id')
    .single();
  expect(byHand.error, byHand.error?.message).toBeNull();
  expect((await submit(first, { name: 'Impostor', email: typed.toLowerCase(), phone: '666' })).data).toBe('ok');
  const still = await owner.c.from('crm_contacts').select('id, first_name, phone, tags, source').ilike('email', typed);
  expect(still.data).toEqual([{ id: byHand.data!.id, first_name: 'Typed', phone: '000', tags: [], source: null }]);
  expect((await submissionsOf(first))[1].contact_id).toBe(byHand.data!.id);
});

testWithSupabase('a filled honeypot is thanked and stores nothing', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Honeypot');
  const address = email('bot');
  const res = await submit(formId, { name: 'Bot', email: address, honeypot: 'http://spam.example' });
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data).toBe('ok');
  expect(await submissionsOf(formId)).toHaveLength(0);
  expect((await counters(formId)).submissions_count).toBe(0);
  const contact = await owner.c.from('crm_contacts').select('id').eq('email', address);
  expect(contact.data).toHaveLength(0);
});

testWithSupabase('over-long, missing and malformed input is refused by the database and stores nothing', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Strict');
  const cases: [string, Parameters<typeof submit>[1], string][] = [
    ['blank name', { name: '   ' }, 'invalid_name'],
    ['no name', { name: null }, 'invalid_name'],
    ['name of 121', { name: 'n'.repeat(121) }, 'name_too_long'],
    ['no email', { email: null }, 'invalid_email'],
    ['not an email', { email: 'not-an-email' }, 'invalid_email'],
    ['email with a space', { email: 'a b@example.com' }, 'invalid_email'],
    ['two at signs', { email: 'a@b@example.com' }, 'invalid_email'],
    ['email of 255', { email: `${'e'.repeat(249)}@b.com` }, 'email_too_long'],
    ['phone of 41', { phone: '1'.repeat(41) }, 'phone_too_long'],
    ['message of 2001', { message: 'm'.repeat(2001) }, 'message_too_long'],
  ];
  for (const [label, fields, word] of cases) {
    const res = await submit(formId, fields);
    expect(res.error, `${label}: ${res.error?.message}`).toBeNull();
    expect(res.data, label).toBe(word);
  }
  expect(await submissionsOf(formId)).toHaveLength(0);
  expect((await counters(formId)).submissions_count).toBe(0);

  // Exactly at the limits is fine.
  const atLimit = await submit(formId, { name: 'n'.repeat(120), phone: '1'.repeat(40), message: 'm'.repeat(2000) });
  expect(atLimit.data).toBe('ok');
  expect(await submissionsOf(formId)).toHaveLength(1);
});

testWithSupabase('the throttle refuses the 31st submission to one form within a minute', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Throttle');
  const calm = await makeForm(owner, 'Calm');
  // One email throughout, so the flood makes one contact, not thirty.
  const address = email('flood');
  for (let i = 1; i <= 30; i += 1) {
    const res = await submit(formId, { name: `Flood ${i}`, email: address });
    expect(res.data, `submission ${i}`).toBe('ok');
  }
  expect((await submit(formId, { name: 'Flood 31', email: address })).data).toBe('throttled');
  expect((await submit(formId, { name: 'Flood 32', email: email('flood-other') })).data).toBe('throttled');
  // Through the module the page uses.
  expect(await submitPublicForm(visitor, formId, { name: 'Flood 33', email: address, phone: null, message: null }))
    .toEqual({ kind: 'throttled' });

  expect(await submissionsOf(formId)).toHaveLength(30);
  expect((await counters(formId)).submissions_count).toBe(30);
  const contacts = await owner.c.from('crm_contacts').select('id').eq('email', address);
  expect(contacts.data).toHaveLength(1);

  // The limit is per form: another form of the same workspace still accepts.
  expect((await submit(calm, { name: 'Calm', email: address })).data).toBe('ok');
}, 120_000);

testWithSupabase('a view is counted for a visitor and an outsider, not for a member, and never for a closed form', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Views');
  const draft = await makeForm(owner, 'Views Draft', 'draft');

  await recordFormView(visitor, formId);
  await recordFormView(visitor, formId);
  expect((await counters(formId)).views_count).toBe(2);

  // The workspace's own member previewing the form.
  const mine = await owner.c.rpc('record_form_view', { p_form_id: formId });
  expect(mine.error, mine.error?.message).toBeNull();
  expect((await counters(formId)).views_count).toBe(2);

  // Someone signed in to another workspace is a visitor like any other.
  await recordFormView(other.c, formId);
  expect((await counters(formId)).views_count).toBe(3);

  await recordFormView(visitor, draft);
  expect((await counters(draft)).views_count).toBe(0);
  const unknown = await visitor.rpc('record_form_view', { p_form_id: UNKNOWN });
  expect(unknown.error).toBeNull();
});

testWithSupabase('a member of another workspace sees no submissions or contacts and can delete none', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Private');
  expect((await submit(formId, { message: 'for this workspace only' })).data).toBe('ok');
  const mine = await submissionsOf(formId);
  expect(mine).toHaveLength(1);

  const seen = await other.c.from('form_submissions').select('id').eq('form_id', formId);
  expect(seen.error).toBeNull();
  expect(seen.data ?? []).toHaveLength(0);
  const all = await other.c.from('form_submissions').select('id').eq('org_id', owner.orgId);
  expect(all.data ?? []).toHaveLength(0);
  const contacts = await other.c.from('crm_contacts').select('id').eq('org_id', owner.orgId);
  expect(contacts.data ?? []).toHaveLength(0);
  const del = await other.c.from('form_submissions').delete().eq('id', mine[0].id).select('id');
  expect(del.error).toBeNull();
  expect(del.data ?? []).toHaveLength(0);

  // Through the seam the screen reads, and the capability it deletes with.
  expect(await createSupabaseReachData(other.c, other.orgId).listFormSubmissions!(formId)).toEqual([]);
  expect(await createSupabaseReachData(other.c, owner.orgId).listFormSubmissions!(formId)).toEqual([]);
  expect(await deleteFormSubmission({ client: other.c, orgId: other.orgId }, { id: mine[0].id })).toEqual({
    ok: false, error: 'That submission no longer exists.',
  });
  expect(await submissionsOf(formId)).toHaveLength(1);
});

testWithSupabase('a member cannot insert or change a submission through the API, and a writer can delete one', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Locked');
  expect((await submit(formId, {})).data).toBe('ok');
  const [row] = await submissionsOf(formId);

  const ins = await owner.c.from('form_submissions').insert({ org_id: owner.orgId, form_id: formId, payload: { name: 'forged' } });
  expect(ins.error?.code).toBe('42501');
  for (const forged of [{ payload: { name: 'changed' } }, { contact_id: null }, { created_at: new Date(0).toISOString() }, { form_id: formId }]) {
    const upd = await owner.c.from('form_submissions').update(forged).eq('id', row.id);
    expect(upd.error?.code, `update ${Object.keys(forged)[0]} must be denied`).toBe('42501');
  }

  const data = createSupabaseReachData(owner.c, owner.orgId);
  const listed = await data.listFormSubmissions!(formId);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ id: row.id, form_id: formId, name: 'Siti Aisyah', phone: null, message: null });
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  expect(await data.listFormSubmissionTimes!(since)).toContain(row.created_at);
  expect(await data.listFormSubmissionTimes!(new Date(Date.now() + 60 * 60 * 1000).toISOString())).toEqual([]);

  expect(await deleteFormSubmission({ client: owner.c, orgId: owner.orgId }, { id: row.id })).toEqual({
    ok: true, data: { id: row.id },
  });
  expect(await submissionsOf(formId)).toHaveLength(0);
  // The count is a running total of what was received, and the contact stays.
  expect((await counters(formId)).submissions_count).toBe(1);
  const contact = await owner.c.from('crm_contacts').select('id').eq('id', row.contact_id);
  expect(contact.data).toHaveLength(1);
});

testWithSupabase('deleting a form deletes its submissions but not their contacts; deleting a contact unlinks it', async (ctx) => {
  needsMigration(ctx);
  const formId = await makeForm(owner, 'Cascade');
  const keep = email('keep');
  const drop = email('drop');
  expect((await submit(formId, { name: 'Keep Me', email: keep })).data).toBe('ok');
  expect((await submit(formId, { name: 'Drop Me', email: drop })).data).toBe('ok');

  const gone = await owner.c.from('crm_contacts').delete().eq('email', drop).select('id');
  expect(gone.error, gone.error?.message).toBeNull();
  expect(gone.data).toHaveLength(1);
  const after = await submissionsOf(formId);
  expect(after).toHaveLength(2);
  expect(after.find((s) => (s.payload as { email: string }).email === drop)).toMatchObject({ contact_id: null, org_id: owner.orgId });
  expect(after.find((s) => (s.payload as { email: string }).email === keep)?.contact_id).toBeTruthy();

  const del = await owner.c.from('forms').delete().eq('id', formId).select('id');
  expect(del.error, del.error?.message).toBeNull();
  const left = await owner.c.from('form_submissions').select('id').eq('form_id', formId);
  expect(left.data ?? []).toHaveLength(0);
  const kept = await owner.c.from('crm_contacts').select('id').eq('email', keep);
  expect(kept.data).toHaveLength(1);
});

testWithSupabase('the demo workspace takes no public submissions, and a demo guest (a viewer) can delete nothing', async (ctx) => {
  needsMigration(ctx);
  const v = await signedIn();
  const { data: demoId, error: joinError } = await joinDemo(v);
  expect(joinError, joinError?.message).toBeNull();
  const forms = await v.from('forms').select('id, status, views_count, submissions_count').eq('org_id', demoId).eq('status', 'active');
  expect(forms.error, forms.error?.message).toBeNull();
  expect(forms.data!.length).toBeGreaterThan(0);
  const demoForm = forms.data![0];

  // An active demo form is closed to the public, and says nothing about itself.
  const looked = await visitor.rpc('get_public_form', { p_form_id: demoForm.id });
  expect(looked.data).toEqual([{ form_name: null, org_name: null, accepting: false }]);
  expect((await submit(demoForm.id, {})).data).toBe('closed');
  await recordFormView(visitor, demoForm.id);
  const after = await v.from('forms').select('views_count, submissions_count').eq('id', demoForm.id).single();
  expect(after.data).toEqual({ views_count: demoForm.views_count, submissions_count: demoForm.submissions_count });

  // A viewer may read the workspace's submissions (the demo has none) and delete nothing.
  const read = await v.from('form_submissions').select('id').eq('org_id', demoId);
  expect(read.error, read.error?.message).toBeNull();
  expect(read.data ?? []).toHaveLength(0);
  const del = await v.from('form_submissions').delete().eq('org_id', demoId).select('id');
  expect(del.error).toBeNull();
  expect(del.data ?? []).toHaveLength(0);
  await v.auth.signOut();
});
