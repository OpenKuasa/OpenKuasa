/**
 * The address a request came from, for counting attempts per client. This is
 * the one place that decides it.
 *
 * What is assumed about the deployment: the app runs behind Railway's edge
 * with nothing else in front (the domain points straight at Railway). Railway
 * documents `X-Real-IP` as the header "for identifying client's remote IP"
 * (docs.railway.com/networking/public-networking/specs-and-limits), set by the
 * edge from the connection it accepted. That header is the only one read.
 *
 * `X-Forwarded-For`, `Forwarded` and every other header of the kind are
 * ignored: a client can send them, Railway does not document what it does to
 * a value that arrives already set, and a header the client may have written
 * must never choose which counter a request is counted against.
 *
 * No usable header (local development, another host, a proxy that does not
 * set it) is "no address", never a guess: the callers then count against one
 * shared key with its own, wider limit. If a proxy is ever put in front of
 * Railway, this function is what has to change (to that proxy's own header).
 */
import { isIP } from 'node:net';
import { headers } from 'next/headers';

/** The header Railway's edge sets to the client's address. */
export const CLIENT_ADDRESS_HEADER = 'x-real-ip';

/** What every request without an address is counted as. */
export const UNKNOWN_CLIENT = 'unknown';

/** Longer than any address can be written. */
const MAX_LENGTH = 64;

/** The first four groups of an IPv6 address, each without leading zeros, or null if it is not one. */
function ipv6Network(address: string): string | null {
  // A zone ("%eth0") names an interface on the machine that wrote it; it is not part of the address.
  const bare = address.split('%')[0];
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  // A dotted IPv4 ending stands for the last two groups; only how many there are matters here.
  const count = (list: string[]) => list.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const missing = 8 - count(head) - count(tail);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const first = all.slice(0, 4).map((g) => Number.parseInt(g, 16));
  if (first.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return first.map((n) => n.toString(16)).join(':');
}

/**
 * The client's address from a request's headers, or null when the platform
 * did not report exactly one. An IPv4 address is returned as it is. An IPv6
 * address is returned as its /64 network: one subscriber is usually handed
 * the whole /64, so counting each address in it apart would count nothing.
 */
export function clientAddressFrom(get: (name: string) => string | null | undefined): string | null {
  const raw = get(CLIENT_ADDRESS_HEADER);
  if (typeof raw !== 'string' || raw.length > MAX_LENGTH) return null;
  const value = raw.trim().toLowerCase();
  if (value === '') return null;

  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;

  // IPv4 written inside IPv6 (::ffff:203.0.113.7) is that IPv4 client.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];

  const network = ipv6Network(value);
  return network ? `${network}::/64` : null;
}

/** What a client is counted under: its address, or the one shared name when it has none. */
export function clientKey(address: string | null): { key: string; known: boolean } {
  return address ? { key: address, known: true } : { key: UNKNOWN_CLIENT, known: false };
}

/**
 * The address of the request being served. For server actions, route handlers
 * and pages; reads the request's headers, so it makes a page dynamic.
 */
export async function requestClientAddress(): Promise<string | null> {
  try {
    const list = await headers();
    return clientAddressFrom((name) => list.get(name));
  } catch {
    // Outside a request there is no client.
    return null;
  }
}
