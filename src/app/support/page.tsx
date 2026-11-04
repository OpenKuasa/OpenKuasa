import type { Metadata } from 'next';
import Link from 'next/link';
import { BookOpen, Mail, MessageSquare } from 'lucide-react';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import { MarketingHeader } from '@/components/marketing/marketing-header';
import { SupportChat } from '@/components/support/support-chat';
import { isLiveChatAllowed } from '@/lib/ai/access';
import { SUPPORT_EMAIL, SUPPORT_QUESTION_LIMIT } from '@/lib/ai/support-chat';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Contact Support · OpenKuasa',
  description: 'Ask Sari, our AI assistant, how to do something in OpenKuasa, or email us.',
};

export const dynamic = 'force-dynamic';

/** Whether the visitor may use the Live chat: signed in with a real account. */
async function canChat(): Promise<boolean> {
  if (!hasSupabaseEnv()) return false;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return isLiveChatAllowed(user);
  } catch {
    return false;
  }
}

const CARD = 'rounded-2xl border border-mk-border bg-mk-surface p-5 sm:p-6';
const ICON = 'grid size-10 place-items-center rounded-xl bg-mk-accent/10 text-mk-accent';

export default async function SupportPage() {
  const chat = await canChat();
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('OpenKuasa support')}`;

  return (
    <div className="min-h-dvh bg-mk-bg text-mk-fg">
      <MarketingHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <h1 className="text-3xl font-bold tracking-tight">Contact Support</h1>
        <p className="mt-2 text-mk-muted">
          Most questions are answered fastest by Sari. For anything about your account, email us.
        </p>

        <section className={`${CARD} mt-8`} aria-labelledby="live-chat">
          <div className="flex items-center gap-3">
            <span className={ICON}><MessageSquare className="size-5" /></span>
            <div>
              <h2 id="live-chat" className="font-semibold">Live chat with Sari, our AI assistant</h2>
              <p className="text-sm text-mk-muted">Answers from our guides, any time.</p>
            </div>
          </div>
          <div className="mt-4">
            <SupportChat canChat={chat} email={SUPPORT_EMAIL} limit={SUPPORT_QUESTION_LIMIT} />
          </div>
        </section>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <section className={CARD} aria-labelledby="email-us">
            <span className={ICON}><Mail className="size-5" /></span>
            <h2 id="email-us" className="mt-3 font-semibold">Email</h2>
            <p className="break-all text-sm text-mk-muted">{SUPPORT_EMAIL}</p>
            <p className="mt-1 text-sm text-mk-muted">We reply by email, usually within a few days.</p>
            <a
              href={mailto}
              className="mt-4 inline-flex min-h-11 items-center rounded-full border border-mk-border px-4 text-sm font-medium hover:bg-mk-fg/10"
            >
              Email us
            </a>
          </section>
          <section className={CARD} aria-labelledby="guides">
            <span className={ICON}><BookOpen className="size-5" /></span>
            <h2 id="guides" className="mt-3 font-semibold">Guides</h2>
            <p className="text-sm text-mk-muted">Step-by-step help for every part of OpenKuasa.</p>
            <Link
              href="/docs"
              className="mt-4 inline-flex min-h-11 items-center rounded-full border border-mk-border px-4 text-sm font-medium hover:bg-mk-fg/10"
            >
              Read the guides
            </Link>
          </section>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
