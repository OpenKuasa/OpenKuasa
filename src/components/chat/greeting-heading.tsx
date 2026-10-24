import type { ReactElement } from 'react';
import { composeHeading } from '@/lib/greeting/assemble';
import type { ServerGreeting } from '@/lib/greeting/types';
import { cn } from '@/lib/utils';

export type GreetingLocation = {
  canAsk: boolean;
  choice: 'device' | 'city' | 'unset';
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
  headingClassName,
}: {
  greeting: ServerGreeting;
  firstName: string | null;
  weatherPhrase: string | null;
  onAsk: (question: string) => void;
  location: GreetingLocation;
  compact?: boolean;
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

  return (
    <div className="min-w-0">
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
        className="mt-1 block text-left text-sm opacity-80 underline-offset-2 transition hover:underline hover:opacity-100"
      >
        {greeting.secondHalf}
      </button>
      {location.canAsk && location.choice !== 'city' && location.choice !== 'device' && (
        <button
          type="button"
          onClick={location.onUseDevice}
          className={cn('mt-1 block', linkClass)}
        >
          📍 Use my location for local weather
        </button>
      )}
      {location.canAsk && location.choice === 'device' && (
        <button
          type="button"
          onClick={location.onUseCity}
          className={cn('mt-1 block', linkClass)}
        >
          Use workspace city
        </button>
      )}
    </div>
  );
}
