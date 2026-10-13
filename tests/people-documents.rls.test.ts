/**
 * Live test of the document and letter write paths and the document bucket against the real database and storage.
 * It needs the three 202611020900xx migrations applied; until then it fails at the first call (the functions and
 * the bucket do not exist). Skipped without Supabase env vars. First run: Task 6 of the L6b plan, after the owner's
 * go-ahead. NOT run by Task 2.
 *
 * A fresh workspace with a CONFIRMED owner (an anonymous account may not upload) and a confirmed member, each
 * linked to an employee record, a colleague, and a confirmed owner of a second workspace.
 *   - Real small PDFs: uploaded by the owner to the member's record and by the member to their own; each attached
 *     with the file's real size and the very type it was uploaded with; the member downloads both through a
 *     one-minute signed link (the bytes are compared, and the link's own expiry is read from its token).
 *   - The member is refused a file on the owner's own record by path (signed link and download), the second
 *     workspace's owner is refused both files and cannot upload into this workspace, nobody can delete from the
 *     bucket, an uploader cannot read a file before it is attached, and a member cannot upload into a colleague's
 *     folder.
 *   - Attach refusals (a wrong size, a wrong type, a type the member may not add, a released path) and the
 *     release of an upload that was never attached.
 *   - Replace and remove return the paths to remove; a deleted employee's files are returned and removed.
 *   - Acknowledgement: only the employee, once, only when asked, cleared by a replaced file.
 *   - A draft letter is invisible to its employee and cannot be acknowledged; issued it is visible and can be
 *     acknowledged once; pulled back it is invisible again.
 *   - A letter from the starter "Offer of employment" template for an employee with no designation is refused at
 *     issue with the placeholder sentence, and the app's placeholder helper agrees with the database's list.
 *   - Every owner-only write is refused to the member with the sentence from the refusals module.
 *   - The sweep functions: the service role runs them, an authenticated owner is refused.
 *   - A demo guest changes nothing (skipped in minutes :00 to :02 UTC, while the demo is re-seeded).
 *   - EVERY file this test uploads is removed, and the last test asserts the bucket holds nothing under the
 *     workspace's folder; a teardown step removes what an earlier failure left and fails loudly if anything remains.
 *
 * Users and workspaces come from tests/helpers/live-workspaces.ts, which also removes them (it deletes no storage
 * object: that is this file's job). Every sentence comes from DOCUMENT_REFUSALS, never a literal.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createEmployee, deleteEmployee, linkEmployeeToMember } from '@/lib/people/capabilities';
import {
  DOCUMENT_BUCKET,
  documentFileFacts,
  documentPath,
  uploadDocumentFile,
} from '@/lib/people/document-files';
import {
  documentLink,
  releaseDocumentFile,
  removeDocumentFile,
  removeDocumentFiles,
} from '@/lib/people/document-files-server';
import {
  acknowledgeDocument,
  addDocument,
  removeDocument,
  replaceDocumentFile,
  requestDocumentAck,
  updateDocument,
} from '@/lib/people/document-writes';
import { DOCUMENT_REFUSALS } from '@/lib/people/documents-refusals';
import { unfilledInLetter } from '@/lib/people/letter-placeholders';
import {
  acknowledgeLetter,
  deleteLetter,
  deleteLetterTemplate,
  issueLetter,
  saveLetter,
  saveLetterTemplate,
  startLetterFromTemplate,
  unissueLetter,
} from '@/lib/people/letter-writes';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import { DEMO_EMPLOYEE_ID } from '@/lib/people/types';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import {
  beforeCleanup,
  createConfirmedTestUser,
  createOrg,
  joinDemo,
  liveClient,
  signInAnon,
} from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const PASSWORD = 'documents-live-pass-123';
const R = DOCUMENT_REFUSALS;
const refused = (code: string) => ({ ok: false, error: R[code] });

let owner: { c: SupabaseClient; userId: string; orgId: string };
let member: { c: SupabaseClient; userId: string };
let other: { c: SupabaseClient; orgId: string };
let guest: { c: SupabaseClient; demoId: string } | undefined;
let service: SupabaseClient | null = null;

// Filled in by the first test, used by the rest.
const ids = { ownerEmp: '', memberEmp: '', colleagueEmp: '', noDesignationEmp: '' };
const state = {
  /** The owner's upload on the member's record: document id and path. */
  hrDoc: { id: '', path: '' },
  /** The member's own upload. */
  ownDoc: { id: '', path: '' },
  /** A document on the owner's own record. */
  ownersDoc: { id: '', path: '' },
};

/** Every object this file put in the bucket and has not yet seen removed. */
const uploaded = new Set<string>();

const ownerCtx = () => ({ client: owner.c, orgId: owner.orgId });
const memberCtx = () => ({ client: member.c, orgId: owner.orgId });
const ownerData = () => createSupabasePeopleData(owner.c, owner.orgId);
const memberData = () => createSupabasePeopleData(member.c, owner.orgId);

/** A tiny real PDF, different each time so two uploads never share bytes. */
function pdf(label: string): { file: File; bytes: Uint8Array } {
  const text = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n% ${label} ${crypto.randomUUID()}\ntrailer << /Root 1 0 R >>\n%%EOF\n`;
  const bytes = new TextEncoder().encode(text);
  return { file: new File([bytes], `${label}.pdf`, { type: 'application/pdf' }), bytes };
}

async function upload(client: SupabaseClient, employeeId: string, label: string) {
  const { file, bytes } = pdf(label);
  const path = documentPath(owner.orgId, employeeId, file);
  const result = await uploadDocumentFile(client, path, file);
  expect(result, `uploading ${label}`).toEqual({ ok: true, data: { path } });
  uploaded.add(path);
  return { file, bytes, path, facts: documentFileFacts(file) };
}

/** Removes a file through the app's own function and forgets it. */
async function discard(path: string) {
  await removeDocumentFile(path);
  uploaded.delete(path);
}

/** Uploads then attaches. */
async function addWithFile(
  ctx: { client: SupabaseClient; orgId: string },
  employeeId: string,
  title: string,
  doc_type: string,
) {
  const up = await upload(ctx.client, employeeId, title.replace(/\W+/g, '-'));
  const added = await addDocument(ctx, { employee_id: employeeId, title, doc_type, file_path: up.path, ...up.facts });
  expect(added.ok, JSON.stringify(added)).toBe(true);
  if (!added.ok) throw new Error('add failed');
  return { ...up, doc: added.data };
}

/** Every object path under the workspace's folder, two levels deep (<org>/<employee>/<file>). */
async function pathsUnder(orgId: string): Promise<string[]> {
  const bucket = service!.storage.from(DOCUMENT_BUCKET);
  const top = await bucket.list(orgId, { limit: 1000 });
  expect(top.error).toBeNull();
  const found: string[] = [];
  for (const entry of top.data ?? []) {
    const inner = await bucket.list(`${orgId}/${entry.name}`, { limit: 1000 });
    expect(inner.error).toBeNull();
    for (const file of inner.data ?? []) found.push(`${orgId}/${entry.name}/${file.name}`);
  }
  return found;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  expect(response.ok, `the signed link answered ${response.status}`).toBe(true);
  return new Uint8Array(await response.arrayBuffer());
}

/** Seconds a signed link lasts, read from the expiry in its own token. */
function linkLifetimeSeconds(url: string): number {
  const token = new URL(url).searchParams.get('token') ?? '';
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp: number };
  return payload.exp - Math.floor(Date.now() / 1000);
}

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('This test needs SUPABASE_SERVICE_ROLE_KEY: it removes every file it uploads.');
  service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Registered first, so it runs whatever else fails: removes what is left in the bucket, then fails loudly if
  // anything is still there. The workspace itself is deleted after it by the helper (which touches no storage).
  beforeCleanup(async () => {
    if (!service || !owner) return;
    const leftovers = new Set([...uploaded, ...(await pathsUnder(owner.orgId)), ...(other ? await pathsUnder(other.orgId) : [])]);
    for (const path of leftovers) await service.storage.from(DOCUMENT_BUCKET).remove([path]);
    const remaining = [...(await pathsUnder(owner.orgId)), ...(other ? await pathsUnder(other.orgId) : [])];
    if (remaining.length > 0) throw new Error(`${remaining.length} uploaded file(s) are still in the documents bucket.`);
  });

  const o = liveClient();
  const ownerUser = await createConfirmedTestUser(o, PASSWORD);
  const org = await createOrg(o, 'People Documents Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  owner = { c: o, userId: ownerUser.userId as string, orgId: org.data as string };

  const m = liveClient();
  const memberUser = await createConfirmedTestUser(m, PASSWORD);
  const invite = await owner.c.rpc('create_invite', { p_email: memberUser.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  member = { c: m, userId: memberUser.userId as string };

  const x = liveClient();
  await createConfirmedTestUser(x, PASSWORD);
  const otherOrg = await createOrg(x, 'Other Documents Sdn Bhd');
  expect(otherOrg.error, otherOrg.error?.message).toBeNull();
  other = { c: x, orgId: otherOrg.data as string };
});
afterAll(async () => {
  await owner?.c.auth.signOut();
  await member?.c.auth.signOut();
  await other?.c.auth.signOut();
  await guest?.c.auth.signOut();
});

testWithSupabase('a real upload by the owner and by the member, attached and downloaded through a one-minute link', async () => {
  const make = async (name: string, extra: Record<string, unknown> = {}) => {
    const made = await createEmployee(ownerCtx(), { name, join_date: '2025-01-06', ...extra });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    if (!made.ok) throw new Error('employee not made');
    return made.data.id;
  };
  ids.ownerEmp = await make('Owner Person');
  ids.memberEmp = await make('Member Person', { designation: 'Clerk' });
  ids.colleagueEmp = await make('Colleague Person', { designation: 'Clerk' });
  ids.noDesignationEmp = await make('No Designation');
  expect((await linkEmployeeToMember(ownerCtx(), { id: ids.ownerEmp, user_id: owner.userId })).ok).toBe(true);
  expect((await linkEmployeeToMember(ownerCtx(), { id: ids.memberEmp, user_id: member.userId })).ok).toBe(true);

  // The owner uploads to the member's record; the member uploads to their own.
  const hr = await addWithFile(ownerCtx(), ids.memberEmp, 'Employment contract', 'contract');
  state.hrDoc = { id: hr.doc.id, path: hr.path };
  expect(hr.doc).toMatchObject({ source: 'hr', ack_requested: false, file_type: 'application/pdf', file_size: hr.bytes.byteLength });
  const own = await addWithFile(memberCtx(), ids.memberEmp, 'My passport', 'identity');
  state.ownDoc = { id: own.doc.id, path: own.path };
  expect(own.doc).toMatchObject({ source: 'employee', file_name: 'My-passport.pdf' });
  const owners = await addWithFile(ownerCtx(), ids.ownerEmp, 'Owner private', 'other');
  state.ownersDoc = { id: owners.doc.id, path: owners.path };

  // The member downloads both of theirs through the app's link function (their own session), a minute long.
  for (const [item, bytes] of [[hr, hr.bytes], [own, own.bytes]] as const) {
    const link = await documentLink(memberCtx(), item.doc.id);
    expect(link.ok, JSON.stringify(link)).toBe(true);
    if (!link.ok) return;
    expect(Buffer.compare(Buffer.from(await fetchBytes(link.data.url)), Buffer.from(bytes))).toBe(0);
    const seconds = linkLifetimeSeconds(link.data.url);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
  }
  // The owner reads the member's own upload too.
  const ownersView = await documentLink(ownerCtx(), own.doc.id);
  expect(ownersView.ok).toBe(true);

  // The models carry no path, and say a file is attached.
  const docs = await memberData().listDocuments();
  expect(docs.map((d) => d.id).sort()).toEqual([hr.doc.id, own.doc.id].sort());
  expect(docs.every((d) => d.has_file && d.file_size !== null && d.file_type === 'application/pdf')).toBe(true);
  expect(JSON.stringify(docs)).not.toContain('file_path');
  expect(JSON.stringify(docs)).not.toContain(hr.path);
});

testWithSupabase('a file is reachable only through a document the caller may read', async () => {
  const bucketOf = (c: SupabaseClient) => c.storage.from(DOCUMENT_BUCKET);

  // The member, by path, on the owner's own record: no signed link, no download.
  expect((await bucketOf(member.c).createSignedUrl(state.ownersDoc.path, 60)).data).toBeNull();
  expect((await bucketOf(member.c).download(state.ownersDoc.path)).error).not.toBeNull();
  // ... and by the document's id.
  expect(await documentLink(memberCtx(), state.ownersDoc.id)).toEqual(refused('DOC_NOT_FOUND'));
  // The member's own are reachable.
  expect((await bucketOf(member.c).createSignedUrl(state.hrDoc.path, 60)).error).toBeNull();

  // The second workspace's owner reaches neither workspace's files.
  for (const path of [state.hrDoc.path, state.ownDoc.path, state.ownersDoc.path]) {
    expect((await bucketOf(other.c).createSignedUrl(path, 60)).data).toBeNull();
    expect((await bucketOf(other.c).download(path)).error).not.toBeNull();
  }
  expect(await documentLink({ client: other.c, orgId: owner.orgId }, state.hrDoc.id)).toEqual(refused('DOC_NOT_FOUND'));

  // Nobody uploads into a workspace or a folder that is not theirs.
  const { file } = pdf('intruder');
  const intoOwnerOrg = documentPath(owner.orgId, ids.memberEmp, file);
  expect((await bucketOf(other.c).upload(intoOwnerOrg, file, { contentType: 'application/pdf', upsert: false })).error).not.toBeNull();
  const intoColleague = documentPath(owner.orgId, ids.colleagueEmp, file);
  const refusedUpload = await bucketOf(member.c).upload(intoColleague, file, { contentType: 'application/pdf', upsert: false });
  expect(refusedUpload.error).not.toBeNull();
  // The signed-out and the anonymous are refused too.
  const anon = liveClient();
  expect((await bucketOf(anon).download(state.hrDoc.path)).error).not.toBeNull();
  expect((await signInAnon(anon)).error).toBeNull();
  expect((await bucketOf(anon).upload(documentPath(owner.orgId, ids.memberEmp, file), file, { contentType: 'application/pdf', upsert: false })).error).not.toBeNull();
  expect((await bucketOf(anon).download(state.hrDoc.path)).error).not.toBeNull();
  await anon.auth.signOut();
  // Nothing slipped in.
  expect((await pathsUnder(owner.orgId)).sort()).toEqual([state.hrDoc.path, state.ownDoc.path, state.ownersDoc.path].sort());

  // No signed-in user can delete or overwrite, the owner included: the object is still there afterwards.
  for (const c of [owner.c, member.c]) {
    await bucketOf(c).remove([state.hrDoc.path]);
    const overwrite = await bucketOf(c).upload(state.hrDoc.path, pdf('overwrite').file, { contentType: 'application/pdf', upsert: true });
    expect(overwrite.error).not.toBeNull();
  }
  expect((await bucketOf(owner.c).download(state.hrDoc.path)).error).toBeNull();
  expect((await pathsUnder(owner.orgId)).includes(state.hrDoc.path)).toBe(true);
});

testWithSupabase('an upload that was never attached cannot be read, can be released, and can never be attached', async () => {
  const bucketOf = (c: SupabaseClient) => c.storage.from(DOCUMENT_BUCKET);
  const up = await upload(member.c, ids.memberEmp, 'never-attached');
  // The uploader cannot read it before a document carries it.
  expect((await bucketOf(member.c).createSignedUrl(up.path, 60)).data).toBeNull();
  expect((await bucketOf(member.c).download(up.path)).error).not.toBeNull();
  // Nobody else can release it; the owner of another workspace is refused.
  expect(await releaseDocumentFile({ client: other.c }, up.path)).toBe(false);
  // A path a document carries is never released.
  expect(await releaseDocumentFile(memberCtx(), state.ownDoc.path)).toBe(false);
  // The uploader can, and the file is then removed with the service client.
  expect(await releaseDocumentFile(memberCtx(), up.path)).toBe(true);
  expect(await releaseDocumentFile(memberCtx(), up.path)).toBe(true);
  await discard(up.path);
  expect((await pathsUnder(owner.orgId)).includes(up.path)).toBe(false);
  // A released path can never be attached.
  const again = await addDocument(memberCtx(), { employee_id: ids.memberEmp, title: 'Late', doc_type: 'other', file_path: up.path, ...up.facts });
  expect(again).toEqual(refused('DOC_BAD_FILE'));
});

testWithSupabase('an attach is refused for a wrong size, a wrong type, or a type the member may not add', async () => {
  const check = async (label: string, change: (facts: ReturnType<typeof documentFileFacts>) => Record<string, unknown>, type = 'other') => {
    const up = await upload(member.c, ids.memberEmp, label);
    const result = await addDocument(memberCtx(), {
      employee_id: ids.memberEmp, title: label, doc_type: type, file_path: up.path, ...up.facts, ...change(up.facts),
    });
    // The action discards a refused upload; do the same here.
    expect(result.ok).toBe(false);
    if (await releaseDocumentFile(memberCtx(), up.path)) await discard(up.path);
    return result;
  };
  expect(await check('wrong-size', (f) => ({ file_size: f.file_size + 1 }))).toEqual(refused('DOC_BAD_FILE'));
  expect(await check('wrong-type', () => ({ file_type: 'image/png' }))).toEqual(refused('DOC_BAD_FILE'));
  expect(await check('wrong-kind', () => ({}), 'contract')).toEqual(refused('DOC_TYPE_NOT_ALLOWED'));
  expect(await check('wrong-kind-2', () => ({}), 'benefits')).toEqual(refused('DOC_TYPE_NOT_ALLOWED'));
  expect((await pathsUnder(owner.orgId)).sort()).toEqual([state.hrDoc.path, state.ownDoc.path, state.ownersDoc.path].sort());
});

testWithSupabase('a type-less .heic is stored with the type the database is told, and attaches', async () => {
  // A browser may report no type for a .heic; storage records the body's own type, so the upload must carry the
  // resolved one. The bytes are not a real HEIC: only the declared and recorded types matter here.
  const bytes = new TextEncoder().encode(`not really a heic ${crypto.randomUUID()}`);
  const file = new File([bytes], 'x.heic', { type: '' });
  expect(file.type).toBe('');
  const path = documentPath(owner.orgId, ids.memberEmp, file);
  const up = await uploadDocumentFile(member.c, path, file);
  expect(up).toEqual({ ok: true, data: { path } });
  uploaded.add(path);
  const facts = documentFileFacts(file);
  expect(facts).toMatchObject({ file_type: 'image/heic', file_size: bytes.byteLength });
  const added = await addDocument(memberCtx(), { employee_id: ids.memberEmp, title: 'Scan', doc_type: 'other', file_path: path, ...facts });
  expect(added, JSON.stringify(added)).toMatchObject({ ok: true, data: { file_type: 'image/heic', file_name: 'x.heic' } });
  if (!added.ok) {
    if (await releaseDocumentFile(memberCtx(), path)) await discard(path);
    return;
  }
  const link = await documentLink(memberCtx(), added.data.id);
  expect(link.ok).toBe(true);
  if (link.ok) expect(Buffer.compare(Buffer.from(await fetchBytes(link.data.url)), Buffer.from(bytes))).toBe(0);
  const removed = await removeDocument(memberCtx(), { document_id: added.data.id });
  expect(removed).toMatchObject({ ok: true, data: { path } });
  await discard(path);
});

testWithSupabase('acknowledgement is the employee\'s alone, once, and only when asked', async () => {
  // Not asked yet.
  expect(await acknowledgeDocument(memberCtx(), { document_id: state.hrDoc.id })).toEqual(refused('DOC_ACK_NOT_REQUESTED'));
  // Not on an employee's own upload.
  expect(await requestDocumentAck(ownerCtx(), { document_id: state.ownDoc.id, requested: true })).toEqual(refused('DOC_NOT_ALLOWED'));
  // The member cannot ask for it.
  expect(await requestDocumentAck(memberCtx(), { document_id: state.hrDoc.id, requested: true })).toEqual(refused('DOC_NOT_FOUND'));
  const asked = await requestDocumentAck(ownerCtx(), { document_id: state.hrDoc.id, requested: true });
  expect(asked).toMatchObject({ ok: true, data: { ack_requested: true, acknowledged_at: null } });
  // The owner cannot acknowledge for the employee.
  expect(await acknowledgeDocument(ownerCtx(), { document_id: state.hrDoc.id })).toEqual(refused('DOC_NOT_FOUND'));
  const done = await acknowledgeDocument(memberCtx(), { document_id: state.hrDoc.id });
  expect(done.ok).toBe(true);
  if (!done.ok) return;
  expect(done.data.acknowledged_at).not.toBeNull();
  expect(await acknowledgeDocument(memberCtx(), { document_id: state.hrDoc.id })).toEqual(refused('DOC_ALREADY_ACKNOWLEDGED'));
  const read = (await ownerData().listDocuments()).find((d) => d.id === state.hrDoc.id);
  expect(read).toMatchObject({ ack_requested: true });
  expect(read?.acknowledged_at).not.toBeNull();

  // A replaced file clears it. The old file is returned and removed.
  const next = await upload(owner.c, ids.memberEmp, 'contract-v2');
  const replaced = await replaceDocumentFile(ownerCtx(), { document_id: state.hrDoc.id, file_path: next.path, ...next.facts });
  expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
  if (!replaced.ok) return;
  expect(replaced.data.old_path).toBe(state.hrDoc.path);
  expect(replaced.data.document).toMatchObject({ ack_requested: true, acknowledged_at: null, file_size: next.bytes.byteLength });
  await discard(state.hrDoc.path);
  state.hrDoc.path = next.path;
  const link = await documentLink(memberCtx(), state.hrDoc.id);
  expect(link.ok).toBe(true);
  if (link.ok) expect(Buffer.compare(Buffer.from(await fetchBytes(link.data.url)), Buffer.from(next.bytes))).toBe(0);
  // Withdrawing the request clears it too, and it can be asked again.
  expect((await requestDocumentAck(ownerCtx(), { document_id: state.hrDoc.id, requested: false })).ok).toBe(true);
});

testWithSupabase('every owner-only document write is refused to the member with its sentence', async () => {
  const memberFacts = pdf('x');
  const path = documentPath(owner.orgId, ids.colleagueEmp, memberFacts.file);
  // Adding to a colleague's record.
  expect(
    await addDocument(memberCtx(), {
      employee_id: ids.colleagueEmp, title: 'Sneaky', doc_type: 'other', file_path: path, ...documentFileFacts(memberFacts.file),
    }),
  ).toEqual(refused('DOC_NOT_ALLOWED'));
  // Changing, replacing, asking for, or removing what HR added (the member's own record) or their own upload.
  const replacement = { file_path: documentPath(owner.orgId, ids.memberEmp, memberFacts.file), ...documentFileFacts(memberFacts.file) };
  for (const id of [state.hrDoc.id, state.ownDoc.id, state.ownersDoc.id]) {
    expect(await updateDocument(memberCtx(), { document_id: id, title: 'Renamed', doc_type: 'other' })).toEqual(refused('DOC_NOT_FOUND'));
    expect(await replaceDocumentFile(memberCtx(), { document_id: id, ...replacement })).toEqual(refused('DOC_NOT_FOUND'));
    expect(await requestDocumentAck(memberCtx(), { document_id: id, requested: true })).toEqual(refused('DOC_NOT_FOUND'));
  }
  expect(await removeDocument(memberCtx(), { document_id: state.hrDoc.id })).toEqual(refused('DOC_NOT_FOUND'));
  expect(await removeDocument(memberCtx(), { document_id: state.ownersDoc.id })).toEqual(refused('DOC_NOT_FOUND'));
  // Nothing changed.
  const docs = await ownerData().listDocuments();
  expect(docs.find((d) => d.id === state.hrDoc.id)?.title).toBe('Employment contract');
  expect(docs.find((d) => d.id === state.ownDoc.id)?.title).toBe('My passport');
});

testWithSupabase('the owner edits, and removing a document returns its file to be removed', async () => {
  const edited = await updateDocument(ownerCtx(), {
    document_id: state.ownDoc.id, title: 'Passport (checked)', doc_type: 'identity', expires_on: '2031-05-04',
  });
  expect(edited).toMatchObject({ ok: true, data: { title: 'Passport (checked)', expires_on: '2031-05-04' } });

  // The member removes their own upload: the database first, then the file.
  const removed = await removeDocument(memberCtx(), { document_id: state.ownDoc.id });
  expect(removed).toMatchObject({ ok: true, data: { id: state.ownDoc.id, path: state.ownDoc.path } });
  // The row is gone, so the file can no longer be reached, but it is still in the bucket until removed.
  expect((await memberData().listDocuments()).map((d) => d.id)).not.toContain(state.ownDoc.id);
  expect(await documentLink(memberCtx(), state.ownDoc.id)).toEqual(refused('DOC_NOT_FOUND'));
  expect((await pathsUnder(owner.orgId)).includes(state.ownDoc.path)).toBe(true);
  await discard(state.ownDoc.path);
  expect((await pathsUnder(owner.orgId)).includes(state.ownDoc.path)).toBe(false);

  // The owner removes what HR added.
  const gone = await removeDocument(ownerCtx(), { document_id: state.hrDoc.id });
  expect(gone).toMatchObject({ ok: true, data: { path: state.hrDoc.path } });
  await discard(state.hrDoc.path);
  const gone2 = await removeDocument(ownerCtx(), { document_id: state.ownersDoc.id });
  expect(gone2.ok).toBe(true);
  await discard(state.ownersDoc.path);
  expect(await pathsUnder(owner.orgId)).toEqual([]);
});

testWithSupabase('deleting an employee returns their files, which are then removed', async () => {
  const made = await createEmployee(ownerCtx(), { name: 'To Be Deleted', join_date: '2025-01-06' });
  expect(made.ok).toBe(true);
  if (!made.ok) return;
  const a = await addWithFile(ownerCtx(), made.data.id, 'First file', 'other');
  const b = await addWithFile(ownerCtx(), made.data.id, 'Second file', 'other');
  expect((await pathsUnder(owner.orgId)).sort()).toEqual([a.path, b.path].sort());
  const result = await deleteEmployee(ownerCtx(), { id: made.data.id }, removeDocumentFiles);
  expect(result).toEqual({ ok: true, data: { id: made.data.id, name: 'To Be Deleted' } });
  uploaded.delete(a.path);
  uploaded.delete(b.path);
  expect(await pathsUnder(owner.orgId)).toEqual([]);
  // A member cannot delete an employee through the function; it answers as "not there".
  expect(await deleteEmployee(memberCtx(), { id: ids.colleagueEmp }, removeDocumentFiles)).toEqual({
    ok: false,
    error: 'That employee was not found.',
  });
});

testWithSupabase('a draft letter is invisible to its employee until it is issued, and pulled back it is invisible again', async () => {
  const draft = await saveLetter(ownerCtx(), {
    employee_id: ids.memberEmp, letter_type: 'confirmation', title: 'Confirmation', body: 'You are confirmed.', ack_requested: true,
  });
  expect(draft).toMatchObject({ ok: true, data: { status: 'draft', issued_on: null, ack_requested: true } });
  if (!draft.ok) return;
  const id = draft.data.id;
  expect((await memberData().listLetters()).map((l) => l.id)).not.toContain(id);
  expect((await ownerData().listLetters()).map((l) => l.id)).toContain(id);
  expect(await acknowledgeLetter(memberCtx(), { letter_id: id })).toEqual(refused('LETTER_NOT_FOUND'));
  expect(await issueLetter(memberCtx(), { letter_id: id })).toEqual(refused('LETTER_NOT_FOUND'));

  const issued = await issueLetter(ownerCtx(), { letter_id: id });
  expect(issued).toMatchObject({ ok: true, data: { status: 'issued' } });
  expect((await memberData().listLetters()).find((l) => l.id === id)).toMatchObject({ body: 'You are confirmed.', ack_requested: true });
  // The owner cannot acknowledge for the employee; the employee can, once.
  expect(await acknowledgeLetter(ownerCtx(), { letter_id: id })).toEqual(refused('LETTER_NOT_FOUND'));
  const done = await acknowledgeLetter(memberCtx(), { letter_id: id });
  expect(done.ok).toBe(true);
  expect(await acknowledgeLetter(memberCtx(), { letter_id: id })).toEqual(refused('LETTER_ALREADY_ACKNOWLEDGED'));
  // An issued letter cannot be edited, deleted or pulled back by the employee; the owner cannot delete it.
  expect(await unissueLetter(memberCtx(), { letter_id: id })).toEqual(refused('LETTER_NOT_FOUND'));
  expect(await deleteLetter(memberCtx(), { letter_id: id })).toEqual(refused('LETTER_NOT_FOUND'));
  expect(await deleteLetter(ownerCtx(), { letter_id: id })).toEqual(refused('LETTER_NOT_DRAFT'));
  expect(
    await saveLetter(ownerCtx(), { employee_id: ids.memberEmp, letter_id: id, letter_type: 'confirmation', title: 'Changed', body: 'x' }),
  ).toEqual(refused('LETTER_NOT_DRAFT'));

  // Pulled back: gone from the employee's list, and the acknowledgement is cleared.
  const back = await unissueLetter(ownerCtx(), { letter_id: id });
  expect(back).toMatchObject({ ok: true, data: { status: 'draft', issued_on: null, acknowledged_at: null } });
  expect((await memberData().listLetters()).map((l) => l.id)).not.toContain(id);
  expect(await unissueLetter(ownerCtx(), { letter_id: id })).toEqual(refused('LETTER_NOT_ISSUED'));
  expect((await deleteLetter(ownerCtx(), { letter_id: id })).ok).toBe(true);
});

testWithSupabase('a letter from the starter template with a missing designation is refused at issue, and the helper agrees', async () => {
  const templates = await ownerData().listLetterTemplates();
  const offer = templates.find((t) => t.name === 'Offer of employment');
  expect(offer, 'every workspace has the starter templates').toBeTruthy();
  expect((await memberData().listLetterTemplates()).length).toBe(0);
  if (!offer) return;

  const started = await startLetterFromTemplate(ownerCtx(), { employee_id: ids.noDesignationEmp, template_id: offer.id });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  if (!started.ok) return;
  const { letter, unfilled } = started.data;
  expect(unfilled).toContain('designation');
  expect(letter.body).toContain('No Designation');
  expect(letter.status).toBe('draft');
  expect([...unfilledInLetter(letter.title, letter.body)].sort()).toEqual([...unfilled].sort());
  expect(await issueLetter(ownerCtx(), { letter_id: letter.id })).toEqual(refused('LETTER_PLACEHOLDER'));
  expect((await memberData().listLetters()).map((l) => l.id)).not.toContain(letter.id);

  // Replace what is missing: it can then be issued.
  const fixed = letter.body.replaceAll('{designation}', 'Clerk').replaceAll('{department}', 'Admin');
  const saved = await saveLetter(ownerCtx(), {
    employee_id: ids.noDesignationEmp, letter_id: letter.id, letter_type: letter.letter_type, title: letter.title, body: fixed,
  });
  expect(saved.ok).toBe(true);
  expect((await issueLetter(ownerCtx(), { letter_id: letter.id })).ok).toBe(true);
  expect(await unissueLetter(ownerCtx(), { letter_id: letter.id })).toMatchObject({ ok: true });
  expect((await deleteLetter(ownerCtx(), { letter_id: letter.id })).ok).toBe(true);

  // A template from another workspace cannot be used.
  const foreign = await saveLetterTemplate({ client: other.c, orgId: other.orgId }, {
    name: 'Foreign', letter_type: 'other', title: 'Foreign', body: 'x',
  });
  expect(foreign.ok).toBe(true);
  if (!foreign.ok) return;
  expect(await startLetterFromTemplate(ownerCtx(), { employee_id: ids.memberEmp, template_id: foreign.data.id })).toEqual(refused('LETTER_NOT_FOUND'));
  expect((await deleteLetterTemplate({ client: other.c, orgId: other.orgId }, { template_id: foreign.data.id })).ok).toBe(true);
});

testWithSupabase('every owner-only letter and template write is refused to the member with its sentence', async () => {
  const [offer] = await ownerData().listLetterTemplates();
  expect(offer).toBeTruthy();
  const draft = await saveLetter(ownerCtx(), { employee_id: ids.memberEmp, letter_type: 'other', title: 'Held', body: 'text' });
  expect(draft.ok).toBe(true);
  if (!draft.ok || !offer) return;
  const issued = await saveLetter(ownerCtx(), { employee_id: ids.memberEmp, letter_type: 'other', title: 'Issued', body: 'text' });
  if (!issued.ok) throw new Error('save failed');
  expect((await issueLetter(ownerCtx(), { letter_id: issued.data.id })).ok).toBe(true);

  expect(await saveLetter(memberCtx(), { employee_id: ids.memberEmp, letter_type: 'other', title: 'Mine', body: 'x' })).toEqual(refused('LETTER_NOT_ALLOWED'));
  expect(await saveLetter(memberCtx(), { employee_id: ids.colleagueEmp, letter_type: 'other', title: 'Theirs', body: 'x' })).toEqual(refused('LETTER_NOT_ALLOWED'));
  expect(await startLetterFromTemplate(memberCtx(), { employee_id: ids.memberEmp, template_id: offer.id })).toEqual(refused('LETTER_NOT_ALLOWED'));
  expect(await issueLetter(memberCtx(), { letter_id: draft.data.id })).toEqual(refused('LETTER_NOT_FOUND'));
  expect(await issueLetter(memberCtx(), { letter_id: issued.data.id })).toEqual(refused('LETTER_NOT_FOUND'));
  expect(await unissueLetter(memberCtx(), { letter_id: issued.data.id })).toEqual(refused('LETTER_NOT_FOUND'));
  expect(await deleteLetter(memberCtx(), { letter_id: draft.data.id })).toEqual(refused('LETTER_NOT_FOUND'));
  expect(await saveLetterTemplate(memberCtx(), { name: 'Mine', letter_type: 'other', title: 'T', body: 'B' })).toEqual(refused('LETTER_NOT_ALLOWED'));
  expect(await deleteLetterTemplate(memberCtx(), { template_id: offer.id })).toEqual(refused('LETTER_NOT_FOUND'));

  // The owner's template rules: a name once, up to the limit's sentence, and a template is independent of letters.
  const t = await saveLetterTemplate(ownerCtx(), { name: 'Unique name', letter_type: 'other', title: 'T', body: 'B' });
  expect(t.ok).toBe(true);
  expect(await saveLetterTemplate(ownerCtx(), { name: 'unique NAME', letter_type: 'other', title: 'T', body: 'B' })).toEqual(refused('LETTER_TEMPLATE_EXISTS'));
  if (t.ok) expect((await deleteLetterTemplate(ownerCtx(), { template_id: t.data.id })).ok).toBe(true);

  // Clean up the letters made here.
  expect((await deleteLetter(ownerCtx(), { letter_id: draft.data.id })).ok).toBe(true);
  expect((await unissueLetter(ownerCtx(), { letter_id: issued.data.id })).ok).toBe(true);
  expect((await deleteLetter(ownerCtx(), { letter_id: issued.data.id })).ok).toBe(true);
});

testWithSupabase('the sweep functions run for the service role and for no one else, and find nothing fresh', async () => {
  const listed = await service!.rpc('hr_orphaned_document_files', { p_org: owner.orgId });
  expect(listed.error, listed.error?.message).toBeNull();
  expect(listed.data).toEqual([]);
  const released = await service!.rpc('hr_release_orphaned_document_files', { p_org: owner.orgId, p_limit: 10 });
  expect(released.error, released.error?.message).toBeNull();
  expect(released.data).toEqual([]);
  for (const c of [owner.c, member.c]) {
    expect((await c.rpc('hr_orphaned_document_files', { p_org: owner.orgId })).error).not.toBeNull();
    expect((await c.rpc('hr_release_orphaned_document_files', { p_org: owner.orgId, p_limit: 10 })).error).not.toBeNull();
  }
});

testWithSupabase('a demo guest changes nothing', async () => {
  // The demo is rebuilt at the top of every hour; its rows are not there to be tried in the first minutes of it.
  if (new Date().getUTCMinutes() <= 2) {
    console.warn('Skipped the demo part of the documents live test: the demo is being re-seeded (minutes :00 to :02).');
    return;
  }
  const g = liveClient();
  expect((await signInAnon(g)).error).toBeNull();
  const demo = await joinDemo(g);
  expect(demo.error, demo.error?.message).toBeNull();
  guest = { c: g, demoId: demo.data as string };
  const ctx = { client: guest.c, orgId: guest.demoId };
  const data = createSupabasePeopleData(guest.c, guest.demoId);
  const [documents, letters] = await Promise.all([data.listDocuments(), data.listLetters()]);
  const code = documents.find((d) => d.title === 'Code of conduct');
  const asking = letters.find((l) => l.ack_requested);
  expect(code && asking, 'the demo has a document and a letter that ask for an acknowledgement').toBeTruthy();
  if (!code || !asking) return;
  expect(documents.every((d) => !d.has_file)).toBe(true);

  const { file } = pdf('demo');
  const demoPath = documentPath(guest.demoId, DEMO_EMPLOYEE_ID, file);
  expect((await guest.c.storage.from(DOCUMENT_BUCKET).upload(demoPath, file, { contentType: 'application/pdf', upsert: false })).error).not.toBeNull();
  expect(await acknowledgeDocument(ctx, { document_id: code.id })).toEqual(refused('DOC_NOT_ALLOWED'));
  expect(await acknowledgeLetter(ctx, { letter_id: asking.id })).toEqual(refused('LETTER_NOT_ALLOWED'));
  expect(await saveLetter(ctx, { employee_id: DEMO_EMPLOYEE_ID, letter_type: 'other', title: 'Demo', body: 'x' })).toEqual(refused('LETTER_NOT_ALLOWED'));
  expect(await updateDocument(ctx, { document_id: code.id, title: 'Renamed', doc_type: 'other' })).toEqual(refused('DOC_NOT_ALLOWED'));
  expect(await removeDocument(ctx, { document_id: code.id })).toEqual(refused('DOC_NOT_ALLOWED'));
  expect((await data.listDocuments()).find((d) => d.id === code.id)).toMatchObject({ title: 'Code of conduct', acknowledged_at: null });
});

testWithSupabase('every file this test uploaded is gone: the bucket holds nothing under the workspace', async () => {
  expect(await pathsUnder(owner.orgId)).toEqual([]);
  expect(await pathsUnder(other.orgId)).toEqual([]);
  expect([...uploaded]).toEqual([]);
});
