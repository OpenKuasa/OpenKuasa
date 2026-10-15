import { AI_CATALOG } from '@/lib/ai-catalog';

// Canonical ARD path the catalog auditor fetches first.
export const dynamic = 'force-static';

export function GET() {
  return Response.json(AI_CATALOG);
}
