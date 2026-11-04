import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_SECRETS,
  GENERATED,
  formatEnv,
  missingHostedSettings,
  parseEnv,
  postgrestFiles,
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

describe('online Supabase (hosted mode)', () => {
  const full = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    DATABASE_URL: 'postgresql://postgres.abc:pw@pooler:5432/postgres',
  };

  it('generates only the app secrets, never Supabase keys', () => {
    const { values, created } = resolveSecrets({ mode: 'hosted' });
    expect(Object.keys(values)).toEqual([...APP_SECRETS]);
    expect(created).toEqual([...APP_SECRETS]);
    expect(values).not.toHaveProperty('SUPABASE_ANON_KEY');
    expect(values).not.toHaveProperty('POSTGRES_PASSWORD');
  });

  it('keeps hosted secrets on a second run', () => {
    const first = resolveSecrets({ mode: 'hosted' });
    const second = resolveSecrets({ mode: 'hosted', existing: first.values });
    expect(second.values).toEqual(first.values);
    expect(second.created).toEqual([]);
  });

  it('finds nothing missing when the project is filled in, under either name', () => {
    expect(missingHostedSettings(full)).toEqual([]);
    const runtimeNames = {
      SUPABASE_PUBLIC_URL: full.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_ANON_KEY: full.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: 'service',
      DATABASE_URL: full.DATABASE_URL,
    };
    expect(missingHostedSettings(runtimeNames)).toEqual([]);
  });

  it('names each missing setting, treating blanks as missing', () => {
    expect(missingHostedSettings({ ...full, DATABASE_URL: ' ', SUPABASE_SERVICE_ROLE_KEY: '' })).toEqual([
      'SUPABASE_SERVICE_ROLE_KEY',
      'DATABASE_URL',
    ]);
  });

  it('stops the CLI with a plain message, and writes nothing, when settings are missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'li-'));
    const file = path.join(dir, 'generated.env');
    const run = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/local-init.mjs')], {
      env: {
        PATH: process.env.PATH ?? '',
        OPENKUASA_SECRETS_FILE: file,
        OPENKUASA_INIT_MODE: 'hosted',
        NEXT_PUBLIC_SUPABASE_URL: full.NEXT_PUBLIC_SUPABASE_URL,
      } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(run.stderr).toMatch(/DATABASE_URL/);
    expect(run.stderr).not.toMatch(/abc\.supabase\.co/);
    expect(() => statSync(file)).toThrow();
  });
});

describe('postgrestFiles', () => {
  // PostgREST's amd64 image has no shell, so it reads these two straight from files.
  it('builds the database address with the password encoded, and passes the JWT secret as is', () => {
    const files = postgrestFiles({ POSTGRES_PASSWORD: 'p@ss/w:rd?#%', JWT_SECRET: 'a'.repeat(40) });
    expect(files['postgrest-db-uri']).toBe(
      `postgres://authenticator:${encodeURIComponent('p@ss/w:rd?#%')}@db:5432/postgres`,
    );
    expect(new URL(files['postgrest-db-uri']).password).toBe(encodeURIComponent('p@ss/w:rd?#%'));
    expect(files['postgrest-jwt-secret']).toBe('a'.repeat(40));
  });
});

describe('local-init CLI', () => {
  it('writes the settings file readable by its group (other stack users) but not by everyone', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'li-'));
    const file = path.join(dir, 'generated.env');
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/local-init.mjs')], {
      env: { PATH: process.env.PATH ?? '', OPENKUASA_SECRETS_FILE: file } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(Object.keys(parseEnv(readFileSync(file, 'utf8')))).toEqual(expect.arrayContaining([...GENERATED]));
  });

  it('writes the two PostgREST files from the final settings, readable by the stack only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'li-'));
    const file = path.join(dir, 'generated.env');
    const run = () =>
      execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/local-init.mjs')], {
        env: { PATH: process.env.PATH ?? '', OPENKUASA_SECRETS_FILE: file, POSTGRES_PASSWORD: 'typed@pw' } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
      });
    run();
    const values = parseEnv(readFileSync(file, 'utf8'));
    const uri = readFileSync(path.join(dir, 'postgrest-db-uri'), 'utf8');
    const jwt = readFileSync(path.join(dir, 'postgrest-jwt-secret'), 'utf8');
    expect(uri).toBe('postgres://authenticator:typed%40pw@db:5432/postgres');
    expect(jwt).toBe(values.JWT_SECRET);
    for (const name of ['postgrest-db-uri', 'postgrest-jwt-secret']) {
      expect(statSync(path.join(dir, name)).mode & 0o777).toBe(0o640);
    }
    run();
    expect(readFileSync(path.join(dir, 'postgrest-jwt-secret'), 'utf8')).toBe(jwt);
  });

  it('writes no PostgREST files for an online Supabase', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'li-'));
    const file = path.join(dir, 'generated.env');
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/local-init.mjs')], {
      env: {
        PATH: process.env.PATH ?? '',
        OPENKUASA_SECRETS_FILE: file,
        OPENKUASA_INIT_MODE: 'hosted',
        NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
        SUPABASE_SERVICE_ROLE_KEY: 'service',
        DATABASE_URL: 'postgres://u:p@h:5432/postgres',
      } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    expect(() => statSync(path.join(dir, 'postgrest-db-uri'))).toThrow();
    expect(() => statSync(path.join(dir, 'postgrest-jwt-secret'))).toThrow();
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

  it.skipIf(process.getuid?.() === 0)('warns when the settings file exists but cannot be read', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-'));
    const file = path.join(dir, 'generated.env');
    writeFileSync(file, 'A=secretvalue\n', { mode: 0o000 });
    const res = spawnSync('sh', [script, 'sh', '-c', 'printf "ran:%s" "${A:-unset}"'], {
      env: { PATH: process.env.PATH ?? '', OPENKUASA_SECRETS_FILE: file } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    expect(res.stderr).toContain(file);
    expect(res.stderr).not.toContain('secretvalue');
    expect(res.stdout).toBe('ran:unset');
  });

  it('stays silent when the settings file does not exist', () => {
    const res = spawnSync('sh', [script, 'true'], {
      env: { PATH: process.env.PATH ?? '', OPENKUASA_SECRETS_FILE: '/nonexistent/x.env' } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });
});
