# syntax=docker/dockerfile:1
#
# The GATEWAY. The only service the browser talks to, and the only one with a public IP.
# It reads no provider key (see the header of src/index.ts).
#
# It serves GET /evals/report.json from reports/report.json ON DISK, which is why
# .dockerignore re-includes that one file. If the report is missing the route answers an
# honest 404 rather than an empty report.
#
# Build context is the ASSIGNMENT ROOT:
#   docker build -f backend/gateway/Dockerfile .
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/

RUN npm ci

COPY packages/contract packages/contract
COPY backend/gateway backend/gateway
# The submission itself. Copying the DIRECTORY, not the file, on purpose: your first
# deploy happens before any report exists (you cannot benchmark a deployment that is not
# up yet), and a mandatory COPY of a missing file fails the build. reports/.keep is
# tracked so this directory is never empty; .dockerignore filters out bench/quality/eval.
# Until a report is copied in, GET /evals/report.json answers an honest 404.
COPY reports/ reports/

RUN npm run build -w @lumina/contract && npm run build -w @lumina/gateway

# env.ts resolves '../../reports/report.json' from process.cwd(). Keep the cwd here.
WORKDIR /app/backend/gateway

ENV NODE_ENV=production
ENV PORT_GATEWAY=8787
EXPOSE 8787

CMD ["node", "dist/index.js"]
