---
title: Scheduled jobs
description: Call OpenKuasa's background endpoints from your own scheduler, with CRON_SECRET.
order: 4
ask: How do I set up the scheduled jobs for my self-hosted OpenKuasa?
---
Six endpoints do background work. Nothing in the app calls them: your own scheduler does, for example a cron job every five minutes.

## Who can do this

Anyone running their own copy, with access to the server's environment and to a scheduler.

## Before you start

- `SUPABASE_SERVICE_ROLE_KEY` is set on the server. Every job runs with it.
- For agent runs, `AGENTS_ENABLED` is `true` (or `1`). Without it, `/api/agents/run` does nothing.

## The endpoints

| Endpoint | What it does |
| --- | --- |
| `POST /api/agents/run` | Runs the agent schedules that are due. |
| `POST /api/agents/poll` | Finishes pending videos, fails runs still running after 15 minutes, and expires old proposals. |
| `POST /api/finance/fx-rates/fetch` | Stores Bank Negara Malaysia's exchange rates. It reaches BNM only when a rate is missing, and spends at most 20 seconds a call. |
| `POST /api/hire/cv-cleanup` | Removes stored CV files of deleted applications. |
| `POST /api/finance/receipt-cleanup` | Removes Receipts Inbox files of deleted receipts, and uploads nobody recorded within the hour. |
| `POST /api/maintenance/sweep-files` | Removes document and logo files nothing points at. Once a day is plenty. A call attempts at most 500 removals, so a large backlog takes several calls. |

They take no body and no parameters, and answer with counts only.

## Steps

1. Make a secret of at least 32 characters, used for nothing else:

   ```bash
   openssl rand -hex 32
   ```

2. Set it as `CRON_SECRET` on the app's server, and on your scheduler.
3. Have the scheduler call each endpoint with the secret as a bearer token:

   ```bash
   curl -X POST https://<your-host>/api/agents/run \
     -H "Authorization: Bearer $CRON_SECRET"
   ```

4. Set `CRON_ALLOW_LEGACY_KEY=false` on the server (see below).

### The old way: the service-role key

Installs set up before `CRON_SECRET` existed sent the Supabase service-role key instead, in an `x-service-key` header or as the bearer token. This is still accepted while `CRON_ALLOW_LEGACY_KEY` is on, and it is on unless you set it to `false`, `0`, `off` or `no`. Every call accepted this way writes a warning to the server log.

Move your scheduler to `CRON_SECRET`, then set `CRON_ALLOW_LEGACY_KEY=false`. New installs should set it to `false` from the start. The old way and the switch will be removed in a later release.

### Jobs that run inside the database

Some jobs run on `pg_cron` inside Supabase and need no scheduler: the nightly close of attendance, the new year's leave balances, the rate-limit clean-up, and the demo data reseeds. The migrations set them up.

## What the answers mean

- `/api/finance/receipt-cleanup` answers `{"ok": true, "queued": n, "removed": n}`: how many unrecorded uploads it listed and how many files it removed. `"ok": false` means part of the work is left for the next call. It stops after 20 seconds.
- `/api/finance/fx-rates/fetch` answers `{"ok", "stored", "pending"}`: how many rates it stored, and how many currency back-fills are left. `ok: false` with status 200 means something was left for the next call. Status 500 means the rates table or its state could not be read or written; the next call starts again.
- `/api/hire/cv-cleanup` answers `{"ok", "removed"}`.
- `"ok": false` needs attention only if it stays that way for many calls in a row.

## Common problems

- **Every call answers `401` with `{"error": "Unauthorized"}`.** `CRON_SECRET` is unset, empty or shorter than 32 characters, or the scheduler sends a different value. A short `CRON_SECRET` accepts nothing.
- **Agents never run.** `AGENTS_ENABLED` is not `true` or `1`, or a workspace has no schedule that is due.
- **Do not reuse a Supabase key as `CRON_SECRET`.** Use a value made for this alone.

## Related

- [Environment variables](/docs/developers/environment-variables)
- [Run your own copy](/docs/developers/self-hosting)
