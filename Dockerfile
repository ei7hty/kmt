# The owner workspace as one always-on container.
#
# Deliberately plain: a standard image listening on $PORT with its database on a
# mounted volume. Nothing here is specific to Fly, Render, Railway or a VPS, so
# moving between them is a matter of where you push it, not a rewrite.
#
# Node 24 is a hard floor, not a preference -- the backend uses node:sqlite,
# which does not exist earlier.
FROM node:24-bookworm-slim

# Chromium, its shared libraries, and Xvfb.
#
# Xvfb is the load-bearing one. Supplier refreshes drive Chromium with
# `headless: false` because giga-tires' WAF refuses headless browsers outright,
# and a headful browser needs a display even on a machine that has no screen.
# Xvfb is that display. Without it, refreshes fail on this host and nowhere else.
#
# tini reaps the browser processes a cancelled refresh leaves behind; without an
# init, they accumulate as zombies until the container is restarted.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation xvfb tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Use the distro's Chromium rather than downloading a second copy through
# Playwright: it is already patched by the base image's updates, and it halves
# the image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    KMT_CHROMIUM_PATH=/usr/bin/chromium \
    KMT_CHROMIUM_NO_SANDBOX=1 \
    NODE_ENV=production \
    PORT=8080 \
    KMT_OWNER_DB=/data/owner.sqlite

WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
#
# Deliberately NOT `--omit=dev`, and do not "optimise" it later: Playwright is a
# devDependency but supplier refreshes import it at runtime. Pruning dev
# dependencies leaves a server that starts, serves and prices perfectly well and
# fails the moment someone presses Refresh.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# The database lives on a volume mounted here. Without one it still runs, but
# every offer and price disappears when the container is replaced.
VOLUME ["/data"]
RUN mkdir -p /data

EXPOSE 8080

# xvfb-run gives Chromium the display it needs; the server ignores it entirely
# until someone presses Refresh.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x1024x24", \
     "node", "backend/server.mjs"]
