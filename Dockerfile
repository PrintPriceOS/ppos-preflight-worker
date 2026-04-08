# @ppos/preflight-worker Dockerfile
FROM node:20-bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Step 1: Securely stage the GUARANTEED FRESH source code from the monorepo root
# This bypasses any nested, outdated 'libs' folders sneaking in from the host side
COPY ppos-preflight-engine ./staged-libs/ppos-preflight-engine
COPY ppos-shared-infra ./staged-libs/ppos-shared-infra
COPY ppos-shared-contracts ./staged-libs/ppos-shared-contracts

# Pack them into immutable tarballs
RUN cd staged-libs/ppos-preflight-engine && TARBALL="$(npm pack | tail -n 1)" && mv "$TARBALL" /app/engine.tgz
RUN cd staged-libs/ppos-shared-infra && TARBALL="$(npm pack | tail -n 1)" && mv "$TARBALL" /app/infra.tgz
RUN cd staged-libs/ppos-shared-contracts && TARBALL="$(npm pack | tail -n 1)" && mv "$TARBALL" /app/contracts.tgz

# Step 2: Bring in the worker source code from the host
WORKDIR /app/ppos-preflight-worker
COPY ppos-preflight-worker ./

# Step 3: Purgatory - ANNIHILATE any host artifacts (node_modules, old libs) that leaked through broken .dockerignores
RUN rm -rf node_modules package-lock.json libs

# Step 4: Reroute package.json strictly to the mathematically perfect `.tgz` archives we built in Step 1
RUN sed -i -E 's|"file:.*ppos-preflight-engine"|"file:../engine.tgz"|g' package.json
RUN sed -i -E 's|"file:.*ppos-shared-infra"|"file:../infra.tgz"|g' package.json

# Step 5: Final pristine installation
RUN npm install --only=production --no-audit

# Environment
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight
ENV HEALTH_PORT=8002

EXPOSE 8002

CMD ["node", "worker.js"]
