# Contributing to OpenKuasa

OpenKuasa is a crowd-sourced, open-source project — it exists because people
contribute. Thank you for being one of them.

The maintainers plan to offer a paid hosted version alongside the free
self-hosted one. It is built on the code in this repository, and everything you
contribute here stays open source under AGPL-3.0. See the
[Contributor License Agreement](#contributor-license-agreement) below for what
that means for your contributions.

## Ground rules

### Original work only

OpenKuasa is an independent project, not affiliated with or representing any
other company or product. To keep it that way:

- **Do not copy from any proprietary product.** That means no source code,
  marketing or interface text, pricing, designs, screenshots, logos, icons,
  images or data.
- **Do not use another company's names or branding** in the product. The
  interface, sample data and marketing pages must never present OpenKuasa as
  another product or suggest a connection to one.
- **Do not contribute anything you obtained under an agreement** with another
  company (as a customer, employee, contractor or partner) that restricts its
  use.
- **Do not make claims that aren't true** — no invented customer numbers,
  testimonials, certifications or company details.

Solve problems your own way. Building the same kind of feature is fine;
reproducing someone else's implementation of it is not.

### Licensing

OpenKuasa is licensed under [AGPL-3.0](LICENSE). Contributions are accepted
under the Contributor License Agreement below. Please read it before opening a
pull request.

## Contributor License Agreement

OpenKuasa is free to self-host, and the maintainers also plan to run a paid
hosted version to fund the project. The hosted version may include code that is
not part of this repository, such as billing and infrastructure. For that to be
possible alongside outside contributions, the maintainers need rights beyond
those the AGPL-3.0 gives everyone. This agreement grants them.

By submitting a contribution (a pull request, patch or any other material) to
this repository, you agree to the following:

1. **You keep your copyright.** You are not assigning ownership of your
   contribution to anyone.
2. **Copyright license.** You grant the OpenKuasa maintainers a perpetual,
   worldwide, non-exclusive, royalty-free, irrevocable license to use,
   reproduce, modify, distribute, publicly perform and display, and sublicense
   your contribution, and to license it to others under any terms, including
   terms other than AGPL-3.0.
3. **Patent license.** You grant the OpenKuasa maintainers and everyone who
   receives the software a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable license under any patent claims you own that are necessarily
   infringed by your contribution, to make, use, sell and otherwise transfer
   it.
4. **Your work, your right to share it.** You confirm the contribution is your
   original work, or that you have the right to submit it under these terms.
   If your employer has rights to work you create, you confirm you have their
   permission. You confirm it contains nothing copied from any proprietary
   product.
5. **No warranty.** Your contribution is provided as is. You are not required
   to support it.

In return, the maintainers commit that **every contribution accepted into this
repository will remain available to everyone under AGPL-3.0** (or a later
version of it). Code that has been published here as open source will not be
taken closed.

If you do not agree to these terms, please do not submit a contribution.

### How to agree

Every pull request must include this line in its description, which the pull
request template adds for you:

> I have read the OpenKuasa Contributor License Agreement in CONTRIBUTING.md
> and I agree to it for this and my future contributions.

## Ways to contribute

You do not have to write code. Bug reports, ideas, design, documentation and
testing on real devices are all useful.

- **Found a bug?** Open a
  [bug report](https://github.com/OpenKuasa/OpenKuasa/issues/new/choose).
- **Have an idea, or want to build something?** Open a
  [feature request](https://github.com/OpenKuasa/OpenKuasa/issues/new/choose).
- **Found a security problem?** Do not open an issue. Follow the
  [security policy](SECURITY.md).
- **Want something to work on?** Look for issues labelled
  [`good first issue`](https://github.com/OpenKuasa/OpenKuasa/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/OpenKuasa/OpenKuasa/labels/help%20wanted).

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Issues

Search the open issues before opening a new one. If yours is already there, add
to it instead.

### When to open an issue first

- **Small changes** such as a typo, a broken link, a styling fix or an obvious
  bug can go straight to a pull request.
- **Anything bigger** starts as an issue: a new screen, a new database table,
  a new dependency, or a change to how an existing feature behaves. Agreeing
  the scope first saves you from building something that cannot be merged.

### Claiming an issue

Comment on the issue to say you would like to take it, and a maintainer will
assign it to you. Please do not start on an issue that is assigned to someone
else. If you can no longer work on something you claimed, say so on the issue
so someone else can pick it up.

### Labels

Maintainers apply labels; the issue forms add the first ones for you. Every
issue gets one type label and, where it applies, an area label.

| Label | Meaning |
|---|---|
| `bug` | Something is broken. |
| `enhancement` | A new feature or an improvement to an existing one. |
| `documentation` | Changes to the README, guides or comments. |
| `accessibility` | A barrier for people with disabilities. |
| `question` | A question, not a request for a change. |
| `good first issue` | Small and well described; a good place to start. |
| `help wanted` | The maintainers would welcome someone taking this on. |
| `area: tuah` | Tuah, the command centre. |
| `area: jebat` | Jebat, leads and ads. |
| `area: kasturi` | Kasturi, the CRM. |
| `area: lekiu` | Lekiu, people and payroll. |
| `area: lekir` | Lekir, hiring. |
| `area: bendahara` | Bendahara, accounting and e-Invois. |
| `area: taming sari` | Taming Sari, the AI assistant. |
| `area: landing` | The landing, pricing and other public pages. |
| `area: platform` | Sign-in, accounts, the database and deployment. |
| `needs triage` | New; a maintainer has not looked at it yet. |
| `needs discussion` | The scope or approach is not agreed yet. Do not start work. |
| `ready` | Agreed and ready for someone to build. |
| `blocked` | Waiting on another issue or pull request. |
| `duplicate`, `invalid`, `wontfix` | Closed without a change, with the reason given. |

## Making a change

1. Fork the repository and clone your fork.
2. Install and run:

   ```bash
   pnpm install
   pnpm dev
   ```

   The [README](README.md) explains the environment variables and the Supabase
   settings needed for sign-in and the database.
3. Create a branch from an up-to-date `main` (see below for the name).
4. Make your change in small, focused commits.
5. Run the checks:

   ```bash
   pnpm lint
   pnpm test
   pnpm build
   ```

   Some tests talk to a real Supabase project. If you have not set one up, say
   in your pull request which tests you could not run.
6. Push to your fork and open a pull request against `main`.

Always use pnpm, not npm or yarn.

### Adding a screen

Each screen has its own route, so a page loads only the scripts its own screen
needs. To add one:

1. Write the screen in `src/screens/<module>/<name>.tsx` with a default export.
2. Make sure its menu item exists in `src/config/nav.ts`.
3. Import it in `src/screens/registry.ts` and add its key, such as
   `'crm/plugins'`.
4. Run `pnpm gen:routes` and commit the `page.tsx` it writes under
   `src/app/(app)/<module>/<name>/` together with your change.

`pnpm dev` and `pnpm build` run step 4 for you, and `pnpm test` fails if a
route file is missing or out of date. Do not edit the generated `page.tsx`
files, and do not import `src/screens/registry.ts` from app code: that puts
every screen back on every page. A menu item with no screen yet shows a
placeholder.

### Branch names

Name your branch `type-description`, in lower case with hyphens, where the type
is `feat` for a feature, `bug` for a fix or `exp` for an experiment. If an
issue tracks the work, put its number after the type:

- `feat-41-purchases-backend` for work on issue #41
- `bug-drawer-reopens-on-back` when there is no issue

Maintainers' own branches carry a three-digit sequence number, such as
`feat-046-contributing-guide`. That sequence is kept inside this repository, so
please do not try to continue it from a fork.

## Pull requests

- **One topic per pull request.** Unrelated fixes go in separate pull requests;
  they are quicker to review and safer to merge.
- **Give it a clear title.** Either your branch name or a short description
  such as `fix: close the drawer on back` is fine.
- **Link the issue.** If an issue tracks the work, write `Closes #41` in the
  description so it closes when the pull request merges. If there is no issue,
  leave the line out; you do not need to create one.
- **Show interface changes.** Add before and after screenshots, including one
  at phone width.
- **Keep the agreement line.** The template adds the Contributor License
  Agreement line; a pull request without it cannot be merged.
- **Say what it depends on.** If your pull request builds on another one that
  is still open, name it in the description. Smaller independent pull requests
  are merged sooner than a long stack.
- **Not finished?** Open it as a draft.

### Review

A maintainer will review your pull request and may ask for changes. To keep
things moving, a maintainer may also push a small fix to your branch directly,
and will say so in a comment; this needs "Allow edits from maintainers" left
ticked, which is the default.

Pull requests are squash-merged, so your commits become one commit on `main`
with you as the author. There is no need to tidy your commit history first.

If `main` has moved on and your branch conflicts with it, rebase onto the
latest `main` and push again.

## Code style

- TypeScript, 2-space indentation, single quotes, semicolons.
- Functional React components with hooks; named exports.
- Server Components by default; add `'use client'` only when needed.
- Read `AGENTS.md` before touching Next.js APIs — this project is on Next.js 16,
  which differs from earlier versions.

## Where help is needed most

The interface is built; much of the backend is not. See the Status section of
the [README](README.md). Wiring screens to Supabase and the AI assistants are
the most valuable places to start.

## Reporting a concern

If you believe something in this repository copies or misrepresents another
product, open an issue so it can be removed.
