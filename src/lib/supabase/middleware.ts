import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { PREVIEW_BLOCKED_MESSAGE, deploymentMode } from '@/lib/auth/preview-mode';
import { REMEMBER_COOKIE, isPersistent, sessionize } from './remember';

// One log line a minute is enough to find in the host's logs without
// repeating it for every request.
let lastBlockedLog = 0;

function serviceUnavailable(): NextResponse {
  const now = Date.now();
  if (now - lastBlockedLog > 60_000) {
    lastBlockedLog = now;
    console.error(PREVIEW_BLOCKED_MESSAGE);
  }
  // Plain and generic: visitors learn nothing about the server's setup.
  return new NextResponse(
    'Service unavailable. This site is temporarily offline; please try again later.\n',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '120',
      },
    },
  );
}

/**
 * Refreshes the Supabase auth session on every request and keeps the
 * auth cookies in sync between the request and the response.
 *
 * Without a Supabase project this is a no-op so the app still runs on sample
 * data in development, or in production when preview was asked for with
 * `OPENKUASA_PREVIEW=1`. A production server that is simply missing the
 * project settings answers 503 here, before any page renders (see the README).
 */
export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return deploymentMode() === 'blocked'
      ? serviceUnavailable()
      : NextResponse.next({ request });
  }

  const supabaseResponse = NextResponse.next({ request });

  let response = supabaseResponse;

  // Honour the user's "remember me" choice so a refreshed token keeps the same
  // cookie lifetime instead of silently becoming persistent again.
  const persist = isPersistent(request.cookies.get(REMEMBER_COOKIE)?.value);

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, sessionize(options, persist)),
        );
      },
    },
  });

  // IMPORTANT: Do not run code between createServerClient and getUser().
  // getUser() revalidates the token and triggers a cookie refresh when needed.
  await supabase.auth.getUser();

  return response;
}
