FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json ./
RUN pnpm install --frozen-lockfile=false
COPY . .
RUN pnpm build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
