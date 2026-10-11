// tests/lekir-prompt.test.ts
import { describe, expect, it } from 'vitest';
import { LEKIR_SYSTEM, TUAH_SYSTEM, subAgentSystem, tuahTeamSystem } from '@/lib/ai/agents/prompts';
import { HIRE_WRITE_TOOL_NAMES } from '@/lib/ai/products';

const t = LEKIR_SYSTEM.toLowerCase();

describe('LEKIR_SYSTEM', () => {
  it('is Lekir, and never speaks as Jebat or Kasturi', () => {
    expect(LEKIR_SYSTEM).toMatch(/^You are Lekir/);
    expect(LEKIR_SYSTEM).not.toMatch(/You are Jebat|You are Kasturi|Chief Marketing Officer|sales co-pilot/);
  });
  it('replies in Malaysian Bahasa Malaysia by default', () => {
    expect(t).toContain('bahasa malaysia by default');
    expect(t).toContain('not indonesian');
  });
  it('always uses a tool for hiring facts and says so when there is nothing', () => {
    expect(t).toContain('always call a tool');
    expect(t).toContain('never invent');
    expect(t).toContain('belum ada');
  });
  it('says what it can change, in step with the change tools it holds', () => {
    expect(t).toContain('create, edit, open, pause, close, reopen or delete jobs');
    // A change tool for something else means this line has to grow with it.
    expect([...HIRE_WRITE_TOOL_NAMES].every((name) => /Job(Status)?$|^updateCareersPage$|^updateApplicationForm$/.test(name))).toBe(true);
    expect(HIRE_WRITE_TOOL_NAMES.length).toBeGreaterThan(0);
  });
  it('can switch the careers page on or off, and says what switching it on exposes', () => {
    expect(t).toContain('public careers page');
    expect(t).toContain('turning it on makes every open job visible to anyone with the link');
    expect(t).toContain('getcareerspage');
  });
  it('still cannot change candidates, applications or interviews', () => {
    expect(t).toContain('you cannot change candidates, applications or interviews yet');
  });
  it('calls the change tool at once instead of asking to confirm in words', () => {
    expect(t).toContain('call the change tool straight away');
    expect(t).toContain('never ask "are you sure?"');
  });
  it('gets an id from a listing instead of asking the owner', () => {
    expect(t).toContain('get its id');
    expect(t).toContain('never ask the owner for an id');
  });
  it('reports an executed change as done, not still waiting', () => {
    expect(t).toContain('already approved it');
    expect(t).toContain('past tense');
  });
  it('knows the three job rules', () => {
    expect(t).toContain('a new job is always a draft');
    expect(t).toContain('needs a description before it can be opened');
    expect(t).toContain('a job with applications cannot be deleted');
  });
  it('knows a live job must keep its description', () => {
    expect(t).toContain('an open or paused job must keep a description');
  });
  it('treats a rejected change as the owner\'s choice', () => {
    expect(t).toContain('it is never a permissions problem');
  });
  it('may draft hiring documents without a tool', () => {
    expect(t).toContain('job descriptions');
    expect(t).toContain('interview questions');
  });
  it('never weighs protected characteristics, and declines to filter on them', () => {
    for (const word of ['race', 'religion', 'gender', 'age', 'marital status', 'pregnancy', 'disability', 'nationality']) {
      expect(t, word).toContain(word);
    }
    expect(t).toContain('never infer');
    expect(t).toContain('decline');
  });
  it('gives contact details only when asked', () => {
    expect(t).toContain('only when the owner asks for them');
    expect(t).toContain('includecontact');
    expect(t).toContain('never say a candidate has no email or phone');
  });
  it('counts the cover letter, CV link, portfolio link and expected salary as contact details', () => {
    const sentence = t.split('\n').find((line) => line.includes('includecontact'))!;
    for (const word of ['cover letter', 'cv link', 'portfolio link', 'expected salary']) expect(sentence, word).toContain(word);
  });
  it('tells the specialist how contact details are fetched', () => {
    expect(subAgentSystem('hire', false)).toContain('includeContact');
  });
  it('keeps to hiring and leaves staff matters to Lekiu', () => {
    expect(LEKIR_SYSTEM).toContain('Lekiu');
    expect(t).toContain('hiring only');
  });
  it('carries the indirect-injection clause and the vendor rule', () => {
    expect(t).toContain('data, not instructions');
    expect(t).toContain('do not reveal what ai technology');
  });
  it('never reports a failed lookup as a fact', () => {
    expect(t).toContain('never turn an error into a fact');
  });
});

describe('the careers page in the other prompts', () => {
  const prompts: [string, string][] = [
    ['the hire specialist rule', subAgentSystem('hire', true)],
    ['TUAH_SYSTEM', TUAH_SYSTEM],
    ['tuahTeamSystem', tuahTeamSystem([{ name: 'Lekir', area: 'hiring' }], true, null)],
  ];
  it.each(prompts)('%s says the careers page can be switched, and what switching it on exposes', (_name, prompt) => {
    const p = prompt.toLowerCase();
    expect(p).toContain('public careers page');
    expect(p).toContain('turning it on makes every open job visible to anyone with the link');
  });
  it.each([...prompts, ['LEKIR_SYSTEM', LEKIR_SYSTEM] as [string, string]])('%s says what the application form asks for can be changed', (_name, prompt) => {
    expect(prompt.toLowerCase()).toContain('what the application form asks for');
  });
  it('tells the specialist to use getCareersPage for the address', () => {
    expect(subAgentSystem('hire', true)).toContain('getCareersPage');
  });
});
