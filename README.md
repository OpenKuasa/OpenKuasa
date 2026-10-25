# OpenKuasa

**The open-source business OS for Malaysian SMEs — one self-hostable app
instead of a stack of separate CRM, HR, payroll and accounting subscriptions.**
Ads, CRM, HR, recruitment and accounting in one place, with an AI command center
on top — built in the open on Next.js, React and Supabase.

OpenKuasa is crowd-sourced: it is developed in the open by its maintainers and
volunteer contributors.

**Free to self-host, always.** A paid hosted version is planned for people who
would rather not run it themselves. It is built on the code in this repository,
which stays open source under AGPL-3.0.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="OpenKuasa — the Jebat (Ads) module overview; every module has a dashboard like this" width="900">
</p>

> [!IMPORTANT]
> **OpenKuasa is an independent, community-run project.** It is not affiliated
> with, endorsed by, or connected to any other company or product, and it speaks
> only for its own contributors.
>
> - Everything in this repository was written from scratch by the community. It
>   contains no third-party source code, proprietary assets or customer data.
> - Any third-party product or company names that come up belong to their
>   respective owners, and are used only to describe the kind of software this is
>   an alternative to.
> - The software is provided "as is", without warranty of any kind — self-host it
>   at your own risk.

## What's inside

Six modules and a cross-app assistant, named after the Malay warriors and court
of Melaka. **All 92 menu screens read and write your workspace's own data** in
Supabase. A few parts inside them are not built yet; they say so on screen
(see [Status](#status)).

| Module | What it does | Alternative to | Route | Menu screens |
| --- | --- | --- | --- | --- |
| **Tuah** | AI command center — chat with your whole business | AI business copilots | `/command` | chat |
| **Jebat** | Ads & marketing — ad studio, creative bank, leads, lead forms, an autonomous weekly agent | ad platforms & agencies | `/reach` | 8 |
| **Kasturi** | CRM — contacts, deals, broadcast, automations, landing pages, chatbot, an AI agent | CRM tools | `/crm` | 15 |
| **Lekiu** | Team — employees, attendance, rosters, leave, claims, payroll, performance | HR & payroll suites | `/people` | 31 |
| **Lekir** | Recruit — jobs, careers page, candidates, interviews, talent pool | recruiting (ATS) | `/hire` | 9 |
| **Bendahara** | Finance — sales, purchases, cash book, banking, multi-currency, double-entry ledger, SST, reports, an AI agent | accounting software | `/finance` | 29 |
| **Taming Sari** | "Sari", the assistant available from every screen | — | everywhere | — |

The menus live in `src/config/nav.ts`, and `src/config/live-screens.ts` lists
the screens that use live data. The screens are in `src/screens/` and are
listed in `src/screens/registry.ts`; each one is served by its own route file
under `src/app/(app)/`, written by `pnpm gen:routes` (see
[Adding a screen](CONTRIBUTING.md#adding-a-screen)).

### What works today

- **Tuah and Sari** — chat on OpenRouter through the Vercel AI SDK. Tuah hands
  each question to a specialist per module (`askJebat`, `askKasturi`, …) and
  can read across every module. Reads run on their own; **every change the
  assistant proposes shows an Approve / Reject card and nothing is saved until
  you approve.** A workspace can bring its own OpenRouter key (stored
  encrypted); without one, each signed-up user gets 3 free questions a week.
- **Jebat** — campaigns, creatives, leads (with stages and promotion to a
  Kasturi contact), public lead forms at `/f/<id>`, appointments and ad
  settings. The **Weekly Studio** agent runs on a schedule you set: it reads
  the last 7 days, researches marketing angles, writes a digest, makes images
  (and optionally a video), and suggests changes that wait in an approve /
  apply queue. Runs are held to per-run, daily and weekly budget caps.
- **Kasturi** — contacts with CSV import and export, deals on a kanban with
  your own pipelines and stages, follow-ups, a calendar, automations (rules on
  contact, form and deal events), public landing pages at `/p/<id>`, email
  broadcasts through the workspace's own Resend key (with one-click
  unsubscribe), billings read from Bendahara invoices, recent activity,
  reports, and a plugins page showing which connections are set up. The
  chatbot answers visitors on your landing pages using the workspace's AI key.
- **Lekiu** — staff self-service (attendance, goals, documents, payslips),
  leave / time-off / claims / overtime applications with approval queues,
  reporting lines (a manager approves for their direct reports only),
  rosters and hours with shift swaps, timesheets, a shift calendar and an HR
  calendar, payroll runs and payslips, payment vouchers, letters on your
  letterhead in English or Malay, scorecards, reviews and training.
- **Lekir** — jobs from draft to open, a public careers page with an apply
  form, PDF CV upload and a daily cap on applications, a candidate pipeline
  with search, applications, interviews with calendar invites and feedback,
  a talent pool, and settings.
- **Bendahara** — quotations into invoices (with line and whole-document
  discounts), credit notes (with a reason), payments in, refunds, cash
  receipts, supplier bills and supplier credit notes, payment vouchers that
  pay several bills, payments out, contra entries, expenses with approval (and
  sending an approved one back), RFQs with quote comparison, purchase orders
  with approval and a printable copy, a receipts inbox (optional AI reading),
  banking with transfers, customers & suppliers, products, an editable chart
  of accounts, journals on a double-entry ledger, and profit & loss, balance
  sheet and trial balance reports with CSV export. **Foreign currency**: MYR
  is the base; accounts, documents, purchase orders and transfers can be in
  another currency, using Bank Negara Malaysia's middle rates, with a
  month-end revaluation. Also an **SST** setup and the SST-02 return, a
  dashboard and overview, an audit trail, and accounting settings (financial
  year, books lock, numbering).
- **AI agents with your own focus** (Kasturi and Bendahara) — you write in
  plain words what the agent should watch for, it reads that back as checks it
  understands, and it runs on your schedule. What it finds comes back as
  suggestions you approve or dismiss; Bendahara's agent only adds notes and
  never changes a document. A suggestion that no longer applies closes itself.
  Lekir and Lekiu are next.

### Platform

- **Workspaces and roles** — sign-up, login, password reset and multi-step
  onboarding; each workspace has owner, admin, member and viewer roles, with
  row-level security in Postgres. Two-factor sign-in with recovery codes; once
  a person turns it on, their changes need the second factor.
- **MCP server** — connect Claude Code, Claude Desktop, Cursor, Codex or any
  other MCP app at `/api/mcp`. Three tools give it the same 259 operations
  Tuah has (113 look-ups, 146 changes), run as the signed-in person under
  their own permissions, with Tuah's checks; riskier changes come back with a
  note that needs a second OK. Each person makes their own API key on
  Account → Developers (shown once, revocable). "Sign in with OpenKuasa" for
  apps that don't take a key is optional (`MCP_SIGN_IN_ENABLED`). Every change
  is written to the activity log as "via MCP", for owners and admins.
- **Demo workspace** — an optional, read-only sample workspace behind a "Try
  the demo" button on the login page (`NEXT_PUBLIC_DEMO_ENABLED=1`).
- **App shell** — a two-level sidebar (product rail + collapsible per-module
  menu), responsive down to mobile.
- **Marketing site** — landing page with a products mega-menu, pricing and
  privacy pages.
- **Account area** — 20 pages: profile, company, team, clients, security, AI
  key, notifications, plan, subscriptions, add-ons, payment methods,
  transactions, connected apps, developers, activity, changelog, docs, support
  and feedback.

## Connect an AI tool (MCP)

The server address is `https://<your-host>/api/mcp` (for openkuasa.com:
`https://openkuasa.com/api/mcp`). Make a personal API key on **Account →
Developers**, which also shows the setup for Claude Code, Codex and Cursor with
a copy button for each. The tool acts as you, with exactly what you can see and
do in the app.

The steps for each tool, and for "Sign in with OpenKuasa" (Claude Desktop and
claude.ai), are in the guides:
[Connect an AI tool (MCP)](https://openkuasa.com/docs/developers/connect-an-ai-tool) and
[Turn on Sign in with OpenKuasa](https://openkuasa.com/docs/developers/mcp-sign-in).

## Screenshots

A look at the running app (sample data):

| | |
| :---: | :---: |
| <img src="docs/screenshots/tuah.png" alt="Tuah — AI command center"><br>**Tuah** · AI command center | <img src="docs/screenshots/jebat-ad-studio.png" alt="Jebat — AI Ad Studio"><br>**Jebat** · AI Ad Studio |
| <img src="docs/screenshots/kasturi-deals.png" alt="Kasturi — deals pipeline"><br>**Kasturi** · deals pipeline | <img src="docs/screenshots/lekiu-payroll.png" alt="Lekiu — payroll"><br>**Lekiu** · payroll |
| <img src="docs/screenshots/lekir-candidates.png" alt="Lekir — candidate pipeline"><br>**Lekir** · candidate pipeline | <img src="docs/screenshots/bendahara-invoices.png" alt="Bendahara — invoicing"><br>**Bendahara** · invoicing |
| <img src="docs/screenshots/sari.png" alt="Taming Sari — the assistant, available from every screen"><br>**Taming Sari** · ask Sari from any screen | <img src="docs/screenshots/onboarding.png" alt="Multi-step onboarding"><br>**Onboarding** · multi-step setup |

## Status

OpenKuasa is in early development. Being upfront about where it stands:

- **Working** — every menu screen reads and writes real workspace data, and
  the assistants and agents call real models.
- **Not built yet, and marked on screen** — sending e-Invoices to LHDN (the
  e-Invoice screen says "Coming soon"); the SST-02 service-tax return on
  payment basis ("not ready yet"); and the Bendahara overview cards that have
  no data source yet. Lekir and Lekiu have no AI agent yet.
- **Not connected** — ad platforms (Meta and others), WhatsApp, Instagram and
  Messenger, payment gateways, bank feeds, LHDN MyInvois submission, and
  EPF / SOCSO / EIS / PCB filing or bank payment files.
- **Payroll figures are proposals** — EPF, SOCSO and EIS are worked out from
  flat rates and PCB is carried from the last payslip; a person checks and
  confirms every figure. The official SOCSO table and PCB schedule are not
  built in.

Check the figures before relying on it to run a real business. Contributions
are very welcome — see the open issues.

## Contributing

OpenKuasa is built by its contributors, and anyone can join in — code, design,
docs, translations, bug reports and ideas are all welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to get started.

- Report a bug or suggest a feature:
  [open an issue](https://github.com/OpenKuasa/OpenKuasa/issues/new/choose)
- Looking for something to pick up:
  [good first issues](https://github.com/OpenKuasa/OpenKuasa/labels/good%20first%20issue)
- Found a security problem: follow the [security policy](SECURITY.md)
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md)

One rule matters above all: **contribute only your own original work.** Never
copy code, text, designs, screenshots or assets from any proprietary product.

Contributions are accepted under a Contributor License Agreement, set out in
`CONTRIBUTING.md`. You keep your copyright, and everything accepted into this
repository stays available under AGPL-3.0.

## Stack

- **Next.js 16** (App Router, Turbopack) + **React 19**
- **TypeScript**, **Tailwind CSS v4**
- **shadcn/ui** (Radix primitives, `radix-nova` preset)
- **Supabase** (`@supabase/ssr`) for data, auth, tenancy and file storage,
  with row-level security on every table
- **Vercel AI SDK** with **OpenRouter** for the assistants and agents
- **Vitest** for tests

## Getting Started

Requires Node 22+ and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/OpenKuasa/OpenKuasa.git
cd OpenKuasa
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). With no Supabase project
set, it opens in preview mode on sample data (see below). To use your own
project, set the variables below, then run `pnpm db:migrate --apply` once to
create the tables (see [Keeping the database migrated](#keeping-the-database-migrated)).

## Environment variables

Create a `.env.local` file in the project root with your Supabase project's
values (Supabase dashboard → Project Settings → API):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
```

### Preview mode (no Supabase project)

Without those two values, `pnpm dev` and the tests run in *preview mode* on
sample data, and a production server (`pnpm start`, or any host) refuses to
serve: every request gets `503 Service unavailable` and the server log names
the missing variables. Set `OPENKUASA_PREVIEW=1` to serve the preview from a
production build on purpose. See
[Run your own copy](https://openkuasa.com/docs/developers/self-hosting).

## Self-hosting setup

`.env.example` has the full list. Beyond the two Supabase values above, more
variables turn on the rest of the app (the service-role key, the key-sealing
secret, AI models, `CRON_SECRET`, `AGENTS_ENABLED`, `MCP_SIGN_IN_ENABLED`,
`AUTH_COOKIE_SECRET` and others). A fresh Supabase project also needs some Auth
settings: anonymous sign-ins on, and hCaptcha left off. The guides explain each
variable and give the steps:

- [Run your own copy](https://openkuasa.com/docs/developers/self-hosting), including the Supabase Auth settings
- [Environment variables](https://openkuasa.com/docs/developers/environment-variables)
- [AI models and keys](https://openkuasa.com/docs/developers/ai-models-and-keys)

### Scheduled triggers (cron)

Six `POST` endpoints under `/api/agents`, `/api/finance`, `/api/hire` and
`/api/maintenance` do background work, and are meant to be called by a
scheduler you run, with `Authorization: Bearer $CRON_SECRET`. Sending the
service-role key instead is deprecated: set `CRON_ALLOW_LEGACY_KEY=false`. The
endpoints, what they answer and how to set them up are in
[Scheduled jobs](https://openkuasa.com/docs/developers/scheduled-jobs).

## Supabase helpers

- `src/lib/supabase/client.ts` — browser client (Client Components)
- `src/lib/supabase/server.ts` — server client (Server Components, Route Handlers, Server Actions)
- `src/lib/supabase/middleware.ts` + `src/proxy.ts` — session refresh

## Scripts

```bash
pnpm dev           # start the dev server
pnpm build         # production build
pnpm start         # run the production build
pnpm lint          # eslint
pnpm test          # run the tests once (vitest)
pnpm test:watch    # run the tests again on every change
pnpm smoke:routes  # check that every screen responds
pnpm gen:routes    # write the route files for the screen registry (runs before dev and build)
pnpm db:migrate    # list migrations the Supabase project lacks; --apply applies them
pnpm docs:shots   # retake docs screenshots from sample data (local server only; set DOCS_SHOTS_BASE; --only <prefix>)
pnpm eval:tuah     # run the assistant evals against real models (spends credits)
```

`pnpm docs:shots` reads `content/docs/shots/*.json` and writes `public/docs-media/`. It refuses any host
except localhost, signs in with **Try the demo**, and never clicks Save, Send, Delete or the like.

`pnpm eval:tuah` is not part of `pnpm test`. It calls real models and writes
to a real workspace, so it bills the OpenRouter key; `EVAL_RUNS` sets how many
times each case runs (3 by default).

`pnpm smoke:routes` needs a production build, so run `pnpm build` first.
Nothing else needs to be running: it starts its own server on `127.0.0.1:3100`,
requests the public pages, every account screen and every product screen, and fails if
any of them answers with something other than a page or a redirect. It works
without a Supabase project. Set `SMOKE_PORT` if port 3100 is taken.

### Keeping the database migrated

After every pull from main, bring the Supabase project in `.env.local` up to
date with `supabase/migrations`:

```bash
pnpm db:migrate           # lists what the project has not had; changes nothing
pnpm db:migrate --apply   # applies those, oldest first, once you type the project ref
```

It needs `OPENKUASA_SUPABASE_TOKEN` in `.env.local`. See
[Keep the database up to date](https://openkuasa.com/docs/developers/database-migrations).

### Testing against a live Supabase project

Some tests (`tests/*.rls.test.ts` and a few others) run against the Supabase
project in your `.env.local` and create anonymous users and workspaces. They now
remove what they create when each file finishes (workspaces first, then users),
using `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`. Without that key the tests
still run, but cleanup is skipped and a loud line says rows were left behind.
The cleanup also needs the function from
`supabase/migrations/*_delete_test_org.sql` applied (it deletes only recent, slugless, test-only workspaces, and only service_role can run it). Never commit the
key.

Every other test runs without the network. `tests/setup/no-network.ts` (loaded
before each test file) refuses `fetch` to anything but this machine and fails
the file that tried, so a unit test that forgot to fake a client cannot reach
the live project. A test file is live when its name contains `.rls.` or
`.live.`, or when it imports `tests/setup/supabase.ts`.

## License

[AGPL-3.0](LICENSE). You are free to use, modify and self-host OpenKuasa. If
you run a modified version as a network service, you must make your source
available to its users under the same license.

The license covers this project's code only. It grants no rights to any
third-party names, marks or products.

Dependencies keep their own licenses. One is not permissive: `heic-to`, which
turns a phone's HEIC photo into a JPEG in the browser and carries libheif and
libde265, is LGPL-3.0. It is used unmodified, as published on npm, where its
source and license text are.
