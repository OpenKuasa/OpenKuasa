import { notFound, redirect } from 'next/navigation';
import { getAllGuides } from '@/lib/docs/content';

type Props = { params: Promise<{ section: string }> };

// Only sections with guides exist; anything else is a 404 under the docs layout.
export const dynamicParams = false;

export function generateStaticParams() {
  return [...new Set(getAllGuides().map((g) => g.section))].map((section) => ({ section }));
}

// A section has no page of its own: send it to its card on the docs home.
export default async function DocsSectionPage({ params }: Props) {
  const { section } = await params;
  // The root layout renders per request, so dynamicParams alone does not 404 here.
  if (!getAllGuides().some((g) => g.section === section)) notFound();
  redirect(`/docs#${section}`);
}
