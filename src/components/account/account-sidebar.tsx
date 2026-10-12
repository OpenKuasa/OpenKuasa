'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, LogOut } from 'lucide-react';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { useViewer } from '@/components/app/viewer-context';
import { visibleAccountSections, type AccountNavItem } from '@/config/account-nav';
import { cn } from '@/lib/utils';

const HOME: AccountNavItem = { label: 'Home', href: '/account', icon: Home };

function NavLink({ item, active }: { item: AccountNavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <Icon className="size-[18px] shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function AccountSidebar() {
  const pathname = usePathname();
  const viewer = useViewer();
  const sections = visibleAccountSections(viewer);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col overflow-y-auto border-r bg-sidebar px-3 py-4">
      <NavLink item={HOME} active={pathname === '/account'} />

      {sections.map((section) => (
        <div key={section.label} className="mt-5">
          <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {section.label}
          </p>
          <div className="space-y-0.5">
            {section.items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={pathname === item.href}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="mt-auto space-y-0.5 border-t pt-4">
        <Link
          href="/command"
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Home className="size-[18px] shrink-0" />
          OpenKuasa OS home
        </Link>
        <SignOutButton className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
          <LogOut className="size-[18px] shrink-0" />
          Sign out
        </SignOutButton>
      </div>
    </aside>
  );
}
