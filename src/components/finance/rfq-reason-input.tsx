import { Input } from '@/components/ui/input';

/**
 * Why this supplier was chosen, asked beside Make purchase order. It is kept on the order and is optional here:
 * the database asks for one only when another supplier quoted the same items for less (or this quote has no
 * exchange rate to compare by), and says so in the question's refusal, so what is typed stays in the box.
 */
export function RfqReasonInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Input
      aria-label="Why this supplier was chosen"
      placeholder="Why this supplier? (optional)"
      maxLength={200}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="mt-2 block max-w-md"
    />
  );
}
