import { expect, test } from 'vitest';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { beforeCleanup, createOrg, joinDemo, liveClient, signInAnon, signInOwner } from './helpers/live-workspaces';

// The Receipts Inbox against the hosted database and the hosted storage
// service. Run by the controller only, after the receipts inbox migration is
// applied. Every workspace here is made by a signed-up user (signInOwner),
// as in the other finance files: a demo guest may not make one, and the
// bucket refuses an anonymous account. Each owns the workspace it makes, so
// each is an owner (who may also post and void, which a member may not): what an editor and a
// viewer may not do is proved by supabase/tests/bendahara_receipts_check.sql,
// which acts as each of them. What only this file can show is the real
// storage service: what it writes down about an upload, and what it refuses.
// The last test reads the demo seed.
//
// Deleting a test workspace removes its rows, not its files. So every path
// uploaded here is remembered, and before the workspaces go this file deletes
// its receipts, removes its files with the service client and takes their
// paths off the list of files to remove. A file that survives fails the run.

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = hasSupabaseEnv && Boolean(serviceKey);
const testWithStorage = canRun ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);
else if (!serviceKey) console.warn('bendahara-receipts: SUPABASE_SERVICE_ROLE_KEY is not set, so nothing here can clean up after itself: skipped.');

// KEEP IN STEP with INBOX_RECEIPT_BUCKET in src/lib/finance/receipts.ts and with the receipts inbox migration.
const INBOX_RECEIPT_BUCKET = 'finance-receipts';
// A 1 × 1 PNG, 68 bytes. Storage does not look inside a file, so the same bytes stand in for a HEIC below.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

type Org = { c: SupabaseClient; userId: string; orgId: string; rent: string };

const uploaded: string[] = [];
const owners: Org[] = [];

function service(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

beforeCleanup(async () => {
  if (!canRun) return;
  // Rows first, by the people who own them: a matched receipt is untied before it is deleted.
  for (const o of owners) {
    await o.c.from('finance_receipts').update({ expense_id: null, bill_id: null }).eq('org_id', o.orgId).eq('status', 'matched');
    const gone = await o.c.from('finance_receipts').delete().eq('org_id', o.orgId);
    if (gone.error) throw new Error(`a test receipt could not be deleted (${gone.error.code})`);
  }
  if (uploaded.length === 0) return;
  const s = service();
  const removed = await s.storage.from(INBOX_RECEIPT_BUCKET).remove(uploaded);
  if (removed.error) throw new Error(`test receipt files could not be removed: ${removed.error.message}`);
  const done = await s.rpc('finance_receipt_deletions_done', { p_paths: uploaded });
  if (done.error) throw new Error(`the test files' paths could not be taken off the list (${done.error.code})`);
  for (const path of uploaded) {
    const left = await s.rpc('finance_receipt_deletion_queued', { p_path: path });
    // Still on the list means its file is still in the bucket.
    if (left.data !== false) throw new Error('a test receipt file was left in the bucket');
  }
  // A file that was uploaded and never recorded is on no list, and storage answers a remove that removed
  // nothing without an error. So look: every folder this file uploaded into must be empty now. (The demo's
  // folder is among them, and is always empty: its seeded receipts have no file.)
  const folders = new Set(uploaded.map((path) => path.split('/')[0]).filter((folder) => /^[0-9a-f-]{36}$/.test(folder)));
  for (const folder of folders) {
    const listed = await s.storage.from(INBOX_RECEIPT_BUCKET).list(folder, { limit: 100 });
    if (listed.error) throw new Error(`a test folder of the bucket could not be listed: ${listed.error.message}`);
    if ((listed.data ?? []).length > 0) throw new Error('a test receipt file was left in the bucket');
  }
});

async function confirmedOwner(orgName: string): Promise<Org> {
  const c = liveClient();
  const { userId, error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: categories } = await c.from('finance_categories').select('id, name, kind').eq('org_id', orgId);
  const o = {
    c,
    userId,
    orgId: orgId as string,
    rent: categories!.find((x) => x.kind === 'expense' && x.name === 'Rent')!.id as string,
  };
  owners.push(o);
  return o;
}

const pathIn = (orgId: string, extension = 'png') => `${orgId}/${crypto.randomUUID()}.${extension}`;

/** Uploads the PNG as the given person. The path is remembered whether or not storage took it. */
async function upload(c: SupabaseClient, path: string, contentType = 'image/png') {
  uploaded.push(path);
  return c.storage.from(INBOX_RECEIPT_BUCKET).upload(path, PNG, { contentType, upsert: false });
}

/** An uploaded and recorded receipt. */
async function receipt(o: Org, name = 'resit.png') {
  const path = pathIn(o.orgId);
  const stored = await upload(o.c, path);
  expect(stored.error, stored.error?.message).toBeNull();
  const recorded = await o.c.rpc('finance_register_receipt', { target_org: o.orgId, file: { path, name } });
  expect(recorded.error, recorded.error?.message).toBeNull();
  return { id: recorded.data as string, path };
}

testWithStorage('an owner uploads a receipt, records it, and reads it back with what storage knows of the file', async () => {
  const a = await confirmedOwner('Receipts A');
  const { id, path } = await receipt(a, 'Resit Kedai 12.png');

  const { data: rows, error } = await a.c.from('finance_receipt_inbox').select('*').eq('org_id', a.orgId);
  expect(error, error?.message).toBeNull();
  expect(rows).toHaveLength(1);
  expect(rows![0]).toMatchObject({
    id,
    file_name: 'Resit Kedai 12.png',
    // Both are the database's own reading of the stored object, not what the caller said.
    mime_type: 'image/png',
    size_bytes: PNG.length,
    has_file: true,
    status: 'review',
    extracted_at: null,
    uploaded_by: a.userId,
    vendor: null,
    amount: null,
    document_kind: null,
    extraction_error: null,
  });
  const { data: stored } = await a.c.from('finance_receipts').select('file_path').eq('id', id).single();
  expect(stored!.file_path).toBe(path);

  // A member signs a short link to their own workspace's file, and the file is the one uploaded.
  const link = await a.c.storage.from(INBOX_RECEIPT_BUCKET).createSignedUrl(path, 60);
  expect(link.error, link.error?.message).toBeNull();
  const file = await a.c.storage.from(INBOX_RECEIPT_BUCKET).download(path);
  expect(file.error, file.error?.message).toBeNull();
  expect(Buffer.from(await file.data!.arrayBuffer()).equals(PNG)).toBe(true);

  // What the link serves: the stored type, and, when asked to download, an attachment. Hosted storage sends
  // no X-Content-Type-Options header on a signed link (seen 2026-10-12), so nothing here tells a browser not
  // to guess: the app must open a receipt's file as a download, never inline (see Known limits in the docs).
  const shown = await fetch(link.data!.signedUrl);
  expect(shown.status).toBe(200);
  expect(shown.headers.get('content-type')).toBe('image/png');
  const saved = await a.c.storage.from(INBOX_RECEIPT_BUCKET).createSignedUrl(path, 60, { download: 'receipt.png' });
  const attachment = await fetch(saved.data!.signedUrl);
  expect(attachment.headers.get('content-disposition') ?? '').toMatch(/^attachment/);
  // The bucket is private: with no signature there is no file, and no public address serves it.
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  expect((await fetch(`${base}/storage/v1/object/public/${INBOX_RECEIPT_BUCKET}/${path}`)).ok).toBe(false);
  expect((await fetch(`${base}/storage/v1/object/${INBOX_RECEIPT_BUCKET}/${path}`)).ok).toBe(false);
  expect((await fetch(link.data!.signedUrl.replace(/token=[^&]+/, 'token=forged'))).ok).toBe(false);
});

testWithStorage('a phone\'s HEIC and HEIF are stored and recorded as what they are', async () => {
  const a = await confirmedOwner('Receipts HEIC');
  const heic = pathIn(a.orgId, 'heic');
  expect((await upload(a.c, heic, 'image/heic')).error).toBeNull();
  const heif = pathIn(a.orgId, 'heif');
  expect((await upload(a.c, heif, 'image/heif')).error).toBeNull();
  const one = await a.c.rpc('finance_register_receipt', { target_org: a.orgId, file: { path: heic, name: 'IMG_1001.HEIC' } });
  expect(one.error, one.error?.message).toBeNull();
  const two = await a.c.rpc('finance_register_receipt', { target_org: a.orgId, file: { path: heif, name: 'IMG_1002.heif' } });
  expect(two.error, two.error?.message).toBeNull();
  const { data: rows } = await a.c.from('finance_receipts').select('mime_type').eq('org_id', a.orgId).order('mime_type');
  expect((rows ?? []).map((r) => r.mime_type)).toEqual(['image/heic', 'image/heif']);
  // A HEIC stored under a name that says HEIF is not recorded.
  const liar = pathIn(a.orgId, 'heif');
  expect((await upload(a.c, liar, 'image/heic')).error).toBeNull();
  const lied = await a.c.rpc('finance_register_receipt', { target_org: a.orgId, file: { path: liar, name: 'liar.heif' } });
  expect(lied.error?.code).toBe('FIN24');
});

testWithStorage('the bucket refuses the wrong type, the wrong folder and the wrong name, and nothing is replaced or removed', async () => {
  const a = await confirmedOwner('Receipts B');
  const b = await confirmedOwner('Receipts C');

  expect((await upload(a.c, pathIn(a.orgId), 'text/html')).error).not.toBeNull();
  expect((await upload(a.c, pathIn(a.orgId, 'webp'), 'image/webp')).error).not.toBeNull();
  expect((await upload(a.c, pathIn(b.orgId))).error).not.toBeNull();
  expect((await upload(a.c, `${a.orgId}/receipt.png`)).error).not.toBeNull();
  expect((await upload(a.c, `${a.orgId}/sub/${crypto.randomUUID()}.png`)).error).not.toBeNull();
  expect((await upload(a.c, `${crypto.randomUUID()}.png`)).error).not.toBeNull();

  // A second upload to the same path is refused: a file is never replaced.
  const path = pathIn(a.orgId);
  expect((await upload(a.c, path)).error).toBeNull();
  expect((await a.c.storage.from(INBOX_RECEIPT_BUCKET).upload(path, PNG, { contentType: 'image/png', upsert: true })).error).not.toBeNull();
  // And no signed-in person removes one: storage answers without an error and removes nothing.
  await a.c.storage.from(INBOX_RECEIPT_BUCKET).remove([path]);
  expect((await a.c.storage.from(INBOX_RECEIPT_BUCKET).download(path)).error).toBeNull();
});

testWithStorage('recording refuses a file that is not there, one already recorded, and one whose type is not its name\'s', async () => {
  const a = await confirmedOwner('Receipts D');
  const { path } = await receipt(a);

  const again = await a.c.rpc('finance_register_receipt', { target_org: a.orgId, file: { path, name: 'again.png' } });
  expect(again.error?.code).toBe('FIN24');
  const ghost = await a.c.rpc('finance_register_receipt', { target_org: a.orgId, file: { path: pathIn(a.orgId), name: 'ghost.png' } });
  expect(ghost.error?.code).toBe('FIN24');

  // Stored as a PNG under a name that says JPEG: storage takes it (both are allowed types), the database does not.
  const liar = pathIn(a.orgId, 'jpg');
  expect((await upload(a.c, liar, 'image/png')).error).toBeNull();
  const lied = await a.c.rpc('finance_register_receipt', { target_org: a.orgId, file: { path: liar, name: 'liar.jpg' } });
  expect(lied.error?.code).toBe('FIN24');

  const slash = pathIn(a.orgId);
  expect((await upload(a.c, slash)).error).toBeNull();
  const named = await a.c.rpc('finance_register_receipt', { target_org: a.orgId, file: { path: slash, name: '../etc/passwd' } });
  expect(named.error?.code).toBe('23514');

  const { data: rows } = await a.c.from('finance_receipts').select('id').eq('org_id', a.orgId);
  expect(rows).toHaveLength(1);
});

testWithStorage('another workspace reads neither the row nor the file, and cannot record it as its own', async () => {
  const a = await confirmedOwner('Receipts E');
  const b = await confirmedOwner('Receipts F');
  const { id, path } = await receipt(a);

  const { data: theirs } = await b.c.from('finance_receipt_inbox').select('id').eq('org_id', a.orgId);
  expect(theirs ?? []).toEqual([]);
  const { data: direct } = await b.c.from('finance_receipts').select('id').eq('id', id);
  expect(direct ?? []).toEqual([]);
  expect((await b.c.storage.from(INBOX_RECEIPT_BUCKET).download(path)).error).not.toBeNull();
  expect((await b.c.storage.from(INBOX_RECEIPT_BUCKET).createSignedUrl(path, 60)).error).not.toBeNull();

  const here = await b.c.rpc('finance_register_receipt', { target_org: b.orgId, file: { path, name: 'theirs.png' } });
  expect(here.error?.code).toBe('23514');
  const there = await b.c.rpc('finance_register_receipt', { target_org: a.orgId, file: { path, name: 'theirs.png' } });
  expect(there.error?.code).toBe('42501');
  const reviewed = await b.c.rpc('finance_review_receipt', { target_org: a.orgId, target_receipt: id, details: { vendor: 'Theirs' } });
  expect(reviewed.error?.code).toBe('FIN11');
  const { data: removed } = await b.c.from('finance_receipts').delete().eq('id', id).select('id');
  expect(removed ?? []).toEqual([]);
});

testWithStorage('a receipt is read, reviewed, made into an expense, untied and deleted, and its file is let go', async () => {
  const a = await confirmedOwner('Receipts G');
  const { id, path } = await receipt(a);

  const read = await a.c.rpc('finance_set_receipt_extraction', {
    target_org: a.orgId, target_receipt: id, details: { vendor: 'Shell Bangsar', receipt_date: '2026-10-03', amount: 142.5, sst_amount: 8.07 },
  });
  expect(read.error, read.error?.message).toBeNull();
  expect(read.data).toBe(true);
  const reviewed = await a.c.rpc('finance_review_receipt', {
    target_org: a.orgId, target_receipt: id, details: { vendor: 'Shell Bangsar', receipt_date: '2026-10-03', amount: 142.5, sst_amount: 8.07 },
  });
  expect(reviewed.error, reviewed.error?.message).toBeNull();
  const late = await a.c.rpc('finance_set_receipt_extraction', { target_org: a.orgId, target_receipt: id, details: { vendor: 'Machine' } });
  expect(late.data).toBe(false);
  const { data: stamped } = await a.c.from('finance_receipts').select('extracted_at, vendor').eq('id', id).single();
  expect(stamped!.extracted_at).not.toBeNull();
  expect(stamped!.vendor).toBe('Shell Bangsar');

  const made = await a.c.rpc('finance_receipt_to_expense', {
    target_org: a.orgId, target_receipt: id,
    expense: { expense_date: '2026-10-03', category_id: a.rent, vendor_name: 'Shell Bangsar', amount: 142.5, sst_amount: 8.07 },
  });
  expect(made.error, made.error?.message).toBeNull();
  const { data: row } = await a.c.from('finance_receipt_inbox').select('status, vendor, amount, expense_id, document_kind, document_label').eq('id', id).single();
  expect(row).toMatchObject({ status: 'matched', vendor: 'Shell Bangsar', expense_id: made.data, document_kind: 'expense', document_label: 'Rent' });
  expect(Number(row!.amount)).toBe(142.5);
  // An owner's expense is approved as it is saved.
  const { data: expense } = await a.c.from('finance_expenses').select('status, amount').eq('id', made.data).single();
  expect(expense!.status).toBe('approved');

  const matched = await a.c.from('finance_receipts').delete().eq('id', id);
  expect(matched.error?.code).toBe('FIN23');
  // The file's name, like its path, type, size and uploader, is not a column a signed-in person may write.
  const moved = await a.c.from('finance_receipts').update({ file_name: 'other.png' }).eq('id', id);
  expect(moved.error?.code).toBe('42501');
  const forged = await a.c.from('finance_receipts').update({ uploaded_by: crypto.randomUUID() }).eq('id', id);
  expect(forged.error?.code).toBe('42501');

  const untied = await a.c.rpc('finance_detach_receipt', { target_org: a.orgId, target_receipt: id });
  expect(untied.error, untied.error?.message).toBeNull();
  const { data: after } = await a.c.from('finance_receipts').select('status, expense_id').eq('id', id).single();
  expect(after).toEqual({ status: 'unmatched', expense_id: null });

  const s = service();
  expect((await s.rpc('finance_receipt_deletion_queued', { p_path: path })).data).toBe(false);
  const deleted = await a.c.from('finance_receipts').delete().eq('id', id);
  expect(deleted.error, deleted.error?.message).toBeNull();
  expect((await s.rpc('finance_receipt_deletion_queued', { p_path: path })).data).toBe(true);
  // Its file can never be a receipt again, though it is still in the bucket for a moment.
  const back = await a.c.rpc('finance_register_receipt', { target_org: a.orgId, file: { path, name: 'back.png' } });
  expect(back.error?.code).toBe('FIN24');
  // The clean-up functions are the server's alone.
  expect((await a.c.rpc('finance_receipt_deletion_queued', { p_path: path })).error).not.toBeNull();
  expect((await a.c.rpc('finance_receipt_deletions_due', { p_limit: 10 })).error).not.toBeNull();
  // While the file is in the bucket its path stays on the list, whatever the caller says.
  expect((await s.rpc('finance_receipt_deletions_done', { p_paths: [path] })).data).toBe(0);
});

testWithStorage('a draft bill is made from a receipt, and is a draft the bill form can finish', async () => {
  const a = await confirmedOwner('Receipts Bill');
  const { id } = await receipt(a);
  const { data: supplier, error: supplierErr } = await a.c
    .from('finance_contacts')
    .insert({ org_id: a.orgId, name: 'Kedai Kertas', is_customer: false, is_supplier: true })
    .select('id')
    .single();
  expect(supplierErr, supplierErr?.message).toBeNull();
  const bill = { supplier_id: supplier!.id, bill_date: '2026-10-03', due_date: '2026-11-02' };
  const made = await a.c.rpc('finance_receipt_to_bill', {
    target_org: a.orgId, target_receipt: id, bill, lines: [{ description: 'Receipt resit.png', quantity: 1, unit_price: 142.5, sst_rate: 0 }],
  });
  expect(made.error, made.error?.message).toBeNull();
  const { data: saved } = await a.c.from('supplier_bill_totals').select('status, total, bill_no').eq('id', made.data).single();
  expect(saved).toMatchObject({ status: 'draft', bill_no: null });
  expect(Number(saved!.total)).toBe(142.5);
  const { data: row } = await a.c.from('finance_receipt_inbox').select('status, bill_id, document_kind, document_label').eq('id', id).single();
  expect(row).toEqual({ status: 'matched', bill_id: made.data, document_kind: 'bill', document_label: null });

  // The person finishes it in the bill form, which saves the same draft; the receipt stays on it.
  const edited = await a.c.rpc('finance_save_bill', {
    target_org: a.orgId, bill: { ...bill, id: made.data }, lines: [{ description: 'A4 paper', quantity: 5, unit_price: 28.5, sst_rate: 0 }],
  });
  expect(edited.error, edited.error?.message).toBeNull();
  const posted = await a.c.rpc('finance_post_bill', { target_org: a.orgId, target_bill: made.data });
  expect(posted.error, posted.error?.message).toBeNull();
  // Posting is a sign-off, which this owner may do; it takes a BILL- number from finance_next_number.
  const { data: after } = await a.c.from('finance_receipt_inbox').select('status, document_label').eq('id', id).single();
  expect(after!.status).toBe('matched');
  expect(after!.document_label).toMatch(/^BILL-\d+$/);

  const again = await a.c.rpc('finance_receipt_to_bill', { target_org: a.orgId, target_receipt: id, bill, lines: [{ description: 'x', quantity: 1, unit_price: 1, sst_rate: 0 }] });
  expect(again.error?.code).toBe('FIN23');
});

testWithStorage('two expenses made from one receipt at the same moment: exactly one is made', async () => {
  const a = await confirmedOwner('Receipts H');
  const { id } = await receipt(a);
  const make = () =>
    a.c.rpc('finance_receipt_to_expense', {
      target_org: a.orgId, target_receipt: id, expense: { category_id: a.rent, vendor_name: 'Twice', amount: 10 },
    });
  const results = await Promise.all([make(), make()]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN23');
  const { data: expenses } = await a.c.from('finance_expenses').select('id').eq('org_id', a.orgId);
  expect(expenses).toHaveLength(1);
});

// UNOBSERVED until the controller runs it (Task 1, step 12). Everything in this test is about what the storage
// service itself does, which no local database can show: whose word the stored type is, and what move, copy,
// list and a resumable upload do in a bucket with no update and no delete rule. Each expectation says what it
// would mean if it failed; where the service may rightly answer either way, the test holds only what must be true
// in both cases.
testWithStorage('what the storage service itself does: a declared type, move, copy, list and a resumable upload', async () => {
  const a = await confirmedOwner('Receipts Storage A');
  const b = await confirmedOwner('Receipts Storage B');
  const bucket = (c: SupabaseClient) => c.storage.from(INBOX_RECEIPT_BUCKET);
  const record = (o: Org, path: string, name: string) =>
    o.c.rpc('finance_register_receipt', { target_org: o.orgId, file: { path, name } });

  // 1. The stored type is the one the uploader declared, not one the service read from the bytes: PNG bytes sent
  //    as image/jpeg under .jpg are stored, and recorded as a JPEG. This is the limit "Why an upload is safe"
  //    states; if the upload is refused instead, the service looks inside files and that row can say more.
  const liar = pathIn(a.orgId, 'jpg');
  expect((await upload(a.c, liar, 'image/jpeg')).error).toBeNull();
  const lied = await record(a, liar, 'really-a-png.jpg');
  expect(lied.error, lied.error?.message).toBeNull();
  const { data: typed } = await a.c.from('finance_receipts').select('mime_type, size_bytes').eq('id', lied.data).single();
  expect(typed).toEqual({ mime_type: 'image/jpeg', size_bytes: PNG.length });

  // 2. Move is an update of the object's name, and there is no update rule: refused, and the file stays put.
  const source = pathIn(a.orgId);
  expect((await upload(a.c, source)).error).toBeNull();
  const movedTo = pathIn(a.orgId);
  uploaded.push(movedTo);
  expect((await bucket(a.c).move(source, movedTo)).error).not.toBeNull();
  expect((await bucket(a.c).download(source)).error).toBeNull();
  expect((await bucket(a.c).download(movedTo)).error).not.toBeNull();

  // 3a. Copy inside the workspace's own folder: an insert like any upload, so it may be let in. Either way the
  //     source is untouched, and a copy that landed is a file that can be recorded like any other.
  const copiedTo = pathIn(a.orgId);
  uploaded.push(copiedTo);
  const copied = await bucket(a.c).copy(source, copiedTo);
  expect((await bucket(a.c).download(source)).error).toBeNull();
  if (!copied.error) expect((await record(a, copiedTo, 'copy.png')).error).toBeNull();

  // 3b. Copy into another workspace's folder: refused, and nothing lands there.
  const across = pathIn(b.orgId);
  uploaded.push(across);
  expect((await bucket(a.c).copy(source, across)).error).not.toBeNull();
  expect((await bucket(b.c).download(across)).error).not.toBeNull();

  // 3c. Copy from another bucket, where the same person may store other types, into this one. If the service
  //     lets it in without applying this bucket's type list, it still cannot become a receipt: the database
  //     refuses a file whose stored type is not the one its name says. (It would sit in the bucket and count
  //     against the workspace's room until the clean-up run takes it, an hour later.)
  const note = `${a.userId}/${crypto.randomUUID()}/note.txt`;
  const chat = a.c.storage.from('chat-attachments');
  const noted = await chat.upload(note, Buffer.from('not a receipt'), { contentType: 'text/plain', upsert: false });
  if (!noted.error) {
    try {
      const landed = pathIn(a.orgId);
      uploaded.push(landed);
      const crossed = await chat.copy(note, landed, { destinationBucket: INBOX_RECEIPT_BUCKET });
      if (!crossed.error) expect((await record(a, landed, 'note.png')).error?.code).toBe('FIN24');
    } finally {
      await chat.remove([note]);
    }
  }

  // 4. Listing is held by the read rule: another workspace's folder lists as empty, one's own does not.
  const theirs = await bucket(b.c).list(a.orgId, { limit: 100 });
  expect(theirs.data ?? []).toEqual([]);
  const own = await bucket(a.c).list(a.orgId, { limit: 100 });
  expect((own.data ?? []).length).toBeGreaterThanOrEqual(2);

  // 5. A resumable (TUS) upload lands as a plain one does: created now, with its size and its type written down,
  //    so it can be recorded. If it cannot, 7b must not use the resumable endpoint.
  const { data: signedIn } = await a.c.auth.getSession();
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const headers = {
    authorization: `Bearer ${signedIn.session!.access_token}`,
    apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    'tus-resumable': '1.0.0',
  };
  const b64 = (value: string) => Buffer.from(value).toString('base64');
  const resumable = pathIn(a.orgId);
  uploaded.push(resumable);
  const created = await fetch(`${base}/storage/v1/upload/resumable`, {
    method: 'POST',
    headers: {
      ...headers,
      'upload-length': String(PNG.length),
      'x-upsert': 'false',
      'upload-metadata': `bucketName ${b64(INBOX_RECEIPT_BUCKET)},objectName ${b64(resumable)},contentType ${b64('image/png')}`,
    },
  });
  expect(created.status).toBe(201);
  const sent = await fetch(new URL(created.headers.get('location')!, base), {
    method: 'PATCH',
    headers: { ...headers, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
    body: PNG,
  });
  expect(sent.status).toBe(204);
  const resumed = await record(a, resumable, 'resumable.png');
  expect(resumed.error, resumed.error?.message).toBeNull();
  const { data: landedRow } = await a.c.from('finance_receipts').select('mime_type, size_bytes').eq('id', resumed.data).single();
  expect(landedRow).toEqual({ mime_type: 'image/png', size_bytes: PNG.length });
});

testWithStorage('a demo viewer reads the seeded inbox, and can write none of it', async () => {
  const c = liveClient();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await joinDemo(c);
  expect(error, error?.message).toBeNull();

  const { data: rows } = await c.from('finance_receipt_inbox').select('status, has_file, document_kind, amount, extraction_error, extracted_at').eq('org_id', demoId);
  expect((rows ?? []).length).toBe(8);
  expect((rows ?? []).filter((r) => r.status === 'matched')).toHaveLength(5);
  expect((rows ?? []).filter((r) => r.status === 'review')).toHaveLength(2);
  expect((rows ?? []).filter((r) => r.status === 'unmatched')).toHaveLength(1);
  // A migration cannot upload: no seeded receipt has a file.
  expect((rows ?? []).every((r) => r.has_file === false)).toBe(true);
  expect((rows ?? []).filter((r) => r.document_kind === 'bill')).toHaveLength(1);
  expect((rows ?? []).filter((r) => r.extraction_error !== null)).toHaveLength(1);
  expect((rows ?? []).filter((r) => r.extracted_at !== null && r.status === 'review')).toHaveLength(1);

  const path = pathIn(demoId as string);
  expect((await upload(c, path)).error).not.toBeNull();
  const recorded = await c.rpc('finance_register_receipt', { target_org: demoId, file: { path, name: 'viewer.png' } });
  expect(recorded.error?.code).toBe('42501');
  const { data: one } = await c.from('finance_receipts').select('id').eq('org_id', demoId).eq('status', 'review').limit(1);
  const reviewed = await c.rpc('finance_review_receipt', { target_org: demoId, target_receipt: one![0].id, details: { vendor: 'Viewer' } });
  expect(reviewed.error?.code).toBe('FIN11');
  const { data: removed } = await c.from('finance_receipts').delete().eq('id', one![0].id).select('id');
  expect(removed ?? []).toEqual([]);
});
