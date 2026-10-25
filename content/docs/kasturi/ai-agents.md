---
title: Kasturi's AI agent
description: Tell Kasturi's agent what to watch for in your pipeline, and approve the follow-ups and notes it suggests.
order: 2
ask: How do I set up Kasturi's AI agent to watch my deals?
screen: /crm/agents
---
Kasturi's agent watches your deals, contacts and follow-ups for what you ask, and suggests follow-ups and notes. Nothing changes until someone approves a suggestion.

## Who can do this

- Everyone in the workspace can see the agent's focus, its suggestions and its history.
- Only owners and admins can write and confirm the focus, choose how often it runs, and set its spending limits. While no focus is saved, anyone else sees **Only an owner or admin can set the focus.** in the focus box.
- Owners, admins and members can press **Run now**, and **Approve** or **Dismiss** a suggestion. Viewers cannot.

## Before you start

The agent runs on your workspace's own AI key. If there is none, the screen asks you to add one. See [Add your OpenRouter key](/docs/getting-started/openrouter-key).

## Steps

1. Open **Kasturi** and choose **AI Agents**.
2. Under **Focus**, type what the agent should watch for in **What should the agent watch for?**, or pick an example such as **Deals quiet for 7+ days**. You can write up to 500 characters.
3. Click **Save**. The agent reads your words and shows **How I understood it**. Anything it cannot do is listed under **I can't do that**.
4. If the list is right, click **Looks right**. To change it, click **Edit**.
5. Under **Schedule and limits**, choose **How often**: **Off**, **Daily** or **Weekly**. Daily runs at 7:00 am. Weekly runs on Monday at 7:00 am. Both are Kuala Lumpur time.
6. Set **Per run (RM)**, **Per day (RM)** and **Per week (RM)**, then click **Save limits**.
7. To run it straight away, click **Run now**.
8. Suggestions appear under **Waiting for you**. Each one says what approving it does. Click **Approve** to make the change, or **Dismiss** to drop it.

### What the agent can watch for

Your focus is matched to these checks. It cannot do anything else.

- Open deals with no activity for a number of days.
- Open deals closing within a number of days, optionally only above a value.
- Follow-ups that are past their due date.
- Contacts with no activity for a number of days.
- Contacts added recently that have no follow-up yet.

A suggestion either adds a follow-up task or leaves a note on a deal or contact. Notes from the agent are marked **from the agent**.

## Common problems

- **Save and confirm a focus first.**: click **Looks right** under **Focus** before you run the agent.
- **A run is already in progress. Please wait for it to finish.**: a workspace runs one at a time.
- **Enter a per-run limit between RM 0 and RM 100.** or **Enter daily and weekly limits between RM 0 and RM 10,000.**: change the limit and save again.
- **Looks right** stays greyed out when the agent could not match your words to anything it can watch for. Rewrite the focus.
- In the demo workspace, this screen shows sample agents only.

## Related

- [AI agents and focus](/docs/tuah/ai-agents)
- [Add and work with deals](/docs/kasturi/deals)
- [Add and manage contacts](/docs/kasturi/contacts)
