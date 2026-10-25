---
title: Lekir's AI agent
description: Let an AI agent watch your hiring for what you ask, and approve the notes it suggests.
order: 2
ask: What can Lekir's AI agent watch for, and how do I set it up?
screen: /hire/agents
---
Lekir's AI agent checks your hiring on a schedule and suggests notes for you to approve. You tell it what to watch for in your own words. How focus, schedules and approvals work in every product is in [AI agents and focus](/docs/tuah/ai-agents). This guide covers what is special to Lekir.

## Who can do this

- **Set the focus, the schedule and the spending limits:** owners and admins only.
- **Run now, Approve or Dismiss a suggestion, and delete a note:** owners, admins and members.
- **Viewers** can see the screen but cannot change anything.

## Before you start

The agent runs on your workspace's own AI key. If there is none, the screen shows **Add an OpenRouter key**. See [Add your OpenRouter key](/docs/getting-started/openrouter-key).

## Steps

1. Open **Lekir** and choose **AI Agents**.
2. In the **Focus** card, write under **What should the agent watch for?** You have up to 500 characters. Or pick one of the examples under **Start from an example:**
   - **Anyone waiting more than 5 days to be screened**
   - **Interviews with no feedback**
   - **Offers with no answer after a week**
   - **Jobs open more than 45 days**
3. Click **Save**. The agent shows **How I understood it**, and anything it cannot do under **I can't do that**.
4. If the read-back is right, click **Looks right**. If not, click **Edit** and change your words.
5. In **Schedule and limits**, choose **How often**: **Off**, **Daily** or **Weekly**. Daily runs at 7:00 am; weekly runs on Monday at 7:00 am (Kuala Lumpur time).
6. Set **Per run (RM)**, **Per day (RM)** and **Per week (RM)**, then click **Save limits**. A new agent starts at RM 0.50 a run, RM 2 a day and RM 5 a week.
7. To run it straight away, click **Run now**.
8. Suggestions appear under **Waiting for you**. Click **Approve** to add the note, or **Dismiss** to drop it. Approved notes are listed under **Notes from the agent**.

### What the agent can watch for

The agent picks from a fixed list of checks. It reads only stages, statuses, dates and counts. It never reads contact details, CVs, skills, ratings or feedback text.

- Applications still at Applied some days after the person applied.
- Applications at Screening with no interview booked.
- Applications at Interview or Offer with no activity for a while.
- Interviews still marked Scheduled after their time.
- Completed interviews with no feedback.
- Offers with no answer recorded.
- Open jobs not filled after some days.
- Open jobs with few new applications.
- Open jobs closing soon.
- Talent pool candidates with no current application.

The agent only adds notes. It does not move, reject or contact anyone.

## Common problems

- **Save and confirm a focus first.** **Run now** needs a focus that you saved and confirmed with **Looks right**.
- **A run is already in progress. Please wait for it to finish.** One run at a time per workspace.
- **Enter a per-run limit between RM 0 and RM 100.** Or **Enter daily and weekly limits between RM 0 and RM 10,000.**
- **Only an owner or admin can set the focus.** Ask an owner or admin.
- **Ask an owner to review this.** Viewers cannot approve or dismiss suggestions.
- **In the demo,** this screen shows a sample crew and nothing can be changed.

## Related

- [AI agents and focus](/docs/tuah/ai-agents)
- [Lekir overview](/docs/lekir/overview)
