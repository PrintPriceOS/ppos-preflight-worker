# @ppos/preflight-worker Dockerfile
# Runtime container for Preflight Worker (AUTOFIX / ANALYZE execution node)
# Includes Ghostscript + deterministic dependency packaging via tarballs

FROM node:20-bookworm-slim

# ------------------------------------------------------------------
# STEP 0 — System dependencies (Ghostscript required for PDF processing)
# ------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Base working directory
WORKDIR /app

# ------------------------------------------------------------------
# STEP 1 — Stage canonical source of shared packages (ENGINE + INFRA + CONTRACTS)
# This guarantees we do NOT depend on host-contaminated libs
# ------------------------------------------------------------------
COPY ppos-preflight-engine ./staged-libs/ppos-preflight-engine
COPY ppos-shared-infra ./staged-libs/ppos-shared-infra
COPY ppos-shared-contracts ./staged-libs/ppos-shared-contracts

# ------------------------------------------------------------------
# STEP 1.1 — Pack staged libs into immutable tarballs
# These are the ONLY source of truth used by npm install
# ------------------------------------------------------------------
RUN cd staged-libs/ppos-preflight-engine && \
    TARBALL="$(npm pack | tail -n 1)" && \
    mv "$TARBALL" /app/engine.tgz

RUN cd staged-libs/ppos-shared-infra && \
    TARBALL="$(npm pack | tail -n 1)" && \
    mv "$TARBALL" /app/infra.tgz

RUN cd staged-libs/ppos-shared-contracts && \
    TARBALL="$(npm pack | tail -n 1)" && \
    mv "$TARBALL" /app/contracts.tgz

# ------------------------------------------------------------------
# STEP 2 — Copy worker source code
# ------------------------------------------------------------------
WORKDIR /app/ppos-preflight-worker
COPY ppos-preflight-worker ./

# ------------------------------------------------------------------
# STEP 3 — Purgatory cleanup
# Remove ANY host artifacts that could corrupt dependency graph
# ------------------------------------------------------------------
RUN rm -rf node_modules package-lock.json libs

# ------------------------------------------------------------------
# STEP 4 — Force package.json to use tarball dependencies
# Ensures deterministic install independent of host paths
# ------------------------------------------------------------------
RUN sed -i -E 's|"file:.*ppos-preflight-engine"|"file:../engine.tgz"|g' package.json
RUN sed -i -E 's|"file:.*ppos-shared-infra"|"file:../infra.tgz"|g' package.json

# ------------------------------------------------------------------
# STEP 5 — Install production dependencies only
# ------------------------------------------------------------------
RUN npm install --only=production --no-audit

# ------------------------------------------------------------------
# STEP 6 — Inject ICC profiles required by Ghostscript autofix
# CRITICAL: Without this, AUTOFIX fails with GS profile error
# ------------------------------------------------------------------
WORKDIR /app
COPY ppos-preflight-worker/icc-profiles /app/icc-profiles

# ------------------------------------------------------------------
# STEP 7 — Runtime environment configuration
# ------------------------------------------------------------------
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight
ENV HEALTH_PORT=8002

# Force engine to use stable ICC path (avoid fragile relative paths)
ENV ICC_PROFILES_DIR=/app/icc-profiles

# ------------------------------------------------------------------
# STEP 8 — Expose health port
# ------------------------------------------------------------------
EXPOSE 8002

# ------------------------------------------------------------------
# STEP 9 — Entrypoint
# ------------------------------------------------------------------
WORKDIR /app/ppos-preflight-worker
CMD ["node", "worker.js"]
