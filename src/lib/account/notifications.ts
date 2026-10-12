import type { SupabaseClient } from '@supabase/supabase-js';
import { safeAppPath } from '@/lib/security/safe-path';

// Imported by the client notifications menu, so this file must not pull in
// server-only modules (`next/headers`, the server Supabase client).

export type NotificationItem = {
  id: string;
  title: string;
  body: string | null;
  /** App-relative link, already checked with `isAppHref`. */
  href: string | null;
  read: boolean;
  createdAt: string;
};

export type NotificationFeed = {
  items: NotificationItem[];
  unreadCount: number;
};

export const EMPTY_FEED: NotificationFeed = { items: [], unreadCount: 0 };

const FEED_SIZE = 10;

/** True for same-app paths like "/account/security"; rejects other origins. */
export function isAppHref(href: string | null | undefined): href is string {
  // Only the exact, already-normalised form passes, so the stored value can be
  // used as the link without rewriting it.
  return typeof href === 'string' && safeAppPath(href) === href;
}

/** "Just now", "2m ago", "3h ago", "4d ago", then a short date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat('en-MY', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kuala_Lumpur',
  }).format(then);
}

/** The user's latest notifications and how many are still unread. */
export async function listNotifications(
  supabase: SupabaseClient,
  userId: string,
): Promise<NotificationFeed> {
  const [latest, unread] = await Promise.all([
    supabase
      .from('notifications')
      .select('id, title, body, href, read_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(FEED_SIZE),
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('read_at', null),
  ]);
  if (latest.error) throw latest.error;
  if (unread.error) throw unread.error;

  return {
    items: (latest.data ?? []).map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body ?? null,
      href: isAppHref(n.href) ? n.href : null,
      read: n.read_at !== null,
      createdAt: n.created_at,
    })),
    unreadCount: unread.count ?? 0,
  };
}

// Only `read_at` is writable by the user (column grant), so the payload must
// stay exactly this.
export async function markNotificationRead(
  supabase: SupabaseClient,
  userId: string,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', id)
    .is('read_at', null);
  if (error) throw error;
}

export async function markAllNotificationsRead(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null);
  if (error) throw error;
}
