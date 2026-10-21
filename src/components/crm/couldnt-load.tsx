import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';

/**
 * What a Kasturi screen shows when its live read fails and a database is
 * configured: its own header and a short message, never sample figures in
 * place of the workspace's own.
 */
export function CouldntLoad({ title, subtitle, thing }: { title: string; subtitle: string; thing: string }) {
  return (
    <ScreenContainer>
      <PageHeader title={title} subtitle={subtitle} />
      <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
        Couldn&apos;t load your {thing} — please refresh
      </p>
    </ScreenContainer>
  );
}
