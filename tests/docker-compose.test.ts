import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENERATED } from '../scripts/local-init.mjs';

const root = path.resolve(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** The text of one top-level service, from its `  name:` line to the next service. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return lines.slice(start, start + 1 + (end === -1 ? rest.length : end)).join('\n');
}

describe('docker-compose.yml', () => {
  const compose = () => read('docker-compose.yml');

  it('never substitutes settings from the shell', () => {
    // `$$` is a literal dollar for the container's own shell; anything else
    // starting with `$` is filled in by Compose from the user's shell.
    const text = compose().replace(/^\s*#.*$/gm, '').replace(/\$\$/g, '');
    const found = [...text.matchAll(/\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[0]);
    expect(found.length).toBeGreaterThan(0);
    for (const ref of found) expect(ref).toMatch(/^\$\{OPENKUASA_IMAGE_TAG(:-[^}]*)?\}$/);
  });

  it('publishes the agreed ports on 127.0.0.1 only, and nothing on 543xx', () => {
    const text = compose();
    expect(text).toContain('"127.0.0.1:58272:3000"');
    expect(text).toContain('"127.0.0.1:58273:8000"');
    expect(text).toContain('"127.0.0.1:58274:8025"');
    expect(text).not.toMatch(/543\d\d/);
  });

  it('never publishes a port on every interface', () => {
    // Every entry under a `ports:` key must be bound to 127.0.0.1, so nobody
    // on the same network can reach the app, the gateway or the caught emails.
    const lines = compose().split('\n');
    const published: string[] = [];
    lines.forEach((line, i) => {
      if (!/^\s+ports:/.test(line)) return;
      const indent = line.search(/\S/);
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.trim() === '' || next.trim().startsWith('#')) continue;
        if (next.search(/\S/) <= indent && !next.trim().startsWith('-')) break;
        if (!next.trim().startsWith('-')) break;
        published.push(next.trim().replace(/^-\s*/, ''));
      }
    });
    expect(published).toHaveLength(3);
    for (const entry of published) expect(entry).toMatch(/^"127\.0\.0\.1:\d+:\d+"$/);
  });

  it('keeps the mail viewer and its template server optional', () => {
    // A default `docker compose up -d` runs only what the app needs; emails
    // come with `docker compose --profile mail up -d`.
    for (const name of ['mail', 'email-templates']) {
      expect(serviceBlock(compose(), name)).toMatch(/\n\s+profiles: \[mail\]/);
    }
    for (const name of ['init', 'db', 'auth', 'rest', 'storage', 'kong', 'migrate', 'app']) {
      expect(serviceBlock(compose(), name)).not.toMatch(/profiles:/);
    }
    // Nothing in the default stack may wait on an optional service.
    for (const name of ['auth', 'kong', 'app']) {
      expect(serviceBlock(compose(), name)).not.toMatch(/\n\s+(mail|email-templates):\s*\n\s+condition:/);
    }
  });

  it('starts PostgREST without a shell, reading its secrets from the files init writes', () => {
    // The amd64 PostgREST image has no /bin/sh (the arm64 one does), so the
    // shell wrapper would stop it from starting on Intel and AMD machines.
    const rest = serviceBlock(compose(), 'rest');
    expect(rest).toContain('image: public.ecr.aws/supabase/postgrest:');
    expect(rest).not.toContain('/bin/sh');
    expect(rest).not.toContain('with-secrets');
    expect(rest).toContain('PGRST_DB_URI: "@/secrets/postgrest-db-uri"');
    expect(rest).toContain('PGRST_JWT_SECRET: "@/secrets/postgrest-jwt-secret"');
    expect(rest).toContain('secrets:/secrets:ro');
  });

  it('starts the app only after migrations succeed', () => {
    const app = serviceBlock(compose(), 'app');
    expect(app).toMatch(/depends_on:\s*\n\s+migrate:\s*\n\s+condition: service_completed_successfully/);
  });

  it('runs migrations only once the database, auth and storage are healthy', () => {
    const migrate = serviceBlock(compose(), 'migrate');
    for (const dep of ['db', 'auth', 'storage']) {
      expect(migrate).toMatch(new RegExp(`\\n\\s+${dep}:\\s*\\n\\s+condition: service_healthy`));
    }
  });
});

describe('docker-compose.hosted.yml (online Supabase)', () => {
  const compose = () => read('docker-compose.hosted.yml');
  const services = () => [...compose().matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]);

  it('runs only the app and its two setup steps, no local Supabase', () => {
    expect(services()).toEqual(['init', 'migrate', 'app', 'secrets']);
  });

  it('never substitutes settings from the shell', () => {
    const text = compose().replace(/^\s*#.*$/gm, '').replace(/\$\$/g, '');
    for (const m of text.matchAll(/\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g)) {
      expect(m[0]).toMatch(/^\$\{OPENKUASA_IMAGE_TAG(:-[^}]*)?\}$/);
    }
  });

  it('publishes only the app, on 127.0.0.1', () => {
    const ports = [...compose().matchAll(/^\s+- "(\d[^"]*:\d+)"$/gm)].map((m) => m[1]);
    expect(ports).toEqual(['127.0.0.1:58272:3000']);
  });

  it('checks the settings first, and starts the app only after migrations succeed', () => {
    expect(serviceBlock(compose(), 'init')).toMatch(/OPENKUASA_INIT_MODE: hosted/);
    expect(serviceBlock(compose(), 'migrate')).toMatch(/init:\s*\n\s+condition: service_completed_successfully/);
    expect(serviceBlock(compose(), 'app')).toMatch(/migrate:\s*\n\s+condition: service_completed_successfully/);
  });

  it('runs migrations with the generated settings loaded', () => {
    expect(serviceBlock(compose(), 'migrate')).toContain('/app/tools/docker/with-secrets.sh');
  });
});

describe('docker-compose.single-port.yml (one address for app and Supabase)', () => {
  const compose = () => read('docker-compose.single-port.yml');

  it('reads only OPENKUASA_PUBLIC_URL, and refuses to start without it', () => {
    const text = compose().replace(/^\s*#.*$/gm, '').replace(/\$\$/g, '');
    const refs = [...text.matchAll(/\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^\$\{OPENKUASA_PUBLIC_URL(:\?[^}]*)?\}$/);
    expect(serviceBlock(compose(), 'app')).toMatch(/\$\{OPENKUASA_PUBLIC_URL:\?/);
    expect(serviceBlock(compose(), 'auth')).toMatch(/\$\{OPENKUASA_PUBLIC_URL:\?/);
  });

  it('points every address the app and sign-in use at that one address', () => {
    const app = serviceBlock(compose(), 'app');
    for (const name of ['SUPABASE_PUBLIC_URL', 'PUBLIC_SITE_URL']) expect(app).toMatch(new RegExp(`${name}: \\$\\{OPENKUASA_PUBLIC_URL`));
    const auth = serviceBlock(compose(), 'auth');
    for (const name of ['API_EXTERNAL_URL', 'GOTRUE_SITE_URL', 'GOTRUE_URI_ALLOW_LIST']) {
      expect(auth).toMatch(new RegExp(`${name}: \\$\\{OPENKUASA_PUBLIC_URL`));
    }
  });

  it('opens no ports of its own', () => {
    expect(compose()).not.toMatch(/^\s+ports:/m);
  });
});

describe('Kong (docker/supabase/api/kong.yml)', () => {
  it('sends every path Supabase does not answer to the app, unbuffered, as the last route', () => {
    const kong = read('docker/supabase/api/kong.yml');
    const names = [...kong.matchAll(/^ {2}- name: (\S+)$/gm)].map((m) => m[1]);
    expect(names.at(-1)).toBe('app');
    const app = kong.slice(kong.indexOf('  - name: app\n'));
    expect(app).toContain('url: http://app:3000');
    expect(app).toContain('preserve_host: true');
    expect(app).toContain('response_buffering: false');
    expect(app).toMatch(/paths:\s*\n\s+- \/\n/);
    expect(app).not.toContain('key-auth');
  });
});

describe('.env.example', () => {
  it('lists every generated setting in .env.example', () => {
    const text = read('.env.example');
    for (const name of GENERATED) expect(text).toMatch(new RegExp(`^${name}=`, 'm'));
  });
});
