# Multi-stage production build for Agentic AI Studio
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Install dependencies
COPY server/package*.json ./
RUN npm ci --only=production

# Production image
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache git bash

ENV NODE_ENV=production
ENV PORT=3001

# Copy built node_modules and code
COPY --from=builder /app/node_modules ./node_modules
COPY server/ ./

# Create data and workspace directories
RUN mkdir -p data workspace

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

CMD ["node", "src/server.js"]
