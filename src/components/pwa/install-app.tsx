'use client';

import { useState, useSyncExternalStore } from 'react';
import { Download, Share } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  getInstallState,
  getServerInstallState,
  promptInstall,
  subscribe,
} from '@/lib/pwa/install';
import { cn } from 'cn';

function useInstallState() {
  return useSyncExternalStore(subscribe, getInstallState, getServerInstallState);
}

function IosSteps({ className }: { className?: string }) {
  return (
    <ol className={cn('list-decimal space-y-1 pl-5 text-xs', className)}>
      <li>
        Tap Share <Share aria-label="Share" className="inline size-3.5 align-text-bottom" /> in Safari.
      </li>
      <li>Choose &ldquo;Add to Home Screen&rdquo;.</li>
    </ol>
  );
}

/** "Install the app" in the account menu. Shows nothing when the app is installed or the browser can't install it. */
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
        Install the app
      </DropdownMenuItem>
      {state === 'ios-steps' && showSteps ? (
        <IosSteps className="px-3 pb-2 pl-8 text-muted-foreground" />
      ) : null}
    </>
  );
}

/** "Install the app" on the landing page footer. */
export function InstallAppLink({ className }: { className?: string }) {
  const state = useInstallState();
  const [showSteps, setShowSteps] = useState(false);
  if (state === 'hidden') return null;
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={state === 'ios-steps' ? showSteps : undefined}
        onClick={() => (state === 'prompt' ? void promptInstall() : setShowSteps((shown) => !shown))}
        className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
      >
        <Download className="size-4" />
        Install the app
      </button>
      {state === 'ios-steps' && showSteps ? <IosSteps className="mt-2 opacity-80" /> : null}
    </div>
  );
}
