'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { clearLogoAction, setLogoAction } from '@/app/account/logo-actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LOGO_TYPES, logoPath, logoUrl, prepareLogoFile, uploadLogoFile } from '@/lib/account/logo';
import {
  LOGO_REMOVE_PROMPT,
  logoButtonLabels,
  type LogoWorking,
} from '@/lib/account/logo-screens';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { createClient } from '@/lib/supabase/client';
import { LogoPicture } from './logo-picture';

/**
 * The editing Logo card, for an owner or admin outside the demo (the page decides with `logoCardMode`). A chosen
 * file is checked by its bytes, uploaded straight to storage under a path built here from the workspace, then
 * attached by the server action, which removes the upload itself when the database refuses. Remove has a second
 * step. A refusal leaves the old logo on screen and says why.
 */
export function LogoCard({
  orgId,
  companyName,
  initialUrl,
}: {
  orgId: string;
  companyName: string;
  initialUrl: string | null;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [working, setWorking] = useState<LogoWorking>('idle');
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const busy = working !== 'idle';
  const labels = logoButtonLabels({ hasLogo: url !== null, working });

  // Focus follows the Remove confirmation: to Keep when it opens, back to Remove when it is dismissed.
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) removeRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const save = async (chosen: File) => {
    setMessage(null);
    setWorking('saving');
    try {
      const prepared = await prepareLogoFile(chosen);
      if (!prepared.ok) {
        setMessage({ kind: 'error', text: prepared.error });
        return;
      }
      const file = prepared.input;
      const path = logoPath(orgId, file);
      const up = await uploadLogoFile(createClient(), path, file);
      if (!up.ok) {
        setMessage({ kind: 'error', text: up.error });
        return;
      }
      const set = await setLogoAction(path);
      if (!set.ok) {
        setMessage({ kind: 'error', text: set.error });
        return;
      }
      setUrl(logoUrl(set.data.logo_path, { isDemo: false }));
      setMessage({ kind: 'ok', text: 'Logo saved.' });
      router.refresh();
    } catch {
      setMessage({ kind: 'error', text: WRITE_FAILED });
    } finally {
      setWorking('idle');
    }
  };

  const remove = async () => {
    setMessage(null);
    setWorking('removing');
    try {
      const result = await clearLogoAction();
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.error });
        return;
      }
      setUrl(null);
      setConfirming(false);
      setMessage({ kind: 'ok', text: 'Logo removed.' });
      router.refresh();
    } catch {
      setMessage({ kind: 'error', text: WRITE_FAILED });
    } finally {
      setWorking('idle');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logo</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-start gap-4">
        <LogoPicture url={url} companyName={companyName} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-muted-foreground">
            Shown at the top of letters. PNG, JPEG or WebP, up to 1 MB.
          </p>
          {confirming ? (
            <div className="space-y-2">
              <p className="text-sm">{LOGO_REMOVE_PROMPT}</p>
              <div className="flex gap-2">
                <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
                  {labels.remove ?? 'Remove logo'}
                </Button>
                <Button
                  ref={keepRef}
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Keep
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={inputRef}
                type="file"
                accept={LOGO_TYPES.join(',')}
                className="sr-only"
                tabIndex={-1}
                aria-label="Choose a workspace logo"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // Clear the input so picking the same file again still fires.
                  event.target.value = '';
                  if (file) void save(file);
                }}
              />
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
                {labels.pick}
              </Button>
              {labels.remove ? (
                <Button
                  ref={removeRef}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => {
                    setMessage(null);
                    setConfirming(true);
                  }}
                >
                  {labels.remove}
                </Button>
              ) : null}
            </div>
          )}
          <div aria-live="polite" role="status">
            {message ? (
              <p className={message.kind === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
                {message.text}
              </p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
