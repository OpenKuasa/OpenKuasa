import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Code2,
  Database,
  Plus,
  Server,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GitHubIcon } from '@/components/brand/github-icon';
import { MarketingHeader } from '@/components/marketing/marketing-header';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import { REPO_URL } from '@/config/marketing';

const INCLUDED = [
  'All six products — Tuah, Jebat, Kasturi, Lekiu, Lekir and Bendahara',
  'Every screen and feature, with nothing held back for a paid tier',
  'No limits on contacts, team members, employees or client accounts',
  'The full source code, yours to read, change and extend',
  'No sign-up, no card and no subscription',
];

const HOSTED = [
  'Built on the same open-source software, set up and run for you',
  'Hosting, updates and backups taken care of',
  'No servers or database to manage',
  'Free to leave — move to your own self-hosted instance any time',
];

const PILLARS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Code2,
    title: 'Open source',
    body: 'Licensed under AGPL-3.0. Use it, study it and modify it. If you offer a modified version as a service, you share your changes back.',
  },
  {
    icon: Server,
    title: 'Self-host or hosted',
    body: 'Run OpenKuasa on infrastructure you control for free, or pay for the hosted version once it launches. It is the same software either way.',
  },
  {
    icon: Database,
    title: 'Your data stays yours',
    body: 'When you self-host, records live in your own database and the project never receives them. Nothing locks you in to the hosted version.',
  },
];

const STEPS = [
  {
    title: 'Get the code',
    body: 'Clone the repository from GitHub.',
    code: `git clone ${REPO_URL}.git`,
  },
  {
    title: 'Install and run',
    body: 'You need Node 20 or newer and pnpm.',
    code: 'pnpm install && pnpm dev',
  },
  {
    title: 'Connect your own services',
    body: 'Add your own Supabase project for data and sign-in. You pay your providers directly for whatever you use.',
    code: null,
  },
];

const FAQS = [
  {
    q: 'Is it really free?',
    a: 'Yes. OpenKuasa is free software under the AGPL-3.0 license. If you host it yourself there are no plans, no credits and nothing to subscribe to.',
  },
  {
    q: 'What will I have to pay for?',
    a: 'Only your own infrastructure — wherever you host the app and the database, plus any third-party services you choose to connect. Those costs are between you and your providers.',
  },
  {
    q: 'Is there a hosted version?',
    a: 'Not yet. A paid hosted version is planned for people who would rather not run it themselves. Pricing has not been announced, and today the only way to use OpenKuasa is to host it yourself.',
  },
  {
    q: 'Will it still be open source once there is a paid version?',
    a: 'Yes. The hosted version is built on the code in the public repository, and that code stays open source under AGPL-3.0. Paying is for the convenience of having it run for you, not for access to the software.',
  },
  {
    q: 'Is it ready to run my business on?',
    a: 'Not yet. OpenKuasa is a work in progress. Accounts, teams, AI chat and a first set of screens in Jebat and Kasturi work with your own data. The other screens still show sample data, and integrations are not connected. Each screen that is not ready says so.',
  },
  {
    q: 'Who builds OpenKuasa?',
    a: 'The OpenKuasa maintainers and volunteer contributors. It is a crowd-sourced project developed in the open, and it is not affiliated with any other company or product.',
  },
  {
    q: 'Is there support?',
    a: 'Support is community-based, through issues and discussions on GitHub, and the Contact Support page, where Sari answers from our guides and you can email us. There is no service-level agreement or warranty.',
  },
  {
    q: 'Can I use it commercially?',
    a: 'Yes. You can run it for your own business. If you modify it and let others use it over a network, the AGPL-3.0 requires you to make your source available to those users.',
  },
  {
    q: 'How can I help?',
    a: 'Code, design, documentation, translations and bug reports are all welcome. See CONTRIBUTING.md in the repository to get started.',
  },
];

// Outline button on the marketing surface. The dark: overrides cancel the
// shadcn outline variant's own dark fill so the button stays transparent.
const OUTLINE =
  'rounded-full border-mk-border bg-transparent text-mk-fg hover:bg-mk-fg/10 hover:text-mk-fg dark:border-mk-border dark:bg-transparent dark:hover:bg-mk-fg/10';

const EYEBROW = 'font-mono text-xs uppercase tracking-[0.2em]';

// Soft emerald glow behind the hero and the closing band.
const GLOW =
  'pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_oklch,var(--mk-accent)_16%,transparent),transparent)]';

export default function PricingPage() {
  return (
    <div className="min-h-dvh bg-mk-bg text-mk-fg">
      <MarketingHeader />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div aria-hidden className={GLOW} />

        <div className="relative mx-auto flex max-w-7xl flex-col items-center px-6 py-24 text-center sm:py-32">
          <span
            className={`inline-flex items-center gap-2 text-mk-accent ${EYEBROW}`}
          >
            <Sparkles className="size-4" />
            Open source · AGPL-3.0
          </span>
          <h1 className="mt-6 max-w-4xl text-5xl font-bold leading-[1.05] tracking-tight sm:text-7xl">
            Free to self-host
          </h1>
          <p className="mt-6 max-w-xl text-lg text-mk-muted">
            Run OpenKuasa on your own infrastructure at no cost. A paid hosted
            version is on the way for teams who would rather not run it
            themselves.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg" className="rounded-full">
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                Get the code
                <ArrowRight className="size-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className={OUTLINE}>
              <Link href="/command">Explore the demo</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Two ways to run it */}
      <section className="border-t border-mk-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-2">
            <div className="flex flex-col rounded-2xl border border-primary bg-mk-surface p-7 ring-1 ring-primary sm:p-8">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">Self-hosted</h2>
                <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
                  Available now
                </span>
              </div>
              <p className="mt-1 text-sm text-mk-muted">
                Run it yourself, on your own infrastructure.
              </p>
              <div className="mt-6 flex flex-wrap items-end gap-x-3 gap-y-1">
                <span className="text-5xl font-bold tracking-tight tabular-nums sm:text-6xl">
                  RM 0
                </span>
                <span className={`pb-2 text-mk-subtle ${EYEBROW}`}>
                  forever
                </span>
              </div>
              <ul className="mt-7 flex-1 space-y-3 border-t border-mk-border pt-7">
                {INCLUDED.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <Check className="mt-0.5 size-4 shrink-0 text-mk-accent" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button asChild className="mt-8 w-full rounded-full">
                <a href={REPO_URL} target="_blank" rel="noreferrer">
                  Get the code
                </a>
              </Button>
            </div>

            <div className="flex flex-col rounded-2xl border border-mk-border bg-mk-surface p-7 sm:p-8">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">Hosted</h2>
                <span className="rounded-full border border-mk-border bg-mk-surface-2 px-2.5 py-0.5 text-xs font-semibold text-mk-muted">
                  Coming soon
                </span>
              </div>
              <p className="mt-1 text-sm text-mk-muted">
                We run it for you, for a fee.
              </p>
              <div className="mt-6 flex flex-wrap items-end gap-x-3 gap-y-1">
                <span className="text-5xl font-bold tracking-tight sm:text-6xl">
                  Paid
                </span>
                <span className={`pb-2 text-mk-subtle ${EYEBROW}`}>
                  pricing to be announced
                </span>
              </div>
              <ul className="mt-7 flex-1 space-y-3 border-t border-mk-border pt-7">
                {HOSTED.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <Check className="mt-0.5 size-4 shrink-0 text-mk-accent" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button
                asChild
                variant="outline"
                className={`mt-8 w-full ${OUTLINE}`}
              >
                <a href={REPO_URL} target="_blank" rel="noreferrer">
                  <GitHubIcon />
                  Follow on GitHub for updates
                </a>
              </Button>
            </div>
          </div>

          <div className="mx-auto mt-5 grid max-w-5xl gap-5 lg:grid-cols-3">
            {PILLARS.map((p) => (
              <div
                key={p.title}
                className="rounded-2xl border border-mk-border bg-mk-surface p-7"
              >
                <span className="grid size-11 place-items-center rounded-xl bg-mk-accent/10 text-mk-accent">
                  <p.icon className="size-5" />
                </span>
                <h3 className="mt-5 text-lg font-bold">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-mk-muted">
                  {p.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Self-hosting steps */}
      <section className="border-t border-mk-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-4xl font-bold tracking-tight sm:text-6xl">
              Host it yourself
            </h2>
            <p className="mt-5 text-lg text-mk-muted">
              Three steps from the repository to a running instance.
            </p>
          </div>

          <ol className="mt-14 grid gap-5 lg:grid-cols-3">
            {STEPS.map((step, i) => (
              <li
                key={step.title}
                className="flex min-w-0 flex-col rounded-2xl border border-mk-border bg-mk-surface p-7"
              >
                <span className="grid size-8 place-items-center rounded-full bg-primary font-mono text-sm font-bold text-primary-foreground">
                  {i + 1}
                </span>
                <h3 className="mt-5 text-lg font-bold">{step.title}</h3>
                <p className="mt-2 text-sm text-mk-muted">{step.body}</p>
                {step.code ? (
                  <div className="mt-5 overflow-hidden rounded-xl border border-mk-border bg-mk-surface-2 font-mono text-xs">
                    <div
                      aria-hidden
                      className="flex h-8 items-center gap-1.5 border-b border-mk-border px-3"
                    >
                      <span className="size-2 rounded-full bg-mk-fg/15" />
                      <span className="size-2 rounded-full bg-mk-fg/15" />
                      <span className="size-2 rounded-full bg-mk-fg/15" />
                    </div>
                    <code className="block overflow-x-auto whitespace-nowrap px-3.5 py-3 text-mk-fg">
                      {step.code}
                    </code>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>

          <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-mk-muted">
            OpenKuasa is a work in progress: some screens work with your own
            data and the rest still show sample data. It is provided as is,
            without warranty of any kind.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-mk-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <div>
              <h2 className="text-4xl font-bold tracking-tight sm:text-6xl">
                Frequently asked questions
              </h2>
              <p className="mt-5 text-lg text-mk-muted">
                Self-hosting, the hosted version and the license.
              </p>
              <div className="mt-8 rounded-2xl border border-mk-border bg-mk-surface p-6">
                <p className="font-bold">Still have questions?</p>
                <p className="mt-1 text-sm text-mk-muted">
                  Ask the community by opening an issue on GitHub.
                </p>
                <a
                  href={`${REPO_URL}/issues`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-mk-accent hover:underline"
                >
                  Open an issue
                  <ArrowRight className="size-4" />
                </a>
              </div>
            </div>

            <div className="space-y-3">
              {FAQS.map((faq) => (
                <details
                  key={faq.q}
                  className="group rounded-2xl border border-mk-border bg-mk-surface"
                >
                  <summary className="flex cursor-pointer select-none items-center justify-between gap-4 p-5 font-medium list-none [&::-webkit-details-marker]:hidden">
                    {faq.q}
                    <Plus className="size-4 shrink-0 text-mk-subtle transition-transform group-open:rotate-45" />
                  </summary>
                  <p className="border-t border-mk-border px-5 py-4 text-sm leading-relaxed text-mk-muted">
                    {faq.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative overflow-hidden border-t border-mk-border">
        <div aria-hidden className={GLOW} />

        <div className="relative mx-auto max-w-3xl px-6 py-32 text-center sm:py-44">
          <h2 className="text-4xl font-bold tracking-tight sm:text-6xl">
            Built in the open, by its community
          </h2>
          <p className="mt-5 text-lg text-mk-muted">
            Run it, read it, improve it. OpenKuasa belongs to the people who
            build it.
          </p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="rounded-full">
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                Get the code
                <ArrowRight className="size-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className={OUTLINE}>
              <a
                href={`${REPO_URL}/blob/main/CONTRIBUTING.md`}
                target="_blank"
                rel="noreferrer"
              >
                Contribute
              </a>
            </Button>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
