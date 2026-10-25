---
title: Turn on Sign in with OpenKuasa
description: Let MCP apps such as Claude Desktop connect to OpenKuasa by signing in instead of with a key.
order: 6
ask: How do I turn on Sign in with OpenKuasa for MCP apps on my own server?
screen: /account/developers
---
Some AI apps, such as Claude Desktop and claude.ai, connect to an MCP server by signing in rather than with a key. "Sign in with OpenKuasa" makes that work. It is off by default.

## Who can do this

- Turning it on: anyone running their own copy, with access to the server's environment and the Supabase dashboard.
- Connecting an app: anyone in a workspace, whatever their role, once it is on.
- Disconnecting: each person disconnects their own apps on **Developers**.

## Before you start

API keys work without any of this. See [Connect an AI tool (MCP)](/docs/developers/connect-an-ai-tool).

## Steps

### Turn it on (self-hosting)

1. In the Supabase dashboard, turn on the OAuth server (Authentication → OAuth Server) and set its consent path to `/oauth/consent`.
2. Set `MCP_SIGN_IN_ENABLED=true` on the app's server. Only the exact value `true` turns it on.
3. Restart the server.

While it is off, the server accepts only API keys, the consent page says **Not available yet**, and the Claude Desktop part of the **Set up** card on **Developers** says **Coming soon**.

### Connect an app

1. In the app (for Claude Desktop and claude.ai: Settings → Connectors), choose Add custom connector and paste the server address, `https://<your-host>/api/mcp`.
2. Sign in to OpenKuasa when asked.
3. Check the page that asks **Allow … to sign in to OpenKuasa as …?** It names the workspace the app will work in: the one you have open. Only allow it if you just started connecting an AI tool yourself.
4. Click **Allow**, or **Don't allow** to refuse.

The app can then do anything you can do in OpenKuasa, as you, in that workspace, until you disconnect it.

### Disconnect an app

1. Open [Developers](/account/developers).
2. In **Connected apps**, click **Disconnect** beside the app, then **Disconnect** again to confirm.

To use the app in another workspace, disconnect it and connect again with that workspace open.

## Common problems

- **"Sign-in connections aren't available yet. Use an API key from Account → Developers."** `MCP_SIGN_IN_ENABLED` is not `true` on this server.
- **"Sign-in connections don't work with two-step sign-in yet. Use an API key from Account → Developers instead."** You use two-step sign-in. Use an API key.
- **The app is told it works in another workspace.** A sign-in connection stays in the workspace it was allowed for. Switch back to it in OpenKuasa, or disconnect the app and connect again.
- **"Could not disconnect that app just now. Try again."** The sign-in could not be ended. Try again.
- **Connected apps still lists apps after you turn sign-in off.** Apps connected while it was on are still listed, so you can disconnect them.

## Related

- [Connect an AI tool (MCP)](/docs/developers/connect-an-ai-tool)
- [Environment variables](/docs/developers/environment-variables)
