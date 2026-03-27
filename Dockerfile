# 🧠 PHASE 10 — PPOS PREFLIGHT WORKER DOCKERFILE
# Multi-stage, minimal, governed execution node

# --- STAGE 1: BUILD & PACK ---
FROM node:20-bookworm-slim AS builder

WORKDIR /build

# Bring in dependencies from monorepo (shared-infra, engine, etc)
COPY ppos-preflight-engine ./libs/ppos-preflight-engine
COPY ppos-shared-infra ./libs/ppos-shared-infra
COPY ppos-shared-contracts ./libs/ppos-shared-contracts

# Pack internals into immutable artifacts
RUN mkdir -p /artifacts && \
    cd libs/ppos-preflight-engine && npm pack && mv *.tgz /artifacts/engine.tgz && \
    cd ../ppos-shared-infra && npm pack && mv *.tgz /artifacts/infra.tgz && \
    cd ../ppos-shared-contracts && npm pack && mv *.tgz /artifacts/contracts.tgz

# --- STAGE 2: RUNTIME ---
FROM node:20-bookworm-slim

# Phase 8: Isolation & Security (System Utilities Only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    poppler-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Import artifacts from builder
COPY --from=builder /artifacts /app/artifacts

# Import worker source
COPY ppos-preflight-worker/package*.json ./
COPY ppos-preflight-worker/*.js ./
COPY ppos-preflight-worker/processors ./processors
COPY ppos-preflight-worker/queue ./queue
COPY ppos-preflight-worker/utils ./utils
COPY ppos-preflight-worker/resilience ./resilience

# Reroute package.json to the immutable .tgz archives
RUN sed -i -E 's|"file:.*ppos-preflight-engine"|"file:./artifacts/engine.tgz"|g' package.json && \
    sed -i -E 's|"file:.*ppos-shared-infra"|"file:./artifacts/infra.tgz"|g' package.json

# Pristine production installation
RUN npm install --only=production --no-audit

# Phase 8: Security (Non-Root Execution)
RUN useradd -m pposworker && \
    mkdir -p /tmp/ppos-preflight && \
    chown -R pposworker:pposworker /app /tmp/ppos-preflight
USER pposworker

# Environment & Config (Phase 9/10)
ENV NODE_ENV=production \
    GS_COMMAND=gs \
    PPOS_TEMP_DIR=/tmp/ppos-preflight \
    HEALTH_PORT=8002 \
    WORKER_CONCURRENCY=4

EXPOSE 8002

# Healthcheck for Docker/K8s
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8002/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "worker.js"]
