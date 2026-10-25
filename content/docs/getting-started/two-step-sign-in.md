---
title: Turn on two-step sign-in
description: Protect your account with a 6-digit code from an authenticator app, and keep recovery codes in case you lose your phone.
order: 11
ask: How do I turn on two-step sign-in with an authenticator app?
screen: /account/security
---
Two-step sign-in (two-factor authentication) adds a second step when you sign in: a 6-digit code from an authenticator app on your phone.

## Who can do this

Every signed-in person can turn it on for their own account, whatever their role. It is not available in the demo workspace.

## Before you start

Install an authenticator app on your phone. Any app that shows 6-digit sign-in codes from a QR code works.

## Steps

### Turn it on

1. Open the account menu (your name, top right) and choose **Change Password**, or go to [Security](/account/security).
2. Under **Two-factor authentication**, next to **Authenticator app**, click **Set up**.
3. Scan the QR code with your authenticator app. If you can't scan it, type the key shown under **Can't scan it? Enter this key by hand:** into the app.
4. Enter the **6-digit code** your app shows and click **Turn on**.
5. OpenKuasa shows 10 recovery codes under **Save your recovery codes**. Click **Copy** or **Download (.txt)** and keep them somewhere safe.
6. Click **I've saved these codes**.

The recovery codes are shown only once. Each one works once.

The status next to **Authenticator app** now says **On**.

### Sign in with a code

1. Sign in with your email and password as usual.
2. On **Enter your code**, type the 6-digit code from your app into **Authentication code**.
3. Click **Verify**.

### If you lose your phone

1. On **Enter your code**, click **Use a recovery code**.
2. Enter one of your saved codes in **Recovery code** and click **Use recovery code**.

Using a recovery code turns two-step sign-in off and your other recovery codes stop working. Once you are signed in, the **Security** page asks you to set it up again.

### Get new recovery codes

1. On the [Security](/account/security) page, under **Recovery codes**, check how many you have left.
2. Click **Regenerate recovery codes**.
3. Enter a code from your app and click **Regenerate codes**.

Your old recovery codes stop working. Save the new ones.

### Turn it off

1. On the [Security](/account/security) page, click **Turn off**.
2. Enter a code from your app and click **Turn off** again.

Your recovery codes are deleted. OpenKuasa sends you a notification when two-step sign-in is turned off.

## Common problems

- **That code is not right. Check your authenticator app and try again.** Type the newest code from your app.
- **Too many attempts. Wait a minute and try again.** or **Too many attempts. Wait a moment and try again.** Wait, then try once more.
- **Too many attempts. Try again in 15 minutes.** Too many recovery codes were tried. Wait 15 minutes.
- **This setup has expired. Start again.** Click **Cancel**, then **Set up** again.
- **You have no recovery codes left.** Click **Regenerate recovery codes** now, or you cannot sign in if you lose your phone.
- **Two-factor authentication is on, but your recovery codes could not be saved.** Two-step sign-in is on. Click **Regenerate recovery codes** straight away.
- **That recovery code is not right.** Check the code. Codes look like `XXXXX-XXXXX`.
- **Two-factor authentication is not available in the demo workspace. Sign up to use it.** Sign up for your own account first.

## Related

- [Change your password and sign out other devices](/docs/getting-started/change-your-password)
- [Sign in and reset your password](/docs/getting-started/sign-in)
- [Change your profile and sign-in email](/docs/getting-started/your-profile)
