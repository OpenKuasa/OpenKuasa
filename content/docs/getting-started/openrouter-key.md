---
title: Add your OpenRouter key
description: Chat with the assistants on your own OpenRouter account, past the 3 free questions a week.
order: 8
ask: How do I add my OpenRouter key?
screen: /account/ai
---
The OpenKuasa assistants run on your own OpenRouter account. You add one key for your workspace, and everyone in it can chat.

## Why you need a key

Without a key, each person gets 3 free questions a week, across all the assistants. They reset every Monday at 00:00 UTC. When they are used up, chat stops until the next week, or until you add a key.

With a key, chat is billed to your OpenRouter account. Set a spending limit on the key in OpenRouter if you want one. As a safety net, each person can run up to 200 chat requests a day on the key. Approving a change the assistant suggests counts as a request too. The count resets at midnight UTC (8 am Malaysia time).

## Who can do this

Only workspace owners and admins can add, change or remove the key. Members and viewers see the note **Only owners and admins can add or change the workspace key.** The demo workspace does not use a key.

## Before you start

Get a key from OpenRouter:

1. Go to openrouter.ai and create an account, or sign in.
2. Add some credit to your account.
3. Open the **Keys** page (openrouter.ai/keys) and create a new key. You can set a spending limit on it here.
4. Copy the key. It starts with `sk-or-`.

## Steps

1. Open the account menu (your name, top right) and click **Profile & Preferences**. In the side menu, under **Apps**, choose **AI key**. Or go straight to [AI key](/account/ai).
2. Paste the key into **OpenRouter API key**.
3. Click **Save key**.

OpenKuasa checks the key with OpenRouter first. The key is stored sealed (encrypted) and is never shown again. Only its last four characters are shown, so you can tell which key is in use. The status changes to **Active**.

![The Workspace key card as the demo workspace shows it: read-only, with no key](/docs-media/getting-started/ai-key.png)

### Change or remove the key

To change it, paste a new key into **Replace with a new key** and click **Replace key**. To stop using your own key, click **Remove key**. Chat then goes back to 3 free questions a week for each person.

## Common problems

- **That does not look like an OpenRouter key. It should start with sk-or-.** Copy the whole key again from OpenRouter.
- **OpenRouter rejected that key. Check it and try again.** The key is wrong or was deleted in OpenRouter. Make a new one.
- **Could not reach OpenRouter to check the key. Please try again.** Nothing was saved. Try again in a moment.
- **This server is not set up to store workspace keys yet. The host needs AI_KEYS_ENCRYPTION_SECRET set.** Whoever runs this copy of OpenKuasa has to set that up first.
- **That question was not sent: you have reached today’s chat limit. It resets at midnight UTC (8 am Malaysia time).** You used today's 200 requests. Try again after 8 am Malaysia time.
- **Your workspace key could not be used on this server. Ask an owner to save it again.** An owner or admin should paste the key again and click **Replace key**.

## Related

- [Ask the assistants](/docs/getting-started/ask-the-assistants)
- [Invite your team](/docs/getting-started/invite-your-team)
