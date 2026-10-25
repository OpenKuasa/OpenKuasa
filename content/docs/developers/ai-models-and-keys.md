---
title: AI models and keys
description: How a self-hosted OpenKuasa pays for AI, which models it uses, and how workspace keys are kept.
order: 7
ask: How do AI keys and models work on a self-hosted OpenKuasa?
---
The assistants and agents call models through OpenRouter. Each workspace can bring its own OpenRouter key. A server can also offer a few free questions on a platform key.

## Who can do this

- Server settings: anyone running their own copy.
- A workspace's own key: only owners and admins add, change or remove it, on **AI key**.

## How a chat question is paid for

1. **The workspace has its own key.** The question runs on that key. As a guard against a runaway script or a stolen session, each person may run up to 200 chat turns a day on it, counted per person and reset at midnight UTC. Approving a change the assistant proposed counts as a turn. If the server cannot open the stored key, chat stops. It never falls back to the platform key.
2. **No workspace key, and the server has `OPENROUTER_API_KEY`.** Each signed-up person gets 3 free questions a week on the platform key.
3. **Neither.** Chat asks for a key: **"Add your OpenRouter key to keep chatting."**

Demo visitors never reach a model.

## Steps

### Let workspaces save their own keys

1. Set `AI_KEYS_ENCRYPTION_SECRET` (32+ characters) on the server. Without it, a workspace cannot save its own key.
2. Set `SUPABASE_SERVICE_ROLE_KEY`. The stored key is read on the server with it.
3. Use the same `AI_KEYS_ENCRYPTION_SECRET` on every host, and keep it. Each stored key is sealed with it (AES-256-GCM) and bound to its workspace, so a value copied to another workspace does not open.

How an owner adds the key is in [Add your OpenRouter key](/docs/getting-started/openrouter-key).

### Offer free questions (optional)

Set `OPENROUTER_API_KEY` to a key of your own. It pays for the free questions. Without it there are no free questions.

### Choose the models

Set these to OpenRouter model ids:

- `OPENKUASA_MODEL_ORCHESTRATOR` and `OPENKUASA_MODEL_WORKER`: the models for Tuah and its specialists. The orchestrator can be a strong model while the specialists run a cheaper, faster one.
- `OPENKUASA_MODEL_RECEIPTS`: the model that reads receipts. Without it, the worker model is used. With neither, a receipt is not read and the Receipts Inbox says **"Reading receipts is not set up on this server."**
- `OPENKUASA_MODEL_AGENT_SEARCH`, `OPENKUASA_MODEL_AGENT_DIGEST`, `OPENKUASA_MODEL_AGENT_IMAGE`, `OPENKUASA_MODEL_AGENT_VIDEO`: the Weekly Studio agent's steps.

An unset Tuah or Weekly Studio model variable falls back to a default written in the code. Set them yourself so you know what you are paying for.

`AI_GATEWAY_BASE_URL` puts an optional gateway in front of OpenRouter.

## Common problems

- **"Your workspace key could not be used on this server. Ask an owner to save it again."** The stored key was sealed with a different `AI_KEYS_ENCRYPTION_SECRET`, or the server has none. Set the original secret, or have an owner or admin save the key again.
- **"Chat is unavailable right now. Please try again."** The server could not read the stored key (for example, `SUPABASE_SERVICE_ROLE_KEY` is missing), the free-question count or the daily count.
- **"You have reached today’s chat limit. It resets at midnight UTC."** The person has used their 200 turns for the day on the workspace key.
- **"Add your OpenRouter key to keep chatting."** The free questions are used up for the week, or the server has no `OPENROUTER_API_KEY`.

## Related

- [Add your OpenRouter key](/docs/getting-started/openrouter-key)
- [Environment variables](/docs/developers/environment-variables)
