# Fruit Addicts CRM — single-instance runtime.
# Runtime is ZERO-dependency (node:sqlite, node:http, node:crypto) and Node runs
# TypeScript natively, so no build/transpile step is required to run.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DB_FILE=/app/data/crm.db \
    HOST=0.0.0.0 \
    PORT=3000

# Only dev tools (typescript/@types) live in package.json; none are needed at
# runtime. Copy source and prepare the data directory.
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data

EXPOSE 3000
VOLUME ["/app/data"]

# Migrate (idempotent) then start.
CMD ["sh", "-c", "node src/db/migrate.ts && node src/server.ts"]
