# API + worker image (one image, two roles — compose overrides the command
# for the worker service). Build context is the REPO ROOT.
#
# Runtime choice: fully compiled, plain `node` — no tsx in production. The
# api compiles with its existing tsc `build` script. @retrowatchdog/shared
# ships TS source in dev (`main: src/index.ts`, no build step), which plain
# node cannot load (Node 24 type-stripping refuses to map its NodeNext
# ".js" import specifiers onto ".ts" files), so this image compiles shared
# to JS as well and repoints its package.json at dist — inside the image
# only; the dev workspace keeps linking TS source.

FROM node:24-alpine AS build
RUN npm install -g pnpm@11
WORKDIR /repo

# Manifests first: dependency layers only invalidate when a manifest or the
# lockfile changes, not on every source edit. `--filter @retrowatchdog/api...`
# prunes the workspace install to api + its workspace deps (shared); pnpm 11
# tolerates lockfile importers (apps/web) absent from the context.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @retrowatchdog/api...

# Sources second (COPY merges into the dirs; node_modules stays intact)
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @retrowatchdog/api build
# Compile shared for runtime. tsc CLI with file args skips tsconfig (TS7
# demands --ignoreConfig to make that explicit), so the emit options are
# spelled out here; they match tsconfig.base.json.
RUN pnpm --filter @retrowatchdog/shared exec tsc src/index.ts src/platforms.ts \
    --ignoreConfig --outDir dist --module nodenext --moduleResolution nodenext \
    --target es2022 --skipLibCheck

FROM node:24-alpine
RUN npm install -g pnpm@11
WORKDIR /repo
ENV NODE_ENV=production

# Prod deps only (no typescript/tsx/vitest), same pruned filter
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @retrowatchdog/api...

COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/drizzle apps/api/drizzle
# Point the workspace-linked shared package at the compiled JS (see header).
# Runs after the install so pnpm's symlink layout is already settled.
RUN sed -i 's|"src/index.ts"|"dist/index.js"|g' packages/shared/package.json

# the image's own unprivileged user: the api and the worker never write to the filesystem
USER node
EXPOSE 3001
# Migrations run on every boot, then the server starts. drizzle's migrator is
# idempotent (journal table), so restarts are safe. The worker service
# replaces this command and therefore never races the DDL — compose gates it
# on the api being healthy.
CMD ["sh", "-c", "node apps/api/dist/db/migrate.js && node apps/api/dist/server.js"]
