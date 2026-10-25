---
title: Keep the database up to date
description: Apply OpenKuasa's database migrations to your Supabase project with pnpm db:migrate.
order: 3
ask: How do I apply OpenKuasa's database migrations to my Supabase project?
---
The database is built by the SQL files in `supabase/migrations`. After every pull from main, bring your Supabase project up to date with them.

## Who can do this

Anyone running their own copy who has a Supabase access token for the project.

## Before you start

Put both of these in `.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL`, your project's address. The script takes the project ref from an address ending in `.supabase.co`.
- `OPENKUASA_SUPABASE_TOKEN`, a Supabase access token.

The script reads both from `.env.local` only, never from your shell. It talks to the Supabase Management API, so no database password is needed.

## Steps

1. See what your project is missing. This changes nothing:

   ```bash
   pnpm db:migrate
   ```

2. Apply what is missing, oldest first:

   ```bash
   pnpm db:migrate --apply
   ```

3. Type the project ref when asked. Nothing is written until you do. Without a terminal to type into, pass it instead: `pnpm db:migrate --apply --confirm=<ref>`.

Each migration runs in one transaction together with its record in `supabase_migrations.schema_migrations`, so it is applied whole or not at all. The script creates that table if your project has none yet.

## Writing a new migration

- Files run in the order of the number at the start of their name. Name a new file so it sorts after the last one in `supabase/migrations`, or a fresh install runs it before the tables it needs.
- Give every new table row-level security, as the existing ones have.
- A statement that cannot run inside a transaction fails under this script. Examples are `CREATE INDEX CONCURRENTLY`, or `ALTER TYPE … ADD VALUE` used in the same file. No migration does that today.

## Common problems

- **"Set OPENKUASA_SUPABASE_TOKEN and NEXT_PUBLIC_SUPABASE_URL in .env.local."** One of them is missing from `.env.local`, or the address does not end in `.supabase.co`.
- **"Not confirmed. Nothing changed."** The ref you typed did not match the project.
- **A migration fails.** That one is rolled back and the ones before it stay applied. The run stops there. Fix it and run again.
- **Pages show samples instead of your data.** Code that needs a table or column your database lacks fails, and some pages then quietly show their samples. Run `pnpm db:migrate`.

## Related

- [Run your own copy](/docs/developers/self-hosting)
- [How OpenKuasa is built](/docs/developers/architecture)
