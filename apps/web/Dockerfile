FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json ./
RUN pnpm install --frozen-lockfile=false
COPY . .

ARG NEXT_PUBLIC_API_URL=/api/v1
ARG NEXT_PUBLIC_MAP_STYLE_URL=https://demotiles.maplibre.org/style.json
ARG NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE=false
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_MAP_STYLE_URL=${NEXT_PUBLIC_MAP_STYLE_URL}
ENV NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE=${NEXT_PUBLIC_FEATURE_OFFLINE_QUEUE}
RUN pnpm build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
