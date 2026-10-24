import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GreetingHeading } from '@/components/chat/greeting-heading';

const greeting = {
  lead: 'Selamat pagi',
  emoji: '☀️',
  isFestive: false,
  secondHalf: '3 approvals are waiting for you.',
  secondHalfQuestion: 'Show me the approvals waiting for me',
};

const html = (
  over: {
    firstName?: string | null;
    choice?: 'device' | 'city' | 'unset';
    weatherPhrase?: string | null;
  } = {},
) =>
  renderToStaticMarkup(
    <GreetingHeading
      greeting={greeting}
      firstName={over.firstName === undefined ? 'Aisyah' : over.firstName}
      weatherPhrase={over.weatherPhrase ?? null}
      onAsk={() => {}}
      location={{
        canAsk: true,
        choice: over.choice ?? 'unset',
        onUseDevice: () => {},
        onUseCity: () => {},
      }}
    />,
  );

describe('GreetingHeading', () => {
  it('renders the composed line, the prompt and the location link', () => {
    const out = html();
    expect(out).toContain('Selamat pagi, Aisyah');
    expect(out).toContain('3 approvals are waiting for you.');
    expect(out).toContain('Use my location');
  });

  it('has no comma before the emoji without a first name', () => {
    const out = html({ firstName: null });
    expect(out).toContain('Selamat pagi ☀️');
    expect(out).not.toContain('Selamat pagi,');
  });

  it('hides the device link once declined on this device', () => {
    const out = html({ choice: 'city' });
    expect(out).not.toContain('Use my location');
  });

  it('offers the workspace city when a device location is in use', () => {
    expect(html({ choice: 'device' })).toContain('Use workspace city');
  });
});
