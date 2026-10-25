---
title: Connect an AI tool (MCP)
description: Make an API key and connect Claude Code, Cursor, Codex or another MCP app to your workspace.
order: 5
ask: How do I connect Claude Code or Cursor to OpenKuasa with an API key?
screen: /account/developers
---
OpenKuasa has an MCP server, so an AI tool on your computer can look things up and make changes in your workspace. The tool acts as you, with exactly what you can see and do in the app.

## Who can do this

- Everyone in a workspace, whatever their role, can make and revoke their own API keys on **Developers**.
- Owners and admins also see a **Workspace keys** card listing every key in the workspace, and can revoke any of them.
- The demo workspace is read-only: you cannot make keys there.

## Before you start

- The server address is `https://<your-host>/api/mcp`. On openkuasa.com it is `https://openkuasa.com/api/mcp`. The **Set up** card on **Developers** shows the address for the site you are on, with a copy button.
- A key works in the workspace you have open when you make it. Make it while that workspace is open.

## Steps

### 1. Make a key

1. Open the account menu, pick any account page, then choose **Developers** under **Apps** in the side menu. Or go straight to [Developers](/account/developers).
2. In **Your API keys**, type a **Key name**, for example "Cursor on my laptop".
3. If you use two-step sign-in, also type the 6-digit **Authenticator code**.
4. Click **Create key**.
5. Copy the key with **Copy key**. It starts with `okk_`. You will not see it again, so keep it somewhere safe. Anyone with it can act as you in this workspace.

Make one key per tool, and revoke it when you stop using that tool.

### 2. Keep the key in an environment variable

Keep the key out of commands and files you might share. On macOS, straight from the clipboard:

```bash
echo "export OPENKUASA_API_KEY=$(pbpaste)" >> ~/.zshrc && source ~/.zshrc
```

### 3. Add the server to your tool

**Claude Code.** The single quotes keep the variable name in the config, so Claude Code fills in the key when it connects:

```bash
claude mcp add --transport http openkuasa https://openkuasa.com/api/mcp \
  --header 'Authorization: Bearer ${OPENKUASA_API_KEY}'
```

**Codex.** Add to `~/.codex/config.toml`:

```toml
[mcp_servers.openkuasa]
url = "https://openkuasa.com/api/mcp"
bearer_token_env_var = "OPENKUASA_API_KEY"
```

**Cursor.** Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "openkuasa": {
      "url": "https://openkuasa.com/api/mcp",
      "headers": { "Authorization": "Bearer ${env:OPENKUASA_API_KEY}" }
    }
  }
}
```

On your own copy, use your own server address in place of `https://openkuasa.com/api/mcp`.

**Claude Desktop and claude.ai** connect without a key, by signing in. This works only when the site has "Sign in with OpenKuasa" turned on; otherwise the **Set up** card says **Coming soon**. See [Turn on Sign in with OpenKuasa](/docs/developers/mcp-sign-in).

### 4. Try it

Restart the tool, then ask it something like "what's in my CRM?".

## What the tool can do

The server gives the tool three tools:

- `openkuasa_tools` lists the operations you can run in this workspace. It can be narrowed to one product.
- `openkuasa_read` runs one look-up.
- `openkuasa_change` runs one change.

These are the same operations Tuah has, with Tuah's checks. Some changes come back with a note instead of being made. The tool should show you the note, and the change is made only when it sends it again with your OK.

Owners and admins see every change made this way in the **Activity log**, marked "via MCP" with the tool's name.

## Revoke a key

1. On **Developers**, find the key in **Your API keys** (or, for owners and admins, in **Workspace keys**).
2. Click **Revoke**, then **Revoke** again to confirm.

The tool that used it can no longer connect.

## Common problems

- **"Give the key a name of 1 to 60 characters."** The key name is empty or too long.
- **"Enter the 6-digit code from your authenticator app to make a key."** You use two-step sign-in. Type the code from your authenticator app.
- **"That code did not work. Check your authenticator app and try again."** The code was wrong or expired.
- **"The demo workspace is read-only. Sign up to make keys and connect AI tools."** You are in the demo workspace.
- **"Two-step sign-in was turned on after this key was made. Make a new key in Account → Developers."** Make a new key, with your authenticator code.
- **"That API key or sign-in is not valid any more. Sign in to OpenKuasa again, or make a new API key."** The key was revoked or is wrong. Make a new one.
- **"You are no longer a member of this workspace, so this connection cannot act in it."** You were removed from the workspace the key belongs to.
- **The tool is told to switch back to a workspace.** A key works only in its own workspace. If you now have another workspace open in OpenKuasa, the server refuses rather than acting there. Switch back in OpenKuasa, or make a key in the other workspace.
- **"Too many requests just now. Wait a minute and try again."** or **"Too many calls just now. Wait a minute and try again."** Each key may send up to 120 requests a minute, and run up to 60 tool calls a minute, of which at most 10 changes.

## Related

- [Turn on Sign in with OpenKuasa](/docs/developers/mcp-sign-in)
- [Environment variables](/docs/developers/environment-variables)
