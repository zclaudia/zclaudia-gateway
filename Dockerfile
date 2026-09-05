# Stage 1: Build
FROM node:22.14.0-slim AS builder

RUN npm install -g pnpm@9.15.0

WORKDIR /app/zclaudia

# Copy workspace metadata first for better layer caching. The lockfile
# includes the packages/* importers, so their manifests must be present
# for a frozen install even though the server doesn't depend on them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
COPY packages/backend/package.json packages/backend/
COPY packages/admin-ui/package.json packages/admin-ui/

RUN pnpm install --frozen-lockfile

# Copy source code
COPY src src
COPY tsconfig.json ./

# Server only — SDK packages are not part of the runtime image
RUN pnpm exec tsc

# Admin web UI (ADR-0005): vite build needs the package sources
COPY packages/admin-ui packages/admin-ui
RUN pnpm --filter @zclaudia/admin-ui build

# Stage 2: Production
FROM node:22.14.0-slim AS runtime

RUN npm install -g pnpm@9.15.0

WORKDIR /app/zclaudia

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
COPY packages/backend/package.json packages/backend/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built output
COPY --from=builder /app/zclaudia/dist dist
# Admin web UI static bundle, served by the gateway at /admin (ADR-0005)
COPY --from=builder /app/zclaudia/packages/admin-ui/dist admin-ui

# Create data directories
RUN mkdir -p /data/gateway /data/files

# SQLite data and file storage will be persisted via volume
ENV GATEWAY_PORT=3200
ENV HOME=/data
ENV GATEWAY_ADMIN_UI_DIR=/app/zclaudia/admin-ui

EXPOSE 3200

WORKDIR /app/zclaudia

CMD ["node", "dist/index.js"]
