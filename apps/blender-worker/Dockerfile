# ─── Blender Worker Dockerfile ────────────────────────────────────────
# Multi-stage build for the headless Blender assembly engine.
#
# Build:  docker build -t ai-blender-worker .
# Run:    docker run --gpus all ai-blender-worker
# ──────────────────────────────────────────────────────────────────────

FROM ubuntu:24.04 AS base

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# ─── System Dependencies ────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    libx11-6 \
    libxxf86vm1 \
    libxcursor1 \
    libxi6 \
    libxrandr2 \
    libxinerama1 \
    libxkbcommon0 \
    libglew2.2 \
    libgl1 \
    libegl1 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# ─── Install Blender 4.4 ────────────────────────────────────────────
ARG BLENDER_VERSION=4.4.0
ARG BLENDER_URL=https://download.blender.org/release/Blender4.4/blender-${BLENDER_VERSION}-linux-x64.tar.xz

RUN wget -q ${BLENDER_URL} -O /tmp/blender.tar.xz \
    && mkdir -p /usr/local/blender \
    && tar -xf /tmp/blender.tar.xz -C /usr/local/blender --strip-components=1 \
    && rm /tmp/blender.tar.xz

ENV BLENDER_BIN=/usr/local/blender/blender
ENV PATH="/usr/local/blender:${PATH}"

# ─── Python Dependencies ────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# ─── Application Code ───────────────────────────────────────────────
COPY src/ ./src/
COPY scripts/ ./scripts/

RUN chmod +x scripts/entrypoint.sh

# ─── Runtime ─────────────────────────────────────────────────────────
ENV WORKER_SCRIPT=/app/src/worker.py

ENTRYPOINT ["./scripts/entrypoint.sh"]
