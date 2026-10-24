'use client';

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Popover } from 'radix-ui';
import { Download, Ellipsis, EllipsisVertical, Share } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  getInstallGuide,
  getInstallState,
  getServerInstallState,
  promptInstall,
  subscribe,
  type InstallGuide,
} from '@/lib/pwa/install';
import { cn } from '@/lib/utils';

function useInstallState() {
  return useSyncExternalStore(subscribe, getInstallState, getServerInstallState);
}

const icon = 'inline size-3.5 align-text-bottom';

const STEPS: Record<InstallGuide, ReactNode[]> = {
  'chrome-desktop': [
    <>Click <EllipsisVertical aria-label="the three dots" className={icon} /> at the top right of Chrome.</>,
    <>Choose &ldquo;Cast, save, and share&rdquo;, then &ldquo;Install OpenKuasa&rdquo;.</>,
  ],
  'edge-desktop': [
    <>Click <Ellipsis aria-label="the three dots" className={icon} /> at the top right of Edge.</>,
    <>Choose &ldquo;Apps&rdquo;, then &ldquo;Install this site as an app&rdquo;.</>,
  ],
  android: [
    <>Tap <EllipsisVertical aria-label="the three dots" className={icon} /> at the top right of Chrome.</>,
    <>Tap &ldquo;Install app&rdquo; or &ldquo;Add to Home screen&rdquo;.</>,
  ],
  ios: [
    <>Tap Share <Share aria-label="Share" className={icon} /> in Safari.</>,
    <>Choose &ldquo;Add to Home Screen&rdquo;.</>,
  ],
  'mac-safari': [<>In the menu bar, choose File.</>, <>Choose &ldquo;Add to Dock&rdquo;.</>],
  other: [<>This browser can&rsquo;t install apps. Open openkuasa.com in Chrome, Edge or Safari.</>],
};

/** The install steps for the browser in use. */
export function InstallSteps({ className }: { className?: string }) {
  const steps = STEPS[getInstallGuide()];
  if (steps.length === 1) return <p className={cn('text-xs', className)}>{steps[0]}</p>;
  return (
    <ol className={cn('list-decimal space-y-1 pl-5 text-xs', className)}>
      {steps.map((step, index) => (
        <li key={index}>{step}</li>
      ))}
    </ol>
  );
}

/**
 * "Get the app": opens the browser's install prompt when it has one, otherwise a small panel with
 * this browser's steps. Hidden inside the installed app.
 */
export function GetAppButton({ className, children }: { className?: string; children?: ReactNode }) {
  const state = useInstallState();
  const label = children ?? (
    <>
      <Download className="size-4" />
      Get the app
    </>
  );
  if (state === 'hidden') return null;
  if (state === 'prompt') {
    return (
      <button type="button" onClick={() => void promptInstall()} className={className}>
        {label}
      </button>
    );
  }
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={className}>
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="z-50 w-72 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
        >
          <p className="text-sm font-semibold">Install OpenKuasa</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Get OpenKuasa in its own window, with its own icon. No download or app store needed.
          </p>
          <InstallSteps className="mt-3 text-sm" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** "Get the app" in the account menu: the install prompt, or the steps shown in the menu. */
export function InstallAppMenuItem() {
  const state = useInstallState();
  const [showSteps, setShowSteps] = useState(false);
  if (state === 'hidden') return null;
  return (
    <>
      <DropdownMenuItem
        className="px-3 py-2"
        onSelect={(event) => {
          if (state === 'prompt') {
            void promptInstall();
          } else {
            event.preventDefault();
            setShowSteps((shown) => !shown);
          }
        }}
      >
        <Download className="size-4" />
        Get the app
      </DropdownMenuItem>
      {state === 'steps' && showSteps ? (
        <InstallSteps className="px-3 pb-2 pl-8 text-muted-foreground" />
      ) : null}
    </>
  );
}
