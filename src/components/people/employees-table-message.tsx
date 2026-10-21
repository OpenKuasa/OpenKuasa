/**
 * The line under the employee list's filters. An error (something did not happen) is an alert in the
 * error style; a notice (it happened, with something to know, such as a refused reporting line on a new
 * employee) is a polite status in the neutral style.
 */
export type TableMessage = { tone: 'error' | 'notice'; text: string };

export function EmployeesTableMessage({ message }: { message: TableMessage }) {
  return message.tone === 'error' ? (
    <p role="alert" className="mx-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message.text}
    </p>
  ) : (
    <p role="status" className="mx-4 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
      {message.text}
    </p>
  );
}
