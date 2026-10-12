import { config } from 'dotenv';

// Integration tests hit the live dev project; load the same env the app uses.
config({ path: '.env.local' });

// Importing this file is what marks a test as live. Every other test file is
// refused the network by tests/setup/no-network.ts, which reads this flag
// (the same `Symbol.for` key; kept as a global so the two files stay apart).
(globalThis as unknown as Record<symbol, boolean>)[Symbol.for('openkuasa.tests.live')] = true;

export const hasSupabaseEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

export const supabaseEnvSkipReason =
  'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local';
