import { beforeEach, describe, expect, it, vi } from 'vitest';

const PAGE = '22222222-2222-4222-8222-222222222222';
const FORM = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  landingPageFormId: vi.fn(),
  countLandingPageLead: vi.fn(),
  submitPublicFormAction: vi.fn(),
}));

vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => true }));
vi.mock('@/lib/crm/public-landing-pages', () => ({
  landingPageFormId: mocks.landingPageFormId,
  countLandingPageLead: mocks.countLandingPageLead,
}));
vi.mock('@/app/f/[formId]/actions', () => ({ submitPublicFormAction: mocks.submitPublicFormAction }));

import { submitLandingPageAction } from '@/app/p/[pageId]/actions';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.landingPageFormId.mockResolvedValue(FORM);
  mocks.submitPublicFormAction.mockResolvedValue({ done: true });
});

describe('a submission from a landing page', () => {
  it('goes to the page’s own form, looked up from the page, and is counted once', async () => {
    const data = form({ name: 'Aisyah', email: 'a@example.com', formId: 'somewhere-else' });
    expect(await submitLandingPageAction(PAGE, undefined, data)).toEqual({ done: true });
    // Whatever the browser sent as a form id is ignored.
    expect(mocks.submitPublicFormAction).toHaveBeenCalledWith(FORM, undefined, data);
    expect(mocks.countLandingPageLead).toHaveBeenCalledTimes(1);
    expect(mocks.countLandingPageLead).toHaveBeenCalledWith(PAGE, FORM);
  });

  it('is turned away when the page is a draft or gone, without reaching the form', async () => {
    mocks.landingPageFormId.mockResolvedValueOnce(null);
    expect(await submitLandingPageAction(PAGE, undefined, form({ name: 'A' }))).toEqual({ closed: true });
    expect(mocks.submitPublicFormAction).not.toHaveBeenCalled();
    expect(mocks.countLandingPageLead).not.toHaveBeenCalled();
  });

  it('is not counted when the form rejected it', async () => {
    mocks.submitPublicFormAction.mockResolvedValue({ errors: { email: 'Enter a valid email.' } });
    await submitLandingPageAction(PAGE, undefined, form({ name: 'A' }));
    expect(mocks.countLandingPageLead).not.toHaveBeenCalled();
  });

  it('is not counted when the hidden field was filled, though it is thanked like any other', async () => {
    const { HONEYPOT_FIELD } = await import('@/lib/reach/form-submissions');
    const state = await submitLandingPageAction(PAGE, undefined, form({ name: 'Bot', [HONEYPOT_FIELD]: 'x' }));
    expect(state).toEqual({ done: true });
    expect(mocks.countLandingPageLead).not.toHaveBeenCalled();
  });

  it('a link that is not a page id reaches nothing', async () => {
    const state = await submitLandingPageAction('not-an-id', undefined, form({ name: 'A' }));
    expect(state?.error).toBeTruthy();
    expect(mocks.landingPageFormId).not.toHaveBeenCalled();
    expect(mocks.submitPublicFormAction).not.toHaveBeenCalled();
  });
});
