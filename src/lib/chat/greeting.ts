/**
 * The first word of a name the person set themselves, or null. Callers pass only a real profile name, never
 * the email fallback or the demo guest's label, so a greeting never says "Hi smoke" or "Hi Demo".
 */
export function firstNameOf(fullName: string | null | undefined): string | null {
  const first = (fullName ?? '').trim().split(/\s+/)[0];
  return first ? first : null;
}

/** An assistant's question, addressed to the person by first name when there is one: "…, Aisyah?". */
export function greet(question: string, firstName: string | null | undefined): string {
  const name = firstName?.trim();
  if (!name) return question;
  return question.endsWith('?') ? `${question.slice(0, -1)}, ${name}?` : `${question}, ${name}`;
}
