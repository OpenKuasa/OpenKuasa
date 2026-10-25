---
title: How OpenKuasa is built
description: The stack, the folders, how screens are routed, and how data is kept to its own workspace.
order: 8
ask: How is the OpenKuasa codebase organised?
---
A map of the codebase for anyone about to change it.

## Who can do this

Anyone reading or changing the code.

## The stack

- Next.js 16 (App Router, Turbopack) and React 19. Next.js 16 differs from earlier versions: read `AGENTS.md` before touching its APIs.
- TypeScript and Tailwind CSS v4, with shadcn/ui components.
- Supabase (`@supabase/ssr`) for data, sign-in, workspaces and file storage, with row-level security on every table.
- The AI SDK with OpenRouter for the assistants and agents.
- Vitest for tests.

## The products and their routes

| Product | What it is | Route | Screens in |
| --- | --- | --- | --- |
| Tuah | The AI command centre | `/command` | |
| Jebat | Ads and marketing | `/reach` | `src/screens/reach/` |
| Kasturi | CRM | `/crm` | `src/screens/crm/` |
| Lekiu | Team, HR and payroll | `/people` | `src/screens/people/` |
| Lekir | Hiring | `/hire` | `src/screens/hire/` |
| Bendahara | Finance | `/finance` | `src/screens/finance/` |

Taming Sari ("Sari") is the assistant on every screen.

## Where things are

| Folder | Holds |
| --- | --- |
| `src/config/nav.ts` | Every product's menu. |
| `src/config/live-screens.ts` | The screens that read and write the workspace's own data. Any other screen shows sample data with a work-in-progress banner. |
| `src/screens/` | The screens, one folder per product, listed in `src/screens/registry.ts`. |
| `src/app/(app)/` | The signed-in app. Each screen has its own route file here, written by `pnpm gen:routes`. |
| `src/app/api/` | Route handlers: each product's chat, the MCP server, and the scheduled endpoints. |
| `src/lib/<product>/` | Each product's data layer and rules. |
| `src/lib/ai/` | The assistants: the model provider, the key gate, the tools. |
| `src/lib/mcp/` | The MCP server. |
| `src/lib/supabase/` | Supabase clients (see below). |
| `supabase/migrations/` | The database, as SQL migrations. |
| `tests/` | The tests. |

## How a screen is routed

Each screen has its own route, so a page loads only the scripts its own screen needs. `scripts/gen-screen-routes.mjs` reads `src/screens/registry.ts` and `src/config/nav.ts`, and writes `src/app/(app)/<product>/<item>/page.tsx` for every screen that is also a menu item. It runs before `pnpm dev` and `pnpm build`. A menu item with no screen yet shows a placeholder.

Nothing in the app imports `src/screens/registry.ts`: that would put every screen's scripts on every page. See [Add a screen](/docs/developers/add-a-screen).

## The Supabase clients

- `src/lib/supabase/client.ts`: the browser client, for Client Components.
- `src/lib/supabase/server.ts`: the server client, for Server Components, Route Handlers and Server Actions.
- `src/lib/supabase/middleware.ts` with `src/proxy.ts`: refreshes the session.
- `src/lib/supabase/service.ts`: the service-role client. It bypasses row-level security, so it is server-only, and is used only for work no signed-in person does, such as the scheduled jobs.

## How data stays in its workspace

- Every row belongs to a workspace (`org_id`). People belong to workspaces through `org_members`, with the role owner, admin, member or viewer.
- Row-level security decides what each person reads and writes. Policies use the helper functions `private.is_org_member(org_id)` and `private.is_org_writer(org_id)`.
- Two-step sign-in is enforced in the database too. For a person with an authenticator whose session has passed only the password step, the membership helpers answer no, so they get no rows and no writes until they enter a code. Product tables add a restrictive `mfa_required` policy on top.
- What each role may do in the app is listed in one place, `src/lib/auth/permissions.ts`. The database enforces the same rules.
- The service role has no default rights on the tables in this project. A migration grants it what the server uses, table by table.

## Tests

`pnpm test` runs the tests once. Unit tests do not reach the network: `tests/setup/no-network.ts` refuses any `fetch` to anything but this machine and fails the file that tried. A test is live (it runs against a real Supabase project) when its name contains `.rls.` or `.live.`, or when it imports `tests/setup/supabase.ts`. Live tests use the Supabase values exported in your shell first, and `.env.local` only for what the shell does not set. `pnpm test` runs the live tests too whenever those values are set, and they write test workspaces into that project, so point them at a project made for testing.

## Related

- [Add a screen](/docs/developers/add-a-screen)
- [Contribute to OpenKuasa](/docs/developers/contributing)
- [Finance backend notes](/docs/developers/finance-backend)
- [CRM backend notes](/docs/developers/crm-backend)
