# Web image: Vite production bundle served by Caddy, which also proxies
# /api/* to the api service (see apps/web/Caddyfile) so the SPA's relative
# `/api` calls work identically in dev (vite proxy) and in containers.
# Build context is the REPO ROOT.

FROM node:24-alpine AS build
RUN npm install -g pnpm@11
WORKDIR /repo

# Manifests first for layer caching (see apps/api/Dockerfile for rationale)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @retrowatchdog/web...

COPY packages/shared packages/shared
COPY apps/web apps/web
# `vite build` directly, not the package's `build` script: that script also
# runs `tsc --noEmit`, which dev/CI already cover — the image build only
# needs the bundle.
RUN pnpm --filter @retrowatchdog/web exec vite build

FROM caddy:2-alpine
COPY --from=build /repo/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
# APP_AUTH picks the Caddyfile snippet: password protection is on exactly when
# a hash is set. Resolved here because a Caddyfile placeholder has no "empty
# means default" and compose cannot express "auth if set, noauth otherwise".
CMD ["sh", "-c", "export APP_AUTH=$([ -n \"$APP_PASSWORD_HASH\" ] && echo auth || echo noauth); exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
