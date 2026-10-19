import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { GitHubIcon } from '@/components/brand/github-icon';
import { REPO_URL } from '@/config/marketing';

export const metadata: Metadata = {
  title: 'Privacy · OpenKuasa',
};

type Section = {
  h: string;
  p: string;
  link?: { label: string; href: string };
};

const SECTIONS: Section[] = [
  {
    h: 'The short version',
    p: 'OpenKuasa is free, open-source software that you host yourself. When you self-host, the OpenKuasa project does not run your instance and does not collect, receive or store any of your data.',
  },
  {
    h: 'What the project collects',
    p: 'Nothing. The software contains no analytics, tracking or telemetry, and it does not send information back to the project or its contributors.',
  },
  {
    h: 'Who is responsible for your data',
    p: 'Whoever runs an OpenKuasa instance is responsible for the data in it. If you self-host, that is you: you decide what is collected, where it is stored, who can access it and how long it is kept, and you are responsible for complying with the laws that apply to you, such as Malaysia\'s Personal Data Protection Act 2010.',
  },
  {
    h: 'The planned hosted version',
    p: 'A paid hosted version of OpenKuasa is planned but is not available yet. Before it accepts any customers it will publish its own privacy policy describing what is collected, how it is used and where it is stored. Until then, this page covers the self-hosted software only.',
  },
  {
    h: 'Using an instance run by someone else',
    p: 'If a company or another person gave you access to an OpenKuasa instance, they are the operator of that instance and their privacy policy applies, not this page. Contact them with any request about your data. The OpenKuasa project has no access to it.',
  },
  {
    h: 'Third-party services',
    p: 'An operator may connect their instance to services such as a database host or other providers. Data sent to those services is governed by the agreement between the operator and that provider.',
  },
  {
    h: 'This demo',
    p: 'The screens you see in this project run on fictional sample data. Names, companies and figures shown are made up for illustration.',
  },
  {
    h: 'Independence',
    p: 'OpenKuasa is a community-run project. It is not affiliated with any other company or product, and this page says nothing about how any third party handles data.',
  },
  {
    h: 'Questions',
    p: 'For questions about the software, open an issue on the project\'s GitHub repository.',
    link: { label: 'Open an issue on GitHub', href: `${REPO_URL}/issues` },
  },
];

export default function PrivacyPage() {
  return (
    <div className="min-h-dvh w-full bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Logo />
          <Link
            href="/command"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl font-bold tracking-tight">Privacy</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated 9 October 2026
        </p>

        <div className="mt-8 space-y-8">
          {SECTIONS.map((s) => (
            <section key={s.h}>
              <h2 className="text-lg font-semibold">{s.h}</h2>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                {s.p}
              </p>
              {s.link ? (
                <a
                  href={s.link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                >
                  <GitHubIcon />
                  {s.link.label}
                </a>
              ) : null}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
