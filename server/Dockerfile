# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile --filter @claude-sync/server --filter @claude-sync/web --ignore-scripts

FROM deps AS build
COPY server ./server
COPY web ./web
RUN pnpm -F @claude-sync/server build
RUN pnpm -F @claude-sync/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/src/db/migrations ./server/dist/db/migrations
COPY --from=build /app/server/package.json ./server/package.json
# Web app bundle — Fastify static serves this at /
COPY --from=build /app/web/dist ./web
EXPOSE 8080
WORKDIR /app/server
CMD ["node", "dist/index.js"]