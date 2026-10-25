---
title: Set Weekly Studio's schedules and spend caps
description: Choose how often Weekly Studio runs and how much of your AI key it may spend each day and each week.
order: 4
ask: How do I make Weekly Studio run on a schedule, and cap what it spends?
screen: /reach/agents
---
Schedules decide when Weekly Studio runs by itself. Spend caps decide how much it may spend across the workspace each day and each week.

## Who can do this

Only owners and admins can add, edit, pause, resume or cancel a schedule, and change the spend caps. Members and viewers see the schedules and the spend, with the note **No schedules yet. An owner or admin can add one.** when there are none.

## Before you start

Weekly Studio must be turned on, and your workspace needs its own AI key. See [Turn on and run Weekly Studio](/docs/jebat/weekly-studio).

## Steps

### Set the spend caps

1. Open **Jebat** and choose **AI Agents** in the side menu.
2. Under **Schedules**, look at **Weekly spend** and **Today**. They show what Weekly Studio has spent in the last 7 days and the last 24 hours, against your caps.
3. Type a **Daily cap (RM)** and a **Weekly cap (RM)**, from RM 0 to RM 10,000. Each saves when you click outside its box. Until you save your own, the caps are RM 5.00 a day and RM 20.00 a week.

### Add a schedule

1. Under **Schedules**, click **Add schedule**.
2. Fill in:
   - **Repeat every (minutes)**: at least 5 minutes, at most one year (525,600 minutes). It starts at 10,080 minutes, which is one week.
   - **Stop after (runs)**: 1 to 1000, or leave it blank for no limit.
   - **Budget (RM)**: RM 0 to RM 1000 for this schedule, or leave it blank for no limit.
3. Click **Create schedule**. The first run is one interval from now.

Choosing **Daily** or **Weekly** under **Cadence** also makes a schedule for you, shown as **cadence preset**. Choosing **Off** cancels it.

### Change a schedule

Each schedule shows when it runs next, how many runs it has used and what it has spent.

- Click **Pause** to stop it for now, and **Resume** to start it again.
- Click **Edit**, change the values, and click **Save changes**.
- Click **Cancel**, then **Cancel schedule**, to end it. It is marked **Completed** and cannot be started again; make a new schedule instead.

A schedule is marked **Completed** by itself when it reaches its **Stop after (runs)** or its **Budget (RM)**.

## Common problems

- **"Paused — daily budget reached" or "Paused — weekly budget reached".** The workspace hit a spend cap, so its active schedules were paused. They do not start again by themselves: raise the cap or wait, then click **Resume**.
- **"Enter spend caps between RM 0 and RM 10,000."** A cap is empty or out of range.
- **"Enter a whole number of minutes."**, **"Minimum 5 minutes."** or **"Enter 1 to 1000, or leave blank for no limit."** Fix the value shown in red.
- **Weekly Studio is turned off.** A schedule does not run while the switch is off. It picks up again when an owner or admin turns it back on.

## Related

- [Turn on and run Weekly Studio](/docs/jebat/weekly-studio)
- [Approve or reject Weekly Studio's suggestions](/docs/jebat/agent-suggestions)
