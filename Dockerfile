# ---- backend -----------------------------------------------------------
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ---- runtime -----------------------------------------------------------
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 app
WORKDIR /app
COPY --from=build /out/server /app/server
# The console is plain HTML/CSS/JS served from source: no node, no build step.
COPY web/ /app/web/
USER app
EXPOSE 3200
ENV WEB_DIR=/app/web LISTEN=:3200
ENTRYPOINT ["/app/server"]
