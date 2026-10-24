/** A heading's link id: lowercase letters, digits and single hyphens. */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Ids for a list of headings; a repeat gets -2, -3 and so on. */
export function uniqueIds(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = headingId(text) || 'section';
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}
