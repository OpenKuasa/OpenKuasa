import { supabaseAnonKey, supabaseServerUrl } from '@/lib/supabase/env';

// Decides whether this server is the real app, an intentional preview, or a
// misconfigured deployment that must not answer.
//
// Nothing here runs at import or build time: every function
// reads the environment when it is called, so `next build` works with or
// without a Supabase project and the decision is made per request.

export type DeploymentMode =
  /** A Supabase project is configured: real sign-in, real data. */
  | 'live'
  /** No project: a Guest viewer over sample data, with no sign-in. */
  | 'preview'
  /** No project in production, and preview was not asked for: refuse. */
  | 'blocked';

export function hasSupabaseEnv(): boolean {
  return Boolean(
    supabaseServerUrl() && supabaseAnonKey(),
  );
}

export function resolveDeploymentMode(input: {
  hasSupabase: boolean;
  nodeEnv: string | undefined;
  previewFlag: string | undefined;
}): DeploymentMode {
  if (input.hasSupabase) return 'live';
  // Local development and tests run on sample data without being asked.
  if (input.nodeEnv !== 'production') return 'preview';
  // In production the sample app is only served on purpose. A deployment that
  // merely lost a variable must fail loudly instead of looking like the app
  // with nobody signed in.
  return input.previewFlag === '1' ? 'preview' : 'blocked';
}

export function deploymentMode(): DeploymentMode {
  return resolveDeploymentMode({
    hasSupabase: hasSupabaseEnv(),
    nodeEnv: process.env.NODE_ENV,
    previewFlag: process.env.OPENKUASA_PREVIEW,
  });
}

/**
 * Whether a screen should read the sample data instead of a Supabase project. Only in
 * preview: a production server that lost its project refuses instead (the proxy answers
 * 503; this covers a request that reaches a screen without passing through it).
 */
export function usesSampleData(): boolean {
  if (hasSupabaseEnv()) return false;
  if (deploymentMode() === 'blocked') throw new Error(PREVIEW_BLOCKED_MESSAGE);
  return true;
}

export const PREVIEW_BLOCKED_MESSAGE =
  'This server is not configured: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set in production. ' +
  'Requests are answered with 503 until they are. To run the sample-data preview on purpose instead, set OPENKUASA_PREVIEW=1.';
