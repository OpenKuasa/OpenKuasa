---
title: Add a screen
description: Add a new screen to an OpenKuasa product, with its own route.
order: 10
ask: How do I add a new screen to an OpenKuasa product?
---
Each screen has its own route, so a page loads only the scripts its own screen needs. Adding one takes four steps.

## Who can do this

Anyone changing the code. A new screen is a bigger change: open an issue first. See [Contribute to OpenKuasa](/docs/developers/contributing).

## Steps

1. Write the screen in `src/screens/<product>/<name>.tsx`, with a default export.
2. Make sure its menu item exists in `src/config/nav.ts`.
3. Import it in `src/screens/registry.ts` and add its key, such as `'crm/plugins'`. The key must be a menu item in `src/config/nav.ts`.
4. Run `pnpm gen:routes`, and commit the `page.tsx` it writes under `src/app/(app)/<product>/<name>/` with your change.

`pnpm dev` and `pnpm build` run step 4 for you. `pnpm gen:routes --check` changes nothing and fails if a route file is out of date.

When the screen reads and writes the workspace's own data, add its key to `src/config/live-screens.ts`. Until then it shows sample data with a work-in-progress banner.

## Common problems

- **`pnpm test` fails.** A route file is missing or out of date. Run `pnpm gen:routes` and commit the result.
- **Do not edit the generated `page.tsx` files.** They are rewritten from the registry and the menu.
- **Do not import `src/screens/registry.ts` from app code.** That puts every screen back on every page.
- **The menu item shows a placeholder.** It has no screen in the registry yet.

## Related

- [How OpenKuasa is built](/docs/developers/architecture)
- [Contribute to OpenKuasa](/docs/developers/contributing)
