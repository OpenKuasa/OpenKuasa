'use client';

import { useId, useState, useTransition } from 'react';
import { archiveShiftTypeAction, saveShiftTypeAction } from '@/app/(app)/people/attendance-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { SHIFT_COLOR_CLASS, SHIFT_COLOR_LABEL, type ShiftTypeDraft, shiftTimes, toShiftTypeInput } from '@/lib/people/roster';
import { SHIFT_COLORS, type ShiftColor, type ShiftType } from '@/lib/people/types';
import { cn } from '@/lib/utils';
import { ShiftPill } from './shift-pill';

const SELECT_CLASS =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

const BLANK: ShiftTypeDraft = { name: '', is_off: false, start_time: '', end_time: '', color: 'sky' };

const draftOf = (t: ShiftType): ShiftTypeDraft => ({
  name: t.name,
  is_off: t.is_off,
  start_time: t.start_time ?? '',
  end_time: t.end_time ?? '',
  color: t.color,
});

/**
 * "Shift types" on the Shift Calendar, for owners and admins: the workspace's types with Edit and Archive (or
 * Bring back), and a form to add one or change one. A shift that ends at or before its start runs overnight. An
 * archived type stays on past shifts but cannot be picked. The database decides every change.
 */
export function ShiftTypesPanel({ types }: { types: ShiftType[] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // a type's id, 'new', or null
  const [draft, setDraft] = useState<ShiftTypeDraft>(BLANK);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, start] = useTransition();
  const ids = useId();
  const panelId = `${ids}-panel`;

  const sorted = [...types].sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));

  function run(action: () => Promise<CapResult<ShiftType>>, done: (t: ShiftType) => string) {
    setNotice(null);
    start(async () => {
      let result: CapResult<ShiftType>;
      try {
        result = await action();
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (result.ok) {
        setEditing(null);
        setNotice({ tone: 'ok', text: done(result.data) });
      } else setNotice({ tone: 'error', text: result.error });
    });
  }

  function save() {
    const converted = toShiftTypeInput(draft);
    if (!converted.ok) {
      setNotice({ tone: 'error', text: converted.error });
      return;
    }
    const id = editing && editing !== 'new' ? editing : null;
    run(
      () => saveShiftTypeAction({ id, ...converted.input }),
      (t) => (id ? `Saved ${t.name}.` : `Added ${t.name}.`),
    );
  }

  const set = <K extends keyof ShiftTypeDraft>(key: K, value: ShiftTypeDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const overnight = !draft.is_off && draft.start_time !== '' && draft.end_time !== '' && draft.end_time <= draft.start_time;

  return (
    <div className="border-t">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <p className="text-sm text-muted-foreground">Shift types are the choices in each cell.</p>
        <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
          {open ? 'Close shift types' : 'Shift types'}
        </Button>
      </div>
      {open ? (
        <div id={panelId} className="space-y-3 px-4 pb-4">
          {notice ? (
            <p role={notice.tone === 'error' ? 'alert' : 'status'} className={cn('text-sm', notice.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
              {notice.text}
            </p>
          ) : null}
          <ul className="divide-y rounded-lg border">
            {sorted.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <ShiftPill type={t} withTimes={false} />
                <span className="mr-auto text-sm text-muted-foreground">
                  {t.is_off ? 'Off' : (shiftTimes(t) ?? 'No set times')}
                  {t.archived ? ' · archived' : ''}
                </span>
                {!t.archived ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditing(t.id);
                      setDraft(draftOf(t));
                      setNotice(null);
                    }}
                  >
                    Edit
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => archiveShiftTypeAction({ id: t.id, archived: !t.archived }),
                      (saved) => (saved.archived ? `Archived ${saved.name}. Past shifts keep it.` : `${saved.name} is back.`),
                    )
                  }
                >
                  {t.archived ? 'Bring back' : 'Archive'}
                </Button>
              </li>
            ))}
          </ul>
          {editing ? (
            <form
              className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <label className="grid gap-1 text-sm">
                Name
                <Input value={draft.name} maxLength={40} required onChange={(e) => set('name', e.target.value)} disabled={busy} />
              </label>
              <label className="grid gap-1 text-sm">
                Colour
                <select className={cn(SELECT_CLASS, SHIFT_COLOR_CLASS[draft.color])} value={draft.color} disabled={busy} onChange={(e) => set('color', e.target.value as ShiftColor)}>
                  {SHIFT_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {SHIFT_COLOR_LABEL[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={draft.is_off} disabled={busy} onChange={(e) => set('is_off', e.target.checked)} />
                An off day (no times)
              </label>
              {!draft.is_off ? (
                <>
                  <label className="grid gap-1 text-sm">
                    Starts
                    <Input type="time" value={draft.start_time} disabled={busy} onChange={(e) => set('start_time', e.target.value)} />
                  </label>
                  <label className="grid gap-1 text-sm">
                    Ends
                    <Input type="time" value={draft.end_time} disabled={busy} onChange={(e) => set('end_time', e.target.value)} />
                  </label>
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    {overnight ? 'Ends the next morning (overnight).' : 'Leave both times empty for a shift with no set hours.'}
                  </p>
                </>
              ) : null}
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? 'Saving…' : editing === 'new' ? 'Add type' : 'Save type'}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing('new');
                setDraft(BLANK);
                setNotice(null);
              }}
            >
              Add a shift type
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
