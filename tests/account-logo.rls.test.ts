/**
 * Live test of the workspace logo (the `org-logos` bucket, `set_org_logo`, `clear_org_logo`) and of a letter's
 * `{salary}`, against the real database and storage. It needs the three letterhead migrations applied
 * (20261109133700, 20261109133800 and 20261109140000, the hardening); until then it fails at the first call.
 * Skipped without Supabase env vars.
 *
 * Setting a logo is the SERVER's: `set_org_logo(p_org, p_actor, p_path)` is for the service role alone, and the
 * server reads the uploaded bytes first. So `setLogo` here runs as the app's server does (with the service key this
 * test already needs), naming the acting user; and one test goes through the server action itself, with the
 * session faked to be the owner's (a server action needs a request, which a test has not).
 *   - An owner who uploads a TEXT file named `.png`, declared `image/png`, and asks the server to set it is refused
 *     with the not-an-image sentence, and the file is removed.
 *   - An owner who calls `set_org_logo` themselves, with their own client, is refused: the two-argument function is
 *     gone and the three-argument one is not theirs to call.
 *   - A logo is served with the short cache lifetime the upload asks for.
 *
 * A fresh workspace with a CONFIRMED owner (an anonymous account may not upload), a confirmed member, and a
 * confirmed owner of a second workspace.
 *   - The one thing no SQL check can prove: a PLAIN upload by an owner (no upsert) succeeds although the bucket has
 *     no select policy; an owner cannot list the bucket, and cannot overwrite a file.
 *   - A real 8x8 PNG generated here is uploaded, set, served from its public address (bytes compared), replaced
 *     (the old file is gone from storage), and removed (the new one is gone and logo_path is null).
 *   - A recorded type that is not the extension's is refused by the function with its sentence, and the unattached
 *     upload is removed.
 *   - A member and the second workspace's owner are refused at upload and at the function; a direct update of
 *     `logo_path` is refused; the company details still save.
 *   - A demo guest is refused at upload and at the function (skipped in minutes :00 to :02 UTC, while the demo is
 *     re-seeded).
 *   - A letter started from the Bahasa Malaysia offer template carries the salary sentence for an employee with a
 *     salary, and keeps `{salary}` (named in `unfilled`, and refused at issue) for one without.
 *   - EVERY file this test uploads is removed, and the last test asserts the bucket holds nothing under either
 *     workspace's folder (checked with the service client: signed-in roles cannot list the bucket); a teardown
 *     step removes what an earlier failure left and fails loudly if anything remains.
 *
 * The public address of a REMOVED file is deliberately not checked: storage serves public objects with a cache
 * lifetime, so a removed object's address can keep answering 200 for a while. That a file is gone is proved by asking
 * storage itself with the service client (the object is not listed under the workspace's folder).
 *
 * Users and workspaces come from tests/helpers/live-workspaces.ts, which deletes them (it removes no storage
 * object: that is this file's job). Every sentence comes from the refusals modules, never a literal.
 */
import { deflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LOGO_BUCKET, logoPath, logoUrl, uploadLogoFile } from '@/lib/account/logo';
import { clearLogo, discardLogoUpload, removeLogoFile, setLogo } from '@/lib/account/logo-server';
import { LOGO_NOT_IMAGE, LOGO_REFUSALS } from '@/lib/account/logo-refusals';
import { createEmployee } from '@/lib/people/capabilities';
import { DOCUMENT_REFUSALS } from '@/lib/people/documents-refusals';
import { issueLetter, startLetterFromTemplate } from '@/lib/people/letter-writes';
import { createSupabasePeopleData } from '@/lib/people/supabase';
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

const PASSWORD = 'logo-live-pass-123';

let owner: { c: SupabaseClient; userId: string; orgId: string };
let member: { c: SupabaseClient; userId: string };
let other: { c: SupabaseClient; userId: string; orgId: string };
let guest: { c: SupabaseClient; demoId: string } | undefined;
let service: SupabaseClient | null = null;

/** Every object this file put in the bucket and has not yet seen removed. */
const uploaded = new Set<string>();

const ownerCtx = () => ({ client: owner.c, orgId: owner.orgId, actorId: owner.userId });
const memberCtx = () => ({ client: member.c, orgId: owner.orgId, actorId: member.userId });

// The server action, with the session it would read faked to be this test's owner (set in the test that uses it).
const session = vi.hoisted(() => ({ viewer: null as unknown, client: null as unknown }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => session.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => session.client }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// ---- A real PNG, generated here ---------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type), 0);
  body.set(data, 4);
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

/** A valid 8x8 RGBA PNG whose colour depends on `shade`, so two logos never share bytes. */
function png(shade: number): Uint8Array<ArrayBuffer> {
  const size = 8;
  const raw = new Uint8Array((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) raw.set([30 + shade, 110, 120, 255], y * (size * 4 + 1) + 1 + x * 4);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8;
  header[9] = 6;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
const pngFile = (shade: number) => new File([png(shade)], 'logo.png', { type: 'image/png' });

/** Uploads a PNG into `orgId`'s folder as `client` through the app's own function, and records it. */
async function uploadPng(client: SupabaseClient, orgId: string, shade: number) {
  const file = pngFile(shade);
  const path = logoPath(orgId, file);
  const result = await uploadLogoFile(client, path, file);
  if (result.ok) uploaded.add(path);
  return { file, path, result };
}

/** Removes a file through the app's own function and forgets it. */
async function discard(path: string) {
  await removeLogoFile(path);
  uploaded.delete(path);
}

/** Every object under the workspace's folder (<org>/<file>), listed with the service client. */
async function pathsUnder(orgId: string): Promise<string[]> {
  const listed = await service!.storage.from(LOGO_BUCKET).list(orgId, { limit: 1000 });
  expect(listed.error).toBeNull();
  return (listed.data ?? []).map((entry) => `${orgId}/${entry.name}`);
}

const currentLogoPath = async (): Promise<string | null> => {
  const { data, error } = await owner.c.from('orgs').select('logo_path').eq('id', owner.orgId).single();
  expect(error).toBeNull();
  return (data as { logo_path: string | null }).logo_path;
};

async function publicBytes(path: string): Promise<{ status: number; type: string | null; cache: string | null; bytes: Uint8Array }> {
  const url = logoUrl(path, { isDemo: false });
  expect(url).not.toBeNull();
  // A cache-busting query string, so an earlier cached answer cannot interfere.
  const response = await fetch(`${url!}?t=${crypto.randomUUID()}`);
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    cache: response.headers.get('cache-control'),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/** Leaves the workspace as it found it, even when an assertion threw: no logo, nothing in the folder. */
async function reset() {
  if (!owner || !service) return;
  await clearLogo(ownerCtx());
  for (const path of await pathsUnder(owner.orgId)) {
    await service.storage.from(LOGO_BUCKET).remove([path]);
    uploaded.delete(path);
  }
}
afterEach(reset);

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('This test needs SUPABASE_SERVICE_ROLE_KEY: it removes every file it uploads.');
  service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Registered first, so it runs whatever else fails: removes what is left in the bucket, then fails loudly if
  // anything is still there. The workspaces themselves are deleted after it by the helper (which touches no storage).
  beforeCleanup(async () => {
    if (!service || !owner) return;
    const orgs = [owner.orgId, ...(other ? [other.orgId] : [])];
    const leftovers = new Set(uploaded);
    for (const orgId of orgs) for (const path of await pathsUnder(orgId)) leftovers.add(path);
    for (const path of leftovers) await service.storage.from(LOGO_BUCKET).remove([path]);
    const remaining: string[] = [];
    for (const orgId of orgs) remaining.push(...(await pathsUnder(orgId)));
    if (remaining.length > 0) throw new Error(`${remaining.length} uploaded file(s) are still in the logo bucket.`);
  });

  const o = liveClient();
  const ownerUser = await createConfirmedTestUser(o, PASSWORD);
  const org = await createOrg(o, 'Logo Live Sdn Bhd');
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
  const otherUser = await createConfirmedTestUser(x, PASSWORD);
  const otherOrg = await createOrg(x, 'Other Logo Sdn Bhd');
  expect(otherOrg.error, otherOrg.error?.message).toBeNull();
  other = { c: x, userId: otherUser.userId as string, orgId: otherOrg.data as string };
});
afterAll(async () => {
  await owner?.c.auth.signOut();
  await member?.c.auth.signOut();
  await other?.c.auth.signOut();
  await guest?.c.auth.signOut();
});

// ---- The owner ----------------------------------------------------------------------------------------------------

testWithSupabase('a plain upload by an owner succeeds with no select policy; the owner cannot list or overwrite', async () => {
  expect(await currentLogoPath()).toBeNull();
  const first = await uploadPng(owner.c, owner.orgId, 0);
  // The upload goes through the app's function: no upsert, a body that carries its type.
  expect(first.result, 'a plain upload by an owner into their own folder').toEqual({ ok: true, data: { path: first.path } });

  // No select policy: the owner sees nothing when listing their own folder, and cannot read the object back as themselves.
  const listed = await owner.c.storage.from(LOGO_BUCKET).list(owner.orgId);
  expect(listed.error).toBeNull();
  expect(listed.data ?? []).toEqual([]);
  expect((await owner.c.storage.from(LOGO_BUCKET).createSignedUrl(first.path, 60)).error).not.toBeNull();

  // No update policy: an overwrite, with or without upsert, is refused, and the bytes stay what they were.
  const again = await owner.c.storage.from(LOGO_BUCKET).upload(first.path, pngFile(9), { contentType: 'image/png', upsert: true });
  expect(again.error).not.toBeNull();
  const plain = await owner.c.storage.from(LOGO_BUCKET).upload(first.path, pngFile(9), { contentType: 'image/png', upsert: false });
  expect(plain.error).not.toBeNull();
  // No delete policy: the owner cannot remove it.
  const removed = await owner.c.storage.from(LOGO_BUCKET).remove([first.path]);
  expect((await pathsUnder(owner.orgId)).includes(first.path)).toBe(true);
  expect(removed.error === null ? (removed.data ?? []).length : 0).toBe(0);

  await discard(first.path);
  expect(await pathsUnder(owner.orgId)).toEqual([]);
});

testWithSupabase('an owner sets, replaces and removes the logo; each old file is removed and the new one is served publicly', async () => {
  const first = await uploadPng(owner.c, owner.orgId, 10);
  expect(first.result.ok).toBe(true);
  expect(await setLogo(ownerCtx(), first.path)).toEqual({ ok: true, data: { logo_path: first.path } });
  expect(await currentLogoPath()).toBe(first.path);

  // Anyone with the address gets the file: the bucket is public, with no select policy.
  const served = await publicBytes(first.path);
  expect(served.status).toBe(200);
  expect(served.type).toContain('image/png');
  expect([...served.bytes]).toEqual([...png(10)]);
  // The upload asks storage for a 60 second cache lifetime (the client's default is an hour): a removed logo's address
  // stops answering that much sooner.
  expect(served.cache ?? '', 'the cache lifetime storage serves the logo with').toMatch(/max-age=60\b/);
  // A member reads the path from the org row they can already read.
  const seen = await member.c.from('orgs').select('logo_path').eq('id', owner.orgId).single();
  expect((seen.data as { logo_path: string | null } | null)?.logo_path).toBe(first.path);

  // Replace: database first, then the old file, from the path the database handed back.
  const second = await uploadPng(owner.c, owner.orgId, 20);
  expect(second.result.ok).toBe(true);
  expect(await setLogo(ownerCtx(), second.path)).toEqual({ ok: true, data: { logo_path: second.path } });
  uploaded.delete(first.path);
  expect(await currentLogoPath()).toBe(second.path);
  expect(await pathsUnder(owner.orgId)).toEqual([second.path]);
  expect(await pathsUnder(owner.orgId)).not.toContain(first.path);
  expect((await publicBytes(second.path)).status).toBe(200);

  // The same path again changes nothing and removes nothing.
  expect(await setLogo(ownerCtx(), second.path)).toEqual({ ok: true, data: { logo_path: second.path } });
  expect(await pathsUnder(owner.orgId)).toEqual([second.path]);

  // Remove: the row first, then the file.
  expect(await clearLogo(ownerCtx())).toEqual({ ok: true, data: { cleared: true } });
  uploaded.delete(second.path);
  expect(await currentLogoPath()).toBeNull();
  expect(await pathsUnder(owner.orgId)).toEqual([]);
  // Removing again with none set is fine and removes nothing.
  expect(await clearLogo(ownerCtx())).toEqual({ ok: true, data: { cleared: true } });
});

testWithSupabase('a recorded type that is not the extension\'s is refused with its sentence, and the unattached upload is removed', async () => {
  const bytes = png(30);
  const path = logoPath(owner.orgId, pngFile(30));
  // PNG bytes, a .png name, but declared (so recorded) as JPEG: what the app never does, so the database refuses.
  const wrong = await owner.c.storage.from(LOGO_BUCKET).upload(path, new File([bytes], 'x.png', { type: 'image/jpeg' }), { contentType: 'image/jpeg', upsert: false });
  expect(wrong.error, 'the upload itself is allowed').toBeNull();
  uploaded.add(path);
  expect(await setLogo(ownerCtx(), path)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
  expect(await currentLogoPath()).toBeNull();
  await discardLogoUpload(ownerCtx(), path);
  uploaded.delete(path);
  expect(await pathsUnder(owner.orgId)).toEqual([]);

  // A path with no object behind it, and another workspace's folder, are refused before the type is looked at.
  const ghost = logoPath(owner.orgId, pngFile(31));
  expect(await setLogo(ownerCtx(), ghost)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
  expect(await setLogo(ownerCtx(), logoPath(other.orgId, pngFile(31)))).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
});

testWithSupabase('a text file named .png and declared image/png is uploaded by an owner, refused by the server, and removed', async () => {
  const path = logoPath(owner.orgId, pngFile(70));
  // What a crafted client does: any bytes, an image name, an image type. Storage takes it (it believes the declared type).
  const junk = new File(['This is plain text, not an image. '.repeat(40)], 'logo.png', { type: 'image/png' });
  const up = await owner.c.storage.from(LOGO_BUCKET).upload(path, junk, { contentType: 'image/png', upsert: false });
  expect(up.error, 'the upload itself is allowed: the upload policy cannot see bytes').toBeNull();
  uploaded.add(path);
  expect(await pathsUnder(owner.orgId)).toEqual([path]);

  // The server action, as the owner's session would call it.
  session.viewer = { userId: owner.userId, orgId: owner.orgId, role: 'owner', isDemo: false };
  session.client = owner.c;
  const { setLogoAction } = await import('@/app/account/logo-actions');
  expect(await setLogoAction(path)).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
  expect(await currentLogoPath()).toBeNull();
  // The refused upload is gone from storage.
  expect(await pathsUnder(owner.orgId)).toEqual([]);
  uploaded.delete(path);

  // The same through the library function: refused before the database is asked.
  const again = logoPath(owner.orgId, pngFile(71));
  expect((await owner.c.storage.from(LOGO_BUCKET).upload(again, junk, { contentType: 'image/png', upsert: false })).error).toBeNull();
  uploaded.add(again);
  expect(await setLogo(ownerCtx(), again)).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
  expect(await currentLogoPath()).toBeNull();
  await discard(again);
});

testWithSupabase('an owner cannot set the logo by calling the function themselves', async () => {
  const mine = await uploadPng(owner.c, owner.orgId, 72);
  expect(mine.result.ok).toBe(true);
  // The function the app before the hardening called: gone.
  const old = await owner.c.rpc('set_org_logo', { p_org: owner.orgId, p_path: mine.path });
  expect(old.error, 'the two-argument function').not.toBeNull();
  // The one the server calls: not for a signed-in user, even one naming themselves and a real image of their own.
  const direct = await owner.c.rpc('set_org_logo', { p_org: owner.orgId, p_actor: owner.userId, p_path: mine.path });
  expect(direct.error, 'the three-argument function, called by the owner').not.toBeNull();
  expect(direct.error?.message).not.toBe('LOGO_BAD_FILE');
  expect(await currentLogoPath()).toBeNull();
  // Nor can they list or ask about the stray files.
  expect((await owner.c.rpc('org_orphaned_logo_files')).error).not.toBeNull();
  expect((await owner.c.rpc('org_logo_file_is_orphaned', { p_name: mine.path })).error).not.toBeNull();
  // The server, naming a member or an outsider, is refused by the function; naming the owner, it goes through.
  const refused = { ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED };
  expect(await setLogo({ client: owner.c, orgId: owner.orgId, actorId: member.userId }, mine.path)).toEqual(refused);
  expect(await setLogo({ client: owner.c, orgId: owner.orgId, actorId: other.userId }, mine.path)).toEqual(refused);
  expect(await currentLogoPath()).toBeNull();
  expect(await setLogo(ownerCtx(), mine.path)).toEqual({ ok: true, data: { logo_path: mine.path } });
  // A file just uploaded is not stray: the sweep would not list it.
  const stray = await service!.rpc('org_logo_file_is_orphaned', { p_name: mine.path });
  expect(stray.error).toBeNull();
  expect(stray.data).toBe(false);
  expect(await clearLogo(ownerCtx())).toEqual({ ok: true, data: { cleared: true } });
  uploaded.delete(mine.path);
  expect(await pathsUnder(owner.orgId)).toEqual([]);
});

testWithSupabase('a direct update of logo_path is refused, and the company details still save', async () => {
  const up = await uploadPng(owner.c, owner.orgId, 40);
  expect(up.result.ok).toBe(true);
  const direct = await owner.c.from('orgs').update({ logo_path: up.path }).eq('id', owner.orgId).select('id');
  expect(direct.error, 'a direct update of logo_path').not.toBeNull();
  expect(await currentLogoPath()).toBeNull();
  const details = await owner.c.from('orgs').update({ address: '1 Jalan Logo' }).eq('id', owner.orgId).select('id');
  expect(details.error, details.error?.message).toBeNull();
  expect(details.data).toHaveLength(1);
  await discard(up.path);
});

// ---- Everyone else ------------------------------------------------------------------------------------------------

testWithSupabase('a member and another workspace\'s owner are refused at upload and at the function', async () => {
  const asMember = await uploadPng(member.c, owner.orgId, 50);
  expect(asMember.result.ok).toBe(false);
  const rawMember = await member.c.storage.from(LOGO_BUCKET).upload(asMember.path, pngFile(50), { contentType: 'image/png', upsert: false });
  expect(rawMember.error).not.toBeNull();

  const intoOthers = await uploadPng(other.c, owner.orgId, 51);
  expect(intoOthers.result.ok).toBe(false);

  // The function checks the caller before the path, whatever the path is.
  const mine = await uploadPng(owner.c, owner.orgId, 52);
  expect(mine.result.ok).toBe(true);
  const refused = { ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED };
  expect(await setLogo(memberCtx(), mine.path)).toEqual(refused);
  expect(await setLogo({ client: other.c, orgId: owner.orgId, actorId: other.userId }, mine.path)).toEqual(refused);
  expect(await clearLogo(memberCtx())).toEqual(refused);
  expect(await clearLogo({ client: other.c, orgId: owner.orgId })).toEqual(refused);
  expect(await currentLogoPath()).toBeNull();
  await discard(mine.path);
});

testWithSupabase('a demo guest is refused at upload and at the function', async () => {
  // The demo is rebuilt at the top of every hour; its rows are not there to be tried in the first minutes of it.
  if (new Date().getUTCMinutes() <= 2) {
    console.warn('Skipped the demo part of the logo live test: the demo is being re-seeded (minutes :00 to :02).');
    return;
  }
  const g = liveClient();
  expect((await signInAnon(g)).error).toBeNull();
  const demo = await joinDemo(g);
  expect(demo.error, demo.error?.message).toBeNull();
  guest = { c: g, demoId: demo.data as string };

  const file = pngFile(60);
  const path = logoPath(guest.demoId, file);
  expect((await g.storage.from(LOGO_BUCKET).upload(path, file, { contentType: 'image/png', upsert: false })).error).not.toBeNull();
  const denied = { ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED };
  const guestId = (await g.auth.getUser()).data.user?.id;
  expect(guestId).toBeTruthy();
  // The function itself refuses the demo, whoever the server names, before it looks at any path.
  const asServer = await service!.rpc('set_org_logo', { p_org: guest.demoId, p_actor: guestId, p_path: path });
  expect(asServer.error?.message).toBe('LOGO_NOT_ALLOWED');
  // And the guest cannot call it themselves.
  expect((await g.rpc('set_org_logo', { p_org: guest.demoId, p_actor: guestId, p_path: path })).error).not.toBeNull();
  expect(await clearLogo({ client: g, orgId: guest.demoId })).toEqual(denied);
  expect((await g.from('orgs').update({ logo_path: path }).eq('id', guest.demoId).select('id')).error).not.toBeNull();
});

// ---- {salary} -----------------------------------------------------------------------------------------------------

testWithSupabase('a letter from the Bahasa Malaysia offer carries the salary and its dates in Bahasa Malaysia, or keeps {salary} and cannot be issued', async () => {
  const make = async (name: string, extra: Record<string, unknown> = {}) => {
    const made = await createEmployee(ownerCtx(), { name, join_date: '2025-01-06', designation: 'Clerk', ...extra });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    if (!made.ok) throw new Error('employee not made');
    return made.data.id;
  };
  const paid = await make('Paid Person', { private: { base_salary: 4500 } });
  const unpaid = await make('Unpaid Person');

  const templates = await createSupabasePeopleData(owner.c, owner.orgId).listLetterTemplates();
  const offer = templates.find((t) => t.name === 'Surat Tawaran Pekerjaan');
  expect(offer, 'the Bahasa Malaysia offer is among the workspace\'s templates').toBeTruthy();
  if (!offer) return;

  const withSalary = await startLetterFromTemplate(ownerCtx(), { employee_id: paid, template_id: offer.id });
  expect(withSalary.ok, JSON.stringify(withSalary)).toBe(true);
  if (!withSalary.ok) return;
  // The template is Bahasa Malaysia, so the salary and the dates are written in it.
  expect(offer.lang).toBe('ms');
  expect(withSalary.data.letter.body).toContain('RM 4,500.00 sebulan');
  expect(withSalary.data.letter.body).not.toContain('per month');
  expect(withSalary.data.letter.body).toContain('berkuat kuasa mulai 6 Januari 2025.');
  expect(withSalary.data.letter.body).not.toContain('January');
  expect(withSalary.data.letter.body).toContain('di Jabatan ');
  expect(withSalary.data.letter.body.split('\n')[0]).toMatch(/^\d{1,2} (Januari|Februari|Mac|April|Mei|Jun|Julai|Ogos|September|Oktober|November|Disember) \d{4}$/);
  expect(withSalary.data.letter.body).not.toContain('{salary}');
  expect(withSalary.data.unfilled).not.toContain('salary');

  const without = await startLetterFromTemplate(ownerCtx(), { employee_id: unpaid, template_id: offer.id });
  expect(without.ok, JSON.stringify(without)).toBe(true);
  if (!without.ok) return;
  expect(without.data.letter.body).toContain('{salary}');
  expect(without.data.unfilled).toContain('salary');
  expect(await issueLetter(ownerCtx(), { letter_id: without.data.letter.id })).toEqual({
    ok: false,
    error: DOCUMENT_REFUSALS.LETTER_PLACEHOLDER,
  });
});

// ---- Left clean ---------------------------------------------------------------------------------------------------

testWithSupabase('every file this test uploaded is gone: the bucket holds nothing under either workspace', async () => {
  expect(await pathsUnder(owner.orgId)).toEqual([]);
  expect(await pathsUnder(other.orgId)).toEqual([]);
  expect([...uploaded]).toEqual([]);
});
