import type { OrgRole } from '@/lib/auth/current-org';
import { greet } from '@/lib/chat/greeting';
import { hourInMalaysia, todayInMalaysia, weekdayKey } from '@/lib/people/dates';
import { festivalWithin, festiveOn } from './festive';
import { pickIdle } from './idle';
import { pickProductNudge, pickTopNudge } from './nudge';
import { timeOfDayPhrase } from './time-of-day';
import type { Nudge, NudgeCounts, ServerGreeting, Surface } from './types';

export type AssembleInput = {
  now: Date;
  surface: Surface;
  role: OrgRole;
  userId: string;
  isDemo: boolean;
  counts: NudgeCounts;
  workspaceHolidays?: { date: string; name: string }[];
};

const MAX_HEADING = 80;

export function assembleServerGreeting(input: AssembleInput): ServerGreeting {
  const { now, surface, role, userId, isDemo, counts, workspaceHolidays } = input;
  const date = todayInMalaysia(now);
  const tod = timeOfDayPhrase(hourInMalaysia(now));
  const festival = festiveOn(date, workspaceHolidays);

  let lead = tod.lead;
  let emoji = tod.emoji;
  if (festival) {
    lead = festival.wish;
    emoji = festival.emoji;
  } else if (tod.lateNight) {
    lead = 'Still at it?';
  }

  const day = weekdayKey(date);
  const idle = () =>
    pickIdle({
      surface,
      userId,
      date,
      window: tod.window,
      isWeekend: day === 'sat' || day === 'sun',
      isFriday: day === 'fri',
      festiveWeek: festivalWithin(date, 7),
    });

  let nudge: Nudge | null = null;
  if (!isDemo) {
    nudge =
      surface === 'tuah' ? pickTopNudge(counts, role) : pickProductNudge(surface, counts, role);
  }
  const chosen = nudge ?? idle();

  return {
    lead,
    emoji,
    isFestive: festival !== null,
    secondHalf: chosen.text,
    secondHalfQuestion: chosen.question,
  };
}

type HeadingParts = {
  lead: string;
  firstName: string | null;
  emoji: string;
  weatherPhrase: string | null;
};

export function composeHeading(parts: HeadingParts): string {
  const { lead, firstName, emoji, weatherPhrase } = parts;
  const name = firstName?.trim() || null;
  const opening = lead.endsWith('?') ? greet(lead, name) : name ? `${lead}, ${name}` : lead;

  // A question already ends the sentence; do not add a full stop after it.
  const joiner = opening.endsWith('?') ? ' ' : '. ';
  const candidates = [
    ...(weatherPhrase ? [`${opening}${joiner}${weatherPhrase}`] : []),
    `${opening} ${emoji}`,
    opening,
  ];
  return candidates.find((text) => text.length <= MAX_HEADING) ?? opening;
}
