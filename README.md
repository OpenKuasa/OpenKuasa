# OpenKuasa OS

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
  <img src="docs/screenshots/dashboard.png" alt="OpenKuasa OS — the Jebat (Ads) module overview; every module has a dashboard like this" width="900">
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
of Melaka. **77 of the 90 menu screens read and write your workspace's own
data** in Supabase. The rest still show sample data and carry a
work-in-progress banner.

| Module | What it does | Alternative to | Route | Live / menu screens |
| --- | --- | --- | --- | --- |
| **Tuah** | AI command center — chat with your whole business | AI business copilots | `/command` | chat |
| **Jebat** | Ads & marketing — ad studio, creative bank, leads, lead forms, an autonomous weekly agent | ad platforms & agencies | `/reach` | 8 / 8 |
| **Kasturi** | CRM — contacts, deals, broadcast, automations, landing pages, chatbot | CRM tools | `/crm` | 13 / 15 |
| **Lekiu** | Team — employees, attendance, leave, claims, payroll, performance | HR & payroll suites | `/people` | 29 / 30 |
| **Lekir** | Recruit — jobs, careers page, candidates, interviews, talent pool | recruiting (ATS) | `/hire` | 8 / 9 |
| **Bendahara** | Finance — sales, purchases, cash book, banking, double-entry ledger, reports | accounting software | `/finance` | 19 / 28 |
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
  unsubscribe), billings read from Bendahara invoices, and reports. The
  chatbot answers visitors on your landing pages using the workspace's AI key.
- **Lekiu** — staff self-service (attendance, goals, documents, payslips),
  leave / time-off / claims / overtime applications with approval queues,
  reporting lines (a manager approves for their direct reports only),
  timesheets, shift calendar, payroll runs and payslips, payment vouchers,
  letters on your letterhead in English or Malay, scorecards,
  reviews and training.
- **Lekir** — jobs from draft to open, a public careers page with an apply
  form and PDF CV upload, a candidate pipeline, applications, interviews with
  calendar invites and feedback, and a talent pool.
- **Bendahara** — quotations into invoices, credit notes (with a reason),
  payments in, refunds, cash receipts, supplier bills, payment vouchers that
  pay several bills, payments out, expenses with approval, RFQs with quote
  comparison, purchase orders with approval and a printable copy, a receipts
  inbox (optional AI reading), banking with transfers, customers & suppliers,
  products, an editable chart of accounts, journals on a double-entry ledger,
  and profit & loss, balance sheet and trial balance reports with CSV export.

### Platform

- **Workspaces and roles** — sign-up, login, password reset and multi-step
  onboarding; each workspace has owner, admin, member and viewer roles, with
  row-level security in Postgres. Two-factor sign-in with recovery codes; once
  a person turns it on, their changes need the second factor.
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

## Screenshots

A look at the running app (sample data):

| | |
| :---: | :---: |
| <img src="docs/screenshots/tuah.png" alt="Tuah — AI command center"><br>**Tuah** · AI command center | <img src="docs/screenshots/jebat-ad-studio.png" alt="Jebat — AI Ad Studio"><br>**Jebat** · AI Ad Studio |
| <img src="docs/screenshots/kasturi-deals.png" alt="Kasturi — deals pipeline"><br>**Kasturi** · deals pipeline | <img src="docs/screenshots/lekiu-payroll.png" alt="Lekiu — payroll"><br>**Lekiu** · payroll |
| <img src="docs/screenshots/lekir-candidates.png" alt="Lekir — candidate pipeline"><br>**Lekir** · candidate pipeline | <img src="docs/screenshots/bendahara-invoices.png" alt="Bendahara — invoicing"><br>**Bendahara** · invoicing |
| <img src="docs/screenshots/sari.png" alt="Taming Sari — the assistant, available from every screen"><br>**Taming Sari** · ask Sari from any screen | <img src="docs/screenshots/onboarding.png" alt="Multi-step onboarding"><br>**Onboarding** · multi-step setup |

## Status

OpenKuasa OS is in early development. Being upfront about where it stands:

- **Working** — the screens listed above read and write real workspace data,
  and the assistants call real models.
- **Still sample data** — Bendahara's overview, dashboard, AI agents, e-Invoice LHDN,
  SST report, audit trail, contra entries, FX revaluation and accounting
  settings; Kasturi's AI agents and plugins; Lekir's settings (only the
  application form card is real); and the Lekiu copy of the calendar.
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
  [open an issue](https://github.com/OpenKuasa/OpenKuasaOS/issues/new/choose)
- Looking for something to pick up:
  [good first issues](https://github.com/OpenKuasa/OpenKuasaOS/labels/good%20first%20issue)
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
git clone https://github.com/OpenKuasa/OpenKuasaOS.git
cd OpenKuasaOS
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

Without those two values the app has no sign-in and no database. What it does
then depends on where it is running:

- **`pnpm dev` and tests** — it runs in *preview mode*: every visitor is a
  read-only "Guest" in a "Preview workspace" and the screens show sample data.
  Nothing needs to be set.
- **A production server (`pnpm start`, or any host)** — it refuses to serve.
  Every request gets a plain `503 Service unavailable` and the server log says
  which variables are missing. A deployment that loses a variable therefore
  fails visibly instead of quietly turning into the sample app with nobody
  signed in.
- **A production preview on purpose** — set `OPENKUASA_PREVIEW=1` on the host
  to serve the sample-data preview from a production build. The flag is only
  read when the Supabase values are missing; it does nothing on a configured
  deployment. Do not set it on the deployment that serves your real data.

The check is made per request (`src/lib/auth/preview-mode.ts`, applied in
`src/lib/supabase/middleware.ts`), so `pnpm build` works with or without the
variables. `pnpm smoke:routes` sets the flag for the server it starts.

### Optional: `AUTH_COOKIE_SECRET`

Opening a password-reset link leaves a short-lived signed cookie that the "set
a new password" form checks. It is signed with `AUTH_COOKIE_SECRET` (32+
characters) when set, otherwise with a key derived from
`AI_KEYS_ENCRYPTION_SECRET`, otherwise with a random key made when the server
starts. The last option is fine for one long-running server; if you run several
instances or a serverless host and set neither secret, set
`AUTH_COOKIE_SECRET` or reset links will intermittently be refused.

## Self-hosting setup

`.env.example` has the full list. Beyond the two Supabase values above, these
turn on the rest of the app:

| Variable | What it is for |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only work: scheduled agents, file clean-ups, reading a workspace's stored keys, test clean-up. Never expose it to the browser. |
| `AI_KEYS_ENCRYPTION_SECRET` | 32+ characters. Seals each workspace's OpenRouter and Resend keys; without it a workspace cannot save its own keys. Use the same value on every host, because changing it makes stored keys unreadable. |
| `OPENROUTER_API_KEY` | The platform key behind the 3 free questions a week for workspaces without their own key. Optional. |
| `OPENKUASA_MODEL_ORCHESTRATOR`, `OPENKUASA_MODEL_WORKER` | Models for Tuah and its specialists. `OPENKUASA_MODEL_RECEIPTS` and `OPENKUASA_MODEL_AGENT_*` override the receipt reader and the Weekly Studio steps. |
| `AI_GATEWAY_BASE_URL` | Optional gateway in front of OpenRouter. |
| `AGENTS_ENABLED` | `true` lets scheduled agent runs happen. Off by default. |
| `CRON_SECRET` | 32+ characters. Authorises the scheduled endpoints below. |
| `NEXT_PUBLIC_DEMO_ENABLED` | `1` shows the "Try the demo" button on the login page. |
| `PUBLIC_SITE_URL` | The lasting address written into broadcast unsubscribe links. |
| `RATE_LIMIT_PEPPER` | Keys the hashes the rate limiter stores, so they cannot be tested against guesses. |
| `OPENKUASA_SUPABASE_TOKEN` | A Supabase access token, used only by `pnpm db:migrate`. |

Email broadcasts use each workspace's own Resend key, entered in the app, so
there is no email variable to set.

A fresh Supabase project also needs these Auth settings (Supabase dashboard →
Authentication) for sign-in and signup to work:

- **Enable Anonymous sign-ins** — powers the demo workspace and the tests.
- **"Confirm email"** — with it off, signup creates a session immediately and
  lands on `/command`. With it on, signup stops at a "check your email" message
  and the user must confirm and sign in. An already-registered address always
  gets that same "check your email" message, so the form does not say which
  addresses have an account.
- **Leave hCaptcha OFF for now** — the auth forms don't yet pass a captcha
  token, so *enabling* hCaptcha would break sign-in and signup. Wiring the
  hCaptcha widget into the auth UI is a planned hardening step before it can be
  turned on in production.

### Scheduled triggers (cron)

Five endpoints do background work and are meant to be called by a scheduler
you run (for example a cron job every five minutes), not by a browser:

| Endpoint | What it does |
| --- | --- |
| `POST /api/agents/run` | Runs the agent schedules that are due |
| `POST /api/agents/poll` | Finishes pending videos, fails stuck runs, expires old proposals |
| `POST /api/hire/cv-cleanup` | Removes stored CV files of deleted applications |
| `POST /api/finance/receipt-cleanup` | Removes Receipts Inbox files of deleted receipts, and uploads nobody recorded within the hour |
| `POST /api/maintenance/sweep-files` | Removes document and logo files nothing points at (once a day is plenty) |

Agent runs also need `AGENTS_ENABLED=true`; without it `/api/agents/run` does
nothing. Database-side jobs (nightly attendance close, yearly leave balances,
demo data reseeds) run on `pg_cron` inside Supabase and need no scheduler.

They take no body and no parameters. Each call must carry a dedicated secret:

```bash
# Generate once, set it as CRON_SECRET on the app and on the scheduler.
openssl rand -hex 32

curl -X POST https://<your-host>/api/agents/run \
  -H "Authorization: Bearer $CRON_SECRET"
```

- `/api/finance/receipt-cleanup` answers `{"ok": true, "queued": n, "removed": n}`:
  how many unrecorded uploads it listed and how many files it removed.
  `"ok": false` means part of the work is left for the next call (it stops
  after 20 seconds); it needs attention only if it stays false for many calls
  in a row.
- `CRON_SECRET` must be at least 32 characters. Unset, empty or shorter means
  the endpoints accept nothing with it (they answer `401`).
- Use a value made for this purpose only. Do not reuse a Supabase key.
- `CRON_ALLOW_LEGACY_KEY` is a temporary switch for installs set up before
  `CRON_SECRET` existed, whose scheduler still sends the Supabase service-role
  key (in an `x-service-key` header or as the bearer token). It is on unless set
  to `false`, and every call accepted that way logs a deprecation warning. Move
  the scheduler to `CRON_SECRET`, then set `CRON_ALLOW_LEGACY_KEY=false`. New
  installs should set it to `false` from the start. The switch and the old path
  will be removed in a later release.

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
pnpm eval:tuah     # run the assistant evals against real models (spends credits)
```

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

Code that needs a table or column the database lacks fails, and some pages then
quietly show their samples instead of your data. The script uses
`OPENKUASA_SUPABASE_TOKEN` and the Supabase Management API, so no database
password is needed. It reads both variables from `.env.local` only, never from
your shell, and `--apply` asks you to type the project ref it is about to write
to (without a terminal, pass `--confirm=<ref>`). Each migration is applied in
one transaction with its record in `supabase_migrations.schema_migrations`
(created if the project has none yet), and the run stops at the first one that
fails.

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

[AGPL-3.0](LICENSE). You are free to use, modify and self-host OpenKuasa OS. If
you run a modified version as a network service, you must make your source
available to its users under the same license.

The license covers this project's code only. It grants no rights to any
third-party names, marks or products.

Dependencies keep their own licenses. One is not permissive: `heic-to`, which
turns a phone's HEIC photo into a JPEG in the browser and carries libheif and
libde265, is LGPL-3.0. It is used unmodified, as published on npm, where its
source and license text are.
