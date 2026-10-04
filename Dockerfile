# Base image pinned by digest; bump digest and package versions together
# (docker buildx imagetools inspect node:22-alpine3.24, apk policy <pkg>).
ARG NODE_IMAGE=node:22-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency install hooks run (ffmpeg-for-homebridge would
# otherwise download a prebuilt ffmpeg binary; the distro package is used instead).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

FROM ${NODE_IMAGE}
ARG FFMPEG_VERSION=8.1.2-r0
ARG TINI_VERSION=0.19.0-r3
ARG TZDATA_VERSION=2026d-r0

RUN apk add --no-cache \
      "ffmpeg=${FFMPEG_VERSION}" \
      "tini=${TINI_VERSION}" \
      "tzdata=${TZDATA_VERSION}" \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data /recordings \
 && chown 568:568 /data /recordings \
 && chmod 0750 /data /recordings

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0555 /usr/local/bin/docker-entrypoint.sh

# 568 = TrueNAS SCALE "apps" user/group.
USER 568:568
ENV HOME=/tmp \
    DATA_DIR=/data \
    RECORDINGS_DIR=/recordings \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    NODE_ENV=production

VOLUME ["/data", "/recordings"]

HEALTHCHECK --interval=2m --timeout=10s --start-period=2m --retries=3 \
  CMD ["node", "/app/src/healthcheck.js"]

ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["run"]
