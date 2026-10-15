# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS deps
WORKDIR /workspace
ENV HUSKY=0

COPY package.json package-lock.json tsconfig.base.json eslint.config.js .prettierrc .prettierignore ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY lib/vecs/package.json lib/vecs/package.json
COPY lib/vecs-client/package.json lib/vecs-client/package.json
COPY lib/vecs-mcp/package.json lib/vecs-mcp/package.json
COPY lib/vecs-phaser/package.json lib/vecs-phaser/package.json
COPY lib/vecs-phaser-client/package.json lib/vecs-phaser-client/package.json
COPY lib/vecs-phaser-server/package.json lib/vecs-phaser-server/package.json
COPY lib/vecs-physics/package.json lib/vecs-physics/package.json
COPY lib/vecs-protocol/package.json lib/vecs-protocol/package.json
COPY lib/vecs-server/package.json lib/vecs-server/package.json
COPY lib/vecs-wire/package.json lib/vecs-wire/package.json

RUN npm ci

FROM deps AS build
WORKDIR /workspace

COPY . .

# lint-staged depends on git staged state; full lint is the deterministic Docker equivalent.
RUN npm run typecheck && npm run lint && npm run format:check
RUN npm run test
RUN npm run build --workspace @vworlds/vecs-demo-client

FROM nginx:1.27-alpine AS runtime

COPY apps/client/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/client/docker/entrypoint.sh /docker-entrypoint.d/40-vecs-vars.sh
COPY --from=build /workspace/apps/client/dist/ /usr/share/nginx/html/

RUN chmod +x /docker-entrypoint.d/40-vecs-vars.sh

EXPOSE 80
