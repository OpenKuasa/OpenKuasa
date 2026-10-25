import 'server-only';

export type PushConfig = { publicKey: string; privateKey: string; subject: string };

/**
 * The VAPID keys push is sent with, or null when push is not set up on this
 * server: any of the three missing, or a subject that is not `mailto:` or an
 * https URL (the push services refuse anything else). Never log what this returns.
 */
export function pushConfig(): PushConfig | null {
  const publicKey = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY ?? '').trim();
  const subject = (process.env.VAPID_SUBJECT ?? '').trim();
  if (!publicKey || !privateKey) return null;
  if (!/^(mailto:\S+|https:\/\/\S+)$/i.test(subject)) return null;
  return { publicKey, privateKey, subject };
}
