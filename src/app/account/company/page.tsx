import { CompanyForm } from '@/components/account/company-form';
import { LogoCard } from '@/components/account/logo-card';
import { LogoCardView } from '@/components/account/logo-card-view';
import { logoUrl } from '@/lib/account/logo-url';
import { logoCardMode } from '@/lib/account/logo-screens';
import { getCompany } from '@/lib/account/data';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';

export default async function CompanyPage() {
  const [viewer, company] = await Promise.all([getViewer(), getCompany()]);

  const readOnlyReason = viewer.isDemo
    ? "You're exploring the demo workspace, so company details are read-only."
    : can(viewer.role, 'manage-company')
      ? null
      : 'Only owners and admins can edit company details.';

  const mode = logoCardMode({ role: viewer.role, isDemo: viewer.isDemo });
  const url = logoUrl(company.logoPath, { isDemo: viewer.isDemo });

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Company details</h1>
        <p className="text-sm text-muted-foreground">
          Your organisation&apos;s information.
        </p>
      </div>

      {mode === 'edit' ? (
        <LogoCard orgId={viewer.orgId} companyName={company.name} initialUrl={url} />
      ) : (
        <LogoCardView url={url} companyName={company.name} demo={mode === 'demo'} />
      )}

      <CompanyForm company={company} readOnlyReason={readOnlyReason} />
    </div>
  );
}
