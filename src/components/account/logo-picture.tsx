'use client';

import { useState } from 'react';
import { LOGO_EMPTY, logoShowsImage } from '@/lib/account/logo-screens';

/**
 * The logo in a fixed box that contains any aspect ratio without stretching, on a neutral ground that suits a
 * transparent PNG in both themes. A picture that fails to load falls back to the empty state, never a broken icon.
 * The image is keyed on its address so a new logo gets a fresh attempt.
 */
export function LogoPicture({ url, companyName }: { url: string | null; companyName: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showing = logoShowsImage({ url, failed: failedUrl === url });
  return (
    <div className="grid h-24 w-40 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted/40 p-2">
      {showing && url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a user's logo from public storage; sized by the box
        <img
          // An image that failed before hydration never fires onError: check it once it is mounted.
          ref={(img) => {
            if (img && img.complete && img.naturalWidth === 0) setFailedUrl(url);
          }}
          src={url}
          alt={`${companyName} logo`}
          className="h-full w-full object-contain"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span className="text-xs text-muted-foreground">{LOGO_EMPTY}</span>
      )}
    </div>
  );
}
