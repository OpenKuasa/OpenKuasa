---
title: Set up the AI chatbot
description: Give Kasturi's chatbot a name, a tone and the facts it may use, try it, and put it on your landing pages.
order: 10
ask: How do I set up the AI chatbot that answers customers on my landing pages?
screen: /crm/chatbot
---
The AI chatbot answers your customers' questions on the landing pages you switch it on for. It answers only from what you write in **Knowledge**. It knows nothing else about your business and cannot see your records.

## Who can do this

- Everyone in the workspace can see the bot's settings, knowledge and conversations.
- Owners, admins and members can change the bot's behaviour and knowledge. Viewers can only read.
- Only owners and admins can change **Daily answers**.

## Before you start

- The chat on landing pages runs on your workspace's own AI key. Without one, it does not appear. See [Add your OpenRouter key](/docs/getting-started/openrouter-key).
- You need at least one landing page to show it on.

## Steps

### Set how the bot behaves

1. Open **Kasturi** and choose **AI Chatbot**.
2. Under **Behaviour**, set the **Bot name**, the **Tone** (**Friendly**, **Professional** or **Playful**) and the **Welcome message**.
3. Tick **Offer a person when the bot cannot help** if you want it to, and set **After this many questions in a row it could not answer** (1 to 10).
4. Click **Save**.

Until you save, the bot uses starting settings: the name Assistant, a friendly tone and a short welcome.

### Write what the bot knows

1. Under **Knowledge**, click **Add entry**.
2. Type a **Title** and fill in **What the bot should know**, such as your prices, delivery terms or opening hours. Use one entry per subject.
3. Click **Save entry**.
4. To change an entry, click its edit button. To remove it, click its delete button, then **Delete entry**.

### Try it

1. Under **Try it**, type a question a customer would ask and send it.
2. The bot answers from what is saved. Each question is a real AI question. Nothing typed here is kept.
3. Click **Start again** to clear the chat.

### Put it on a landing page

1. Open **Landing Page** and edit a page.
2. Tick **Show the AI chatbot on this page** and save.
3. Under **Channels**, **Web chat** shows how many pages the bot is on.

### Set the daily limit

1. Under **Daily answers**, type how many answers the chat on landing pages may give in a day, from 1 to 1,000.
2. Click **Save**.

Each answer uses your workspace's AI key. Once the day's answers are used, visitors are told the chat is busy and to try again later. The count starts again at 8 am Malaysia time.

### Read the conversations

**Conversations** shows what customers asked and what the bot said. A conversation where someone asked for a person is marked **Asked for a person**.

## Common problems

- **Web chat** shows **Needs an AI key**: add an OpenRouter key for the workspace.
- **Web chat** shows **Not switched on yet**: tick **Show the AI chatbot on this page** on a landing page.
- The chat is paused because the OpenRouter key could not be used or has no credit left. Fix the key or top it up, then click **Switch the chat back on**.
- **A workspace can keep at most 20 entries. Delete one, or add to an existing entry.**: you have 20 entries already.
- **Keep an entry to 4,000 characters or fewer. Split a longer one in two.**: shorten the entry.
- **Only an owner or admin can change the daily answers.**: ask an owner or admin.
- WhatsApp, Instagram DM and Messenger show **Not connected**. The bot answers only on landing pages.
- **The preview is not available in the demo workspace.**: sign up to try your own bot.

## Related

- [Landing pages](/docs/kasturi/landing-pages)
- [Add your OpenRouter key](/docs/getting-started/openrouter-key)
- [Plugins](/docs/kasturi/plugins)
- [Kasturi settings](/docs/kasturi/settings)
