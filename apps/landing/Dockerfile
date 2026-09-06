# syntax=docker/dockerfile:1
# Build from the repository root: `docker build -f apps/landing/Dockerfile .`
# The page reads the vault source, the contract tests and the blog posts at build time, so the
# whole workspace is the context (see .dockerignore for what is left out).

FROM oven/bun:1.3.14-alpine AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @helico/landing build

# Static files behind nginx running as an unprivileged user on port 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/landing/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/landing/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
	CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
