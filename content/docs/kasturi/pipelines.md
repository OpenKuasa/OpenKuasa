---
title: Manage pipelines and stages
description: Add, rename and delete pipelines in Kasturi, pick the default one, and change the stages deals move through.
order: 6
ask: How do I add a pipeline or change the stages in Kasturi?
screen: /crm/deals
---
A pipeline is the set of stages your deals move through. You can keep more than one, for example one for new sales and one for partner deals.

## Who can do this

- Everyone in the workspace can see the pipelines and their stages.
- Owners, admins and members can add, rename, delete and reorder them. Viewers do not see **Manage pipelines**.

## Steps

### Open the pipeline settings

1. Open **Kasturi** and choose **Deals**.
2. Click **Manage pipelines** above the board. The **Pipelines** card opens.

### Add a pipeline

1. Under **New pipeline**, type a **Name**.
2. Under **Stages, separated by commas**, type the stages in board order. It starts with the stages of the starting pipeline.
3. Click **Create pipeline**. The board switches to it.

### Rename, make default or delete a pipeline

- Click **Rename**, type the **New name** and click **Save name**.
- Click **Make default** to make it the pipeline the board and the Overview open on.
- Click **Delete**, then **Delete pipeline**. Its stages are deleted too. If it was the default, another pipeline becomes the default. This cannot be undone.

### Change the stages

1. Click **Edit stages** on the pipeline.
2. To add one, type it under **New stage** and click **Add**. It goes just before **Won**, or last if there is no **Won** stage.
3. To change one, click its edit button. Change the **Stage name** or the **Win chance (%)** and click **Save**.
4. To reorder, use the move up and move down buttons beside each stage.
5. To remove one, click its remove button, then **Remove stage**. This cannot be undone.

The stage called **Won** is special: a deal moved into it counts as won. If you rename a stage to **Won**, or away from it, Kasturi tells you what changes.

## Common problems

- **Enter a name for the pipeline.** or **Keep the pipeline name to 60 characters or fewer.**: check the name.
- **Another pipeline already uses that name.**: pick a different name.
- **Enter at least two stages, separated by commas.**: a pipeline needs at least two stages.
- **A pipeline can have at most 12 stages.**: remove some stages first.
- **Use each stage name once. "…" appears twice.**: two stages in your list have the same name.
- **Keep the stage name to 30 characters or fewer.**: shorten the stage name.
- **Another stage in this pipeline already uses that name.**: pick a different stage name.
- **Enter the win chance as a whole number from 0 to 100.**: type a whole number.
- **A pipeline needs at least two stages.**: you cannot remove the second-last stage.
- **A workspace needs at least one pipeline.**: you cannot delete the only pipeline.
- **Move or delete this pipeline's deals first.** or **Move or delete this stage's deals first.**: a pipeline or stage that still holds deals cannot be deleted.
- **The stages changed while this was saving. Check them and try again.**: someone else changed the stages at the same time.

## Related

- [Add and work with deals](/docs/kasturi/deals)
- [Kasturi settings](/docs/kasturi/settings)
- [Automations](/docs/kasturi/automations)
