'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { ASSISTANT } from '@/config/nav';
import {
  ASSISTANT_FAB_HEIGHT_REM,
  ASSISTANT_FAB_OFFSET_REM,
  showsAssistantFab,
} from './assistant-fab-layout';

// The conversation carries the chat engine and the charts its replies draw.
// It is fetched when the panel is first wanted, not with every screen.
const loadConversation = () =>
  import('@/components/command/sari-conversation').then(
    (mod) => mod.SariConversation,
  );

const SariConversation = dynamic(loadConversation, {
  loading: () => (
    <div
      role="status"
      className="grid flex-1 place-items-center text-sm text-muted-foreground"
    >
      Opening {ASSISTANT.short}…
    </div>
  ),
});

/**
 * Taming Sari — the cross-app AI assistant. Floating entry point on every
 * module screen; opens a slide-over chat that reuses the command-center engine.
 * The conversation is remembered, so closing the panel or changing screen
 * brings it back as it was.
 */
export function AssistantFab() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // The Command page is this same assistant at full size; a second door to
  // it there only covers the composer.
  const onCommandPage = !showsAssistantFab(pathname);
  if (onCommandPage && open) setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Keyboard focus follows the panel: into it on open, back to the button on close.
  useEffect(() => {
    if (open) panelRef.current?.focus();
    else if (wasOpen.current) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (onCommandPage) return null;

  return (
    <>
      {!open ? (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(true)}
          // Start the download on intent, so the panel opens ready.
          onPointerEnter={() => void loadConversation()}
          onFocus={() => void loadConversation()}
          style={{
            bottom: `${ASSISTANT_FAB_OFFSET_REM}rem`,
            minHeight: `${ASSISTANT_FAB_HEIGHT_REM}rem`,
          }}
          className="brand-scope fixed right-5 z-30 inline-flex cursor-pointer items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-lg transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label={`Ask ${ASSISTANT.name}`}
        >
          <Sparkles className="size-4" />
          Ask {ASSISTANT.short}
        </button>
      ) : null}

      {open ? (
        <div className="brand-scope fixed inset-0 z-50">
          {/* Anywhere outside the panel closes it. */}
          <div
            className="absolute inset-0 bg-black/40 animate-in fade-in-0 duration-200"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={`${ASSISTANT.name} assistant`}
            className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l bg-background shadow-2xl outline-none animate-in slide-in-from-right duration-200"
          >
            <SariConversation
              compact
              pathname={pathname}
              onClose={() => setOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
