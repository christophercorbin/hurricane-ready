# syntax=docker/dockerfile:1

# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-alpine
RUN apk upgrade --no-cache \
 && apk add --no-cache wget \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules node_modules
COPY --chown=node:node src/ src/
COPY --chown=node:node web/ web/
COPY --chown=node:node fixtures/ fixtures/
COPY --chown=node:node package.json .

ENV NODE_ENV=production \
    PORT=8080 \
    STATE_FILE=/data/state.json

RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.mjs"]
