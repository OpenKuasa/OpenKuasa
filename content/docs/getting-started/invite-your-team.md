---
title: Invite your team
description: Create invite links for the people you work with, give each a role, and change or remove members later.
order: 5
ask: How do I invite someone to my OpenKuasa workspace and choose their role?
screen: /account/team
---
You add people to your workspace with invite links. Each link is for one email address and one role.

## Who can do this

Only workspace owners and admins can invite, change roles and remove members. Members and viewers see the **Team** page with the note **Only owners and admins can invite and manage members.** In the demo workspace the page is read-only.

## Steps

### Invite someone

1. Open the account menu (your name, top right) and choose **Role Permission**. Or go to [Team](/account/team).
2. Under **Invite a member**, enter the person's **Email**.
3. Choose a **Role**: **Admin**, **Member** or **Viewer**. **Member** is picked for you.
4. Click **Create invite link**.
5. Click **Copy link** and send the link to the person yourself, for example by chat or email.

OpenKuasa does not email the invite. The link works for 7 days, and only for the email you entered. The person opens it and follows [Join a workspace from an invite](/docs/getting-started/join-a-workspace).

If you invite the same email again, the new link replaces the old one.

### See or cancel open invites

**Pending invites** lists every link that has not been used yet, with its role and the date it expires. Each one has its link and a **Copy link** button, so you can send it again.

To cancel an invite, click **Revoke**. The link stops working.

### Change someone's role

1. In the members list, find the person.
2. Under **Manage**, pick a new role from the list next to their name.

The person gets an in-app notification that their role changed. You cannot change your own role or the owner's role, so there is no list next to those rows.

### Remove someone

1. In the members list, click **Remove** next to the person.
2. Click **Confirm remove**, or **Cancel** to keep them.

They lose access to the workspace. You cannot remove yourself or the owner.

## What each role can do

The **Roles & permissions** table at the bottom of the **Team** page shows what each role can do:

| Capability | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| View dashboards | Yes | Yes | Yes | Yes |
| Manage contacts & deals | Yes | Yes | Yes | No |
| Approve leave & claims | Yes | Yes | No | No |
| Post, pay & void finance documents | Yes | Yes | No | No |
| Edit company details | Yes | Yes | No | No |
| Manage billing & plan | Yes | Yes | No | No |
| Invite & manage members | Yes | Yes | No | No |
| Manage the workspace AI key | Yes | Yes | No | No |
| Manage the workspace email key | Yes | Yes | No | No |
| Send broadcasts by email | Yes | Yes | No | No |
| Manage AI agents & their spend | Yes | Yes | No | No |
| See & revoke everyone's API keys | Yes | Yes | No | No |
| Delete workspace | Yes | No | No | No |

![The Roles & permissions table on the Team page](/docs-media/getting-started/team-roles.png)

The person who created the workspace is its owner. The owner role cannot be given in an invite or a role change.

## Common problems

- **That person is already a member of this workspace.** They are already in. Change their role instead.
- **Please enter a valid email address.** Check the email for typing mistakes.
- **You cannot change your own role.** Ask another owner or admin to do it.
- **The owner’s role cannot be changed.** and **The owner cannot be removed.** The owner always stays the owner.
- **You cannot remove yourself from the workspace.** Ask another owner or admin.
- **Only owners and admins can manage members.** Ask an owner or admin.
- **The demo workspace is read-only. Sign up to invite your own team.** Sign up for your own workspace first.

## Related

- [Join a workspace from an invite](/docs/getting-started/join-a-workspace)
- [Fill in your company details](/docs/getting-started/company-details)
- [Add your OpenRouter key](/docs/getting-started/openrouter-key)
