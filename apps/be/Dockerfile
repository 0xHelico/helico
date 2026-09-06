# syntax=docker/dockerfile:1
# Build from the repository root: `docker build -f apps/be/Dockerfile .`
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY apps/be/go.mod apps/be/go.sum ./
RUN go mod download
COPY apps/be/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/be ./cmd/be

# A static binary, the Markdown to seed from, and a writable /data for the SQLite file.
FROM alpine:3.21
RUN adduser -D -H -u 10001 be && mkdir -p /data && chown be:be /data
WORKDIR /app
COPY --from=build /out/be /app/be
COPY --from=build /src/content /app/content
ENV BE_ADDR=:8787 BE_DB_PATH=/data/helico.db BE_CONTENT_DIR=/app/content
VOLUME /data
EXPOSE 8787
USER be
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
	CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
ENTRYPOINT ["/app/be"]
