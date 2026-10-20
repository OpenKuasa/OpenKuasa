import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLOSING_RATE_RULE,
  boxRateText,
  ratesFromPreview,
  FX_REVALUATION_MESSAGES as M,
  closingRatesInput,
  expectedOf,
  fxRevaluationRefusal,
  isMonthEnd,
  netGain,
  perOneRateText,
  postFxRevaluation,
  postFxRevaluationInput,
  previewFxRevaluation,
  previewFxRevaluationInput,
} from '@/lib/finance/fx-revaluation';
import { revaluationLine, revaluedSen } from '@/lib/finance/fx-settlement';
import { NOT_ALLOWED, WRITE_FAILED, type FinanceWriteContext } from '@/lib/finance/result';

// Month-end FX revaluation, stage 6a (migration 20261123100000). Node only, no database: the migration is read as
// text, the data layer is driven through a fake client, and the bigint twin of the arithmetic is held to the plan's
// worked examples (.superpowers/sdd/2026-10-20-bendahara-fx-revaluation.md, R1-R7), the same figures
// supabase/tests/bendahara_fx_revaluation_check.sql asserts against the database, to the sen.

const MIGRATION = 'supabase/migrations/20261123100000_bendahara_fx_revaluation.sql';
const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8');
/** The migration without its comments, so a word in a comment never passes or fails a test. */
const body = sql
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

const DIGEST = '0123456789abcdef0123456789abcdef';
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sen = (n: number) => BigInt(Math.round(n * 100));
const rate = (text: string) => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(`${whole}${fraction.padEnd(10, '0')}`);
};

describe('the migration', () => {
  it('replaces exactly the three functions and the view it names', () => {
    const replaced = [...body.matchAll(/create or replace (view|function) ([a-z_.]+)/gi)].map((m) => m[2]).sort();
    expect(replaced).toEqual([
      'private.finance_ledger_seed',
      'public.finance_ledger_lines',
      'public.finance_next_number',
    ]);
  });

  it('drops nothing but the three constraints it restates', () => {
    expect([...body.matchAll(/\bdrop\s+(constraint|table|view|function|trigger|policy|column|index|default)\s+([a-z_.]+)/gi)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual([
      'constraint finance_ledger_accounts_stands_for_check',
      'constraint finance_ledger_accounts_system_key_check',
      'constraint finance_sequences_doc_type_check',
    ]);
  });

  it('seeds fx_unrealised at 4910, an income account, for every workspace', () => {
    expect(body).toMatch(/\('fx_unrealised', 4910, 'Unrealised Exchange Gain or Loss', 'income'\)/);
    expect(body).toMatch(/when system_key in \('fx_realised','fx_unrealised'\) then type = 'income'/);
    expect(body).toMatch(/select private\.finance_ledger_seed\(id\) from public\.orgs;/);
  });

  it('numbers a run FX- and keeps finance_next_number the owner’s, writer first', () => {
    const fn = body.slice(body.indexOf('create or replace function public.finance_next_number'));
    expect(fn.slice(0, fn.indexOf('end $$;'))).toMatch(/security definer\s+set search_path = ''/);
    expect(fn).toMatch(/if not private\.is_org_writer\(target_org\) then/);
    expect(fn).toMatch(/when 'fx_revaluation' then 'FX-'/);
    expect(body).toMatch(/'journal','contra',\s+'fx_revaluation'\)\)/);
  });

  it('reads the closing rate through the selling rule, never the middle rate column', () => {
    const fn = body.slice(body.indexOf('create function private.finance_fx_closing_rate('));
    expect(fn.slice(0, fn.indexOf('$$;'))).toMatch(/private\.finance_sst_fx_rate\(target_currency, period_end\)/);
    expect(body).not.toMatch(/finance_fx_rates\b/);
    expect(CLOSING_RATE_RULE).toEqual({ source: 'bnm', session: '1700', figure: 'selling', date: 'period_end' });
  });

  it('refuses NaN by name on every new amount and rate column, and defaults no rate or figure', () => {
    for (const column of ['rate', 'foreign_balance', 'carried_myr', 'revalued_myr', 'difference', 'earlier_myr', 'posted_myr']) {
      expect(body, column).toMatch(new RegExp(`\\b${column} numeric\\([0-9,]+\\)[^\\n]*${column} <> 'NaN'`));
      expect(body, column).not.toMatch(new RegExp(`\\b${column} numeric\\([0-9,]+\\)[^\\n]*\\bdefault\\b`));
    }
  });

  it('hands service_role nothing, and the signed-in only select on the new tables', () => {
    for (const table of ['finance_fx_revaluations', 'finance_fx_revaluation_rates', 'finance_fx_revaluation_lines']) {
      expect(body, table).toMatch(new RegExp(`revoke all on public\\.${table} from public, anon, authenticated, service_role;`));
      expect(body, table).toMatch(new RegExp(`grant select on public\\.${table} to authenticated;`));
      expect(body, table).toMatch(new RegExp(`create trigger finance_fx_revaluation_locked before update or delete on public\\.${table}\\b`));
    }
    expect(body).not.toMatch(/grant [^;]* to [^;]*service_role/i);
  });

  it('makes the reversal inside the branch, keyed :reverse, dated the next day', () => {
    expect(body).toMatch(/case when rv\.rev then ':reverse' else '' end/);
    expect(body).toMatch(/r\.period_end \+ case when rv\.rev then 1 else 0 end/);
    expect(body).toMatch(/cross join lateral \(values \(false\), \(true\)\) as rv\(rev\)/);
  });
});

describe('the bigint twin of the arithmetic (worked examples)', () => {
  const at448 = rate('4.48');
  it('R1: invoice A, USD 600.00 open carrying RM 2,520.00, revalues to 2,688.00: a gain of 168.00', () => {
    expect(revaluationLine('invoice', sen(600), sen(2520), sen(0), at448)).toEqual({
      revalued: sen(2688), difference: sen(168), posted: sen(168), gain: sen(168),
    });
  });
  it('R2: bill B, USD 1,080.00 carrying 4,536.00, revalues to 4,838.40: owing more is a loss of 302.40', () => {
    expect(revaluationLine('bill', sen(1080), sen(4536), sen(0), at448)).toEqual({
      revalued: sen(4838.4), difference: sen(302.4), posted: sen(302.4), gain: sen(-302.4),
    });
  });
  it('R3: the USD account, USD 9,000.00 with a book value of 40,240.00, revalues to 40,320.00', () => {
    expect(revaluationLine('account', sen(9000), sen(40240), sen(0), at448)).toEqual({
      revalued: sen(40320), difference: sen(80), posted: sen(80), gain: sen(80),
    });
  });
  it('R4: a fully converted SGD account needs no rate: its -30.00 book value revalues to 0, a gain of 30.00', () => {
    expect(revaluationLine('account', sen(0), sen(-30), sen(0), null)).toEqual({
      revalued: sen(0), difference: sen(30), posted: sen(30), gain: sen(30),
    });
  });
  it('R5: a customer in credit by USD 100.00 (RM -420.00) revalues with its sign to -448.00', () => {
    expect(revaluationLine('invoice', sen(-100), sen(-420), sen(0), at448)).toEqual({
      revalued: sen(-448), difference: sen(-28), posted: sen(-28), gain: sen(-28),
    });
  });
  it('run 1: five lines, a net loss of 52.40', () => {
    const gains = [
      revaluationLine('invoice', sen(600), sen(2520), sen(0), at448)!,
      revaluationLine('bill', sen(1080), sen(4536), sen(0), at448)!,
      revaluationLine('account', sen(9000), sen(40240), sen(0), at448)!,
      revaluationLine('account', sen(0), sen(-30), sen(0), null)!,
      revaluationLine('invoice', sen(-100), sen(-420), sen(0), at448)!,
    ].map((l) => ({ gain: Number(l.gain) / 100, digest: DIGEST }));
    expect(expectedOf(gains)).toEqual({ lines: 5, net_gain: '-52.40', digest: DIGEST });
    expect(netGain(gains)).toBe(-52.4);
  });
  it('R6: a second run posts only the change: A posts 0, bill D (SGD 500.00 at 3.45) posts 25.00', () => {
    expect(revaluationLine('invoice', sen(600), sen(2520), sen(168), at448)!.posted).toBe(sen(0));
    expect(revaluationLine('bill', sen(500), sen(1700), sen(0), rate('3.45'))).toEqual({
      revalued: sen(1725), difference: sen(25), posted: sen(25), gain: sen(-25),
    });
  });
  it('R6b: a run at a wrong 4.5000 posted 180.00; the run at 4.4800 posts -12.00', () => {
    expect(revaluationLine('invoice', sen(600), sen(2520), sen(0), rate('4.5'))!.posted).toBe(sen(180));
    expect(revaluationLine('invoice', sen(600), sen(2520), sen(180), at448)!.posted).toBe(sen(-12));
  });
  it('R7: JPY 123,457 carrying 3,580.25 revalues at 0.0295 to 3,641.98 (3,641.9815), 61.73 more', () => {
    expect(revaluationLine('invoice', sen(123457), sen(3580.25), sen(0), rate('0.0295'))).toEqual({
      revalued: sen(3641.98), difference: sen(61.73), posted: sen(61.73), gain: sen(61.73),
    });
  });
  it('R8: at the middle 4.4750 an invoice booked at the selling 4.4800 would show a loss that never happened', () => {
    expect(revaluationLine('invoice', sen(1000), sen(4480), sen(0), at448)!.difference).toBe(sen(0));
    expect(revaluationLine('invoice', sen(1000), sen(4480), sen(0), rate('4.475'))!.difference).toBe(sen(-5));
  });
  it('revalues a negative balance with its sign: USD -100.00 at 4.48 is RM -448.00', () => {
    expect(revaluedSen(BigInt(-10000), BigInt(44800000000))).toBe(BigInt(-44800));
  });
  it('rounds a half sen away from zero either way, as Postgres rounds a numeric', () => {
    // USD 0.01 at 4.5 is RM 0.045.
    expect(revaluedSen(BigInt(1), rate('4.5'))).toBe(BigInt(5));
    expect(revaluedSen(BigInt(-1), rate('4.5'))).toBe(BigInt(-5));
    // USD 0.01 at 4.48 is RM 0.0448.
    expect(revaluedSen(BigInt(-1), rate('4.48'))).toBe(BigInt(-4));
  });
  it('has no figure for a foreign balance with no rate', () => {
    expect(revaluationLine('invoice', sen(600), sen(2520), sen(0), null)).toBeNull();
    expect(expectedOf([{ gain: 1, digest: DIGEST }, { gain: null, digest: DIGEST }])).toBeNull();
    // Nothing to post has no digest to send.
    expect(expectedOf([])).toBeNull();
    expect(netGain([{ gain: null }])).toBeNull();
  });
});

describe('the inputs', () => {
  it('knows a month end', () => {
    expect(isMonthEnd('2026-10-31')).toBe(true);
    expect(isMonthEnd('2024-02-29')).toBe(true);
    expect(isMonthEnd('2026-10-30')).toBe(false);
    expect(isMonthEnd('2026-02-29')).toBe(false);
    expect(isMonthEnd('31/10/2026')).toBe(false);
  });
  it('refuses a day that is not a month end, in the screen’s words', () => {
    const r = previewFxRevaluationInput.safeParse({ period_end: '2026-10-30' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(M.monthEnd);
    expect(previewFxRevaluationInput.parse({ period_end: '2026-10-31' })).toEqual({ period_end: '2026-10-31', rates: {} });
  });
  it('sends a rate typed per 100 (JPY) per one unit, ten decimals; a rate per one as it is', () => {
    expect(
      previewFxRevaluationInput.parse({
        period_end: '2026-10-31',
        rates: {
          JPY: { rate: '2.95', source: 'manual' },
          USD: { rate: '4.48', source: 'bnm', rate_date: '2026-10-30' },
        },
      }).rates,
    ).toEqual({
      JPY: { rate: '0.0295000000', source: 'manual' },
      USD: { rate: '4.4800000000', source: 'bnm', rate_date: '2026-10-30' },
    });
  });
  it('rounds past ten places once, half up, in whole numbers', () => {
    expect(perOneRateText('4.48000000005', 'USD')).toBe('4.4800000001');
    expect(perOneRateText('2.950000000049', 'JPY')).toBe('0.0295000000');
    expect(perOneRateText('0', 'USD')).toBeUndefined();
    expect(perOneRateText('0.00000000004', 'USD')).toBeUndefined();
    expect(perOneRateText('10000000000', 'USD')).toBeUndefined();
    expect(perOneRateText('4.48e0', 'USD')).toBeUndefined();
    expect(perOneRateText('-4.48', 'USD')).toBeUndefined();
    expect(perOneRateText('NaN', 'USD')).toBeUndefined();
  });
  it('refuses a rate that is not a number, ringgit, a BNM rate with no date and a typed one with a date', () => {
    for (const rates of [
      { USD: { rate: 'abc', source: 'manual' } },
      { MYR: { rate: '1', source: 'manual' } },
      { usd: { rate: '4.48', source: 'manual' } },
      { USD: { rate: '4.48', source: 'bnm' } },
      { USD: { rate: '4.48', source: 'manual', rate_date: '2026-10-30' } },
      { USD: { rate: '4.48', source: 'reuters' } },
    ]) {
      expect(closingRatesInput.safeParse(rates).success, JSON.stringify(rates)).toBe(false);
    }
  });
  it('asks a post for what the preview showed: its digest, at least one line and a net gain to the sen', () => {
    const base = { period_end: '2026-10-31', rates: {} };
    expect(postFxRevaluationInput.safeParse({ ...base, expected: { lines: 5, net_gain: '-52.40', digest: DIGEST } }).success).toBe(true);
    for (const expected of [
      undefined,
      { lines: 5, net_gain: '-52.40' },
      { lines: 5, net_gain: '-52.40', digest: 'not an md5' },
      { lines: 0, net_gain: '0', digest: DIGEST },
      { lines: 5, net_gain: '-52.400', digest: DIGEST },
      { lines: 5.5, net_gain: '1', digest: DIGEST },
      { lines: 5, net_gain: 'NaN', digest: DIGEST },
    ]) {
      const r = postFxRevaluationInput.safeParse({ ...base, expected });
      expect(r.success, JSON.stringify(expected)).toBe(false);
    }
  });
});

describe('a preview\'s rates go back in the box\'s unit', () => {
  it('writes a rate per one unit in the box: per 100 for JPY, as it is for USD, exactly', () => {
    expect(boxRateText('0.0295000000', 'JPY')).toBe('2.95');
    expect(boxRateText('0.0295000001', 'JPY')).toBe('2.95000001');
    expect(boxRateText('4.4800000000', 'USD')).toBe('4.48');
    expect(boxRateText('3', 'SGD')).toBe('3');
    expect(boxRateText('abc', 'USD')).toBeUndefined();
  });
  it('sends a previewed JPY rate back unchanged: the same rate per one unit reaches the database', () => {
    const items = [
      { currency: 'JPY', rate_text: '0.0295000000', rate_source: 'bnm' as const, rate_date: '2026-10-30' },
      { currency: 'JPY', rate_text: '0.0295000000', rate_source: 'bnm' as const, rate_date: '2026-10-30' },
      { currency: 'USD', rate_text: '4.5000000000', rate_source: 'manual' as const, rate_date: null },
      { currency: 'SGD', rate_text: null, rate_source: null, rate_date: null },
    ];
    expect(ratesFromPreview(items)).toEqual({
      JPY: { rate: '2.95', source: 'bnm', rate_date: '2026-10-30' },
      USD: { rate: '4.5', source: 'manual' },
    });
    expect(closingRatesInput.parse(ratesFromPreview(items))).toEqual({
      JPY: { rate: '0.0295000000', source: 'bnm', rate_date: '2026-10-30' },
      USD: { rate: '4.5000000000', source: 'manual' },
    });
    // The trap it closes: rate_text itself in the box would be read per 100.
    expect(closingRatesInput.parse({ JPY: { rate: '0.0295000000', source: 'manual' } }).JPY.rate).toBe('0.0002950000');
  });
});

describe('the data layer answers the database in words', () => {
  function fake(answer: { data?: unknown; error?: { code: string; message: string } | null }, newest?: unknown[]) {
    const calls: { fn: string; args: unknown }[] = [];
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: newest ?? [], error: null }),
    };
    const client = {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return { data: answer.data ?? null, error: answer.error ?? null };
      },
      from: () => chain,
    };
    return { ctx: { client, orgId: UUID(9) } as unknown as FinanceWriteContext, calls };
  }
  const post = postFxRevaluationInput.parse({
    period_end: '2026-10-31',
    rates: { USD: { rate: '4.48', source: 'bnm', rate_date: '2026-10-30' }, JPY: { rate: '2.95', source: 'manual' } },
    expected: { lines: 5, net_gain: '-52.40', digest: DIGEST },
  });

  it('sends the month end, the rates per one unit and the expected figures, and answers the run', async () => {
    const { ctx, calls } = fake({ data: [{ id: UUID(1), revaluation_no: 'FX-0001' }] });
    expect(await postFxRevaluation(ctx, post)).toEqual({ ok: true, data: { id: UUID(1), revaluation_no: 'FX-0001' } });
    expect(calls).toEqual([
      {
        fn: 'finance_post_fx_revaluation',
        args: {
          target_org: UUID(9),
          run: {
            period_end: '2026-10-31',
            rates: {
              USD: { rate: '4.4800000000', source: 'bnm', rate_date: '2026-10-30' },
              JPY: { rate: '0.0295000000', source: 'manual' },
            },
            expected: { lines: 5, net_gain: '-52.40', digest: DIGEST },
          },
        },
      },
    ]);
  });

  it.each([
    ['FIN53', M.monthEnd],
    ['FIN55', M.changed],
    ['FIN39', M.notBnmRate],
    ['FIN14', M.needsSignOff],
    ['FIN01', M.locked],
    ['42501', NOT_ALLOWED],
  ])('post: %s is "%s"', async (pg, sentence) => {
    const { ctx } = fake({ error: { code: pg, message: 'x' } });
    expect(await postFxRevaluation(ctx, post)).toEqual({ ok: false, error: sentence });
  });

  it('post: FIN38 names the currencies the database named', async () => {
    const { ctx } = fake({ error: { code: 'FIN38', message: 'enter the closing rate for SGD, USD' } });
    expect(await postFxRevaluation(ctx, post)).toEqual({ ok: false, error: 'Enter the closing rate for SGD, USD before posting.' });
    const other = fake({ error: { code: 'FIN38', message: 'a closing rate is for a currency other than ringgit' } });
    expect(await postFxRevaluation(other.ctx, post)).toEqual({ ok: false, error: M.rate(null) });
  });

  it('post: FIN56 says the month end', async () => {
    const { ctx } = fake({ error: { code: 'FIN56', message: 'x' } });
    expect(await postFxRevaluation(ctx, post)).toEqual({
      ok: false,
      error: 'Nothing to post: every foreign-currency balance at 31 Oct 2026 is already at these rates.',
    });
  });

  it('post: FIN54 reads the newest run again for its number and month end', async () => {
    const { ctx } = fake({ error: { code: 'FIN54', message: 'x' } }, [{ revaluation_no: 'FX-0007', period_end: '2026-11-30' }]);
    expect(await postFxRevaluation(ctx, post)).toEqual({
      ok: false,
      error: 'FX-0007 for 30 Nov 2026 is already posted. Month ends are revalued in order, so an earlier one cannot be revalued now.',
    });
    const none = fake({ error: { code: 'FIN54', message: 'x' } }, []);
    expect(await postFxRevaluation(none.ctx, post)).toEqual({ ok: false, error: M.laterRunUnknown });
  });

  it('post: anything else is the general sentence', async () => {
    const { ctx } = fake({ error: { code: 'XX000', message: 'x' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await postFxRevaluation(ctx, post)).toEqual({ ok: false, error: WRITE_FAILED });
    spy.mockRestore();
  });

  it('preview: sends the rates, reads each row, and words a refusal for the action', async () => {
    const row = {
      kind: 'invoice', item_id: UUID(2), reference: 'INV-0001', party: 'Overseas Ltd', currency: 'USD',
      foreign_balance: 600, carried_myr: 2520, earlier_myr: 0, rate_text: '4.4800000000', rate_source: 'bnm',
      rate_date: '2026-10-30', bnm_rate_text: '4.4800000000', bnm_rate_date: '2026-10-30',
      revalued_myr: 2688, difference: 168, posted_myr: 168, gain: 168, digest: DIGEST,
    };
    const { ctx, calls } = fake({ data: [row] });
    const input = previewFxRevaluationInput.parse({ period_end: '2026-10-31' });
    expect(await previewFxRevaluation(ctx, input)).toEqual([row]);
    expect(calls).toEqual([{ fn: 'finance_fx_revaluation_preview', args: { target_org: UUID(9), period_end: '2026-10-31', rates: {} } }]);
    const refused = fake({ error: { code: 'FIN39', message: 'x' } });
    await expect(previewFxRevaluation(refused.ctx, input)).rejects.toMatchObject({ code: 'FIN39' });
    expect(fxRevaluationRefusal({ code: 'FIN39' })).toBe(M.notBnmRate);
    expect(fxRevaluationRefusal({ code: 'FIN53' })).toBe(M.monthEnd);
    expect(fxRevaluationRefusal({ code: 'XX000' })).toBeNull();
  });
});

