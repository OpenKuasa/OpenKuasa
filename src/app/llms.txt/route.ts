// Served at /llms.txt (https://llmstxt.org/): a Markdown summary for LLMs/agents.
// A metadata/route handler is needed because, without it, /llms.txt falls through
// to the [product] dynamic route and returns HTML.
const BODY = `# OpenKuasa

> Free and open-source (AGPL-3.0) all-in-one business suite for Malaysian SMEs — six products on one login, powered by Taming Sari AI.

OpenKuasa is a crowd-sourced, self-hostable platform covering marketing (Jebat), sales/CRM (Kasturi), hiring (Lekir), people & HR (Lekiu) and finance (Bendahara), orchestrated by the Tuah AI command center. The products are named for the court of Melaka.

## Pages
- [Home](https://openkuasa.com/): product overview
- [Pricing](https://openkuasa.com/pricing): free to self-host; a hosted option is planned
- [Privacy](https://openkuasa.com/privacy): privacy policy

## Source
- [GitHub](https://github.com/OpenKuasa/OpenKuasa): AGPL-3.0 source code
`;

export const dynamic = 'force-static';

export function GET() {
  return new Response(BODY, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
