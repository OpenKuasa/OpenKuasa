// Takes the docs screenshots listed in content/docs/shots/*.json from sample data.
// Usage: DOCS_SHOTS_BASE=http://localhost:3175 pnpm docs:shots [--only <file prefix>]
// Local servers only. Never clicks anything that saves (see docs-shots-lib.mjs).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HIDE_ASSISTANT_FAB_CSS, isDeniedClick, isLocalBase, shotContextOptions } from './docs-shots-lib.mjs';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = (process.env.DOCS_SHOTS_BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? '' : (process.argv[onlyAt + 1] ?? '');

if (!isLocalBase(base)) {
  console.error(`Refusing ${base}: docs screenshots only run against localhost or 127.0.0.1.`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const shots = readdirSync('content/docs/shots')
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => JSON.parse(readFileSync(join('content/docs/shots', f), 'utf8')))
  .filter((s) => s.file.startsWith(only));

for (const s of shots) {
  for (const step of s.steps ?? []) {
    if (step.click !== undefined && isDeniedClick(step.click)) {
      console.error(`${s.file}: refusing to click "${step.click}" (it could save or send)`);
      process.exit(1);
    }
  }
}
if (shots.length === 0) {
  console.error(`No shots match "${only}".`);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0;

/** Signs in to the demo once (each sign-in makes a new demo user) and returns the saved session. */
async function signInToDemo() {
  const context = await browser.newContext({ colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Try the demo', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
    return await context.storageState();
  } finally {
    await context.close();
  }
}

let demoState = null;
if (shots.some((s) => s.as === 'demo')) {
  try {
    demoState = await signInToDemo();
  } catch (err) {
    console.error(`Demo sign-in failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    await browser.close();
    process.exit(1);
  }
}

// Each shot gets a fresh context with its own viewport; demo shots share the one saved sign-in.
for (const s of shots) {
  const [w, h] = s.viewport ?? [1280, 800];
  const viewport = { width: Math.min(w, 1280), height: h };
  let context;
  try {
    context = await browser.newContext(shotContextOptions(s.as, viewport, demoState));
    const page = await context.newPage();
    await page.goto(base + s.path, { waitUntil: 'networkidle' });
    for (const step of s.steps ?? []) {
      if (step.click !== undefined) await page.getByRole('button', { name: step.click, exact: true }).click();
      if (step.wait !== undefined) await page.waitForTimeout(step.wait);
    }
    // After the steps, since a step may click the button to open the panel.
    await page.addStyleTag({ content: HIDE_ASSISTANT_FAB_CSS });
    await page.waitForTimeout(500);
    const out = join('public/docs-media', s.file);
    mkdirSync(dirname(out), { recursive: true });
    if (s.clip) await page.locator(s.clip).first().screenshot({ path: out });
    else await page.screenshot({ path: out });
    console.log(`ok   ${s.file}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${s.file}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
  } finally {
    await context?.close();
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
