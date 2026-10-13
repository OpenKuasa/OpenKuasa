import { describe, expect, it } from 'vitest';
import { KASTURI_SYSTEM, kasturiSystem } from '@/lib/ai/agents/prompts';
import { CRM_WRITE_TOOL_NAMES } from '@/lib/ai/crm-tools';

const t = KASTURI_SYSTEM.toLowerCase();

describe('KASTURI_SYSTEM', () => {
  it('is Kasturi, and never speaks as Jebat', () => {
    expect(KASTURI_SYSTEM).toMatch(/^You are Kasturi/);
    expect(KASTURI_SYSTEM).not.toMatch(/You are Jebat|Chief Marketing Officer/);
  });
  it('states writes need the owner\'s approval', () => {
    expect(t).toContain('approv');
  });
  it('carries the indirect-injection clause', () => {
    expect(t).toContain('data, not instructions');
  });
  it('calls the change tool at once instead of asking to confirm in words', () => {
    expect(t).toContain('call the change tool straight away');
    expect(t).toContain('never ask "are you sure?"');
  });
  it('tells the model to get an id from a listing instead of asking the owner', () => {
    expect(t).toContain('get its id');
    expect(t).toContain('never ask the owner for an id');
  });
  it('tells the model to report an executed change as done, not still waiting', () => {
    expect(t).toContain('already approved it');
    expect(t).toContain('past tense');
  });
  it('says what it can change, in step with the change tools it holds', () => {
    expect(t).toContain('add, edit or delete contacts');
    expect(t).toContain('add, edit, move, mark as lost, reopen or delete deals');
    // A change tool for something else means this line has to grow with it.
    expect(t).toContain('add follow-ups and mark them done');
    expect([...CRM_WRITE_TOOL_NAMES].every((name) => /Contact$|Deal(Lost)?$|FollowUp$/.test(name))).toBe(true);
  });
  it('says what it can change on the screens it shares with Jebat', () => {
    expect(t).toContain('book, edit, reschedule, cancel, complete or delete appointments');
    expect(t).toContain('create, edit, activate, pause or delete lead forms');
  });
  it('converts appointment times between Malaysia and UTC', () => {
    expect(t).toContain('3:00 pm in malaysia is 07:00 utc');
    // Lookups are already local: shifting them again was a real mistake on prod.
    expect(t).toContain('never add or subtract hours from them');
  });
  it('never promises a reminder a follow-up does not send', () => {
    expect(t).toContain('does not send anyone a notification');
  });
  it('is told today’s date in Malaysia on every turn', () => {
    // 10 Oct, 23:30 UTC is already Sunday 11 Oct, 07:30 in Malaysia.
    const prompt = kasturiSystem(new Date('2026-10-10T23:30:00.000Z'));
    expect(prompt.startsWith(KASTURI_SYSTEM)).toBe(true);
    expect(prompt).toContain('It is Sunday, 2026-10-11, 07:30 in Malaysia (UTC+8).');
  });
  it('keeps its prompt byte-identical for the same moment', () => {
    expect(kasturiSystem(new Date('2026-10-10T23:30:00.000Z'))).toBe(
      `${KASTURI_SYSTEM}\n\nTODAY\n- It is Sunday, 2026-10-11, 07:30 in Malaysia (UTC+8). Work out "today", "tomorrow", "next week" and any other date from this, never from memory.`,
    );
  });
  it('names the lookups a deal needs first', () => {
    expect(KASTURI_SYSTEM).toContain('listCrmContacts');
    expect(KASTURI_SYSTEM).toContain('listPipelines');
  });
  it('never makes up a contact\'s name or email', () => {
    expect(t).toContain('a new contact needs a first name and an email');
  });
  it('leaves leads to Jebat instead of adding a contact in their place', () => {
    expect(t).toContain("never add a contact in a lead's place");
  });
  it('never reports a failed lookup as a fact', () => {
    expect(t).toContain('never turn an error into a fact');
  });
});
