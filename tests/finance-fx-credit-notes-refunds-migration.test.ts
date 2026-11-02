import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/20261120120000_bendahara_fx_credit_notes_refunds.sql'),
  'utf8',
);

describe('the foreign credit-note and refund migration', () => {
  it('revokes the refund function from the service role before checking its privileges', () => {
    expect(migration).toContain(
      'revoke all on function public.finance_record_refund(uuid, jsonb) from public, anon, service_role;',
    );
  });
});
