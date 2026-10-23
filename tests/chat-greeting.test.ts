import { describe, expect, it } from 'vitest';
import { firstNameOf, greet } from '@/lib/chat/greeting';
import { toViewer } from '@/lib/auth/viewer';

/** The Ask greetings use the person's first name when they set one, and nothing in its place when not. */

describe('greet', () => {
  it('adds the first name before the question mark', () => {
    expect(greet('How is the team doing?', 'Aisyah')).toBe('How is the team doing, Aisyah?');
  });
  it('leaves the question alone without a name', () => {
    expect(greet('How is the team doing?', null)).toBe('How is the team doing?');
    expect(greet('How is the team doing?', undefined)).toBe('How is the team doing?');
    expect(greet('How is the team doing?', '   ')).toBe('How is the team doing?');
  });
});

describe('firstNameOf', () => {
  it('takes the first word', () => {
    expect(firstNameOf('  Aisyah   binti Rahman ')).toBe('Aisyah');
  });
  it('is null for no name', () => {
    expect(firstNameOf('')).toBeNull();
    expect(firstNameOf('   ')).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });
});

describe('the viewer first name', () => {
  const org = { id: 'o1', name: 'Kedai', role: 'owner' as const };
  const user = (over: Record<string, unknown> = {}) =>
    ({ id: 'u1', email: 'smoke@example.com', is_anonymous: false, user_metadata: {}, ...over }) as never;

  it('comes from the profile name', () => {
    expect(toViewer(user(), org, 'Aisyah Rahman').firstName).toBe('Aisyah');
  });
  it('falls back to the sign-up name', () => {
    expect(toViewer(user({ user_metadata: { full_name: 'Farah Lee' } }), org, null).firstName).toBe('Farah');
  });
  it('is null when only the email stands in for a name, so no one is greeted as "smoke"', () => {
    const v = toViewer(user(), org, null);
    expect(v.name).toBe('smoke');
    expect(v.firstName).toBeNull();
  });
  it('is null for a demo guest', () => {
    expect(toViewer(user({ is_anonymous: true, email: null }), org, null).firstName).toBeNull();
  });
});
