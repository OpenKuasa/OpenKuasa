import { describe, expect, it } from 'vitest';
import { proposalNames } from '@/lib/agents/proposal-names';
import type { AgentProposal } from '@/lib/agents/types';
import { changeRows } from '@/lib/chat/change-rows';

const LEAD = '11111111-1111-4111-8111-111111111111';
const APPT = '22222222-2222-4222-8222-222222222222';

const proposal = (action: string, input: unknown): AgentProposal => ({
  id: `p-${action}`,
  org_id: 'org1',
  run_id: null,
  agent_key: 'weekly_studio',
  product: 'reach',
  action,
  input,
  title: 't',
  detail: null,
  rationale: null,
  check_key: null,
  status: 'pending',
  result: null,
  created_at: '',
  decided_at: null,
  decided_by: null,
  expires_at: '',
});

/** A client that answers each table with its rows, and records what was asked. */
function fakeClient(tables: Record<string, Record<string, unknown>[]>) {
  const asked: { table: string; ids: string[]; org: unknown }[] = [];
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, org: unknown) => ({
          in: async (_c: string, ids: string[]) => {
            asked.push({ table, ids, org });
            return { data: (tables[table] ?? []).filter((r) => ids.includes(r.id as string)), error: null };
          },
        }),
      }),
    }),
  };
  return { client: client as never, asked };
}

describe('names for pending agent suggestions', () => {
  it('reads only the rows the suggestions point at, and names them the way a chat card does', async () => {
    const { client, asked } = fakeClient({
      leads: [{ id: LEAD, name: 'Siti Nur' }],
      appointments: [{ id: APPT, contact_name: 'Aina', kind: 'Follow-up call', scheduled_at: '2026-10-28T01:00:00.000Z' }],
    });
    const proposals = [
      proposal('promoteLeadToContact', { id: LEAD }),
      proposal('setLeadStage', { id: LEAD, stage: 'booked' }),
      proposal('setAppointmentStatus', { id: APPT, status: 'completed' }),
      proposal('createForm', { name: 'Raya promo' }),
    ];
    const names = await proposalNames(client, 'org1', proposals);
    expect(asked).toEqual([
      { table: 'leads', ids: [LEAD], org: 'org1' },
      { table: 'appointments', ids: [APPT], org: 'org1' },
    ]);
    const find = (id: unknown, kind?: string) => (kind && typeof id === 'string' ? (names[`${kind}:${id}`] ?? null) : null);
    expect(changeRows('promoteLeadToContact', { id: LEAD }, find)[0]).toMatchObject({ label: 'Lead', to: 'Siti Nur' });
    expect(changeRows('setAppointmentStatus', { id: APPT, status: 'completed' }, find)[0]).toMatchObject({
      label: 'Appointment',
      to: 'Aina, Follow-up call, Wed 28 Oct 9:00 am',
    });
  });

  it('reads nothing when no suggestion points at a row, and a row it cannot read stays unnamed', async () => {
    const { client, asked } = fakeClient({});
    expect(await proposalNames(client, 'org1', [proposal('createForm', { name: 'x' })])).toEqual({});
    expect(asked).toEqual([]);
    expect(await proposalNames(client, 'org1', [proposal('setLeadStage', { id: LEAD, stage: 'booked' })])).toEqual({});
  });
});
