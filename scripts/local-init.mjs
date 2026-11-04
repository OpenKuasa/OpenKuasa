#!/usr/bin/env node
/**
 * First-run secret generation for the local Docker install.
 *
 *   node scripts/local-init.mjs
 *
 * Runs once in the `init` container. Every name in GENERATED that the user left
 * blank in `.env` gets a fresh value, written to /secrets/generated.env (mode
 * 0640, on a volume every other container mounts). A second run changes nothing:
 * a value already in the file is kept, so sessions and the database password
 * stay valid. A value the user typed always wins over the file.
 *
 * ANON_KEY and SERVICE_ROLE_KEY are HS256 JWTs signed with JWT_SECRET, as
 * self-hosted Supabase expects. A key that does not verify against the final
 * JWT_SECRET (the user brought their own secret) is signed again.
 *
 * docker/with-secrets.sh loads the file into the other containers. Values are
 * never printed.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERATED = [
  'POSTGRES_PASSWORD',
  'JWT_SECRET',
  'ANON_KEY',
  'SERVICE_ROLE_KEY',
  'AUTH_COOKIE_SECRET',
  'AI_KEYS_ENCRYPTION_SECRET',
  'RATE_LIMIT_PEPPER',
  'CRON_SECRET',
];

/** With an online Supabase, the only secrets to generate are the app's own. */
export const APP_SECRETS = ['AUTH_COOKIE_SECRET', 'AI_KEYS_ENCRYPTION_SECRET', 'RATE_LIMIT_PEPPER', 'CRON_SECRET'];

/**
 * What an online-Supabase setup must have, each as the name `.env.example`
 * uses plus any other name the app also accepts for it.
 */
const HOSTED_REQUIRED = [
  ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_PUBLIC_URL'],
  ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'],
  ['SUPABASE_SERVICE_ROLE_KEY'],
  ['DATABASE_URL'],
];

/** The `.env.example` names of the online-Supabase settings still blank. */
export function missingHostedSettings(env) {
  return HOSTED_REQUIRED.filter((names) => !names.some((n) => filled(env[n]))).map(([name]) => name);
}

export const SECRETS_FILE_MODE = 0o640;

const KEY_ROLES = { ANON_KEY: 'anon', SERVICE_ROLE_KEY: 'service_role' };
const TEN_YEARS_SECONDS = 10 * 365 * 24 * 60 * 60;

const b64url = (input) => Buffer.from(input).toString('base64url');
const sign = (data, secret) => createHmac('sha256', secret).update(data).digest();

/** HS256 JWT using node:crypto only. */
export function signJwt(payload, secret) {
  const data = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  return `${data}.${sign(data, secret).toString('base64url')}`;
}

/** True when `token` is a well-formed HS256 JWT signed with `secret`. */
export function verifyJwt(token, secret) {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret === '') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const given = Buffer.from(parts[2], 'base64url');
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Parses KEY=value lines; the value is everything after the first `=`. */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export function formatEnv(values) {
  return Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

const filled = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * For each GENERATED name: the user's non-blank value, else the one already
 * in the file, else a new one. `created` lists the names given a new value.
 */
export function resolveSecrets({ existing = {}, provided = {}, mode = 'local' }) {
  /** @type {Record<string, string>} */
  const values = {};
  const created = [];
  const pick = (name) => (filled(provided[name]) ? provided[name] : filled(existing[name]) ? existing[name] : undefined);

  if (mode === 'hosted') {
    for (const name of APP_SECRETS) {
      values[name] = pick(name) ?? randomBytes(32).toString('hex');
      if (!filled(provided[name]) && !filled(existing[name])) created.push(name);
    }
    return { values, created };
  }

  for (const name of GENERATED) {
    if (name in KEY_ROLES) continue;
    let value = pick(name);
    if (value === undefined) {
      value = randomBytes(32).toString('hex');
      created.push(name);
    }
    values[name] = value;
  }

  const iat = Math.floor(Date.now() / 1000);
  for (const name of GENERATED) {
    if (!(name in KEY_ROLES)) continue;
    let value = pick(name);
    if (value === undefined || !verifyJwt(value, values.JWT_SECRET)) {
      value = signJwt({ role: KEY_ROLES[name], iss: 'supabase', iat, exp: iat + TEN_YEARS_SECONDS }, values.JWT_SECRET);
      created.push(name);
    }
    values[name] = value;
  }

  // Keep GENERATED order in both outputs.
  /** @type {Record<string, string>} */
  const ordered = {};
  for (const name of GENERATED) ordered[name] = values[name];
  ordered.SUPABASE_ANON_KEY = ordered.ANON_KEY;
  ordered.SUPABASE_SERVICE_ROLE_KEY = ordered.SERVICE_ROLE_KEY;
  return { values: ordered, created: GENERATED.filter((n) => created.includes(n)) };
}

function main() {
  const file = process.env.OPENKUASA_SECRETS_FILE || '/secrets/generated.env';
  const mode = process.env.OPENKUASA_INIT_MODE === 'hosted' ? 'hosted' : 'local';
  if (mode === 'hosted') {
    const missing = missingHostedSettings(process.env);
    if (missing.length > 0) {
      console.error(
        `Fill these in .env from your Supabase project, then start again: ${missing.join(', ')}.\n` +
          'See "Docker app with online Supabase" in the self-hosting guide.',
      );
      process.exit(1);
    }
  }
  const existing = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const { values, created } = resolveSecrets({ existing, provided: process.env, mode });

  if (created.length > 0 || formatEnv(existing) !== formatEnv(values)) {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    // 0640, not 0600: the file is read by containers running as other users
    // (Kong is uid 1001 and joins this file's group, 1000, via group_add).
    // Nobody outside the stack mounts the volume.
    writeFileSync(tmp, formatEnv(values), { mode: SECRETS_FILE_MODE });
    chmodSync(tmp, SECRETS_FILE_MODE);
    renameSync(tmp, file);
  }
  console.log(created.length > 0 ? `Generated ${created.length} new settings` : 'Settings already in place');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
