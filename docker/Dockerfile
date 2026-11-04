# syntax=docker/dockerfile:1
# The OpenKuasa app image for the Docker setup (docker compose up).
#
#   default command        the app: node server.js on 0.0.0.0:3000, non-root
#   one-off steps          node /app/tools/scripts/local-init.mjs
#                          node /app/tools/scripts/migrate-local.mjs
#
# /app/tools mirrors the repo layout (scripts/, supabase/, docker/) so the
# scripts find ../supabase/migrations exactly as they do in a checkout.
# Nothing about Supabase is baked in: the app reads it at run time.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Every dependency, from the lockfile.
FROM base AS deps
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# The standalone server. No Supabase variables are set here on purpose.
# Tracing already puts some public/ files in standalone/public, so copy the
# contents of public/ into it rather than the folder itself.
FROM base AS build
WORKDIR /src
COPY --from=deps /src/node_modules ./node_modules
COPY . .
# The type check needs more than Node's default heap.
ENV NEXT_OUTPUT=standalone \
    NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm build \
 && test -f .next/standalone/server.js \
 && mkdir -p .next/standalone/public .next/standalone/.next/static \
 && cp -r public/. .next/standalone/public/ \
 && cp -r .next/static/. .next/standalone/.next/static/ \
 && test -d .next/standalone/content/docs

# pg for the migration runner, at the version the lockfile pins, and nothing else.
FROM base AS tools
WORKDIR /tools
COPY --from=deps /src/node_modules/pg/package.json /tmp/pg.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    version="$(node -p "require('/tmp/pg.json').version")" \
 && printf '{"name":"openkuasa-tools","private":true,"dependencies":{"pg":"%s"}}\n' "$version" > package.json \
 && pnpm install --config.node-linker=hoisted \
 && node -e "require('pg')"

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /src/.next/standalone ./
COPY --from=tools /tools/node_modules /app/tools/node_modules
COPY scripts/db-migrate.mjs scripts/migrate-local.mjs scripts/local-init.mjs /app/tools/scripts/
COPY supabase/migrations /app/tools/supabase/migrations
COPY supabase/email-templates /app/tools/supabase/email-templates
COPY --chmod=755 docker/with-secrets.sh docker/app-entrypoint.sh /app/tools/docker/

# /secrets belongs to the app user, so a fresh named volume mounted there
# is writable by local-init.
RUN mkdir -p /secrets && chown node:node /secrets

USER node
EXPOSE 3000
CMD ["/app/tools/docker/app-entrypoint.sh"]
