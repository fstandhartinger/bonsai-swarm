# Bonsai Swarm coordinator + web app.
FROM node:22-alpine
# eMudhra CA distrust (Oct 2026): current CA bundle, and make Node trust it instead of its bundled root list
RUN apk add --no-cache --upgrade ca-certificates-bundle
ENV NODE_OPTIONS="--use-openssl-ca"

ENV NODE_ENV=production
WORKDIR /app

# dependencies first, so a code change does not re-install them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# the extracted WebGPU runtime is cached here; it is re-fetched if the container restarts
ENV RUNTIME_CACHE_DIR=/tmp/bonsai-runtime-cache
ENV PORT=3000
EXPOSE 3000

# bounded, cheap, and it touches Postgres so an unhealthy database shows up
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

USER node
# Structured JSON logs + request ids (logging standard, AGENTS.md; logkit/README.md). No IPs or user agents.
COPY logkit ./logkit
ENV LOG_APP=bonsai-swarm LOG_IP=0 LOG_UA=0
CMD ["node", "-r", "./logkit/logkit-preload.cjs", "server/index.js"]