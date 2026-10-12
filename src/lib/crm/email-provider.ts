/**
 * The one place that talks to the email provider (Resend). Everything else
 * hands it finished messages and gets back, per message, whether the provider
 * took it. Never logs a key, an address or a message.
 */
import 'server-only';

const RESEND_API = 'https://api.resend.com';
/** How many messages the provider takes in one call. */
export const PROVIDER_BATCH_SIZE = 100;
const SEND_TIMEOUT_MS = 20_000;
const CHECK_TIMEOUT_MS = 8_000;

/** One finished message. */
export type OutgoingEmail = {
  /** `Name <address>`. */
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

export type SendResult =
  | { ok: true; providerId: string | null }
  /** A short, plain reason. Never the provider's raw reply. */
  | { ok: false; error: string };

export type EmailProvider = {
  /**
   * Sends up to `PROVIDER_BATCH_SIZE` messages in one call and answers for
   * each, in order. `idempotencyKey` makes a repeat of the same call (after a
   * timeout, say) a no-op at the provider instead of a second send.
   */
  sendBatch(apiKey: string, emails: OutgoingEmail[], idempotencyKey: string): Promise<SendResult[]>;
};

/** What the provider said, reduced to something safe to store and show. */
function reason(status: number): string {
  if (status === 401 || status === 403) return 'The email key was refused. Check it in the email settings.';
  if (status === 422 || status === 400) {
    return 'The provider refused the message. Check that the sender address is on a verified domain.';
  }
  if (status === 429) return 'The provider’s sending limit was reached. Try again later.';
  if (status >= 500) return 'The email provider had a problem. Try again later.';
  return 'The email provider did not take the message.';
}

export const resendProvider: EmailProvider = {
  async sendBatch(apiKey, emails, idempotencyKey) {
    const failAll = (error: string): SendResult[] => emails.map(() => ({ ok: false, error }));
    if (emails.length === 0) return [];
    if (emails.length > PROVIDER_BATCH_SIZE) return failAll('Too many messages in one call.');
    try {
      const response = await fetch(`${RESEND_API}/emails/batch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(emails),
        cache: 'no-store',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) return failAll(reason(response.status));
      // { data: [{ id }, …] }, one per message, in order.
      const body = (await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
      const ids = Array.isArray(body?.data) ? body.data : [];
      return emails.map((_, index) => {
        const id = ids[index]?.id;
        return { ok: true, providerId: typeof id === 'string' ? id.slice(0, 100) : null };
      });
    } catch {
      // A timeout or a dropped connection: the provider may or may not have taken them.
      return failAll('The email provider could not be reached. Some messages may have gone; check before sending again.');
    }
  },
};

/**
 * Asks Resend whether the key is real. A key restricted to sending is real
 * but may not list domains; Resend says so by name, and that counts as valid.
 * Never logs the key.
 */
export async function checkResendKey(apiKey: string): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const response = await fetch(`${RESEND_API}/domains`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (response.ok) return 'valid';
    if (response.status === 401 || response.status === 403) {
      const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
      return body?.name === 'restricted_api_key' ? 'valid' : 'invalid';
    }
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}
