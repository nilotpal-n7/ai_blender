# ─── Go Orchestrator Dockerfile ──────────────────────────────────────
# Multi-stage build: compile in Go image, run in minimal Alpine.
#
# Build:  docker build -f infra/docker/orchestrator.Dockerfile -t ai-blender-orchestrator apps/orchestrator
# Run:    docker run -p 8080:8080 ai-blender-orchestrator
# ──────────────────────────────────────────────────────────────────────

# ─── Build Stage ─────────────────────────────────────────────────────
FROM golang:1.24-alpine AS builder

RUN apk add --no-cache git

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /build/server ./cmd/server

# ─── Run Stage ───────────────────────────────────────────────────────
FROM alpine:3.21

RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=builder /build/server .

EXPOSE 8080

ENTRYPOINT ["./server"]
