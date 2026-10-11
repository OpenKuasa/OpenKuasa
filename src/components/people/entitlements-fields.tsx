'use client';

import { Input } from '@/components/ui/input';
import { leaveLabel } from '@/lib/people/overview';

export const ENTITLEMENT_TYPES = ['annual', 'medical', 'emergency'] as const;
export type EntitlementType = (typeof ENTITLEMENT_TYPES)[number];

/** What is typed in the three fields, as text. */
export type EntitlementValues = Record<EntitlementType, string>;

/** A balance row as `loadLeaveEntitlementsAction` returns it. */
export type LoadedEntitlement = { leave_type: string; year: number; entitled_days: number; used_days: number };

export type EntitlementChange = { leave_type: EntitlementType; year: number; days: number };

const figure = (n: number): string => String(Math.round(n * 10) / 10);

/** The fields' starting text: this year's entitlement per type, blank where the employee has no row yet. */
export function entitlementValues(rows: LoadedEntitlement[], year: number): EntitlementValues {
  const text = (type: EntitlementType) => {
    const row = rows.find((r) => r.leave_type === type && r.year === year);
    return row ? figure(row.entitled_days) : '';
  };
  return { annual: text('annual'), medical: text('medical'), emergency: text('emergency') };
}

/**
 * The entitlements to save: those whose text differs from where it started
 * and is not blank. A number outside 0 to 365 in halves is an error naming
 * the leave type, and nothing is saved.
 */
export function entitlementChanges(
  initial: EntitlementValues,
  current: EntitlementValues,
  year: number,
): { ok: true; changes: EntitlementChange[] } | { ok: false; error: string } {
  const changes: EntitlementChange[] = [];
  for (const type of ENTITLEMENT_TYPES) {
    const text = current[type].trim();
    if (text === initial[type].trim() || text === '') continue;
    const days = Number(text);
    if (!Number.isFinite(days) || days < 0 || days > 365 || !Number.isInteger(days * 2)) {
      return { ok: false, error: `${leaveLabel(type)}: use whole or half days, from 0 to 365.` };
    }
    changes.push({ leave_type: type, year, days });
  }
  return { ok: true, changes };
}

/**
 * The three entitlement fields on the employee form. `loaded` is false when
 * the balances could not be read, which leaves them out rather than showing
 * blanks that would look like zero.
 */
export function EntitlementsFields({
  year,
  loaded,
  values,
  disabled,
  onChange,
}: {
  year: number;
  loaded: boolean;
  values: EntitlementValues;
  disabled: boolean;
  onChange: (type: EntitlementType, value: string) => void;
}) {
  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <p className="text-sm font-medium">Leave entitlements for {year}</p>
        <p className="text-xs text-muted-foreground">Days per year. Changing one updates this year’s balance.</p>
      </div>
      {loaded ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {ENTITLEMENT_TYPES.map((type) => (
            <div key={type} className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">{leaveLabel(type)} (days)</span>
              <Input
                aria-label={`${leaveLabel(type)} entitlement`}
                type="number"
                inputMode="decimal"
                min={0}
                max={365}
                step={0.5}
                disabled={disabled}
                placeholder="Not set"
                value={values[type]}
                onChange={(event) => onChange(type, event.target.value)}
              />
            </div>
          ))}
        </div>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          The entitlements could not be loaded, so they are left as they are. Close this and open it again to edit them.
        </p>
      )}
    </div>
  );
}
