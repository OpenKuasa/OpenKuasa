'use client';

import { useState, useTransition } from 'react';
import { confirmFocusAction, saveFocusAction } from '@/app/(app)/crm/agent-actions';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { CrmFocusView } from '@/screens/crm/agents-view';

type Mode = 'edit' | 'review' | 'summary';

const NO_MATCH = "I couldn't match this to anything I can watch for";

function initialMode(state: CrmFocusView['state']): Mode {
  if (state === 'confirmed') return 'summary';
  if (state === 'unconfirmed') return 'review';
  return 'edit';
}

function ReadBack({ readBack, cannot }: { readBack: string[]; cannot: string[] }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <h4 className="text-sm font-medium">How I understood it</h4>
        {readBack.length === 0 ? (
          <p className="text-sm text-muted-foreground">{NO_MATCH}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {readBack.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>
      {cannot.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-sm font-medium">I can&apos;t do that</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {cannot.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The focus box: the workspace's own words, read back as the checks the agent will run.
 * Owners and admins write and confirm it; everyone else sees it.
 */
export function AgentFocus({
  focus,
  starters,
  maxChars,
  canManage,
  hasKey,
}: {
  focus: CrmFocusView;
  starters: readonly string[];
  maxChars: number;
  canManage: boolean;
  hasKey: boolean;
}) {
  const [mode, setMode] = useState<Mode>(initialMode(focus.state));
  // Where Cancel returns to from the edit box.
  const [backTo, setBackTo] = useState<Mode>(initialMode(focus.state));
  const [text, setText] = useState(focus.text);
  const [saved, setSaved] = useState({ text: focus.text, readBack: focus.readBack, cannot: focus.cannot });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    start(async () => {
      try {
        const res = await saveFocusAction(text);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSaved({ text: text.trim(), readBack: res.readBack, cannot: res.cannot });
        setMode('review');
      } catch {
        setError('Something went wrong.');
      }
    });
  }

  function confirm() {
    setError(null);
    start(async () => {
      try {
        const res = await confirmFocusAction();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setMode('summary');
      } catch {
        setError('Something went wrong.');
      }
    });
  }

  function edit() {
    setError(null);
    setText(saved.text);
    setBackTo(mode);
    setMode('edit');
  }

  const errorLine = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );

  if (mode === 'edit') {
    const trimmed = text.trim();
    const canSave = canManage && hasKey && trimmed.length > 0 && text.length <= maxChars && !pending;
    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="crm-agent-focus">What should the agent watch for?</Label>
          <Textarea
            id="crm-agent-focus"
            value={text}
            maxLength={maxChars}
            rows={4}
            disabled={!canManage || pending}
            placeholder="For example: deals quiet for a week, and new contacts nobody has called."
            onChange={(e) => setText(e.target.value)}
          />
          <p className="text-right text-xs tabular-nums text-muted-foreground">
            {text.length} / {maxChars}
          </p>
        </div>
        {canManage && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Start from an example:</p>
            <div className="flex flex-wrap gap-2">
              {starters.map((s) => (
                <Button
                  key={s}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  disabled={pending}
                  onClick={() => setText(s)}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!canSave} onClick={save}>
              {pending ? 'Reading it…' : 'Save'}
            </Button>
            {saved.text && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setMode(backTo);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Only an owner or admin can set the focus.</p>
        )}
        {errorLine}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm">{saved.text}</p>
      <ReadBack readBack={saved.readBack} cannot={saved.cannot} />
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {mode === 'review' && (
            <Button type="button" disabled={pending || saved.readBack.length === 0} onClick={confirm}>
              {pending ? 'Working…' : 'Looks right'}
            </Button>
          )}
          <Button type="button" variant="outline" disabled={pending} onClick={edit}>
            Edit
          </Button>
        </div>
      ) : (
        mode === 'review' && (
          <p className="text-sm text-muted-foreground">Waiting for an owner or admin to confirm.</p>
        )
      )}
      {errorLine}
    </div>
  );
}
