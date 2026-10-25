---
title: Run your own copy
description: Self-host OpenKuasa on your own Supabase project and any Node server.
order: 1
ask: How do I self-host OpenKuasa on my own Supabase project?
---
OpenKuasa is free to self-host under AGPL-3.0. You need a Supabase project for data and sign-in, and a server that runs Node.

## Who can do this

Anyone running their own copy. You need access to a Supabase project and to the server you deploy on.

## Before you start

- Node 22 or newer.
- pnpm. Always use pnpm, not npm or yarn.
- A Supabase project.

## Steps

### 1. Get the code

```bash
git clone https://github.com/OpenKuasa/OpenKuasa.git
cd OpenKuasa
pnpm install
pnpm dev
```

Open http://localhost:3000. With no Supabase project set, the app opens in preview mode: every visitor is a read-only "Guest" in a "Preview workspace", and the screens show sample data.

### 2. Point it at your Supabase project

Create a `.env.local` file in the project root with your project's URL and anon key (Supabase dashboard → Project Settings → API):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
```

The rest of the app is turned on by more variables. See [Environment variables](/docs/developers/environment-variables).

### 3. Create the tables

Run the migrations once against your project:

```bash
pnpm db:migrate --apply
```

It asks you to type the project ref before it writes anything. See [Keep the database up to date](/docs/developers/database-migrations).

### 4. Set up Supabase Auth

In the Supabase dashboard, under Authentication:

- **Enable Anonymous sign-ins.** It powers the demo workspace and the tests.
- **Confirm email** is your choice. With it off, signup signs the person in at once and lands on `/command`. With it on, signup stops at a "check your email" message, and the person confirms and then signs in.
- **Leave hCaptcha off.** The sign-in forms do not send a captcha token yet, so turning hCaptcha on breaks sign-in and signup.

The sign-in email templates are in `supabase/email-templates/`. They are not set by the migrations: paste each file into the matching template in the Supabase dashboard (Authentication → Emails → Templates). Every link in them points at the app's `/auth/confirm` route.

### 5. Build and run it on your server

```bash
pnpm build
pnpm start
```

Any host that runs Node 22 and these two commands will do. openkuasa.com runs on Railway.

### 6. Add the scheduler

Some background work runs only when your scheduler calls it. See [Scheduled jobs](/docs/developers/scheduled-jobs).

## Common problems

- **Every request answers `503 Service unavailable`.** A production server (`pnpm start`, or any host) refuses to serve when `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` is missing. The server log names the missing variables. This is on purpose: a deployment that loses a variable fails visibly instead of turning into the sample app.
- **You want the sample-data preview on a production build.** Set `OPENKUASA_PREVIEW=1`. It is read only when the Supabase values are missing, so it does nothing on a configured deployment. Do not set it on the deployment that serves your real data.
- **Some pages show sample data instead of yours.** The database is missing a table or column that the code needs. Run `pnpm db:migrate` to see which migrations your project lacks.
- **Rate limits count everyone together.** The app tells clients apart by the `X-Real-IP` header that Railway's edge sets. On a host or proxy that does not set it, every request counts against one shared counter, which has its own, wider limit.
- **Password-reset links are sometimes refused.** If you run several instances or a serverless host, set `AUTH_COOKIE_SECRET` (32+ characters). See [Environment variables](/docs/developers/environment-variables).

## Related

- [Environment variables](/docs/developers/environment-variables)
- [Keep the database up to date](/docs/developers/database-migrations)
- [Scheduled jobs](/docs/developers/scheduled-jobs)
- [How OpenKuasa is built](/docs/developers/architecture)
