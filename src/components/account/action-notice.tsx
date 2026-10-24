/**
 * The short success line under a list whose row just changed ("Key revoked."). The row is gone by the time the
 * action returns, so the line is kept by the list, not by the row's own action state.
 */
export function ActionNotice({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {text}
    </p>
  );
}
