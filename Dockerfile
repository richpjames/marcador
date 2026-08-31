FROM oven/bun:1-alpine
WORKDIR /app

# Dependencies first, so a source-only change reuses this layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# No build step: Bun runs the TypeScript directly, so the image contains the
# source it executes and there is nothing to keep in sync.
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/marcador.db
# Matches the other app on this host, so log timestamps read as local time.
ENV TZ=Europe/Madrid

EXPOSE 3000

# Coolify polls this to decide whether a deploy came up; /healthz is outside the
# auth wall precisely so it can.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["bun", "src/index.ts"]
