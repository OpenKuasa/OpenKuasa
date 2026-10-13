/**
 * Removes what the accuracy check left in the workspace when a run was
 * stopped before it could tidy up. It asks no model anything:
 * `pnpm eval:tuah evals/tuah-cleanup.eval.ts`.
 */

import { config } from 'dotenv';
import { test } from 'vitest';
import { cleanUp, evalAccount, openWorkspace } from './tuah/harness';

config({ path: '.env.local' });

const account = evalAccount();

(account && process.env.NEXT_PUBLIC_SUPABASE_URL ? test : test.skip)('removes rows left by the accuracy check', async () => {
  const workspace = await openWorkspace(account!);
  await cleanUp(workspace);
  // Local: the default ends every session of the account, a browser's included.
  await workspace.client.auth.signOut({ scope: 'local' });
});
