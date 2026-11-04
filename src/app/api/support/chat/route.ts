/**
 * POST /api/support/chat — the support page's Live chat (see `handleSupportChat`):
 * guides only, no workspace data, its own weekly allowance on the platform key.
 */
import { handleSupportChat } from '@/lib/ai/support-chat';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleSupportChat(request);
}
