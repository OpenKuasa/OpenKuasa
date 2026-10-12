'use client';

import { Bold, Heading, Italic, List, ListOrdered } from 'lucide-react';
import { type RefObject, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { type Mark, applyMark } from '@/lib/people/letter-marks';

const BUTTONS: { mark: Mark; label: string; Icon: typeof Bold }[] = [
  { mark: 'bold', label: 'Bold', Icon: Bold },
  { mark: 'italic', label: 'Italic', Icon: Italic },
  { mark: 'heading', label: 'Heading', Icon: Heading },
  { mark: 'bullet', label: 'Bullet list', Icon: List },
  { mark: 'number', label: 'Numbered list', Icon: ListOrdered },
];

/** The five formatting buttons. Disabled while saving and in Preview. */
export function LetterToolbar({ disabled, onMark }: { disabled: boolean; onMark: (mark: Mark) => void }) {
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-1">
      {BUTTONS.map(({ mark, label, Icon }) => (
        <Button
          key={mark}
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={disabled}
          aria-label={label}
          title={label}
          // Keep the selection in the text field instead of moving focus to the button.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onMark(mark)}
        >
          <Icon aria-hidden />
        </Button>
      ))}
    </div>
  );
}

/**
 * Applies a toolbar button to a textarea: the pure rule decides the new text and selection; this puts the text in
 * state, then restores the selection and focus once React has written it. A refusal (the length limit) is reported
 * through `onError` and changes nothing.
 */
export function useMarkApply({
  ref,
  value,
  setValue,
  max,
  onError,
}: {
  ref: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (next: string) => void;
  max: number;
  onError: (message: string | null) => void;
}) {
  const wanted = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    const target = wanted.current;
    const element = ref.current;
    if (!target || !element) return;
    wanted.current = null;
    element.focus();
    element.setSelectionRange(target.start, target.end);
  }, [value, ref]);

  return (mark: Mark) => {
    const element = ref.current;
    const result = applyMark(value, element?.selectionStart ?? value.length, element?.selectionEnd ?? value.length, mark, max);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    onError(null);
    wanted.current = { start: result.selStart, end: result.selEnd };
    if (result.text === value) {
      element?.focus();
      element?.setSelectionRange(result.selStart, result.selEnd);
      wanted.current = null;
      return;
    }
    setValue(result.text);
  };
}
