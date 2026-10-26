# Backend image: Express API + background scheduler + headless Chromium.
#
# This must run as ONE always-on container. The Reddit rate-limit queue
# (>=700ms between requests) and the "already checking this account" guard are
# both in-process state, so a second replica would double the request rate at
# Reddit and run duplicate checks. Never scale this service.
#
# Builds on x86_64 and on arm64 (Oracle's Ampere A1 free tier).
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install against the committed lockfile. The workspace package.json files must
# be present for npm to resolve the workspaces.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci --omit=dev

# Chromium for REDDIT_MODE=html. playwright-core never downloads browsers, so
# install the build matching its exact version (plus the OS libraries it needs)
# into the default location where playwright-core looks for it.
# If this ever fails on your architecture, install the distro's chromium with
# apt instead and point REDDIT_BROWSER_PATH at it.
RUN npx --yes playwright@"$(node -p "require('playwright-core/package.json').version")" install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Only the server runs here; the dashboard is hosted on Netlify.
COPY server server

# Listen on all interfaces inside the container. Because this is not loopback,
# the app makes sign-in mandatory and refuses to start without it configured.
ENV HOST=0.0.0.0 PORT=4000
EXPOSE 4000

# Fail the container (and trigger a restart) if the API stops answering.
HEALTHCHECK --interval=60s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
