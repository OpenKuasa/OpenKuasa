---
title: AI agents and their focus
description: Tell a product's AI agent what to watch for, choose when it runs and what it may spend, and approve what it suggests.
order: 8
ask: How do I set up an AI agent to watch for things in my business?
---
Kasturi, Lekir, Lekiu and Bendahara each have an AI agent. You tell it what to watch for, in your own words. It checks your records on a schedule and suggests follow-ups or notes. Nothing is added until someone approves it.

## Who can do this

In **Kasturi**, **Lekir** and **Bendahara**:

- owners and admins set the focus, confirm it, and change the schedule and limits;
- owners, admins and members can press **Run now**, approve or dismiss suggestions, and, where there are notes, delete them;
- everyone else can look but not change anything. Before a focus is saved, the focus box says **Only an owner or admin can set the focus.** After it is saved, it says **Waiting for an owner or admin to confirm.** until an owner or admin confirms it.

In **Lekiu**, the **AI Agents** screen is for owners and admins only. Anyone else sees **This page is for owners and admins of the workspace.** Owners and admins can do everything on it.

In the demo, the **AI Agents** screens show sample content only.

## Before you start

Each product has its own **AI Agents** screen in its side menu. They all work the same way, as below. Jebat's **AI Agents** screen is different: it runs the Weekly Studio agent, which drafts a weekly content digest.

The agent runs on your workspace's own OpenRouter key. Free questions do not cover it. Without a key, the screen says **The agent runs on your workspace's own AI key.** See [Add your OpenRouter key](/docs/getting-started/openrouter-key).

## Steps

### 1. Write the focus

1. Open the product, then **AI Agents** in the side menu.
2. In **Focus**, write in **What should the agent watch for?**. Use your own words, up to 500 characters. Or click one of the ideas under **Start from an example:**, such as **Deals quiet for 7+ days** in Kasturi.
3. Click **Save**. The button says **Reading it…** while the agent reads your words.
4. Check **How I understood it**. Each line is one check the agent will run. If you asked for something it cannot do, it is listed under **I can't do that**.
5. If it is right, click **Looks right**. This switches the agent on. If not, click **Edit** and try other words.

Each agent can only run its own fixed set of checks. Your words choose from that set. They cannot make it do anything else.

Reading your focus uses your AI key, so it counts towards the spend limits.

### 2. Choose when it runs and what it may spend

In **Schedule and limits**:

1. Under **How often**, pick **Daily** or **Weekly**. Daily runs at 7:00 am. Weekly runs on Monday at 7:00 am. Both are Kuala Lumpur time. **Off** stops it running on its own.
2. Set **Per run (RM)**, from RM 0 to RM 100, and **Per day (RM)** and **Per week (RM)**, from RM 0 to RM 10,000.
3. Click **Save limits**.

The box shows what the agent spent **Today** and **This week** against those limits. When one is reached, it says **Cap reached**.

To run it straight away, click **Run now**. It keeps to the same limits. When it ends, it says **Run finished. Any suggestions are waiting above.**

### 3. Approve or dismiss suggestions

Suggestions show under **Waiting for you**. The **AI Agents** item in the side menu shows how many are waiting.

Each suggestion names its record, with a link where there is one. It says **Why it came up:** and what approving it does.

- Click **Approve** to add it.
- Click **Dismiss** to drop it. Nothing is changed.

A suggestion left waiting for 7 days expires.

### 4. Look back

**Recent history** lists each run: whether it is **Running**, **Done**, **Failed** or **Skipped**, when it started, how many suggestions it made and what it cost.

Open **Recently decided** to see the latest suggestions and how each ended: **Approved**, **Rejected**, **Failed**, **Expired** or **No longer applies**. **No longer applies** means it was approved, but the record had changed by then, so nothing was added.

In Lekir, Lekiu and Bendahara, approved notes are listed under **Notes from the agent**. Click **View** to open the record. To remove a note, click **Delete**, then **Delete note**. The record itself is not changed.

## Common problems

- **"Add your AI key in Settings to use the agent."** The workspace has no OpenRouter key. An owner or admin adds one first.
- **"Write what the agent should watch for (up to 500 characters)."** The focus is empty or too long.
- **"I couldn't match this to anything I can watch for".** None of your words matched a check this agent can run. **Looks right** stays greyed out. Click **Edit** and try other words, or start from an example.
- **"You have changed the focus 10 times today. Try again tomorrow."** The focus can be saved 10 times a day.
- **"The agent is turned off. An owner or admin can turn it on."** Usually a focus was saved but **Looks right** was never clicked. An owner or admin clicks **Looks right** to confirm the focus, which turns the agent on. If **How often** was later set to **Off**, pick **Daily** or **Weekly** instead.
- **"Save and confirm a focus first."** The focus was edited and saved again, so it needs confirming again. An owner or admin clicks **Looks right**.
- **"Pick daily or weekly so the agent runs on its own, or press Run now."** The focus is confirmed, but no schedule is set yet.
- **"A run is already in progress. Please wait for it to finish."** A workspace runs one agent at a time.
- **"The workspace daily spend cap has been reached. Try again tomorrow, or ask an owner or admin to raise it."**
- **"The workspace weekly spend cap has been reached. Ask an owner or admin to raise it."**
- **"Enter a per-run limit between RM 0 and RM 100."** or **"Enter daily and weekly limits between RM 0 and RM 10,000."** A limit is outside its range.

## Related

- [Approve or reject a change](/docs/tuah/approve-changes)
- [Add your OpenRouter key](/docs/getting-started/openrouter-key)
