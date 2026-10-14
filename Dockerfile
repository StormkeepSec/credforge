# syntax=docker/dockerfile:1
# One image, three roles (docker-compose.yml): app (default), worker, migrate.

ARG NODE_IMAGE=node:24-trixie-slim

# ---- build: install all dependencies, build the web app and the server bundle ----
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Manifests first so dependency installation is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/ scripts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/ob3/package.json packages/ob3/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @credforge/web --filter @credforge/server run build

# Production dependencies of the server only; workspace packages are already bundled into dist.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @credforge/server deploy --prod --legacy /out

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="credforge" \
      org.opencontainers.image.description="Create and award Open Badges 3.0 digital badges." \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production
WORKDIR /app/apps/server

COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/web/dist /app/apps/web/dist
COPY --from=build /repo/packages/db/migrations /app/packages/db/migrations

RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server.js"]
