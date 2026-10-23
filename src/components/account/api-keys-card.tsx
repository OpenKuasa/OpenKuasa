'use client';

import { useActionState, useState } from 'react';
import { ShieldCheck, UsersRound } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ReadOnlyNotice } from '@/components/account/settings-form';
import { CopyButton } from '@/components/account/mcp-setup-card';
import { createKeyAction, revokeKeyAction } from '@/app/account/developers/actions';

/** A key as the Developers page lists it. Never the key itself: that is shown once, when it is made. */
export type KeyListing = {
  id: string;
  name: string;
  /** Whose key it is, as the Team page names them. */
  owner: string;
  isYours: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

const DATE = new Intl.DateTimeFormat('en-MY', { day: '2-digit', month: 'short', year: 'numeric' });

function when(iso: string | null): string {
  if (!iso) return 'Never used';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : `Last used ${DATE.format(date)}`;
}

function created(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `Made ${DATE.format(date)}`;
}

/** The new key, right after it is made: once, with a copy button. */
export function NewKeyNotice({ keyValue, name }: { keyValue: string; name: string }) {
  return (
    <div role="status" className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
      <p className="text-sm font-medium">{`Your new key “${name}”`}</p>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={keyValue}
          aria-label="Your new API key"
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <CopyButton text={keyValue} label="Copy key" />
      </div>
      <p className="text-xs text-muted-foreground">
        Copy it now and keep it somewhere safe. You won&apos;t see this again. Anyone with it can act as you in this
        workspace, so treat it like a password.
      </p>
    </div>
  );
}

function CreateKeyForm({ needsCode }: { needsCode: boolean }) {
  // A native form action clears the fields after each submit, which is what a code field wants.
  const [state, formAction, pending] = useActionState(createKeyAction, undefined);

  return (
    <div className="space-y-3">
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div className="min-w-40 flex-1 space-y-1.5">
          <Label htmlFor="key-name">Key name</Label>
          <Input id="key-name" name="name" placeholder="e.g. Cursor on my laptop" maxLength={60} autoComplete="off" required />
        </div>
        {needsCode ? (
          <div className="w-36 space-y-1.5">
            <Label htmlFor="key-totp">Authenticator code</Label>
            <Input
              id="key-totp"
              name="totp"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="123456"
              autoComplete="one-time-code"
              required
            />
          </div>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Making…' : 'Create key'}
        </Button>
      </form>
      {state && 'error' in state ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state && 'key' in state ? <NewKeyNotice keyValue={state.key} name={state.name} /> : null}
    </div>
  );
}

function RevokeKeyButton({ id, name }: { id: string; name: string }) {
  const [state, formAction, pending] = useActionState(revokeKeyAction, undefined);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={formAction} className="flex items-center gap-2">
        <input type="hidden" name="id" value={id} />
        {confirming ? (
          <>
            <Button key="cancel" type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button key="confirm" type="submit" variant="destructive" size="sm" disabled={pending} aria-label={`Revoke ${name}`}>
              {pending ? 'Revoking…' : 'Revoke'}
            </Button>
          </>
        ) : (
          <Button key="ask" type="button" variant="outline" size="sm" onClick={() => setConfirming(true)} aria-label={`Revoke ${name}`}>
            Revoke
          </Button>
        )}
      </form>
      {state?.error ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function KeyRows({ keys, showOwner, canRevoke }: { keys: KeyListing[] | null; showOwner: boolean; canRevoke: boolean }) {
  if (keys === null) return <p className="grid min-h-16 place-items-center text-sm text-muted-foreground">Couldn&apos;t load</p>;
  if (keys.length === 0) return <p className="text-sm text-muted-foreground">No keys yet.</p>;
  return (
    <ul className="space-y-1">
      {keys.map((key) => (
        <li
          key={key.id}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border bg-background/50 px-3 py-2"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{key.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[showOwner ? (key.isYours ? 'You' : key.owner) : null, created(key.createdAt), when(key.lastUsedAt)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          {canRevoke ? <RevokeKeyButton id={key.id} name={key.name} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** "Your API keys": the person's own keys in this workspace, and the form to make one. */
export function ApiKeysCard({
  keys,
  needsCode,
  readOnly,
}: {
  /** Null when they could not be read. */
  keys: KeyListing[] | null;
  needsCode: boolean;
  /** The demo: nothing can be made or revoked. */
  readOnly: boolean;
}) {
  return (
    <BentoCard
      title="Your API keys"
      subtitle="For Claude Code, Cursor, Codex and other tools that take a key"
      icon={ShieldCheck}
      className="col-span-2 md:col-span-12"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          A key lets an AI tool act as you in this workspace, with exactly what you can see and do. Make one per tool,
          and revoke it when you stop using that tool.
        </p>
        {readOnly ? (
          <ReadOnlyNotice>The demo workspace is read-only. Sign up to make API keys.</ReadOnlyNotice>
        ) : (
          <CreateKeyForm needsCode={needsCode} />
        )}
        <KeyRows keys={keys} showOwner={false} canRevoke={!readOnly} />
      </div>
    </BentoCard>
  );
}

/** "Workspace keys", for owners and admins: every live key in the workspace, whoever made it. */
export function WorkspaceKeysCard({ keys }: { keys: KeyListing[] | null }) {
  return (
    <BentoCard
      title="Workspace keys"
      subtitle="Every key in this workspace. Owners and admins can revoke any of them."
      icon={UsersRound}
      className="col-span-2 md:col-span-12"
    >
      <KeyRows keys={keys} showOwner canRevoke />
    </BentoCard>
  );
}
