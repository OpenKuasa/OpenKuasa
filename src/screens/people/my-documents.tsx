import { CalendarClock, Download, FileText, Upload } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { LiveDot } from '@/components/ui/live-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInMalaysia } from '@/lib/people/dates';
import { type MyDocumentRow, buildMyDocumentsModel } from '@/lib/people/documents';
import { LOAD_FAILED, LaterButton, Muted, NotLinkedCard, StatusPill, loadPeople } from './parts';

/** The pill for a row: what needs the person first, then the expiry state. */
function statusOf(row: MyDocumentRow): { tone: 'good' | 'pending' | 'bad' | 'neutral'; label: string } {
  if (row.awaiting_acknowledgement) return { tone: 'pending', label: 'Needs your acknowledgement' };
  if (row.expiry === 'expired') return { tone: 'bad', label: 'Expired' };
  if (row.expiry === 'expiring') return { tone: 'bad', label: 'Expiring soon' };
  return { tone: 'neutral', label: 'Available' };
}

/** The signed-in employee's own documents, issued letters and paid payslips. */
export default async function MyDocumentsScreen() {
  const { model } = await loadPeople('my-documents', async (data, now, ctx) => {
    const today = todayInMalaysia(now);
    // Not linked to an employee: nothing to read, the builder answers "not linked".
    if (ctx.viewer.employeeId === null) {
      return buildMyDocumentsModel({ documents: [], letters: [], payslips: [], today, viewer: ctx.viewer });
    }
    const [documents, letters, payslips] = await Promise.all([
      data.listDocuments(),
      data.listLetters(),
      data.listPayslips(ctx.viewer.employeeId),
    ]);
    return buildMyDocumentsModel({ documents, letters, payslips, today, viewer: ctx.viewer });
  });

  const header = (
    <PageHeader
      title="My Documents"
      subtitle="Your documents, letters and payslips."
      actions={
        <LaterButton variant="outline" size="sm" icon={Upload}>
          Upload
        </LaterButton>
      }
    />
  );

  if (model && !model.linked) {
    return (
      <ScreenContainer>
        {header}
        <BentoGrid>
          <NotLinkedCard />
        </BentoGrid>
      </ScreenContainer>
    );
  }
  const loaded = model && model.linked ? model : null;

  return (
    <ScreenContainer>
      {header}

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Documents" value={loaded ? loaded.documents : '—'} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Needs your acknowledgement" value={loaded ? loaded.awaiting_acknowledgement : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Expiring within 90 days" value={loaded ? loaded.expiring_soon : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Payslips" value={loaded ? loaded.payslips : '—'} />
        </BentoCard>

        <BentoCard
          title="All documents"
          subtitle="Needs your acknowledgement first, then most recent"
          icon={FileText}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!loaded ? (
            LOAD_FAILED
          ) : loaded.rows.length === 0 ? (
            <Muted>No documents on file yet</Muted>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead>Document</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="whitespace-nowrap">Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loaded.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                              <FileText className="size-4" />
                            </span>
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-medium">{row.title}</span>
                              {row.awaiting_acknowledgement ? <LiveDot active /> : null}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{row.type_label}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{row.date_label}</TableCell>
                        <TableCell>
                          <StatusPill tone={statusOf(row).tone}>{statusOf(row).label}</StatusPill>
                        </TableCell>
                        <TableCell className="text-right">
                          <LaterButton variant="ghost" size="sm" icon={Download} compact>
                            Download
                          </LaterButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
                <span>
                  {loaded.documents} documents · {loaded.letters} letters · {loaded.payslips} payslips
                </span>
                <span className="flex items-center gap-1.5">
                  <CalendarClock className="size-4" />
                  {loaded.awaiting_acknowledgement} awaiting your acknowledgement
                </span>
              </div>
            </>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
