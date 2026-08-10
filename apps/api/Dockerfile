FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json ./
RUN pnpm install --frozen-lockfile=false
COPY . .
RUN pnpm build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json ./
RUN pnpm install --prod --frozen-lockfile=false
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY migrations ./migrations
EXPOSE 3001
CMD ["sh", "-c", "node scripts/migrate.mjs && node dist/main.js"]
