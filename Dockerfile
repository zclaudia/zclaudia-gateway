# Stage 1: Build
FROM node:22.14.0-slim AS builder

RUN npm install -g pnpm@9.15.0

WORKDIR /app/zclaudia

# Copy package metadata first for better layer caching
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# Copy source code
COPY src src
COPY tsconfig.json ./

RUN pnpm run build

# Stage 2: Production
FROM node:22.14.0-slim AS runtime

RUN npm install -g pnpm@9.15.0

WORKDIR /app/zclaudia

COPY package.json pnpm-lock.yaml ./

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
