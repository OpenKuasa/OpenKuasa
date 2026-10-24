---
title: Add your OpenRouter key
description: Chat with the assistants as much as you like, on your own OpenRouter account.
order: 2
ask: How do I add my OpenRouter key?
screen: /account/ai
---
The OpenKuasa assistants run on your own OpenRouter account. You add one key for your workspace, and everyone in it can chat.

## Why you need a key

Without a key, each person gets 3 free questions a week, across all the assistants. They come back each week. When they are used up, chat stops until next week, or until you add a key.

With a key, chat is billed to your OpenRouter account. We do not put a limit on it. Set a spending limit on the key in OpenRouter if you want one.

## Who can add it

Only workspace owners and admins can add, change or remove the key. If you are a member, you will see a note asking you to talk to an owner or admin. The demo workspace does not use a key.

## Get a key from OpenRouter

1. Go to openrouter.ai and create an account, or sign in.
2. Add some credit to your account.
3. Open the **Keys** page (openrouter.ai/keys) and create a new key. You can set a spending limit on it here.
4. Copy the key. It starts with `sk-or-`.

## Add it to OpenKuasa

1. Open the account menu (your name, top right), pick any account page, then choose **AI key** under **Apps** in the side menu. Or go straight to [AI key](/account/ai).
2. Paste the key into **OpenRouter API key**.
3. Click **Save key**.

OpenKuasa checks the key with OpenRouter first. If OpenRouter rejects it, or the key does not start with `sk-or-`, you will see a message and nothing is saved.

## How your key is kept

The key is stored sealed (encrypted). It is never shown again. Only its last four characters are shown, so you can tell which key is in use.

## Change or remove the key

To change it, paste a new key into **Replace with a new key** and click **Replace key**. To stop using your own key, click **Remove key**. Chat then goes back to 3 free questions a week for each person.
