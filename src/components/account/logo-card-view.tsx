import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { isSampleLogo, LOGO_DEMO_NOTE } from '@/lib/account/logo-screens';
import { LogoPicture } from './logo-picture';

/** The logo with no control: for members, viewers and the demo workspace. Names no logo action. */
export function LogoCardView({
  url,
  companyName,
  demo,
}: {
  url: string | null;
  companyName: string;
  demo: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Logo</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        <LogoPicture url={url} companyName={companyName} />
        <p className="text-sm text-muted-foreground">
          {demo && isSampleLogo(url)
            ? LOGO_DEMO_NOTE
            : 'Shown on letters. Owners and admins can change it.'}
        </p>
      </CardContent>
    </Card>
  );
}
