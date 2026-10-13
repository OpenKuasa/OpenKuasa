'use client';

import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/account/user-avatar';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { useViewer } from '@/components/app/viewer-context';
import { canSee, type Capability } from '@/lib/auth/permissions';

const ITEMS: { label: string; href: string; needs?: Capability }[] = [
  { label: 'Pricing & Features', href: '/account/plan', needs: 'manage-billing' },
  { label: 'Account & Billing', href: '/account/subscriptions', needs: 'manage-billing' },
  { label: 'Role Permission', href: '/account/team' },
  { label: 'Change Password', href: '/account/security' },
  { label: 'Product Changelog', href: '/account/changelog' },
  { label: 'Contact Support', href: '/account/support' },
  { label: 'Tutorials & Docs', href: '/account/docs' },
  { label: 'Feature Requests', href: '/account/feedback' },
];

export function UserMenu() {
  const viewer = useViewer();
  const { name, initials, avatarUrl, email, orgName } = viewer;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-full border bg-background py-1 pl-1 pr-2.5 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <UserAvatar
          initials={initials[0]}
          avatarUrl={avatarUrl}
          className="size-7"
          fallbackClassName="bg-primary text-xs text-primary-foreground"
        />
        <span className="hidden max-w-32 truncate sm:inline">{name}</span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="w-64 p-0">
        {/* header */}
        <Link
          href="/account/profile"
          className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-accent"
        >
          <UserAvatar
            initials={initials}
            avatarUrl={avatarUrl}
            className="size-11"
            fallbackClassName="text-sm font-bold"
          />
          <div className="min-w-0">
            <p className="truncate font-bold leading-tight">{name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {email ? `${email} · ${orgName}` : orgName}
            </p>
            <p className="text-sm font-medium text-primary">
              Profile &amp; Preferences
            </p>
          </div>
        </Link>

        <DropdownMenuSeparator className="my-0" />

        <div className="py-1">
          {ITEMS.filter((item) => canSee(viewer, item.needs)).map((item) => (
            <DropdownMenuItem key={item.label} asChild className="px-3 py-2">
              <Link href={item.href}>{item.label}</Link>
            </DropdownMenuItem>
          ))}
        </div>

        <DropdownMenuSeparator className="my-0" />

        <div className="flex items-center justify-between px-3 py-2.5 text-sm font-medium">
          <SignOutButton className="text-primary hover:underline">
            Sign out
          </SignOutButton>
          <Link
            href="/privacy"
            className="text-muted-foreground hover:text-foreground hover:underline"
          >
            Privacy policy
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
