---
title: Run it on BoxCompute
description: Try your own copy of OpenKuasa on a BoxCompute cloud computer in Malaysia, with one prompt to their agent or a few commands.
order: 13
ask: How do I run OpenKuasa on BoxCompute?
---
[BoxCompute](https://boxcompute.ai) rents small cloud computers in Cyberjaya by the hour. Their AI agent can set OpenKuasa up for you from one prompt, so you need nothing installed on your own laptop.

It suits **trying your own copy**. For running a business day to day, use a server or host that stays on and has a fixed address: see [Run your own copy](/docs/developers/self-hosting).

## Before you start

- A BoxCompute account. New accounts get US$5 of free credit for 14 days.
- About US$0.15 an hour while the computer runs. OpenKuasa needs their **Large** computer (3 GB of memory) and uses about 1 GB of it. A stopped computer costs nothing.

## What to expect

- **The link lasts one hour.** BoxCompute opens one private link to your computer, and it closes after an hour. When you open a new one, tell OpenKuasa the new address (below), and everyone signs in again.
- **The computer stops when nobody uses it.** It stops about 30 minutes after the last activity, and it also sleeps after about 42 hours in any case. Starting it again keeps your files, and you then need a new link.
- **Your data lives on that computer.** It survives stopping and starting. **Deleting the computer deletes your data**, and there are no automatic backups.
- Anyone who has the link can open it, so share it only with people you trust.

## Set it up with one prompt

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

## Update, stop and remove

- **Update:** `cd /workspace/OpenKuasa && git pull && docker compose -f docker-compose.yml -f docker-compose.single-port.yml pull && docker compose -f docker-compose.yml -f docker-compose.single-port.yml up -d`
- **Stop:** stop the computer in BoxCompute. Your data stays.
- **Remove for good:** delete the computer in BoxCompute. This deletes your data.

## Common problems

- **"Set OPENKUASA_PUBLIC_URL in .env".** The address line is missing from `.env`. Add it as in step 5, then start again.
- **The page opens but sign-in or "Try the demo" does nothing.** The address in `.env` isn't the link you opened, usually after a new link. Update the line and run the `up -d` line again.
- **The page never loads.** Run `docker compose logs migrate` in the folder to see why, fix it, and run the `up -d` line again.

## Related

- [Run your own copy](/docs/developers/self-hosting)
- [Environment variables](/docs/developers/environment-variables)
