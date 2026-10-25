import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AiKeyForm, RemoveAiKeyForm } from '@/components/account/ai-key-form';
import { ReadOnlyNotice } from '@/components/account/settings-form';
import { getChatStatus } from '@/lib/ai/gate';
import { hasKeySecret } from '@/lib/ai/key-crypto';
import { WORKSPACE_KEY_TURNS_PER_DAY } from '@/lib/ai/rate-limit';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { createClient } from '@/lib/supabase/server';

export default async function AiKeyPage() {
  const viewer = await getViewer();
  const live = hasSupabaseEnv() && !viewer.isDemo;
  const status = live ? await getChatStatus(await createClient()) : null;
  const canManage = live && can(viewer.role, 'manage-ai-key');

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">AI key</h1>
        <p className="text-sm text-muted-foreground">
          Chat runs on your own OpenRouter account.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>How it works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Add one OpenRouter key for {viewer.orgName} and everyone in the
              workspace chats on it, billed to your OpenRouter account. Set a
              spending limit on the key in OpenRouter.
            </p>
            <p>
              {`As a safety net, each person can send up to ${WORKSPACE_KEY_TURNS_PER_DAY} chat requests a day on the key.`}{' '}
              The count resets at midnight UTC (8 am Malaysia time).
            </p>
            <p>
              Without a key, each person gets{' '}
              {status?.freeLimit ?? 3} free questions a week across all the
              assistants.
            </p>
            <p>
              Create a key at{' '}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary hover:underline"
              >
                openrouter.ai/keys
              </a>
              .
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace key</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {!status ? (
              <ReadOnlyNotice>
                The demo workspace shows sample answers and does not use a key.
                Sign up to add your own.
              </ReadOnlyNotice>
            ) : (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium">
                      {status.hasKey ? status.keyHint : 'No key added'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {status.hasKey
                        ? 'Chat is running on your OpenRouter account.'
                        : `You have ${status.freeRemaining} of ${status.freeLimit} free questions left this week.`}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {status.hasKey ? 'Active' : 'Not set'}
                  </span>
                </div>

                {!canManage ? (
                  <ReadOnlyNotice>
                    Only owners and admins can add or change the workspace key.
                  </ReadOnlyNotice>
                ) : !hasKeySecret() ? (
                  <ReadOnlyNotice>
                    This server is not set up to store workspace keys yet. The
                    host needs AI_KEYS_ENCRYPTION_SECRET set.
                  </ReadOnlyNotice>
                ) : (
                  <>
                    <AiKeyForm hasKey={status.hasKey} />
                    {status.hasKey ? <RemoveAiKeyForm /> : null}
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
