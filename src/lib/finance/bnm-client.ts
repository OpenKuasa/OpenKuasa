import 'server-only';
import { BNM_ACCEPT, BNM_BASE_URL } from './fx-bnm';

/**
 * What BNM sent back: JSON with its status (a 404 with `{"code":404}` is
 * BNM saying it has nothing), or something that is not JSON (its portal's
 * HTML page, a proxy's error page).
 */
export type BnmAnswer = { kind: 'json'; status: number; body: unknown } | { kind: 'not-json'; status: number };

/** The signature the fetch routine takes, so tests hand it a recorded answer instead. */
export type BnmGet = (path: string, timeoutMs: number) => Promise<BnmAnswer>;

/**
 * The one place the app calls Bank Negara Malaysia. A GET with the Accept
 * header BNM needs, no key, given up after `timeoutMs`. A network failure or
 * a timeout throws. Nothing about the request is logged here.
 */
export const bnmGet: BnmGet = async (path, timeoutMs) => {
  const res = await fetch(`${BNM_BASE_URL}${path}`, {
    method: 'GET',
    headers: { Accept: BNM_ACCEPT },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    await res.body?.cancel();
    return { kind: 'not-json', status: res.status };
  }
  try {
    return { kind: 'json', status: res.status, body: await res.json() };
  } catch {
    return { kind: 'not-json', status: res.status };
  }
};
