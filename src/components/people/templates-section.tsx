'use client';

import { useState, useTransition } from 'react';
import { deleteLetterTemplateAction } from '@/app/(app)/people/letter-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { removeTemplateSentence } from '@/lib/people/letters-screens';
import { TemplateDialog } from './template-form';

export type TemplateListRow = { id: string; name: string; letter_type: string; type_label: string; title: string; body: string };

function TemplateItem({ template }: { template: TemplateListRow }) {
  const [pending, start] = useTransition();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function remove() {
    setError(null);
    start(async () => {
      try {
        const result = await deleteLetterTemplateAction({ template_id: template.id });
        if (!result.ok) setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      }
    });
  }

  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{template.name}</h3>
        <Badge variant="secondary">{template.type_label}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{template.title}</p>
      <p className="line-clamp-3 whitespace-pre-line text-xs text-muted-foreground">{template.body}</p>
      <div className="flex flex-wrap items-center gap-2">
        <TemplateDialog template={template} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          aria-expanded={removing}
          aria-label={`Remove template ${template.name}`}
          onClick={() => {
            setError(null);
            setRemoving(true);
          }}
        >
          Remove
        </Button>
      </div>
      {removing ? (
        <div className="flex flex-wrap items-center gap-2" onKeyDown={(event) => event.key === 'Escape' && setRemoving(false)}>
          <p role="alert" className="text-sm">
            {removeTemplateSentence(template.name)}
          </p>
          <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={remove}>
            {pending ? 'Working…' : 'Remove'}
          </Button>
          <Button type="button" size="sm" variant="ghost" data-autofocus autoFocus disabled={pending} onClick={() => setRemoving(false)}>
            Keep
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** The templates with Add, Edit and Remove. Owners and admins outside the demo only; the demo gets a read-only list. */
export function TemplatesSection({ rows }: { rows: TemplateListRow[] }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <TemplateDialog />
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No templates yet</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <TemplateItem key={row.id} template={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
