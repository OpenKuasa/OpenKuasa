import { AI_CATALOG } from '@/lib/ai-catalog';

// Root-path alias of /.well-known/ai-catalog.json, so a request to either resolves.
export const dynamic = 'force-static';

export function GET() {
  return Response.json(AI_CATALOG);
}
