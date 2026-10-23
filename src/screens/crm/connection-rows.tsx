import type { CrmConnections } from '@/lib/crm/connections';
import { SettingsRow as StatusRow, plural } from '@/components/settings/workspace-card';

// The row and the counting are shared with every product's Settings (the Workspace card).
export { SettingsRow as StatusRow, plural } from '@/components/settings/workspace-card';

/** The AI key, email sending, the landing-page chatbot and automations, each with its state and where to set it. */
export function ConnectionRows({ connections }: { connections: CrmConnections }) {
  const { hasAiKey, emailSender, pagesWithChat, automationsOn } = connections;
  return (
    <ul className="space-y-1">
      <StatusRow
        label="AI key (OpenRouter)"
        value={hasAiKey ? 'Set' : 'Not set'}
        on={hasAiKey}
        href="/account/ai"
        linkLabel={hasAiKey ? 'Manage' : 'Add a key'}
      />
      <StatusRow
        label="Email sending (Resend)"
        value={emailSender ? `From ${emailSender}` : 'Not set'}
        on={emailSender !== null}
        href="/crm/broadcast"
        linkLabel={emailSender ? 'Manage' : 'Set up'}
      />
      <StatusRow
        label="Chatbot on landing pages"
        value={
          pagesWithChat === null
            ? 'Unknown'
            : pagesWithChat === 0
              ? 'Off'
              : `On for ${plural(pagesWithChat, 'page', 'pages')}`
        }
        on={(pagesWithChat ?? 0) > 0}
        href="/crm/chatbot"
        linkLabel="Open"
      />
      <StatusRow
        label="Automations"
        value={automationsOn === null ? 'Unknown' : automationsOn === 0 ? 'None on' : `${automationsOn} on`}
        on={(automationsOn ?? 0) > 0}
        href="/crm/automations"
        linkLabel="Open"
      />
    </ul>
  );
}
