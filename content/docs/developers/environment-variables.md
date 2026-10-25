---
title: Environment variables
description: Every setting a self-hosted OpenKuasa reads from its environment, and what each one turns on.
order: 2
ask: Which environment variables does a self-hosted OpenKuasa need?
---
OpenKuasa reads its settings from the environment. Locally, put them in `.env.local` in the project root. On a server, set them in your host's settings.

## Who can do this

Anyone running their own copy, on the server they deploy to.

## Steps

1. Start with the two Supabase values. Without them there is no sign-in and no database.
2. Add the variables for the parts you want to use, from the tables below.
3. Restart the server after a change.

Never put a secret in a file you commit or share. `SUPABASE_SERVICE_ROLE_KEY` and every secret below stay on the server and never reach the browser.

### Required

| Variable | What it is for |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project's URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase project's anon key. |

### Server work and secrets

| Variable | What it is for |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only work: scheduled agents, file clean-ups, reading a workspace's stored keys, and test clean-up. Never expose it to the browser. |
| `AI_KEYS_ENCRYPTION_SECRET` | 32+ characters. Seals each workspace's OpenRouter and Resend keys, and the sessions behind MCP API keys. Without it a workspace cannot save its own keys. It also signs the unsubscribe links in Kasturi broadcasts, so broadcasts can't send without it. Use the same value on every host: changing it makes stored keys unreadable and breaks the unsubscribe links in broadcasts already sent. |
| `AUTH_COOKIE_SECRET` | Optional, 32+ characters. Signs the short-lived cookie a password-reset link leaves. Without it the app uses a key made from `AI_KEYS_ENCRYPTION_SECRET`, or else a random key made when the server starts. |
| `RATE_LIMIT_PEPPER` | Keys the hashes the rate limiter stores, so they cannot be tested against guesses. |

### AI

| Variable | What it is for |
| --- | --- |
| `OPENROUTER_API_KEY` | Optional. The platform key behind the 3 free questions a week for people whose workspace has no key of its own. |
| `OPENKUASA_MODEL_ORCHESTRATOR`, `OPENKUASA_MODEL_WORKER` | The models for Tuah and its specialists, as OpenRouter model ids. |
| `OPENKUASA_MODEL_RECEIPTS` | The model that reads receipts in the Receipts Inbox. Without it, the worker model is used. |
| `OPENKUASA_MODEL_AGENT_SEARCH`, `OPENKUASA_MODEL_AGENT_DIGEST`, `OPENKUASA_MODEL_AGENT_IMAGE`, `OPENKUASA_MODEL_AGENT_VIDEO` | Override the models for the Weekly Studio agent's steps. |
| `AI_GATEWAY_BASE_URL` | Optional gateway in front of OpenRouter. |

### Scheduled jobs and agents

| Variable | What it is for |
| --- | --- |
| `CRON_SECRET` | 32+ characters. Authorises the scheduled endpoints. |
| `CRON_ALLOW_LEGACY_KEY` | A temporary switch for installs whose scheduler still sends the service-role key. Set it to `false`. See [Scheduled jobs](/docs/developers/scheduled-jobs). |
| `AGENTS_ENABLED` | `true` (or `1`) lets scheduled agent runs happen. Off by default. |

### Features and sign-in

| Variable | What it is for |
| --- | --- |
| `MCP_SIGN_IN_ENABLED` | `true` turns on "Sign in with OpenKuasa" for MCP apps. Off by default, so AI tools connect with API keys only. See [Turn on Sign in with OpenKuasa](/docs/developers/mcp-sign-in). |
| `NEXT_PUBLIC_DEMO_ENABLED` | `1` shows the **Try the demo** button on the login page and lets the demo sign-in run. Unset, the demo sign-in answers "Demo is not available." |
| `PUBLIC_SITE_URL` | The lasting address written into broadcast unsubscribe links. Without it, the address the request came in on is used. |
| `OPENKUASA_PREVIEW` | `1` serves the sample-data preview from a production build. Read only when the Supabase values are missing. |

### Tools

| Variable | What it is for |
| --- | --- |
| `OPENKUASA_SUPABASE_TOKEN` | A Supabase access token, used only by `pnpm db:migrate`. |

Email broadcasts use each workspace's own Resend key, entered in the app, so there is no email variable to set.

## Common problems

- **Chat says "Your workspace key could not be used on this server. Ask an owner to save it again."** The workspace's key was sealed with a different `AI_KEYS_ENCRYPTION_SECRET`, for example after a move to a new host. Set the old value again. If it is lost, an owner or admin saves the key again on **AI key**.
- **The scheduled endpoints answer `401`.** `CRON_SECRET` is unset, empty or shorter than 32 characters, or the scheduler sends a different value. Or `CRON_ALLOW_LEGACY_KEY` is `false` while the scheduler still sends the service-role key.
- **Password-reset links are sometimes refused.** You run several instances or a serverless host and set neither `AUTH_COOKIE_SECRET` nor `AI_KEYS_ENCRYPTION_SECRET`. Set one of them.

## Related

- [Run your own copy](/docs/developers/self-hosting)
- [AI models and keys](/docs/developers/ai-models-and-keys)
- [Scheduled jobs](/docs/developers/scheduled-jobs)
