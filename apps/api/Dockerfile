FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml ./
COPY packages/secure-envelope/package.json ./packages/secure-envelope/package.json
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --filter @sos/api... --no-frozen-lockfile
COPY packages/secure-envelope ./packages/secure-envelope
COPY apps/api ./apps/api
WORKDIR /workspace/apps/api
RUN pnpm build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml ./
COPY packages/secure-envelope/package.json ./packages/secure-envelope/package.json
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --prod --filter @sos/api... --no-frozen-lockfile
COPY packages/secure-envelope ./packages/secure-envelope
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY apps/api/scripts ./apps/api/scripts
COPY apps/api/migrations ./apps/api/migrations
WORKDIR /workspace/apps/api
EXPOSE 3001
CMD ["sh", "-c", "node scripts/migrate.mjs && node dist/main.js"]
