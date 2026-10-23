import type { CrmConnections } from '@/lib/crm/connections';
import { PluginsView } from './plugins-view';

/** Sample states for the no-database demo: the same screen, showing only what the live one can. */
const SAMPLE_CONNECTIONS: CrmConnections = {
  hasAiKey: true,
  emailSender: 'hello@example.com',
  pagesWithChat: 1,
  automationsOn: 2,
};

export default function PluginsScreen() {
  return <PluginsView connections={SAMPLE_CONNECTIONS} />;
}
