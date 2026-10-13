import { describe, expect, it } from 'vitest';
import { JEBAT_SYSTEM, KASTURI_SYSTEM, LEKIR_SYSTEM, LEKIU_SYSTEM } from '@/lib/ai/agents/prompts';

// One shared LANGUAGE rule across the four product assistants (Tuah is separate).
// The latest message decides; the block leads each prompt so a short rule is followed.
const PROMPTS = {
  Jebat: JEBAT_SYSTEM,
  Kasturi: KASTURI_SYSTEM,
  Lekir: LEKIR_SYSTEM,
  Lekiu: LEKIU_SYSTEM,
};

describe.each(Object.entries(PROMPTS))('%s LANGUAGE block', (_name, prompt) => {
  const t = prompt.toLowerCase();
  const start = t.indexOf('\nlanguage\n');
  const block = t.slice(start, t.indexOf('\n\n', start + 1));

  it('is the first block of the prompt', () => {
    expect(start).toBeGreaterThan(0);
    // Only the one-paragraph introduction comes before it.
    expect(start).toBe(t.indexOf('\n\n') + 1);
  });

  it('puts the latest-message rule first, before any mention of a default', () => {
    expect(block).toMatch(/^\nlanguage\n- reply in the language of the user's latest message/);
    expect(block.indexOf('latest message')).toBeLessThan(block.indexOf('by default'));
    expect(t).not.toMatch(/- reply in bahasa malaysia by default/);
    expect(t).not.toContain('switch fully to english only if');
    expect(block).toContain('show wording, not which language to use');
  });

  it('judges each message on its own: earlier turns do not decide, a decline included', () => {
    expect(block).toContain('judge every message on its own');
    expect(block).toContain('earlier turns');
    expect(block).toContain('tool results');
    expect(block).toMatch(/names, titles and (letter bodies|notes) and of your own last reply/);
    expect(block).toContain('your own last reply');
    expect(block).toContain('does not decide');
    expect(block).toContain('a decline or a one-line answer');
  });

  it('keeps Malaysian usage, not Indonesian', () => {
    expect(block).toContain('malaysian usage, not indonesian');
  });

  it('stays short', () => {
    expect(block.length).toBeLessThan(1500);
  });
});

describe('Lekiu declines', () => {
  const t = LEKIU_SYSTEM.toLowerCase();
  const start = LEKIU_SYSTEM.indexOf('\nLETTERS AND DOCUMENTS\n');
  const section = LEKIU_SYSTEM.slice(start, LEKIU_SYSTEM.indexOf('\nWHO CAN SEE WHAT\n')).toLowerCase();

  it('speaks about the record the user named in this message, never one from earlier in the chat', () => {
    expect(section).toContain('when you decline, speak about what the person named in this message, by the name they used');
    expect(section).toContain('never swap in another letter or record from earlier in the chat');
    expect(section).toContain('if you are not sure which record they mean, say where the action is done and name no record');
  });

  it('says an employee removes only what they uploaded, and HR-added documents go through an owner or admin', () => {
    expect(section).toContain('an employee removes only a document they uploaded themselves, on their my documents page');
    expect(section).toContain("a document an owner or admin added is removed only by an owner or admin, from the employee's documents on the employees screen, never by the employee");
    expect(section).toContain('uploaded_by');
    expect(section).toContain('which case applies');
  });

  it('keeps the existing rules', () => {
    expect(section).toContain('a member never hears of a draft letter');
    expect(section).toContain("you can never do it for anyone");
    expect(section).toContain("when you decline any of this, reply in the language of the user's latest message");
    expect(t).not.toContain('`');
  });
});
