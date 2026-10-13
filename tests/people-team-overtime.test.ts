import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => true }));

import { parseTeamOvertime, readTeamOvertime } from '@/lib/people/supabase';

const ROW = {
  id: 'o1',
  org_id: 'org1',
  employee_id: 'e1',
  work_date: '2026-10-05',
  hours: 2.5,
  day_kind: 'weekday',
  rate_multiplier: 1.5,
  reason: 'Month-end close',
  status: 'pending',
  requested_by: 'u1',
  decided_by: null,
  decided_at: null,
  decision_note: null,
  created_at: '2026-10-06T01:00:00+00:00',
};

const PAY_KEYS = ['hourly_rate_cents', 'amount_cents', 'payslip_id', 'paid_month'];

describe('parseTeamOvertime', () => {
  it('keeps the fourteen columns the function returns, as numbers where they are numbers', () => {
    const [row] = parseTeamOvertime([{ ...ROW, hours: '2.5', rate_multiplier: '1.5' }]);
    expect(row).toEqual(ROW);
  });

  it('has no pay field, even if one is sent', () => {
    const [row] = parseTeamOvertime([{ ...ROW, hourly_rate_cents: 2000, amount_cents: 6000, payslip_id: 'p1' }]);
    for (const key of PAY_KEYS) expect(row, key).not.toHaveProperty(key);
    expect(JSON.stringify(row)).not.toContain('6000');
    expect(JSON.stringify(row)).not.toContain('2000');
  });

  it('allows a day kind and a multiplier that are null on an old row', () => {
    const [row] = parseTeamOvertime([{ ...ROW, day_kind: null, rate_multiplier: null }]);
    expect(row.day_kind).toBeNull();
    expect(row.rate_multiplier).toBeNull();
  });

  it('drops what is not a row, and a row with an unknown status or no id', () => {
    expect(parseTeamOvertime(null)).toEqual([]);
    expect(parseTeamOvertime('x')).toEqual([]);
    expect(parseTeamOvertime([null, 5, {}, { ...ROW, id: 7 }, { ...ROW, status: 'weird' }, ROW])).toEqual([ROW]);
  });
});

describe('readTeamOvertime', () => {
  it('calls the function once with the workspace and returns the parsed rows', async () => {
    const rpc = vi.fn(async () => ({ data: [ROW], error: null }));
    expect(await readTeamOvertime({ rpc } as never, 'org1')).toEqual([ROW]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('hr_team_overtime', { p_org: 'org1' });
  });

  it('throws on an error, like every other provider read, naming no id', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '42883', message: 'secret org1' } }));
    const failure = await readTeamOvertime({ rpc } as never, 'org1').catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('42883');
    expect((failure as Error).message).not.toContain('org1');
  });
});
