const DATE = new Intl.DateTimeFormat('en-MY', { day: '2-digit', month: 'short', year: 'numeric' });

/** An ISO timestamp as "05 Oct 2026"; null when it is not a date. */
export function formatDate(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DATE.format(date);
}
