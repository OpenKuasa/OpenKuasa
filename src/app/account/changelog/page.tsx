const RELEASES = [
  {
    version: 'v2.4',
    date: '7 Oct 2026',
    tag: 'New',
    title: 'Bendahara — full accounting module',
    notes: [
      'e-Invoice LHDN (MyInvois) submission & validation',
      'Invoices, quotations, bills, journals & chart of accounts',
      'SST report and FX revaluation',
    ],
  },
  {
    version: 'v2.3',
    date: '2 Oct 2026',
    tag: 'New',
    title: 'Lekir — AI recruiting (ATS)',
    notes: ['Candidate pipeline (kanban)', 'Jobs, applications & interviews', 'Talent pool & careers page'],
  },
  {
    version: 'v2.2',
    date: '26 Sep 2026',
    tag: 'Improved',
    title: 'Kasturi — Deals pipeline revamp',
    notes: ['Populated, draggable deal cards', 'Per-stage totals', 'Faster board rendering'],
  },
  {
    version: 'v2.1',
    date: '18 Sep 2026',
    tag: 'Fixed',
    title: 'Spacing & viewport polish',
    notes: ['Centered content with a consistent max width', 'Tables now scroll inside their card', 'Dynamic viewport height everywhere'],
  },
];

const TAG_STYLES: Record<string, string> = {
  New: 'bg-emerald-500/15 text-emerald-600',
  Improved: 'bg-blue-500/15 text-blue-600',
  Fixed: 'bg-amber-500/15 text-amber-600',
};

export default function ChangelogPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Product Changelog</h1>
        <p className="text-sm text-muted-foreground">
          What&apos;s new in OpenKuasa.
        </p>
      </div>

      <div className="space-y-4">
        {RELEASES.map((r) => (
          <div
            key={r.version}
            className="rounded-xl border bg-card p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-bold">{r.version}</span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TAG_STYLES[r.tag]}`}
              >
                {r.tag}
              </span>
              <span className="text-sm text-muted-foreground">{r.date}</span>
            </div>
            <p className="mt-2 font-semibold">{r.title}</p>
            <ul className="mt-2 space-y-1">
              {r.notes.map((n) => (
                <li
                  key={n}
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  {n}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
