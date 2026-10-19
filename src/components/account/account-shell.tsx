'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { LayoutGrid, LogOut, Menu } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { AccountSidebar } from '@/components/account/account-sidebar';
import { UserMenu } from '@/components/app/user-menu';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { ThemeToggle } from '@/components/theme/theme-toggle';

export function AccountShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [prevPathname, setPrevPathname] = useState(pathname);

  // Close the mobile drawer whenever the route changes.
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setNavOpen(false);
  }

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setNavOpen(true)}
            className="-ml-1 grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:hidden"
          >
            <Menu className="size-5" />
          </button>
          <Logo wordmark="OpenKuasa" wordmarkClassName="whitespace-nowrap max-sm:hidden" />
          <span className="hidden text-muted-foreground sm:inline">·</span>
          <span className="hidden font-semibold text-muted-foreground sm:inline">
            Account
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Link
            href="/command"
            aria-label="Back to apps"
            className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <LayoutGrid className="size-5" />
          </Link>
          <SignOutButton
            aria-label="Sign out"
            className="hidden size-9 place-items-center rounded-full sm:grid text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <LogOut className="size-5" />
          </SignOutButton>
          <ThemeToggle className="rounded-full text-muted-foreground" />
          <UserMenu />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar — inline from md up */}
        <div className="hidden shrink-0 md:flex">
          <AccountSidebar />
        </div>
        <main className="flex-1 overflow-auto bg-muted/30">{children}</main>
      </div>

      {/* Sidebar — off-canvas drawer below md */}
      {navOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 shadow-xl">
            <AccountSidebar />
          </div>
        </div>
      ) : null}
    </div>
  );
}
