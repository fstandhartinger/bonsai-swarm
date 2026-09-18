# Bonsai Swarm coordinator + web app.
FROM node:22-alpine

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
CMD ["node", "server/index.js"]
