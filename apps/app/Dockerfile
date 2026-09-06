# syntax=docker/dockerfile:1
# Build from the repository root: `docker build -f apps/app/Dockerfile .`
# The app imports @helico/plugin-uniswap and @helico/plugin-cre from the workspace, so the
# context is the whole repository (see .dockerignore for what is left out).

FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile

# The compile runs under Node, not Bun. Bun resolves the workspace and the lockfile, which is
# why it installs; but running Next's build through it segfaults on this deployment's CPU
# (SIGILL inside the JIT), and a build host is not the place to debug someone else's codegen.
FROM node:24-alpine AS build
WORKDIR /repo
COPY --from=deps /repo /repo

# NEXT_PUBLIC_* values are compiled into the browser bundle, so they are build arguments rather
# than deployment variables — and their defaults live here rather than in the workflow, because
# the landing taught us that an argument passed only by CI silently does not arrive.
#
# The vault address is empty until #85 deploys it. Empty is not a placeholder: the mandate page
# reads it and says the vault is not deployed rather than offering buttons that cannot work.
ARG NEXT_PUBLIC_VAULT_ADDRESS=
ARG NEXT_PUBLIC_ARBITRUM_RPC_URL=
ARG NEXT_PUBLIC_PROJECT_ID=8cc38dcdd178b28a332ffb9750248a9d
ENV NEXT_PUBLIC_VAULT_ADDRESS=${NEXT_PUBLIC_VAULT_ADDRESS} \
	NEXT_PUBLIC_ARBITRUM_RPC_URL=${NEXT_PUBLIC_ARBITRUM_RPC_URL} \
	NEXT_PUBLIC_PROJECT_ID=${NEXT_PUBLIC_PROJECT_ID} \
	NEXT_TELEMETRY_DISABLED=1
RUN cd apps/app && ../../node_modules/.bin/next build

# `output: standalone` traces exactly the files the server needs, so the runtime carries neither
# the toolchain nor the workspace.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=8080 \
	HOSTNAME=0.0.0.0 \
	BE_API_URL=https://api.helico.site
COPY --from=build /repo/apps/app/.next/standalone ./
COPY --from=build /repo/apps/app/.next/static ./apps/app/.next/static
COPY --from=build /repo/apps/app/public ./apps/app/public
# node:alpine ships a `node` user; the server needs to read its files and nothing else.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
	CMD node -e "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/app/server.js"]
