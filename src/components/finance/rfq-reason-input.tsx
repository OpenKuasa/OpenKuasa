import { useId } from 'react';
import { Input } from '@/components/ui/input';

/** Under the box on a whole-RFQ question. The database holds the rule; the screen does not work it out for a whole RFQ. */
export const WHOLE_RFQ_REASON_HINT = "Needed when another supplier quoted less, or there's no exchange rate to compare.";

/**
 * Why this supplier was chosen, asked beside Make purchase order. It is kept on the order. The database asks for one
 * when another supplier quoted the same items for less (or this quote has no exchange rate to compare by) and says
 * so in the question's refusal, so what is typed stays in the box. `hint` is the line under the box, read with it;
 * `label` names the box when several are on screen (a split asks one for each order).
 */
export function RfqReasonInput({
  value,
  onChange,
  disabled,
  hint,
  label = 'Why this supplier was chosen',
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
  label?: string;
}) {
  const hintId = useId();
  return (
    <>
      <Input
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        placeholder="Why this supplier?"
        maxLength={200}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 block max-w-md"
      />
      {hint ? (
        <span id={hintId} className="mt-1 block text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </>
  );
}
