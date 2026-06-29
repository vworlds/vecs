# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS deps
WORKDIR /workspace
ENV HUSKY=0

COPY package.json package-lock.json tsconfig.base.json eslint.config.js .prettierrc .prettierignore ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY lib/vecs/package.json lib/vecs/package.json
COPY lib/vecs-client/package.json lib/vecs-client/package.json
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
RUN npm run build --workspace @vworlds/vecs-demo-server

FROM node:24-alpine AS runtime-deps
WORKDIR /workspace
ENV HUSKY=0
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY lib/vecs/package.json lib/vecs/package.json
COPY lib/vecs-client/package.json lib/vecs-client/package.json
COPY lib/vecs-phaser/package.json lib/vecs-phaser/package.json
COPY lib/vecs-phaser-client/package.json lib/vecs-phaser-client/package.json
COPY lib/vecs-phaser-server/package.json lib/vecs-phaser-server/package.json
COPY lib/vecs-physics/package.json lib/vecs-physics/package.json
COPY lib/vecs-protocol/package.json lib/vecs-protocol/package.json
COPY lib/vecs-server/package.json lib/vecs-server/package.json
COPY lib/vecs-wire/package.json lib/vecs-wire/package.json

RUN npm pkg delete scripts.prepare && npm ci --omit=dev --workspace @vworlds/vecs-demo-server --include-workspace-root=false

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=runtime-deps /workspace/node_modules/ ./node_modules/
COPY --from=build /workspace/apps/server/dist/ ./dist/
COPY --from=build /workspace/apps/server/assets/ ./assets/

EXPOSE 3000
CMD ["node", "dist/main.js"]
