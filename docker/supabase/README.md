# Local Supabase for `docker compose`

These files are vendored from Supabase's own self-hosting setup, the `docker/`
folder of [supabase/supabase](https://github.com/supabase/supabase/tree/4a04bb1fc9f74d6d8bcd11c06f205fbf4bd24158/docker),
at commit **`4a04bb1fc9f74d6d8bcd11c06f205fbf4bd24158`** (2026-11-04).
`docker-compose.yml` at the repo root is based on that commit's
`docker-compose.yml` plus its `docker-compose.kong.yml` override.

**Licence.** The files in this folder are © Supabase ("Copyright 2024
Supabase"), Apache-2.0; the full text is in [`LICENSE`](LICENSE), copied from
the same commit. OpenKuasa as a whole is AGPL-3.0. Modified by OpenKuasa:
`api/kong.yml` (trimmed, plus a header comment). Unmodified: `api/kong-entrypoint.sh`,
`db/roles.sql`, `db/jwt.sql`, `db/webhooks.sql`. The table below describes the changes.

| File here | Upstream file | Changes |
| --- | --- | --- |
| `api/kong.yml` | `volumes/api/kong.yml` | Trimmed to the auth, rest and storage routes; the dashboard login, the opaque `sb_` key credentials and the routes to dropped services removed |
| `api/kong-entrypoint.sh` | `volumes/api/kong-entrypoint.sh` | None |
| `db/roles.sql` | `volumes/db/roles.sql` | None |
| `db/jwt.sql` | `volumes/db/jwt.sql` | None |
| `db/webhooks.sql` | `volumes/db/webhooks.sql` | None. Kept because it creates `supabase_functions_admin`, which `roles.sql` gives a password, and because hosted projects have the same schema |

## Images

| Service | Image | Note |
| --- | --- | --- |
| db | `public.ecr.aws/supabase/postgres:17.6.1.166` | Upstream pins 17.6.1.136. 17.6.1.166 is the image the Supabase CLI ran when all 218 migrations were tested on 2026-11-04. Migrations need Postgres 17 |
| auth | `public.ecr.aws/supabase/gotrue:v2.197.0` | Same as upstream |
| rest | `public.ecr.aws/supabase/postgrest:v14.18` | Same version as upstream (`postgrest/postgrest:v14.18`). Supabase's build has `/bin/sh`, so it is wrapped like the others |
| storage | `public.ecr.aws/supabase/storage-api:v1.81.0` | Same as upstream |
| kong | `kong/kong:3.9.3` | Same as upstream's Kong override |
| mail | `public.ecr.aws/supabase/mailpit:v1.22.3` | Not in upstream; the mail catcher the Supabase CLI uses |
| email-templates | `busybox:1.37.0` | Not in upstream; serves `supabase/email-templates` to auth, see below |

Supabase images come from `public.ecr.aws/supabase/…`, Supabase's own mirror of
the Docker Hub images, which has no anonymous pull limit.

## Left out, and why

The app was searched (`git grep` over `src/` and `supabase/migrations/`) for
each service before dropping it.

| Service | Why it is not here |
| --- | --- |
| realtime | No realtime channels in `src/` (only a comment in the CSP). Its `_realtime` schema SQL (`realtime.sql`) is dropped with it |
| studio | A database admin UI. Nothing in the app needs it |
| meta (postgres-meta) | Only Studio uses it |
| analytics (logflare) and vector | Log collection for Studio. `logs.sql` and `_supabase.sql` are dropped with them |
| functions (edge-runtime) | No `functions.invoke` or `/functions/v1` calls |
| imgproxy | No image transformations; storage runs with `ENABLE_IMAGE_TRANSFORMATION=false` |
| supavisor (pooler) | The app talks to PostgREST, and `migrate` connects to `db` directly. `pooler.sql` is dropped with it |
| envoy | Upstream's new default gateway. Kong is kept because its config and entrypoint are already templated for these keys |
| GraphQL route | Nothing calls `/graphql/v1` |

## How secrets reach each service

`init` writes the generated secrets once to `/secrets/generated.env` on the
`secrets` volume (mode 0640, owner and group 1000). Every other service mounts
that volume read-only and starts through `docker/with-secrets.sh`, which
exports each value unless `.env` already set it. A short `sh -c` then gives the
value the name that service reads:

| Service | Runs as | Gets |
| --- | --- | --- |
| db | root, then postgres | `POSTGRES_PASSWORD`, `PGPASSWORD` (used by `roles.sql`) |
| auth | uid 1000 | `GOTRUE_JWT_SECRET`, `GOTRUE_DB_DATABASE_URL` |
| rest | uid 1000 | `PGRST_JWT_SECRET`, `PGRST_DB_URI` |
| storage | root | `ANON_KEY`, `SERVICE_KEY`, `AUTH_JWT_SECRET`, `DATABASE_URL` |
| kong | uid 1001, plus group 1000 (`group_add`) | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| migrate, app | uid 1000 (`node`) | everything, under its own names |

## Email templates

GoTrue reads its email templates from URLs, not files. The `email-templates`
service serves `supabase/email-templates/` inside the stack only (no host
port), and auth points `GOTRUE_MAILER_TEMPLATES_*` at it. Every email lands in
the mail viewer at http://localhost:58274.

## Updating

To move to a newer Supabase commit, compare these files and the image tags
with that commit's `docker/` folder, update this README, and run the stack
from empty (`docker compose down -v && docker compose up -d`).
