'use client';

import { useState } from 'react';
import { Check, Copy, Workflow } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';

/** Stands in for a key in every snippet. A real key is only ever shown once, right after it is made. */
export const KEY_PLACEHOLDER = 'okk_…';

type Snippet = { id: string; tool: string; where: string; code: string; note?: string };

/** The setup snippets for one server address. */
export function mcpSnippets(serverUrl: string): Snippet[] {
  return [
    {
      id: 'claude-code',
      tool: 'Claude Code',
      where: 'Run in a terminal',
      code: `claude mcp add --transport http openkuasa ${serverUrl} --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
    },
    {
      id: 'cursor',
      tool: 'Cursor',
      where: 'Add to ~/.cursor/mcp.json',
      code: JSON.stringify(
        { mcpServers: { openkuasa: { url: serverUrl, headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } } } },
        null,
        2,
      ),
    },
    {
      id: 'codex',
      tool: 'Codex',
      where: 'Add to ~/.codex/config.toml',
      code: `[mcp_servers.openkuasa]\nurl = "${serverUrl}"\nbearer_token_env_var = "OPENKUASA_API_KEY"`,
      note: `Then set the key in your shell: export OPENKUASA_API_KEY=${KEY_PLACEHOLDER}`,
    },
  ];
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} title={status === 'failed' ? 'Select it and copy it yourself' : undefined}>
      {status === 'copied' ? <Check /> : <Copy />}
      {status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy by hand' : label}
    </Button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs whitespace-pre">
        {code}
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

/** "Set up": the server address and how to add it to each AI tool. */
export function McpSetupCard({ serverUrl }: { serverUrl: string }) {
  return (
    <BentoCard
      title="Set up"
      subtitle="Connect an AI tool to OpenKuasa"
      icon={Workflow}
      className="col-span-2 md:col-span-12"
    >
      <div className="space-y-5 text-sm">
        <div className="space-y-1.5">
          <p className="font-medium">Server address</p>
          <CodeBlock code={serverUrl} />
        </div>

        <div className="space-y-1.5">
          <p className="font-medium">Claude Desktop and claude.ai</p>
          <p className="text-muted-foreground">
            No key needed. In Settings → Connectors, choose Add custom connector, paste the server address, then sign
            in with OpenKuasa and allow it for this workspace.
          </p>
        </div>

        {mcpSnippets(serverUrl).map((snippet) => (
          <div key={snippet.id} className="space-y-1.5">
            <p className="font-medium">
              {snippet.tool} <span className="font-normal text-muted-foreground">· {snippet.where}</span>
            </p>
            <CodeBlock code={snippet.code} />
            {snippet.note ? <p className="text-xs text-muted-foreground">{snippet.note}</p> : null}
          </div>
        ))}

        <p className="text-xs text-muted-foreground">
          Replace {KEY_PLACEHOLDER} with a key from Your API keys above.
        </p>
      </div>
    </BentoCard>
  );
}
