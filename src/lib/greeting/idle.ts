/**
 * Deterministic "nothing is waiting" greeting lines. Pure, no I/O.
 *
 * The line is chosen from a hash of (userId, date, window), so it stays the
 * same within a time-of-day window and changes across mornings and people.
 * Every line is a question the assistant can answer when clicked.
 */

import type { Festival } from '@/lib/greeting/festive';
import type { TimeOfDay } from '@/lib/greeting/time-of-day';
import type { Nudge, Surface } from '@/lib/greeting/types';

export type IdleCtx = {
  surface: Surface;
  userId: string;
  date: string;
  window: TimeOfDay['window'];
  isWeekend: boolean;
  isFriday: boolean;
  festiveWeek: Festival | null;
};

const GENERAL: Record<Surface, readonly string[]> = {
  tuah: [
    'What would you like to get done today?',
    'Anything I can look into for you?',
    'Want a quick recap of how things stand?',
    'What should we tackle first?',
    'Is there something you keep putting off?',
    'Need a hand finding something?',
    'Want to check in on any of your teams?',
    'What is on your mind today?',
  ],
  crm: [
    'Which customer should we look at today?',
    'Want to see who has gone quiet lately?',
    'Shall we draft a friendly follow-up?',
    'Who deserves a thank-you note today?',
    'Want a recap of your open deals?',
    'Should we tidy up a few customer records?',
    'Is there a new contact to add?',
    'Want to see what your pipeline looks like?',
  ],
  people: [
    'Who on the team should we check in on?',
    'Want a look at who is away this week?',
    'Shall we review upcoming leave?',
    'Is there a policy you want to update?',
    'Want to see how attendance looks lately?',
    'Need a letter or document drafted?',
    'Anyone joining soon who needs a welcome plan?',
    'Want to review the team calendar?',
  ],
  hire: [
    'Which role should we focus on today?',
    'Want a look at your open vacancies?',
    'Shall we review the latest candidates?',
    'Need a job post drafted or refreshed?',
    'Want to plan this week\'s interviews?',
    'Should we tidy up your hiring pipeline?',
    'Is there a candidate worth another look?',
    'Want help writing interview questions?',
  ],
  finance: [
    'Want a quick look at your cash position?',
    'Shall we review recent invoices?',
    'Is there a bill you want to check on?',
    'Want a summary of this month so far?',
    'Need help recording an expense?',
    'Should we look over your suppliers?',
    'Want to see how sales compare to last month?',
    'Shall we tidy up your accounts?',
  ],
  reach: [
    'What would you like to promote today?',
    'Shall we draft a new post?',
    'Want a look at how your ads are doing?',
    'Should we plan next week\'s content?',
    'Want ideas for a new campaign?',
    'Shall we review recent leads?',
    'Is there a booking form to refresh?',
    'Want to see what is working best lately?',
  ],
};

const FESTIVE: Record<Surface, readonly string[]> = {
  tuah: [
    'Festive week ahead. Want help planning around it?',
    'The holiday is close. Anything to wrap up first?',
    'Want a short list to finish before the festive break?',
  ],
  crm: [
    'Festive week ahead. Shall we send customers a greeting?',
    'The holiday is near. Anyone to follow up before it?',
    'Want to plan festive offers for your customers?',
  ],
  people: [
    'Festive week ahead. Want to check who is on leave?',
    'The holiday is near. Is the team calendar up to date?',
    'Shall we plan cover for the festive break?',
  ],
  hire: [
    'Festive week ahead. Want to line up interviews around it?',
    'The holiday is near. Any offers to send before it?',
    'Shall we plan hiring around the festive break?',
  ],
  finance: [
    'Festive week ahead. Any bills due before the holiday?',
    'The holiday is near. Want to check your cash for the break?',
    'Shall we send invoices before the festive break?',
  ],
  reach: [
    'Festive week ahead. Shall we draft a festive post?',
    'The holiday is near. Want to schedule your posts early?',
    'Want ideas for a festive campaign?',
  ],
};

/** How many general idle lines a surface has. */
export function idleLineCount(surface: Surface): number {
  return GENERAL[surface].length;
}

/** FNV-1a 32-bit hash; stable across runs and platforms. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pickIdle(ctx: IdleCtx): Nudge {
  const festive = ctx.festiveWeek !== null && (ctx.isWeekend || ctx.isFriday);
  const lines = festive ? FESTIVE[ctx.surface] : GENERAL[ctx.surface];
  const seed = hash(`${ctx.userId}|${ctx.date}|${ctx.window}|${ctx.surface}`);
  const text = lines[seed % lines.length];
  return { text, question: text };
}
