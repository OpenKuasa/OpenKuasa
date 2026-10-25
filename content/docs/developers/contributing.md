---
title: Contribute to OpenKuasa
description: The rules, the Contributor License Agreement, branch names and pull requests for contributing to OpenKuasa.
order: 9
ask: How do I contribute a change to OpenKuasa?
---
OpenKuasa is built by its contributors. Code, design, docs, translations, bug reports and ideas are all welcome. The full guide is `CONTRIBUTING.md` in the repository.

## Who can do this

Anyone with a GitHub account who agrees to the Contributor License Agreement.

## Before you start

- **Contribute only your own original work.** Never copy code, text, designs, screenshots, logos, icons, images or data from any proprietary product.
- Do not use another company's names or branding in the product, and make no claims that are not true.
- Do not contribute anything you obtained under an agreement with another company that restricts its use.
- Read the Contributor License Agreement in `CONTRIBUTING.md`. In short: you keep your copyright; you give the maintainers a licence to use your contribution, including under terms other than AGPL-3.0; and every contribution accepted into the repository stays available to everyone under AGPL-3.0.

## Steps

1. **Find or open an issue.** Small changes (a typo, a broken link, a styling fix, an obvious bug) can go straight to a pull request. Anything bigger starts as an issue: a new screen, a new database table, a new dependency, or a change to how a feature behaves. Look for issues labelled `good first issue` or `help wanted`.
2. **Claim it.** Comment on the issue, and a maintainer will assign it to you. Do not start on an issue assigned to someone else.
3. **Fork and run it.**

   ```bash
   pnpm install
   pnpm dev
   ```

   Always use pnpm, not npm or yarn.
4. **Make a branch** from an up-to-date `main`, named `type-description` in lower case with hyphens. The type is `feat` for a feature, `bug` for a fix or `exp` for an experiment. If an issue tracks the work, put its number after the type: `feat-41-purchases-backend`. Without one: `bug-drawer-reopens-on-back`.
5. **Make your change** in small, focused commits.
6. **Run the checks:**

   ```bash
   pnpm lint
   pnpm test
   pnpm build
   ```

   Some tests talk to a real Supabase project. If you have not set one up, say in your pull request which tests you could not run.
7. **Open a pull request** against `main`.

## Pull requests

- One topic per pull request.
- A clear title: your branch name, or a short description such as `fix: close the drawer on back`.
- If an issue tracks the work, write `Closes #41` in the description. If there is no issue, leave the line out; you do not need to create one.
- For interface changes, add before and after screenshots, including one at phone width.
- Keep the agreement line the template adds. A pull request without it cannot be merged.
- If it builds on another open pull request, name it.
- Not finished? Open it as a draft.

Pull requests are squash-merged, so your commits become one commit on `main` with you as the author. If `main` has moved on and your branch conflicts with it, rebase onto the latest `main` and push again.

## Code style

- TypeScript, 2-space indentation, single quotes, semicolons.
- Functional React components with hooks, and named exports.
- Server Components by default. Add `'use client'` only when needed.

## Common problems

- **`pnpm test` fails on a route file.** A screen's route file is missing or out of date. Run `pnpm gen:routes` and commit what it writes. See [Add a screen](/docs/developers/add-a-screen).
- **You found a security problem.** Do not open an issue. Follow the security policy in `SECURITY.md`.

## Related

- [Add a screen](/docs/developers/add-a-screen)
- [How OpenKuasa is built](/docs/developers/architecture)
- [Run your own copy](/docs/developers/self-hosting)
