import { describe, expect, it } from 'vitest';
import {
  ANY_FORM,
  AUTOMATION_MESSAGES as M,
  RUN_TREND_WEEKS,
  automationStats,
  createAutomation,
  deleteAutomation,
  describeAction,
  describeTrigger,
  mapAutomation,
  parseAutomationForm,
  readAutomationId,
  runsSince,
  setAutomationEnabled,
  updateAutomation,
} from '@/lib/crm/automations';
import { CrmContactFormError } from '@/lib/crm/contacts';

const STAGE = '11111111-1111-4111-8111-111111111111';
const FORM = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

const FOLLOW_UP = { name: 'Chase quotes', trigger: 'deal_stage', stageId: STAGE, action: 'add_follow_up', title: 'Chase the quote', dueDays: '2' };

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

describe('the automation form', () => {
  it('reads a deal-stage trigger with a follow-up, switched on to begin with', () => {
    expect(parseAutomationForm(form({ ...FOLLOW_UP, name: '  Chase   quotes ', title: ' Chase the\nquote ' }))).toEqual({
      name: 'Chase quotes',
      trigger_type: 'deal_stage',
      trigger_stage_id: STAGE,
      trigger_form_id: null,
      trigger_any_form: false,
      action_type: 'add_follow_up',
      action_title: 'Chase the quote',
      action_due_days: 2,
      action_tag: null,
      action_status: null,
      enabled: true,
    });
  });

  it('keeps only what the chosen trigger and action use', () => {
    const fields = parseAutomationForm(
      form({
        name: 'Tag new leads',
        trigger: 'contact_created',
        // Left over from choices made before these were settled on.
        stageId: STAGE,
        formId: FORM,
        action: 'add_tag',
        tag: ' VIP  buyer ',
        title: 'stray',
        dueDays: '9',
        status: 'customer',
      }),
    );
    expect(fields).toMatchObject({
      trigger_stage_id: null,
      trigger_form_id: null,
      trigger_any_form: false,
      action_title: null,
      action_due_days: null,
      action_tag: 'VIP buyer',
      action_status: null,
    });
  });

  it('takes one lead form, or any', () => {
    const base = { name: 'Welcome', trigger: 'form_submitted', action: 'set_status', status: 'contacted' };
    expect(parseAutomationForm(form({ ...base, formId: FORM }))).toMatchObject({
      trigger_form_id: FORM,
      trigger_any_form: false,
      action_status: 'contacted',
    });
    expect(parseAutomationForm(form({ ...base, formId: ANY_FORM }))).toMatchObject({
      trigger_form_id: null,
      trigger_any_form: true,
    });
    expect(() => parseAutomationForm(form({ ...base, formId: '' }))).toThrow(M.form);
  });

  it('a follow-up can have no due date, or be due the same day', () => {
    expect(parseAutomationForm(form({ ...FOLLOW_UP, dueDays: '' })).action_due_days).toBeNull();
    expect(parseAutomationForm(form({ ...FOLLOW_UP, dueDays: '0' })).action_due_days).toBe(0);
  });

  it('says what is missing or wrong', () => {
    const bad = (over: Record<string, string>, message: string) =>
      expect(() => parseAutomationForm(form({ ...FOLLOW_UP, ...over }))).toThrow(message);
    bad({ name: ' ' }, M.name);
    bad({ trigger: 'on_full_moon' }, M.trigger);
    bad({ stageId: '' }, M.stage);
    bad({ action: 'send_money' }, M.action);
    bad({ title: '' }, M.title);
    bad({ dueDays: '366' }, M.dueDays);
    bad({ dueDays: '-1' }, M.dueDays);
    bad({ dueDays: '1.5' }, M.dueDays);
    bad({ action: 'add_tag', tag: '' }, M.tag);
    bad({ action: 'add_tag', tag: 'a, b' }, M.tagComma);
    bad({ action: 'add_tag', tag: 'x'.repeat(31) }, M.tagTooLong);
    // An automation never archives a contact.
    bad({ action: 'set_status', status: 'archived' }, M.status);
  });

  it('the edit form says whether it is switched on; unticked means off', () => {
    expect(parseAutomationForm(form({ ...FOLLOW_UP, enabledField: '1', enabled: 'on' })).enabled).toBe(true);
    expect(parseAutomationForm(form({ ...FOLLOW_UP, enabledField: '1' })).enabled).toBe(false);
    expect(() => readAutomationId(form({ automationId: 'nope' }))).toThrow(M.gone);
    expect(readAutomationId(form({ automationId: ID }))).toBe(ID);
  });
});

describe('an automation in words', () => {
  const stages = [{ id: STAGE, label: 'Proposal' }];
  const forms = [{ id: FORM, label: 'Raya enquiry' }];
  const base = { stageId: null, formId: null, anyForm: false };

  it('names the stage or form that sets it off', () => {
    expect(describeTrigger({ ...base, trigger: 'deal_stage', stageId: STAGE }, stages, forms)).toEqual({
      text: 'A deal arrives in Proposal',
      broken: false,
    });
    expect(describeTrigger({ ...base, trigger: 'form_submitted', formId: FORM }, stages, forms).text).toBe(
      '“Raya enquiry” is submitted',
    );
    expect(describeTrigger({ ...base, trigger: 'form_submitted', anyForm: true }, stages, forms).text).toBe(
      'Any lead form is submitted',
    );
    expect(describeTrigger({ ...base, trigger: 'deal_won' }, stages, forms).text).toBe('A deal is won');
  });

  it('says so when the stage or form it named has been deleted, since it then never runs', () => {
    expect(describeTrigger({ ...base, trigger: 'deal_stage' }, stages, forms).broken).toBe(true);
    expect(describeTrigger({ ...base, trigger: 'form_submitted' }, stages, forms).broken).toBe(true);
  });

  it('says what it does', () => {
    const none = { title: '', dueDays: null, tag: '', status: null };
    expect(describeAction({ ...none, action: 'add_follow_up', title: 'Chase the quote', dueDays: 2 })).toBe(
      'Add follow-up “Chase the quote”, due in 2 days',
    );
    expect(describeAction({ ...none, action: 'add_follow_up', title: 'Call', dueDays: 1 })).toContain('due in 1 day');
    expect(describeAction({ ...none, action: 'add_follow_up', title: 'Call', dueDays: 0 })).toContain('due the same day');
    expect(describeAction({ ...none, action: 'add_follow_up', title: 'Call' })).toContain('no due date');
    expect(describeAction({ ...none, action: 'add_tag', tag: 'vip' })).toBe('Add the tag “vip”');
    expect(describeAction({ ...none, action: 'set_status', status: 'customer' })).toBe('Set status to Customer');
  });
});

describe('the figures', () => {
  // Monday 12 Oct 2026, mid-morning in Kuala Lumpur.
  const now = new Date('2026-10-12T02:00:00.000Z');

  it('count this month’s runs and how many did not fail, by the date in Malaysia', () => {
    const stats = automationStats(
      [{ enabled: true }, { enabled: false }, { enabled: true }],
      [
        { status: 'done', at: '2026-10-11T03:00:00.000Z' },
        { status: 'skipped', at: '2026-10-05T03:00:00.000Z' },
        { status: 'failed', at: '2026-10-01T03:00:00.000Z' },
        // 17:00 UTC on 30 Sep is 1:00 am on 1 Oct in Malaysia: this month.
        { status: 'done', at: '2026-09-30T17:00:00.000Z' },
        // 15:00 UTC on 30 Sep is 11:00 pm on 30 Sep: last month.
        { status: 'failed', at: '2026-09-30T15:00:00.000Z' },
      ],
      now,
    );
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(2);
    expect(stats.runsThisMonth).toBe(4);
    expect(stats.successRate).toBe(75);
  });

  it('chart eight weeks, Monday to Sunday, oldest first, ending with this week', () => {
    const { trend } = automationStats(
      [],
      [
        { status: 'done', at: '2026-10-12T01:00:00.000Z' },
        { status: 'failed', at: '2026-10-11T03:00:00.000Z' },
        { status: 'done', at: '2026-10-05T03:00:00.000Z' },
        // Before the first week charted.
        { status: 'done', at: '2026-08-01T03:00:00.000Z' },
      ],
      now,
    );
    expect(trend).toHaveLength(RUN_TREND_WEEKS);
    expect(trend[0]).toMatchObject({ week: '2026-08-24', label: 'Aug 24' });
    expect(trend.at(-1)).toEqual({ week: '2026-10-12', label: 'Oct 12', runs: 1, failed: 0 });
    expect(trend.at(-2)).toEqual({ week: '2026-10-05', label: 'Oct 5', runs: 2, failed: 1 });
    // Runs are read from the first charted week's midnight in Malaysia.
    expect(runsSince(now)).toBe('2026-08-23T16:00:00.000Z');
  });

  it('have no success rate when nothing has run', () => {
    expect(automationStats([], [], now).successRate).toBeNull();
  });
});

describe('saving an automation', () => {
  const fields = parseAutomationForm(form(FOLLOW_UP));

  it('adds it to the workspace, and never sends a counter or the reason it was switched off', async () => {
    const { client, seen } = fakeClient([{}]);
    await createAutomation(client, 'org1', fields, 'user1');
    expect(seen[0]).toMatchObject({ table: 'crm_automations', op: 'insert' });
    expect(seen[0].payload).toEqual({ org_id: 'org1', ...fields, created_by: 'user1' });
    for (const column of ['runs_count', 'last_run_at', 'paused_reason']) {
      expect(seen[0].payload).not.toHaveProperty(column);
    }
  });

  it('changes only that automation in that workspace', async () => {
    const { client, seen } = fakeClient([{ data: [{ id: ID }] }]);
    await updateAutomation(client, 'org1', ID, fields);
    expect(seen[0].op).toBe('update');
    expect(seen[0].payload).not.toHaveProperty('org_id');
    expect(seen[0].filters).toEqual([
      ['id', ID],
      ['org_id', 'org1'],
    ]);
  });

  it('switches one on or off, writing nothing else', async () => {
    const { client, seen } = fakeClient([{ data: [{ id: ID }] }]);
    await setAutomationEnabled(client, 'org1', ID, false);
    expect(Object.keys(seen[0].payload as object).sort()).toEqual(['enabled', 'updated_at']);
    expect(seen[0].payload).toMatchObject({ enabled: false });
  });

  it('says so when the stage or form is not this workspace’s, or the automation has gone', async () => {
    await expect(createAutomation(fakeClient([{ error: { code: '42501' } }]).client, 'org1', fields)).rejects.toThrow(
      M.missing,
    );
    await expect(updateAutomation(fakeClient([{ error: { code: '23503' } }]).client, 'org1', ID, fields)).rejects.toThrow(
      M.missing,
    );
    await expect(updateAutomation(fakeClient([{ data: [] }]).client, 'org1', ID, fields)).rejects.toThrow(M.gone);
    await expect(setAutomationEnabled(fakeClient([{ data: [] }]).client, 'org1', ID, true)).rejects.toThrow(M.gone);
    // The database allows only so many switched on at once.
    await expect(
      setAutomationEnabled(fakeClient([{ error: { code: '23514' } }]).client, 'org1', ID, true),
    ).rejects.toThrow(M.tooManyOn);
    await expect(createAutomation(fakeClient([{ error: { code: '23514' } }]).client, 'org1', fields)).rejects.toThrow(
      M.tooManyOn,
    );
    await expect(deleteAutomation(fakeClient([{ data: [] }]).client, 'org1', ID)).rejects.toThrow(CrmContactFormError);
  });

  it('reads a stored row back', () => {
    expect(
      mapAutomation({
        id: ID,
        name: 'Chase quotes',
        trigger_type: 'deal_stage',
        trigger_stage_id: STAGE,
        trigger_form_id: null,
        trigger_any_form: false,
        action_type: 'add_follow_up',
        action_title: 'Chase the quote',
        action_due_days: 2,
        action_tag: null,
        action_status: null,
        enabled: false,
        paused_reason: 'Switched off after 500 runs in one day.',
        runs_count: 500,
        // 17:30 UTC on the 12th is 1:30 am on the 13th in Malaysia.
        last_run_at: '2026-10-12T17:30:00.000Z',
      }),
    ).toEqual({
      id: ID,
      name: 'Chase quotes',
      trigger: 'deal_stage',
      stageId: STAGE,
      formId: null,
      anyForm: false,
      action: 'add_follow_up',
      title: 'Chase the quote',
      dueDays: 2,
      tag: '',
      status: null,
      enabled: false,
      pausedReason: 'Switched off after 500 runs in one day.',
      runs: 500,
      lastRunDay: '2026-10-13',
    });
  });
});
