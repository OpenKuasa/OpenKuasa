import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { GitHubIcon } from '@/components/brand/github-icon';
import { REPO_URL } from '@/config/marketing';

type Col = {
  title: string;
  links: { label: string; href: string; external?: boolean }[];
};

const COLUMNS: Col[] = [
  {
    title: 'Platforms',
    links: [
      { label: 'Tuah — Command', href: '/command' },
      { label: 'Jebat — Ads', href: '/reach/assistant' },
      { label: 'Kasturi — CRM', href: '/crm/assistant' },
      { label: 'Lekiu — Team', href: '/people/assistant' },
      { label: 'Lekir — Recruit', href: '/hire/assistant' },
      { label: 'Bendahara — Finance', href: '/finance/assistant' },
    ],
  },
  {
    title: 'Apps',
    links: [
      { label: 'Ad Studio', href: '/reach/ad-studio' },
      { label: 'Payroll', href: '/people/payroll' },
      { label: 'e-Invoice LHDN', href: '/finance/e-invoice' },
      { label: 'Ask Sari', href: '/command' },
      { label: 'Marketplace Apps', href: '#marketplace' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Pricing', href: '/pricing' },
      { label: 'Tutorials & Docs', href: '/account/docs' },
      { label: 'Product Changelog', href: '/account/changelog' },
      { label: 'Feature Requests', href: '/account/feedback' },
      { label: 'GitHub', href: REPO_URL, external: true },
      {
        label: 'Contributing',
        href: `${REPO_URL}/blob/main/CONTRIBUTING.md`,
        external: true,
      },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About OpenKuasa', href: '#about' },
      { label: 'Contact Support', href: '/account/support' },
      { label: 'Terms & Conditions', href: '#terms' },
      { label: 'Privacy Policy', href: '/privacy' },
      { label: 'GDPR', href: '#gdpr' },
    ],
  },
];

const SOCIALS: { label: string; href: string; path: string }[] = [
  {
    label: 'Threads',
    href: 'https://www.threads.com/@openkuasa.os',
    path: 'M12 3c4.4 0 7 2.9 7 9s-2.6 9-7 9-7-2.9-7-9 2.6-9 7-9zm.3 5c-1.9 0-3 1-3.2 2.1l1.7.4c.1-.6.6-.9 1.4-.9 1 0 1.5.5 1.6 1.5-.5-.1-1-.2-1.6-.2-1.8 0-3 .9-3 2.4 0 1.3 1.1 2.2 2.6 2.2 1.1 0 1.9-.5 2.3-1.1.2.5.3.9.3 1l1.6-.3c-.2-.6-.3-1.3-.3-2.1v-1.6c0-2-1.2-3.3-3.4-3.3zm.1 4.3c.5 0 1 .1 1.4.2 0 1-.7 1.6-1.6 1.6-.6 0-1.1-.3-1.1-.9 0-.6.6-.9 1.3-.9z',
  },
];

export function MarketingFooter() {
  return (
    <footer className="bg-mk-surface-2 text-mk-fg">
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
          <div>
            <Logo wordmarkClassName="text-mk-fg text-2xl" />
            <p className="mt-4 max-w-xs text-sm text-mk-muted dark:text-mk-fg/55">
              The community-built, open-source operating system for growing businesses.
            </p>
            <div className="mt-5 flex gap-2.5">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="GitHub"
                className="grid size-9 place-items-center rounded-full bg-mk-fg/10 text-mk-fg/80 transition-colors hover:bg-mk-fg/20 hover:text-mk-fg"
              >
                <GitHubIcon className="size-[18px]" />
              </a>
              {SOCIALS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={s.label}
                  className="grid size-9 place-items-center rounded-full bg-mk-fg/10 text-mk-fg/80 transition-colors hover:bg-mk-fg/20 hover:text-mk-fg"
                >
                  <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor">
                    <path d={s.path} />
                  </svg>
                </a>
              ))}
            </div>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <p className="text-xs font-semibold uppercase tracking-widest text-mk-muted dark:text-mk-subtle">
                {col.title}
              </p>
              <ul className="mt-4 space-y-3 text-sm">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {l.external ? (
                      <a
                        href={l.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-mk-fg/70 transition-colors hover:text-mk-fg"
                      >
                        {l.label}
                      </a>
                    ) : (
                      <Link
                        href={l.href}
                        className="text-mk-fg/70 transition-colors hover:text-mk-fg"
                      >
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-4 border-t border-mk-border pt-6 text-sm text-mk-muted dark:text-mk-subtle sm:flex-row sm:items-center">
          <p>© 2026 OpenKuasa contributors · Independent open-source project, not affiliated with any other company or product.</p>
          <span className="inline-flex items-center gap-2">
            <span className="size-2 rounded-full bg-primary" />
            All systems operational
          </span>
        </div>
      </div>
    </footer>
  );
}
