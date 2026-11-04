---
title: Run it on BoxCompute
description: Try your own copy of OpenKuasa on a BoxCompute cloud computer in Malaysia, with one prompt to their agent or a few commands.
order: 13
ask: How do I run OpenKuasa on BoxCompute?
---
[BoxCompute](https://boxcompute.ai) rents small cloud computers in Cyberjaya by the hour. Their AI agent can set OpenKuasa up for you from one prompt, so you need nothing installed on your own laptop.

It suits **trying your own copy**. For running a business day to day, use a server or host that stays on and has a fixed address: see [Run your own copy](/docs/developers/self-hosting).

There are two ways to set it up:

- **Quick try (local Supabase):** everything runs on the BoxCompute computer. Nothing else to sign up for.
- **Keep your data (online Supabase):** only the app runs on BoxCompute, and your data lives in your own project on supabase.com, with its backups. Deleting the computer loses nothing.

## Before you start

- A BoxCompute account. New accounts get US$5 of free credit for 14 days.
- About US$0.15 an hour while the computer runs. OpenKuasa needs their **Large** computer (3 GB of memory) and uses about 1 GB of it. A stopped computer costs nothing.

## What to expect

- **The link lasts one hour.** BoxCompute opens one private link to your computer, and it closes after an hour. When you open a new one, tell OpenKuasa the new address (below), and everyone signs in again.
- **The computer stops when nobody uses it.** It stops about 30 minutes after the last activity, and it also sleeps after about 42 hours in any case. Starting it again keeps your files, and you then need a new link.
- **With local Supabase, your data lives on that computer.** It survives stopping and starting. **Deleting the computer deletes your data**, and there are no automatic backups. With online Supabase, it lives in your Supabase project.
- Anyone who has the link can open it, so share it only with people you trust.

## Quick try: set it up with one prompt

In BoxCompute, start a new chat and paste this:

```text
Set up OpenKuasa for me on a new computer. Stop and show me the error if any step fails.
1. Create a Large computer named "openkuasa" (start it if it already exists).
2. Install Docker: curl -fsSL https://get.docker.com | sh
3. Get OpenKuasa: cd /workspace && git clone --depth 1 https://github.com/OpenKuasa/OpenKuasa.git && cd OpenKuasa && cp .env.example .env
4. Open a browser preview for port 58273.
5. Save its address in .env, with no slash at the end: sed -i '/^OPENKUASA_PUBLIC_URL=/d' .env && echo "OPENKUASA_PUBLIC_URL=<the preview address>" >> .env
6. Start it: docker compose -f docker-compose.yml -f docker-compose.single-port.yml up -d
7. Wait until curl -s -o /dev/null -w "%{http_code}" http://localhost:58273/login prints 200 (up to 5 minutes), then give me the preview link.
```

Approve the steps it asks about: creating the computer, and opening the preview. The first start takes about 5 minutes. Then open the link, and sign up or press **Try the demo**.

### When the link has expired

Paste this into the same chat:

```text
My OpenKuasa link has expired. Start the computer "openkuasa" if it is stopped, open a new browser preview for port 58273, replace the OPENKUASA_PUBLIC_URL line in /workspace/OpenKuasa/.env with the new address (no slash at the end), then run: cd /workspace/OpenKuasa && docker compose -f docker-compose.yml -f docker-compose.single-port.yml up -d. Give me the new link.
```

## Or run the commands yourself

Open your computer's **Terminal** in BoxCompute and run:

```bash
curl -fsSL https://get.docker.com | sh
cd /workspace && git clone --depth 1 https://github.com/OpenKuasa/OpenKuasa.git && cd OpenKuasa
cp .env.example .env
```

Open a browser preview for port 58273 (ask the agent, or use the computer's **Previews** tab). Put its address in `.env`, with no slash at the end, then start:

```bash
echo "OPENKUASA_PUBLIC_URL=https://<your-preview-address>" >> .env
docker compose -f docker-compose.yml -f docker-compose.single-port.yml up -d
```

For a new link, change the `OPENKUASA_PUBLIC_URL` line in `.env` and run the `up -d` line again.

### How it works

BoxCompute gives one link for one port. `docker-compose.single-port.yml` puts the app and its database behind port 58273: requests for sign-in, data and files go to Supabase, and everything else goes to the app. It also tells both of them the link's address, from `OPENKUASA_PUBLIC_URL`. The same file works for any host that gives you a single address, such as a tunnel or one domain on a proxy.

## Keep your data: online Supabase

First set up a project on supabase.com, as in [Docker app with online Supabase](/docs/developers/self-hosting#docker-app-with-online-supabase): note its four settings, turn on anonymous sign-ins if you want "Try the demo", and leave "Confirm email" off unless you set up your own email sending.

**Never paste your Supabase keys or database password into BoxCompute's chat.** You type them into the computer's Terminal yourself.

1. In BoxCompute, start a new chat and paste this:

   ```text
   Prepare OpenKuasa for me on a new computer. Stop and show me the error if any step fails.
   1. Create a Large computer named "openkuasa" (start it if it already exists).
   2. Install Docker: curl -fsSL https://get.docker.com | sh
   3. Get OpenKuasa: cd /workspace && git clone --depth 1 https://github.com/OpenKuasa/OpenKuasa.git && cd OpenKuasa && cp .env.example .env
   Then tell me it is ready for my settings. Don't start it yet.
   ```

2. Open the computer's **Terminal** and run these lines, with your own values after each `=` (keep the quotes):

   ```bash
   cd /workspace/OpenKuasa
   echo 'NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co' >> .env
   echo 'NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>' >> .env
   echo 'SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>' >> .env
   echo 'DATABASE_URL=<your-session-pooler-connection-string>' >> .env
   ```

   A setting written twice in `.env` takes the later line, so these win over the blank ones copied from the example.

3. Back in the chat, paste this:

   ```text
   Start OpenKuasa with my online Supabase. Stop and show me the error if any step fails.
   1. Open a browser preview for port 58273.
   2. Save its address, with no slash at the end: cd /workspace/OpenKuasa && sed -i '/^OPENKUASA_PUBLIC_URL=/d' .env && echo "OPENKUASA_PUBLIC_URL=<the preview address>" >> .env
   3. Start it: docker compose -f docker-compose.hosted.yml -f docker-compose.hosted-single-port.yml up -d
   4. Wait until curl -s -o /dev/null -w "%{http_code}" http://localhost:58273/login prints 200 (up to 5 minutes), then give me the preview link.
   ```

If a setting is missing, it stops and names it: `docker compose -f docker-compose.hosted.yml logs init` shows which. To use email links (password reset, invites), also set your Supabase project's site URL to the link.

When the link expires, use the prompt under [When the link has expired](#when-the-link-has-expired), with `docker compose -f docker-compose.hosted.yml -f docker-compose.hosted-single-port.yml up -d` as the start command.

With online Supabase, the computer runs only the app and a small front door on port 58273. The app's address comes from `OPENKUASA_PUBLIC_URL`, and the browser talks to your Supabase project directly.

## Update, stop and remove

- **Update:** `cd /workspace/OpenKuasa && git pull && docker compose -f docker-compose.yml -f docker-compose.single-port.yml pull && docker compose -f docker-compose.yml -f docker-compose.single-port.yml up -d`. With online Supabase, use `-f docker-compose.hosted.yml -f docker-compose.hosted-single-port.yml` in both places instead.
- **Stop:** stop the computer in BoxCompute. Your data stays.
- **Remove for good:** delete the computer in BoxCompute. With local Supabase, this deletes your data. With online Supabase, your data stays in your Supabase project.

## Common problems

- **"Set OPENKUASA_PUBLIC_URL in .env".** The address line is missing from `.env`. Add it as in step 5, then start again.
- **The page opens but sign-in or "Try the demo" does nothing.** The address in `.env` isn't the link you opened, usually after a new link. Update the line and run the `up -d` line again.
- **The page never loads.** Run `docker compose logs migrate` in the folder to see why, fix it, and run the `up -d` line again.

## Related

- [Run your own copy](/docs/developers/self-hosting)
- [Environment variables](/docs/developers/environment-variables)
