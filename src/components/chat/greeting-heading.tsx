import type { ReactElement } from 'react';
import { composeHeading } from '@/lib/greeting/assemble';
import type { ServerGreeting } from '@/lib/greeting/types';
import { cn } from '@/lib/utils';

export type GreetingLocation = {
  canAsk: boolean;
  /** 'loading': this browser's saved choice is not read yet, so no link is shown. */
  choice: 'device' | 'city' | 'unset' | 'loading';
  onUseDevice: () => void;
  onUseCity: () => void;
};

/**
 * The personal greeting: one heading line, one clickable prompt, and a quiet
 * opt-in for local weather. Purely presentational: colours inherit, so it sits
 * on either the primary card (Ask boxes) or the page background (Tuah).
 */
export function GreetingHeading({
  greeting,
  firstName,
  weatherPhrase,
  onAsk,
  location,
  compact = false,
  align = 'left',
  headingClassName,
}: {
  greeting: ServerGreeting;
  firstName: string | null;
  weatherPhrase: string | null;
  onAsk: (question: string) => void;
  location: GreetingLocation;
  compact?: boolean;
  /** 'center' for the Tuah home; the product Ask boxes stay left. */
  align?: 'left' | 'center';
  headingClassName?: string;
}): ReactElement {
  const heading = composeHeading({
    lead: greeting.lead,
    firstName,
    emoji: greeting.emoji,
    weatherPhrase,
  });
  const linkClass =
    'text-xs underline-offset-2 opacity-70 transition hover:underline hover:opacity-100';
  const place = align === 'center' ? 'mx-auto text-center' : 'text-left';

  return (
    <div className={cn('min-w-0', align === 'center' && 'text-center')}>
      <h1
        className={cn(
          'font-bold tracking-tight',
          headingClassName ?? (compact ? 'text-xl' : 'text-2xl'),
        )}
      >
        {heading}
      </h1>
      <button
        type="button"
        onClick={() => onAsk(greeting.secondHalfQuestion)}
        className={cn(
          'mt-1 block text-sm opacity-80 underline-offset-2 transition',
          'hover:underline hover:opacity-100',
          place,
        )}
      >
        {greeting.secondHalf}
      </button>
      {location.canAsk && location.choice === 'unset' && (
        <button
          type="button"
          onClick={location.onUseDevice}
          className={cn('mt-1 block', linkClass, place)}
        >
          📍 Use my location for local weather
        </button>
      )}
      {location.canAsk && location.choice === 'device' && (
        <button
          type="button"
          onClick={location.onUseCity}
          className={cn('mt-1 block', linkClass, place)}
        >
          Use workspace city
        </button>
      )}
    </div>
  );
}
