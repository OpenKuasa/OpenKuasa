import { describe, expect, it } from 'vitest';
import {
  buildDocumentsModel,
  buildLettersModel,
  buildSettingsModel,
  isExpiringSoon,
  loadRecordsModel,
  loadSettingsModel,
  maskAccount,
  workWeekLabel,
} from '@/lib/people/documents';
import { createSeedPeopleData } from '@/lib/people/seed';
import {
  DEMO_EMPLOYEE_ID,
  type HrDocument,
  type PeopleData,
  type PeopleSettings,
  type PeopleViewer,
} from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = '2026-10-09';
const data = createSeedPeopleData(NOW);

const DEMO: PeopleViewer = { employeeId: DEMO_EMPLOYEE_ID, isHr: false, isDemo: true };
const HR_5: PeopleViewer = { employeeId: 'seed-emp-5', isHr: true, isDemo: false };
const MEMBER: PeopleViewer = { employeeId: 'seed-emp-5', isHr: false, isDemo: false };
const UNLINKED: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };

const doc = (over: Partial<HrDocument>): HrDocument => ({
  id: 'd', employee_id: DEMO_EMPLOYEE_ID, employee_name: 'E', title: 'T', doc_type: 'benefits',
  status: 'available', issued_on: '2026-01-01', expires_on: null, ...over,
});

const SETTINGS: PeopleSettings = {
  work_week: ['mon', 'tue', 'wed', 'thu', 'fri'],
  default_annual_leave_days: 14.5,
  default_medical_leave_days: 14,
  default_emergency_leave_days: 3,
  overtime_rates: { weekday: 1.5, rest_day: 2, public_holiday: 3 },
  notifications: {},
};

describe('maskAccount', () => {
  it('keeps the last 4 characters only', () => {
    expect(maskAccount('1234567890')).toBe('••••7890');
  });
  it('hides a short account entirely and returns null for nothing', () => {
    expect(maskAccount('123')).toBe('•••');
    expect(maskAccount('1234')).toBe('••••');
    expect(maskAccount(null)).toBeNull();
    expect(maskAccount('  ')).toBeNull();
  });
});

describe('isExpiringSoon', () => {
  it('counts 90 days away, not 91, and not past or undated', () => {
    expect(isExpiringSoon({ expires_on: '2027-01-07' }, TODAY)).toBe(true); // +90
    expect(isExpiringSoon({ expires_on: '2027-01-08' }, TODAY)).toBe(false); // +91
    expect(isExpiringSoon({ expires_on: '2026-10-08' }, TODAY)).toBe(false);
    expect(isExpiringSoon({ expires_on: null }, TODAY)).toBe(false);
  });
});

describe('My Documents model', () => {
  it("holds the demo employee's 7 documents, 1 pending signature, 1 expiring", async () => {
    const model = buildDocumentsModel(await data.listDocuments(), DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.total).toBe(7);
    expect(model.pending_signature).toBe(1);
    expect(model.expiring_soon).toBe(1);
    expect(model.payslips).toBe(3);
    expect(model.by_type.reduce((sum, t) => sum + t.value, 0)).toBe(7);
    expect(model.rows.at(-1)!.title).toBe('Employment contract');
    expect(model.rows.find((r) => r.status === 'expiring')!.date_label).toMatch(/^Expires \d\d \w{3} \d{4}$/);
  });

  it("gives an HR viewer linked to employee 5 employee 5's documents only", async () => {
    const all = await data.listDocuments();
    const model = buildDocumentsModel(all, HR_5, TODAY);
    if (!model.linked) throw new Error('expected linked');
    const mine = all.filter((d) => d.employee_id === 'seed-emp-5');
    expect(model.total).toBe(mine.length);
    expect(model.total).toBeGreaterThan(0);
    expect(model.rows.every((r) => mine.some((d) => d.id === r.id))).toBe(true);
  });

  it('shows not linked for an unlinked account and handles no rows', () => {
    expect(buildDocumentsModel([doc({})], UNLINKED, TODAY)).toEqual({ linked: false });
    const empty = buildDocumentsModel([], DEMO, TODAY);
    if (!empty.linked) throw new Error('expected linked');
    expect(empty.total).toBe(0);
    expect(empty.by_type).toEqual([]);
    expect(empty.rows).toEqual([]);
  });

  it('puts undated documents last', () => {
    const model = buildDocumentsModel(
      [doc({ id: 'a', title: 'A', issued_on: null }), doc({ id: 'b', title: 'B', issued_on: '2026-02-01' })],
      DEMO,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    expect(model.rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(model.rows[1].date_label).toBe('—');
  });
});

describe('Records', () => {
  it("builds the demo employee's record from their own private row", async () => {
    const model = await loadRecordsModel(data, DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.sections.map((s) => s.key)).toEqual(['personal', 'employment', 'statutory', 'emergency', 'bank']);
    expect(model.sections[4].rows[1].value).toMatch(/^••••\d{4}$/);
    expect(model.employment).toBe('Full-time');
  });

  it('reads private details for the viewer only', async () => {
    const asked: string[] = [];
    const spy: PeopleData = {
      ...data,
      getEmployeePrivate: async (id) => {
        asked.push(id);
        return data.getEmployeePrivate(id);
      },
    };
    await loadRecordsModel(spy, DEMO, TODAY);
    expect(asked).toEqual([DEMO_EMPLOYEE_ID]);
    asked.length = 0;
    expect(await loadRecordsModel(spy, UNLINKED, TODAY)).toEqual({ linked: false });
    expect(asked).toEqual([]);
  });

  it('shows "Not recorded" for a viewer with no private row, never undefined or null', async () => {
    const none: PeopleData = { ...data, getEmployeePrivate: async () => null };
    const model = await loadRecordsModel(none, DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    const values = model.sections.flatMap((s) => s.rows.map((r) => r.value));
    expect(values).toContain('Not recorded');
    expect(values.join('|')).not.toMatch(/undefined|null/);
    expect(model.sections[0].rows.find((r) => r.label === 'NRIC')!.value).toBe('Not recorded');
  });

  it('copes with a missing directory row and no balances', async () => {
    const empty: PeopleData = { ...data, listEmployees: async () => [], listLeaveBalances: async () => [] };
    const model = await loadRecordsModel(empty, DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.tenure.value).toBe('—');
    expect(model.annual_leave_left).toBe('—');
    const shown = [model.tenure.value, model.annual_leave_left, model.department, model.employment]
      .concat(model.sections.flatMap((s) => s.rows.map((r) => r.value)))
      .join('|');
    expect(shown).not.toMatch(/NaN|undefined|null/);
  });
});

describe('Letters model', () => {
  it('counts the sample letters for the team', async () => {
    const model = buildLettersModel(await data.listLetters(), DEMO, TODAY);
    expect(model.team).toBe(true);
    expect(model.totals).toEqual({ issued_this_year: 2, drafts: 2, issued_this_month: 1 });
    expect(model.by_type!.map((t) => t.key).sort()).toEqual(['Confirmation', 'Promotion']);
    expect(model.rows).toHaveLength(5);
    expect(model.rows[0].date_label).toMatch(/\d{4}$/);
  });

  it('gives a plain member their rows and no team figures', async () => {
    const model = buildLettersModel(await data.listLetters(), MEMBER, TODAY);
    expect(model.team).toBe(false);
    expect(model.totals).toBeNull();
    expect(model.by_type).toBeNull();
    expect(model.rows.length).toBeGreaterThan(0);
  });

  it('builds from no rows', () => {
    const model = buildLettersModel([], HR_5, TODAY);
    expect(model.totals).toEqual({ issued_this_year: 0, drafts: 0, issued_this_month: 0 });
    expect(model.by_type).toEqual([]);
    expect(model.rows).toEqual([]);
  });
});

describe('Settings', () => {
  it('shows the stored values read-only', async () => {
    const model = await loadSettingsModel(data, HR_5);
    if (model.hr_only) throw new Error('expected settings');
    expect(model.working_days).toBe('Mon–Fri');
    expect(model.annual_leave_days).toBe('14');
    expect(model.medical_leave_days).toBe('14');
    expect(model.emergency_leave_days).toBe('3');
    expect(model.overtime.map((o) => o.value)).toEqual(['1.5x', '2x', '3x']);
    expect(model.notifications.map((n) => n.on)).toEqual([true, true, true, false]);
  });

  it('reads nothing for a plain member', async () => {
    let reads = 0;
    const spy: PeopleData = {
      ...data,
      getSettings: async () => {
        reads += 1;
        return data.getSettings();
      },
    };
    expect(await loadSettingsModel(spy, MEMBER)).toEqual({ hr_only: true });
    expect(reads).toBe(0);
  });

  it('treats empty notifications as off and labels the working week', () => {
    const model = buildSettingsModel(SETTINGS);
    if (model.hr_only) throw new Error('expected settings');
    expect(model.notifications.every((n) => !n.on)).toBe(true);
    expect(model.annual_leave_days).toBe('14.5');
    expect(model.medical_leave_days).toBe('14');
    expect(model.emergency_leave_days).toBe('3');
    expect(workWeekLabel(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).toBe('Mon–Sat');
    expect(workWeekLabel(['mon', 'wed'])).toBe('Mon, Wed');
    expect(workWeekLabel([])).toBe('—');
  });
});
