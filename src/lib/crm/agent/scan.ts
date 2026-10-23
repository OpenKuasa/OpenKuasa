import type { Candidate } from '@/lib/agents/definition';
import { formatDay, formatRM, klDay } from '@/lib/crm/deal-stats';
import type { CrmAgentRaw } from '@/lib/crm/agent/context';

const DAY_MS = 24 * 60 * 60 * 1000;

type Deal = CrmAgentRaw['deals'][number];
type Contact = CrmAgentRaw['contacts'][number];

/** Same shape as the Overview: `Company — Title`, or just the title. */
function dealName(deal: Deal) {
  return deal.company && deal.company !== deal.title ? `${deal.company} — ${deal.title}` : deal.title;
}

/** Whole days between an ISO timestamp and `now`; null when it does not parse. */
function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / DAY_MS));
}

function ageOf(iso: string | null) {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(time) ? Infinity : time;
}

/** Oldest activity first. */
function oldestFirst<T>(rows: T[], at: (row: T) => string | null): T[] {
  return [...rows].sort((a, b) => ageOf(at(a)) - ageOf(at(b)));
}

function contactActivity(contact: Contact) {
  return contact.lastActivityAt ?? contact.createdAt;
}

/**
 * Pure: turns the snapshot into suggestions, one rule per confirmed check. Names are
 * inserted as plain data; escaping is the renderer's job. No confirmed plan, no suggestions.
 */
export function scanCrm(raw: CrmAgentRaw, now: Date): Candidate[] {
  if (!raw.plan) return [];
  const today = klDay(now);
  const dueDay = klDay(new Date(now.getTime() + DAY_MS));
  const out: Candidate[] = [];

  for (const check of raw.plan.checks) {
    const days = check.params.days;

    if (check.key === 'deal_quiet') {
      const open = raw.deals.filter((d) => d.status === 'open');
      for (const deal of oldestFirst(open, (d) => d.lastActivityAt)) {
        const n = daysSince(deal.lastActivityAt, now);
        if (n === null || n < days) continue;
        const name = dealName(deal);
        if (deal.contactId) {
          out.push({
            action: 'createFollowUp',
            input: { contactId: deal.contactId, title: `Check in on ${name}`, dueDay },
            title: `Follow up on ${name} — quiet ${n} days`,
            detail: null,
            checkKey: check.key,
          });
        } else {
          out.push({
            action: 'createAgentNote',
            input: { dealId: deal.id, body: `No activity for ${n} days.` },
            title: `Note on ${name} — quiet ${n} days`,
            detail: null,
            checkKey: check.key,
          });
        }
      }
    } else if (check.key === 'deal_closing_soon') {
      const last = klDay(new Date(now.getTime() + days * DAY_MS));
      const minValue = check.params.min_value ?? 0;
      const closing = raw.deals.filter(
        (d) =>
          d.status === 'open' &&
          d.expectedClose !== null &&
          d.expectedClose >= today &&
          d.expectedClose <= last &&
          d.value >= minValue,
      );
      for (const deal of oldestFirst(closing, (d) => d.lastActivityAt)) {
        const n = daysSince(deal.lastActivityAt, now) ?? 0;
        const closes = formatDay(deal.expectedClose as string, { year: false });
        out.push({
          action: 'createAgentNote',
          input: {
            dealId: deal.id,
            body: `Closes ${closes}, no activity for ${n} days (${formatRM(deal.value)}).`,
          },
          title: `Note on ${dealName(deal)} — closes ${closes}`,
          detail: null,
          checkKey: check.key,
        });
      }
    } else if (check.key === 'follow_up_overdue') {
      const names = new Map(raw.contacts.map((c) => [c.id, c.name]));
      const late = raw.overdue.filter((f) => f.dueAt.slice(0, 10) < today);
      for (const followUp of oldestFirst(late, (f) => f.dueAt)) {
        const since = formatDay(followUp.dueAt.slice(0, 10), { year: false });
        out.push({
          action: 'createAgentNote',
          input: {
            contactId: followUp.contactId,
            body: `Follow-up "${followUp.title}" overdue since ${since}.`,
          },
          title: `Note on ${followUp.contactName ?? names.get(followUp.contactId) ?? 'a contact'} — overdue follow-up`,
          detail: null,
          checkKey: check.key,
        });
      }
    } else if (check.key === 'contact_idle') {
      for (const contact of oldestFirst(raw.contacts, contactActivity)) {
        const n = daysSince(contactActivity(contact), now);
        if (n === null || n < days) continue;
        out.push({
          action: 'createFollowUp',
          input: { contactId: contact.id, title: `Check in with ${contact.name}`, dueDay },
          title: `Follow up with ${contact.name} — quiet ${n} days`,
          detail: null,
          checkKey: check.key,
        });
      }
    } else if (check.key === 'contact_new_no_follow_up') {
      const fresh = raw.contacts.filter((c) => {
        const age = daysSince(c.createdAt, now);
        return age !== null && age <= days && !c.hasOpenFollowUp;
      });
      for (const contact of oldestFirst(fresh, contactActivity)) {
        out.push({
          action: 'createFollowUp',
          input: { contactId: contact.id, title: `Welcome call with ${contact.name}`, dueDay },
          title: `Follow up with new contact ${contact.name}`,
          detail: null,
          checkKey: check.key,
        });
      }
    }
  }
  return out;
}
