'use client';

import Link from 'next/link';
import { CircleUserRound, LogOut, type LucideIcon } from 'lucide-react';
import { PRODUCTS, productHref } from '@/config/nav';
import { Logo } from '@/components/brand/logo';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useIconHover } from '@animateicons/react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { cn } from '@/lib/utils';

function RailLink({
  href,
  label,
  sublabel,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  sublabel?: string;
  icon: LucideIcon;
  active?: boolean;
}) {
  const { ref, triggerProps } = useIconHover();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          {...triggerProps}
          className={cn(
            'grid size-10 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
            active &&
              'bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground',
          )}
        >
          <AnimatedIcon
            ref={ref}
            name={(Icon as unknown as { displayName?: string }).displayName}
            size={20}
          />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span className="font-semibold">{label}</span>
        {sublabel ? (
          <span className="ml-1.5 text-xs opacity-70">{sublabel}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

function RailSignOut() {
  const { ref, triggerProps } = useIconHover();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SignOutButton
          aria-label="Sign out"
          {...triggerProps}
          className="grid size-10 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <AnimatedIcon
            ref={ref}
            name={(LogOut as unknown as { displayName?: string }).displayName}
            size={20}
          />
        </SignOutButton>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span className="font-semibold">Sign out</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function ProductRail({ activeKey }: { activeKey: string | null }) {
  return (
    <aside className="flex h-full w-16 shrink-0 flex-col items-center border-r bg-sidebar py-3">
      <Link href="/command" aria-label="OpenKuasa home" className="mb-3">
        <Logo showWordmark={false} markClassName="size-9 rounded-xl" />
      </Link>

      <nav className="flex flex-1 flex-col items-center gap-1">
        {PRODUCTS.map((p) => (
          <RailLink
            key={p.key}
            href={productHref(p)}
            label={p.name}
            sublabel={p.tagline}
            icon={p.icon}
            active={activeKey === p.key}
          />
        ))}
      </nav>

      <div className="flex flex-col items-center gap-1">
        <RailLink
          href="/account"
          label="Account"
          icon={CircleUserRound}
          active={activeKey === 'account'}
        />
        <RailSignOut />
      </div>
    </aside>
  );
}
