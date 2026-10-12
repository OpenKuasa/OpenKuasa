#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const host = process.env.SMOKE_HOST || '127.0.0.1';
const port = process.env.SMOKE_PORT || '3100';
const baseUrl = process.env.SMOKE_BASE_URL || `http://${host}:${port}`;
const allowedStatuses = new Set([200, 301, 302, 303, 307, 308]);

function listAccountRoutes() {
  const dir = join(root, 'src/app/account');
  return readdirSync(dir)
    .filter((entry) => {
      const fullPath = join(dir, entry);
      return entry !== 'layout.tsx' && statSync(fullPath).isDirectory() && existsSync(join(fullPath, 'page.tsx'));
    })
    .map((entry) => `/account/${entry}`);
}

function listProductRoutes() {
  const navPath = join(root, 'src/config/nav.ts');
  const source = readFileSync(navPath, 'utf8');
  const blocks = source.split(/\n  \{\n    key: '/).slice(1);
  const routes = [];

  for (const block of blocks) {
    const key = block.slice(0, block.indexOf("'"));
    if (!key) continue;

    routes.push(`/${key}`);

    const slugs = [...block.matchAll(/slug: '([^']+)'/g)].map((match) => match[1]);
    for (const slug of slugs) routes.push(`/${key}/${slug}`);
  }

  return routes;
}

function unique(values) {
  return [...new Set(values)].sort();
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, { redirect: 'manual' });
      if (response.status > 0) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${baseUrl}: ${lastError?.message ?? 'no response'}`);
}

async function checkRoute(route) {
  const response = await fetch(`${baseUrl}${route}`, { redirect: 'manual' });
  const ok = allowedStatuses.has(response.status);
  return {
    route,
    status: response.status,
    location: response.headers.get('location') || '',
    ok,
  };
}

async function main() {
  if (!existsSync(join(root, '.next/BUILD_ID'))) {
    throw new Error('No production build found. Run `pnpm build` before `pnpm smoke:routes`.');
  }

  const routes = unique([
    '/',
    '/login',
    '/onboarding',
    '/pricing',
    '/privacy',
    '/settings',
    '/account',
    ...listAccountRoutes(),
    ...listProductRoutes(),
  ]);

  const server = spawn('pnpm', ['exec', 'next', 'start', '--hostname', host, '--port', port], {
    cwd: root,
    // `next start` is a production server, which refuses to serve the
    // sample-data preview unless asked. This check is meant to run with or
    // without a Supabase project, so ask for it; the flag does nothing when
    // the project variables are set.
    env: { OPENKUASA_PREVIEW: '1', ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  server.stdout.on('data', (chunk) => {
    logs.push(chunk.toString());
  });
  server.stderr.on('data', (chunk) => {
    logs.push(chunk.toString());
  });

  try {
    await waitForServer();
    const results = [];
    for (const route of routes) results.push(await checkRoute(route));

    const failed = results.filter((result) => !result.ok);
    for (const result of results) {
      const suffix = result.location ? ` -> ${result.location}` : '';
      console.log(`${result.ok ? 'OK' : 'FAIL'} ${result.status} ${result.route}${suffix}`);
    }

    if (failed.length) {
      console.error(logs.join('').slice(-4_000));
      throw new Error(`${failed.length}/${results.length} routes failed smoke check.`);
    }

    console.log(`Checked ${results.length} routes from ${baseUrl}`);
  } finally {
    server.kill('SIGTERM');
    setTimeout(() => server.kill('SIGKILL'), 2_000).unref();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
