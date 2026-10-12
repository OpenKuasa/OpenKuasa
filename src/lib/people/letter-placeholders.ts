/**
 * Placeholders in a letter or template. Pure. The database fills them when a letter is started from a template
 * and refuses to issue a letter that still has one; this mirrors its rule so a screen can say which are left.
 *
 * The rule, as the database writes it (case-sensitive, no spaces inside the braces):
 * `\{(employee_name|employee_no|designation|department|join_date|company_name|today)\}`.
 * Anything else in braces (`{salary}`, `{Today}`, `{ today }`, an unclosed `{today`) is ordinary text.
 */

/** The seven names, in the database's order. */
export const PLACEHOLDERS: readonly string[] = [
  'employee_name',
  'employee_no',
  'designation',
  'department',
  'join_date',
  'company_name',
  'today',
];

const RULE = () => new RegExp(`\\{(${PLACEHOLDERS.join('|')})\\}`, 'g');

/** The known placeholders still present in `text`, in the order they first appear, each once. */
export function unfilledPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(RULE())) if (!found.includes(match[1])) found.push(match[1]);
  return found;
}

/** The known placeholders left in a letter's title and body, as {@link unfilledPlaceholders}: title first, each once. */
export function unfilledInLetter(title: string, body: string): string[] {
  const found = unfilledPlaceholders(title);
  for (const name of unfilledPlaceholders(body)) if (!found.includes(name)) found.push(name);
  return found;
}
