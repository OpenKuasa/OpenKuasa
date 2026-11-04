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

  it('publishes the agreed ports and nothing on 543xx', () => {
    const text = compose();
    expect(text).toContain('"58272:3000"');
    expect(text).toMatch(/58273:/);
    expect(text).toMatch(/58274:/);
    expect(text).not.toMatch(/543\d\d/);
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

describe('.env.example', () => {
  it('lists every generated setting in .env.example', () => {
    const text = read('.env.example');
    for (const name of GENERATED) expect(text).toMatch(new RegExp(`^${name}=`, 'm'));
  });
});
