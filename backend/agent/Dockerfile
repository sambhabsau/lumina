# syntax=docker/dockerfile:1
#
# The AGENT service. This is the only process that holds a provider key, so it must NOT be
# publicly reachable - see fly.toml here (no [http_service] block, no allocated IP) and the
# red line in SUBMISSION.md. The gateway reaches it over Fly's private network.
#
# Build context is the ASSIGNMENT ROOT, not this folder:
#   docker build -f backend/agent/Dockerfile .
# because npm workspaces and @lumina/contract live above this directory.
FROM node:22-alpine

WORKDIR /app

# All four workspace manifests are copied even though this image only runs one service:
# `npm ci` validates the whole lockfile tree and errors if a declared workspace is missing.
# It does mean web's build tooling gets installed here. Trim later if image size matters;
# a deploy that works beats a deploy that is small.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/

RUN npm ci

COPY packages/contract packages/contract
COPY backend/agent backend/agent

RUN npm run build -w @lumina/contract && npm run build -w @lumina/agent

# runlog.ts calls writeFileSync with no try/catch, and .dockerignore excludes `runs` from
# the build context - so without this mkdir the directory does not exist in the image and
# EVERY answer throws ENOENT at the moment it tries to write its run log.
# Note this is container-local and ephemeral: Fly machines do not persist it across a
# restart or a redeploy. Use `npm run export:runs` to pull logs off the machine.
RUN mkdir -p /app/runs

# env.ts resolves '../../.env' and runsDir '../../runs' from process.cwd(), so the cwd has
# to be the service directory with the repo root two levels up. Do not flatten this.
WORKDIR /app/backend/agent

ENV NODE_ENV=production
ENV PORT_AGENT=8000
EXPOSE 8000

CMD ["node", "dist/index.js"]
