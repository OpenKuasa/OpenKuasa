'use client';

import { type ReactNode, createContext, useContext, useState } from 'react';
import { logoUrl } from '@/lib/account/logo-url';
import type { Letterhead } from '@/lib/people/letterhead-data';
import { letterHeadLines } from '@/lib/people/letter-marks';

type LetterheadValue = { head: Letterhead | null; workspaceName: string };

const LetterheadContext = createContext<LetterheadValue>({ head: null, workspaceName: '' });

/**
 * The workspace's letterhead, read once by the server screen and handed down here so every letter view and every
 * editor preview on the screen draws the same header without a fetch of its own. `head` is null when the read
 * failed: the header is then only the workspace name, no logo.
 */
export function LetterheadProvider({
  head,
  workspaceName,
  children,
}: {
  head: Letterhead | null;
  workspaceName: string;
  children: ReactNode;
}) {
  return <LetterheadContext.Provider value={{ head, workspaceName }}>{children}</LetterheadContext.Provider>;
}

/** The letterhead handed down by `LetterheadProvider`, for a printout that needs more of it than `LetterHead` draws. */
export function useLetterhead(): Letterhead | null {
  return useContext(LetterheadContext).head;
}

/** The logo, name, registration number and address, on screen and in print. It stays together on one page. */
export function LetterHead({ fallbackName = '' }: { fallbackName?: string }) {
  const { head, workspaceName } = useContext(LetterheadContext);
  const [logoFailed, setLogoFailed] = useState(false);
  const lines = letterHeadLines(
    head ?? { name: workspaceName || fallbackName, registration_no: null, address: null, city: null, state: null, postcode: null },
  );
  const name = lines.name === '' ? 'Your workspace' : lines.name;
  const url = head ? logoUrl(head.logo_path, { isDemo: head.isDemo }) : null;
  return (
    <div className="flex break-inside-avoid items-center gap-4">
      {url && !logoFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`${name} logo`}
          className="max-h-16 max-w-40 object-contain print:max-h-20"
          onError={() => setLogoFailed(true)}
        />
      ) : null}
      <div className="min-w-0">
        <p className="text-base font-semibold">{name}</p>
        {lines.details.map((line, index) => (
          <p key={index} className="text-xs">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
