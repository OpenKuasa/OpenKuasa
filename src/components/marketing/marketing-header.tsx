'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Menu, X, ArrowRight } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { GitHubIcon } from '@/components/brand/github-icon';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { GetAppButton } from '@/components/pwa/install-app';
import { MEGA_MENU, NAV_LINKS, REPO_URL } from '@/config/marketing';
import { cn } from '@/lib/utils';

export function MarketingHeader() {
  const [megaOpen, setMegaOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-mk-border bg-mk-bg/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-8">
          <Link href="/" aria-label="OpenKuasa home">
            <Logo wordmarkClassName="text-mk-fg text-xl" />
          </Link>

          <nav className="hidden items-center gap-6 text-sm text-mk-fg/75 xl:flex">
            <Link href="/" className="transition-colors hover:text-mk-fg">
              Home
            </Link>

            {/* Products — mega-menu trigger */}
            <div
              className="relative"
              onMouseEnter={() => setMegaOpen(true)}
              onMouseLeave={() => setMegaOpen(false)}
            >
              <button
                type="button"
                onClick={() => setMegaOpen((v) => !v)}
                className="flex items-center gap-1 transition-colors hover:text-mk-fg"
                aria-expanded={megaOpen}
              >
                Products
                <ChevronDown
                  className={cn(
                    'size-4 transition-transform',
                    megaOpen && 'rotate-180',
                  )}
                />
              </button>
            </div>

            {NAV_LINKS.filter((l) => l.label !== 'Home').map((l) => (
              <Link
                key={l.label}
                href={l.href}
                className="whitespace-nowrap transition-colors hover:text-mk-fg"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="hidden items-center gap-4 xl:flex">
          <ThemeToggle className="text-mk-fg/75 hover:bg-mk-fg/10 hover:text-mk-fg dark:hover:bg-mk-fg/10" />
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm font-medium text-mk-fg/75 transition-colors hover:text-mk-fg"
          >
            <GitHubIcon />
            GitHub
          </a>
          <GetAppButton className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-mk-fg/75 transition-colors hover:text-mk-fg" />
          <Link
            href="/login"
            className="text-sm font-medium text-mk-fg/75 transition-colors hover:text-mk-fg"
          >
            Login
          </Link>
          <Button asChild className="rounded-full">
            <Link href="/onboarding">Get Started</Link>
          </Button>
        </div>

        {/* mobile toggle */}
        <button
          type="button"
          className="text-mk-fg xl:hidden"
          aria-label="Toggle menu"
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X className="size-6" /> : <Menu className="size-6" />}
        </button>
      </div>

      {/* Mega-menu panel (desktop) */}
      <div
        className={cn(
          'absolute inset-x-0 top-full hidden border-b border-black/10 bg-background text-foreground shadow-xl xl:block',
          megaOpen ? 'block' : 'xl:hidden',
        )}
        onMouseEnter={() => setMegaOpen(true)}
        onMouseLeave={() => setMegaOpen(false)}
      >
        <div className="mx-auto grid max-w-7xl grid-cols-4 gap-8 px-6 py-10">
          {MEGA_MENU.map((col) => {
            const Icon = col.icon;
            return (
              <div key={col.name}>
                <div className="flex items-center gap-2.5">
                  <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-[18px]" />
                  </span>
                  <div>
                    <p className="font-bold leading-tight">{col.name}</p>
                    <p className="text-xs text-muted-foreground">{col.tagline}</p>
                  </div>
                </div>
                <ul className="mt-4 space-y-3">
                  {col.items.map((item) => (
                    <li key={item.label}>
                      <Link
                        href={col.href}
                        className="group block"
                        onClick={() => setMegaOpen(false)}
                      >
                        <span className="text-sm font-medium group-hover:text-primary">
                          {item.label}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {item.desc}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link
                  href={col.href}
                  onClick={() => setMegaOpen(false)}
                  className="mt-4 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-primary hover:underline"
                >
                  Explore all apps
                  <ArrowRight className="size-3.5" />
                </Link>
              </div>
            );
          })}
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen ? (
        <div className="border-t border-mk-border bg-mk-bg px-6 py-4 xl:hidden">
          <nav className="flex flex-col gap-1 text-sm text-mk-fg/80">
            <Link href="/" className="py-2" onClick={() => setMobileOpen(false)}>
              Home
            </Link>
            <p className="pt-3 text-xs font-semibold uppercase tracking-widest text-mk-subtle">
              Products
            </p>
            {MEGA_MENU.map((col) => (
              <Link
                key={col.name}
                href={col.href}
                className="py-2 pl-1"
                onClick={() => setMobileOpen(false)}
              >
                {col.name}{' '}
                <span className="text-mk-subtle">· {col.tagline}</span>
              </Link>
            ))}
            <div className="my-2 h-px bg-mk-border" />
            {NAV_LINKS.filter((l) => l.label !== 'Home').map((l) => (
              <Link
                key={l.label}
                href={l.href}
                className="py-2"
                onClick={() => setMobileOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 py-2"
              onClick={() => setMobileOpen(false)}
            >
              <GitHubIcon />
              GitHub
            </a>
            <GetAppButton className="flex items-center gap-2 py-2" />
            <div className="mt-3 flex items-center gap-3">
              <ThemeToggle className="shrink-0 text-mk-fg/80 hover:bg-mk-fg/10 hover:text-mk-fg dark:hover:bg-mk-fg/10" />
              <Button
                asChild
                variant="outline"
                className="flex-1 rounded-full border-mk-fg/20 bg-transparent text-mk-fg hover:bg-mk-fg/10 hover:text-mk-fg"
              >
                <Link href="/login" onClick={() => setMobileOpen(false)}>
                  Login
                </Link>
              </Button>
              <Button asChild className="flex-1 rounded-full">
                <Link href="/onboarding" onClick={() => setMobileOpen(false)}>
                  Get Started
                </Link>
              </Button>
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
