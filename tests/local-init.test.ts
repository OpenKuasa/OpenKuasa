import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GENERATED,
  formatEnv,
  parseEnv,
  resolveSecrets,
  verifyJwt,
} from '../scripts/local-init.mjs';

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

describe('resolveSecrets', () => {
  it('generates every blank setting on a first run', () => {
    const { values, created } = resolveSecrets({ existing: {}, provided: {} });
    for (const name of GENERATED) expect(values[name]).toBeTruthy();
    expect(created).toEqual([...GENERATED]);
    expect(values.SUPABASE_ANON_KEY).toBe(values.ANON_KEY);
    expect(values.SUPABASE_SERVICE_ROLE_KEY).toBe(values.SERVICE_ROLE_KEY);
  });

  it('changes nothing on a second run', () => {
    const first = resolveSecrets({ existing: {}, provided: {} });
    const second = resolveSecrets({ existing: first.values, provided: {} });
    expect(second.values).toEqual(first.values);
    expect(second.created).toEqual([]);
  });

  it('keeps what the user typed', () => {
    const { values } = resolveSecrets({ existing: {}, provided: { AUTH_COOKIE_SECRET: 'mine' } });
    expect(values.AUTH_COOKIE_SECRET).toBe('mine');
    const again = resolveSecrets({ existing: values, provided: { AUTH_COOKIE_SECRET: 'other' } });
    expect(again.values.AUTH_COOKIE_SECRET).toBe('other');
  });

  it('treats a blank typed value as not typed', () => {
    const first = resolveSecrets({ existing: {}, provided: {} });
    const second = resolveSecrets({ existing: first.values, provided: { CRON_SECRET: '  ' } });
    expect(second.values.CRON_SECRET).toBe(first.values.CRON_SECRET);
  });

  it('re-signs the keys when the user brings their own JWT secret', () => {
    const first = resolveSecrets({ existing: {}, provided: {} });
    const mine = 's'.repeat(40);
    const { values, created } = resolveSecrets({ existing: first.values, provided: { JWT_SECRET: mine } });
    expect(values.JWT_SECRET).toBe(mine);
    for (const name of ['ANON_KEY', 'SERVICE_ROLE_KEY']) {
      expect(verifyJwt(values[name], mine)).toBe(true);
      expect(verifyJwt(values[name], first.values.JWT_SECRET)).toBe(false);
    }
    expect(created).toEqual(expect.arrayContaining(['ANON_KEY', 'SERVICE_ROLE_KEY']));
    expect(values.SUPABASE_ANON_KEY).toBe(values.ANON_KEY);
  });

  it('keeps a typed key that verifies and re-signs one that does not', () => {
    const first = resolveSecrets({ existing: {}, provided: {} });
    const ok = resolveSecrets({ existing: {}, provided: { JWT_SECRET: first.values.JWT_SECRET, ANON_KEY: first.values.ANON_KEY } });
    expect(ok.values.ANON_KEY).toBe(first.values.ANON_KEY);
    const bad = resolveSecrets({ existing: {}, provided: { ANON_KEY: 'not.a.jwt' } });
    expect(verifyJwt(bad.values.ANON_KEY, bad.values.JWT_SECRET)).toBe(true);
  });

  it('signs keys Supabase accepts', () => {
    const { values } = resolveSecrets({ existing: {}, provided: {} });
    const anon = decode(values.ANON_KEY);
    expect(anon.role).toBe('anon');
    expect(anon.iss).toBe('supabase');
    expect(anon.exp - anon.iat).toBeGreaterThanOrEqual(9 * 365 * 24 * 3600);
    expect(decode(values.SERVICE_ROLE_KEY).role).toBe('service_role');
    expect(verifyJwt(values.ANON_KEY, values.JWT_SECRET)).toBe(true);
    expect(verifyJwt(values.ANON_KEY + 'x', values.JWT_SECRET)).toBe(false);
  });
});

describe('env file', () => {
  it('round-trips the env file', () => {
    const v = { A: 'x=y==', B: 'a/b+c.d', C: 'plain' };
    expect(parseEnv(formatEnv(v))).toEqual(v);
  });
});

describe('with-secrets.sh', () => {
  const script = path.resolve(__dirname, '../docker/with-secrets.sh');
  it('exports only unset or empty names, keeps awkward values intact', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-'));
    const file = path.join(dir, 'generated.env');
    writeFileSync(file, 'A=one=two/+.\nB=file\nC=file\nD=$(echo pwned)\n');
    const out = execFileSync(
      'sh',
      [script, 'sh', '-c', 'printf "%s|%s|%s|%s" "$A" "$B" "$C" "$D"'],
      { env: { PATH: process.env.PATH ?? '', OPENKUASA_SECRETS_FILE: file, B: 'typed', C: '' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' },
    );
    expect(out).toBe('one=two/+.|typed|file|$(echo pwned)');
  });
});
