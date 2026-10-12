import { describe, expect, it } from 'vitest';
import { CrmContactFormError } from '@/lib/crm/contacts';
import {
  LANDING_PAGE_MESSAGES as M,
  PAGE_HEADLINE_MAX,
  createLandingPage,
  deleteLandingPage,
  landingPagePath,
  landingPageStats,
  mapLandingPage,
  parseLandingPageForm,
  readLandingPageId,
  updateLandingPage,
  type LandingPageFormChoice,
} from '@/lib/crm/landing-pages';

const FORM = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

const VALID = { name: 'Raya promo', headline: 'Diskaun Raya', formId: FORM, status: 'published' };

type Result = { data?: unknown; error?: { code?: string } | null };

/** A stand-in for the Supabase client: answers in turn and keeps what was written. */
function fakeClient(answers: Result[]) {
  const seen: { op: string; table: string; payload?: unknown; filters: unknown[][] }[] = [];
  const from = (table: string) => {
    const call = { op: 'select', table, payload: undefined as unknown, filters: [] as unknown[][] };
    seen.push(call);
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (...args: unknown[]) => {
      call.filters.push(args);
      return builder;
    };
    for (const op of ['insert', 'update', 'delete']) {
      builder[op] = (payload?: unknown) => {
        call.op = op;
        call.payload = payload;
        return builder;
      };
    }
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: null, ...answers.shift() });
    return builder;
  };
  return { client: { from } as never, seen };
}

describe('the landing page form', () => {
  it('tidies what was typed and keeps the text’s line breaks', () => {
    expect(
      parseLandingPageForm(
        form({
          name: '  Raya   promo ',
          headline: ' Diskaun\nRaya ',
          subheadline: '  Hingga 20 April ',
          body: 'Baris satu\r\n\r\nBaris dua  ',
          buttonLabel: ' Tempah Sekarang ',
          formId: FORM,
          status: 'published',
          chatEnabled: 'on',
        }),
      ),
    ).toEqual({
      name: 'Raya promo',
      headline: 'Diskaun Raya',
      subheadline: 'Hingga 20 April',
      body: 'Baris satu\n\nBaris dua',
      button_label: 'Tempah Sekarang',
      form_id: FORM,
      status: 'published',
      chat_enabled: true,
    });
  });

  it('stores an empty optional field as nothing, and anything but "published" as a draft', () => {
    expect(parseLandingPageForm(form({ name: 'A', headline: 'B', status: 'live' }))).toEqual({
      name: 'A',
      headline: 'B',
      subheadline: null,
      body: null,
      button_label: null,
      form_id: null,
      status: 'draft',
      chat_enabled: false,
    });
  });

  it('needs a name and a headline', () => {
    expect(() => parseLandingPageForm(form({ ...VALID, name: '  ' }))).toThrow(M.name);
    expect(() => parseLandingPageForm(form({ ...VALID, headline: '' }))).toThrow(M.headline);
    expect(() => parseLandingPageForm(form({ ...VALID, headline: 'x'.repeat(PAGE_HEADLINE_MAX + 1) }))).toThrow(
      M.headlineTooLong,
    );
  });

  it('will not publish a page with no lead form, but saves it as a draft', () => {
    expect(() => parseLandingPageForm(form({ ...VALID, formId: '' }))).toThrow(M.formNeeded);
    expect(parseLandingPageForm(form({ ...VALID, formId: '', status: 'draft' })).form_id).toBeNull();
  });

  it('refuses a lead form or a page id that is not an id', () => {
    expect(() => parseLandingPageForm(form({ ...VALID, formId: 'nope' }))).toThrow(M.form);
    expect(() => readLandingPageId(form({ pageId: 'nope' }))).toThrow(M.gone);
    expect(readLandingPageId(form({ pageId: PAGE }))).toBe(PAGE);
  });
});

describe('a page as the screen lists it', () => {
  const forms = new Map<string, LandingPageFormChoice>([
    [FORM, { id: FORM, name: 'Raya enquiry', status: 'active' }],
    ['paused', { id: 'paused', name: 'Old form', status: 'paused' }],
  ]);
  const row = {
    id: PAGE,
    name: 'Raya promo',
    headline: 'Diskaun Raya',
    subheadline: null,
    body: null,
    button_label: null,
    form_id: FORM,
    status: 'published',
    views_count: 40,
    leads_count: 5,
    chat_enabled: true,
  };

  it('is live only when it is published and its form is active', () => {
    expect(mapLandingPage(row, forms)).toMatchObject({
      formName: 'Raya enquiry',
      live: true,
      views: 40,
      leads: 5,
      path: `/p/${PAGE}`,
      subheadline: '',
      buttonLabel: '',
      chatEnabled: true,
    });
    expect(mapLandingPage({ ...row, status: 'draft' }, forms).live).toBe(false);
    expect(mapLandingPage({ ...row, form_id: 'paused' }, forms).live).toBe(false);
    // The form was deleted: nothing to show, so not live.
    expect(mapLandingPage({ ...row, form_id: null }, forms)).toMatchObject({ formName: null, live: false });
    expect(landingPagePath(PAGE)).toBe(`/p/${PAGE}`);
  });

  it('adds up to the figures above the table', () => {
    expect(
      landingPageStats([
        { status: 'published', views: 40, leads: 5 },
        { status: 'draft', views: 0, leads: 0 },
        { status: 'published', views: 23, leads: 2 },
      ]),
    ).toEqual({ pages: 3, published: 2, views: 63, leads: 7, conversion: 11.1 });
    expect(landingPageStats([]).conversion).toBeNull();
  });
});

describe('saving a landing page', () => {
  const fields = parseLandingPageForm(form(VALID));

  it('adds it to the workspace, made by whoever asked, and never sends a counter', async () => {
    const { client, seen } = fakeClient([{}]);
    await createLandingPage(client, 'org1', fields, 'user1');
    expect(seen[0]).toMatchObject({ table: 'crm_landing_pages', op: 'insert' });
    expect(seen[0].payload).toEqual({ org_id: 'org1', ...fields, created_by: 'user1' });
    expect(Object.keys(seen[0].payload as object)).not.toEqual(expect.arrayContaining(['views_count', 'leads_count']));
  });

  it('changes only that page in that workspace, and never its workspace or counters', async () => {
    const { client, seen } = fakeClient([{ data: [{ id: PAGE }] }]);
    await updateLandingPage(client, 'org1', PAGE, fields);
    expect(seen[0].op).toBe('update');
    expect(Object.keys(seen[0].payload as object).sort()).toEqual(
      ['body', 'button_label', 'chat_enabled', 'form_id', 'headline', 'name', 'status', 'subheadline', 'updated_at'].sort(),
    );
    expect(seen[0].filters).toEqual([
      ['id', PAGE],
      ['org_id', 'org1'],
    ]);
  });

  it('says so when the chosen form is not this workspace’s, or the page has gone', async () => {
    await expect(createLandingPage(fakeClient([{ error: { code: '42501' } }]).client, 'org1', fields)).rejects.toThrow(
      M.form,
    );
    await expect(
      updateLandingPage(fakeClient([{ error: { code: '23503' } }]).client, 'org1', PAGE, fields),
    ).rejects.toThrow(M.form);
    await expect(updateLandingPage(fakeClient([{ data: [] }]).client, 'org1', PAGE, fields)).rejects.toThrow(M.gone);
    await expect(deleteLandingPage(fakeClient([{ data: [] }]).client, 'org1', PAGE)).rejects.toThrow(
      CrmContactFormError,
    );
  });
});
