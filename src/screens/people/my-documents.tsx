import { CalendarClock, FileText } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { UploadDocumentButton } from '@/components/people/document-form';
import { DocumentRow } from '@/components/people/document-row';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInMalaysia } from '@/lib/people/dates';
import { buildMyDocumentsModel } from '@/lib/people/documents';
import { myDocumentsControls } from '@/lib/people/documents-screens';
import { LOAD_FAILED, Muted, NotLinkedCard, loadPeople } from './parts';

/**
 * The signed-in employee's own documents, issued letters and paid payslips. Anything awaiting their acknowledgement
 * comes first, with its button. Upload is drawn only when `myDocumentsControls` says so: never in the sample
 * company (not even as a disabled sample), and not for an account with no employee record.
 */
export default async function MyDocumentsScreen() {
  const { model: loadedModel, viewer } = await loadPeople('my-documents', async (data, now, ctx) => {
    const today = todayInMalaysia(now);
    // Not linked to an employee: nothing to read, the builder answers "not linked".
    if (ctx.viewer.employeeId === null) {
      return {
        orgId: ctx.orgId,
        my: buildMyDocumentsModel({ documents: [], letters: [], payslips: [], today, viewer: ctx.viewer }),
      };
    }
    const [documents, letters, payslips] = await Promise.all([
      data.listDocuments(),
      data.listLetters(),
      data.listPayslips(ctx.viewer.employeeId),
    ]);
    return { orgId: ctx.orgId, my: buildMyDocumentsModel({ documents, letters, payslips, today, viewer: ctx.viewer }) };
  });

  const model = loadedModel?.my ?? null;
  const orgId = loadedModel?.orgId ?? null;
  const controls = myDocumentsControls(viewer, model, orgId);

  const header = (
    <PageHeader
      title="My Documents"
      subtitle="Your documents, letters and payslips."
      actions={
        controls.upload && orgId && model && model.linked ? (
          <UploadDocumentButton orgId={orgId} employeeId={model.employee_id} />
        ) : null
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
                      <DocumentRow key={`${row.kind}-${row.id}`} row={row} />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
                <span>
                  {loaded.documents} {loaded.documents === 1 ? 'document' : 'documents'} · {loaded.letters}{' '}
                  {loaded.letters === 1 ? 'letter' : 'letters'} · {loaded.payslips}{' '}
                  {loaded.payslips === 1 ? 'payslip' : 'payslips'}
                </span>
                <span className="flex items-center gap-1.5">
                  <CalendarClock className="size-4" aria-hidden />
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
