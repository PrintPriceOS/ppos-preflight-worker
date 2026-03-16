# @ppos/preflight-worker Dockerfile
FROM node:20-bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Satisfy local dependencies
COPY ppos-preflight-engine ./ppos-preflight-engine
COPY ppos-shared-infra ./ppos-shared-infra

# Setup worker
WORKDIR /app/ppos-preflight-worker
COPY ppos-preflight-worker/package*.json ./
RUN npm ci --only=production

COPY ppos-preflight-worker ./

# Environment
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight
ENV HEALTH_PORT=8002

EXPOSE 8002

CMD ["node", "worker.js"]
