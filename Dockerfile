# ---- frontend ----------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---- backend -----------------------------------------------------------
# Pinned to a patch release, and kept equal to the toolchain line in go.mod:
# a floating tag only moves when someone remembers to pull it.
FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
# The build context carries no .git, so the version comes in as an argument.
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/faketoken/faketoken/internal/api.version=${VERSION}" \
    -o /out/server ./cmd/server

# ---- runtime -----------------------------------------------------------
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 app
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=web /web/dist /app/web
USER app
EXPOSE 3200
ENV WEB_DIR=/app/web LISTEN=:3200
ENTRYPOINT ["/app/server"]
