---
title: Set up email sending
description: Connect your own Resend account so Kasturi can send broadcasts from your own address.
order: 9
ask: How do I set up email sending for broadcasts in Kasturi?
screen: /crm/broadcast
---
Kasturi sends broadcasts through your own Resend account, from an address on your own domain. You add the key and the sender once, in **Email settings**.

## Who can do this

Only workspace owners and admins can add, change or remove the email settings. Others do not see **Email settings**. Until it is set up, they see **Email sending is not set up. Ask an owner or admin to connect it.**

## Before you start

- Create a Resend account and verify your domain with Resend.
- Create a Resend API key. It starts with `re_`.
- Emails are billed to your Resend account.

## Steps

1. Open **Kasturi** and choose **Broadcast**.
2. Click **Email settings**.
3. Paste the key into **Resend API key**.
4. Type a **Sender name**, the name people see the email is from.
5. Type a **Sender email** on a domain you have verified with Resend.
6. Click **Save settings**. Kasturi checks the key with Resend before it saves anything.
7. You see **Email settings saved.** Under **My broadcasts**, the screen now shows who broadcasts are sent as.

The key is stored sealed (encrypted) and is never shown again. Only its last four characters are shown.

### Change or remove the settings

- To change the key or the sender, open **Email settings** again, enter the details and click **Save settings**. The key must be entered each time you save.
- To stop sending, click **Remove key**. Broadcasts already sent are kept.

## Common problems

- **That does not look like a Resend API key. It should start with re_.**: check you copied the whole key.
- **Resend rejected that key. Check it and try again.**: the key is wrong or has been revoked in Resend.
- **Could not reach Resend to check the key. Please try again.**: try again in a moment.
- **Enter the email address to send from, on a domain you have verified with Resend.**: fix the sender email.
- **The sender name cannot contain <, > or quotation marks.**: remove those characters.
- **Only owners and admins can manage the email settings.**: ask an owner or admin.
- **The demo workspace is read-only. Sign up to send broadcasts.**: the demo cannot save email settings.

## Related

- [Send a broadcast](/docs/kasturi/broadcast)
- [Plugins](/docs/kasturi/plugins)
