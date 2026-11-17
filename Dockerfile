# Build from the REPOSITORY ROOT, not from app/:
#
#   docker build -t hpn-metrics .          # or: docker compose up -d --build
#
# The context has to be the root because docker/entrypoint.sh lives beside this file,
# and a Dockerfile cannot COPY from outside its own context. Everything the image
# actually needs is under app/ — the collector, its dependencies, and one helper
# script — so every COPY below is app/-prefixed. `build: .` in docker-compose.yml is
# therefore correct and should not be narrowed to `build: ./app`.
FROM node:22-alpine AS deps
WORKDIR /app
# .npmrc travels with the package files: it carries ignore-scripts=true, and npm only
# reads the project .npmrc from the directory holding package.json. Leaving it at the
# repo root would silently stop applying it here and on bare-metal installs in app/.
COPY app/package.json app/package-lock.json app/.npmrc ./
# --ignore-scripts: a compromised transitive dep cannot run a postinstall hook.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    API_HOST=0.0.0.0 \
    ALLOW_PUBLIC_BIND=true

# su-exec is ~10KB and is only how the entrypoint drops privileges; it is not
# used when the container already starts unprivileged (the default).
RUN apk add --no-cache su-exec

COPY --from=deps /app/node_modules ./node_modules
COPY app/package.json ./
COPY app/src ./src

# Only the runtime tooling ships. `docker compose exec metrics node
# scripts/issue-token.mjs issue` needs this one; app/scripts/sync-prompt.mjs is a
# build-time helper for the Open WebUI filter (it reads app/openwebui/SYSTEM_PROMPT.md,
# which is not in this image) and doctor.sh inspects the HOST, so neither belongs here.
COPY app/scripts/issue-token.mjs ./scripts/issue-token.mjs

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# /data exists in the image and is owned by the unprivileged user, so a NAMED
# VOLUME inherits correct ownership automatically on first use. That is why the
# default compose file needs no chown anywhere.
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /data

# Default to unprivileged. The bind-mount overlay overrides this with user: "0:0"
# to enable the chown-then-drop path for host directories.
USER node
EXPOSE 8283

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||8283)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/index.js"]
