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

RUN pnpm install --frozen-lockfile

# Copy source code
COPY src src
COPY tsconfig.json ./

# Server only — SDK packages are not part of the runtime image
RUN pnpm exec tsc

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

# Create data directories
RUN mkdir -p /data/gateway /data/files

# SQLite data and file storage will be persisted via volume
ENV GATEWAY_PORT=3200
ENV HOME=/data

EXPOSE 3200

WORKDIR /app/zclaudia

CMD ["node", "dist/index.js"]
