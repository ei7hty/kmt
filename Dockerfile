# The owner workspace as one always-on container.
#
# Deliberately plain: a standard image listening on $PORT with its database on a
# mounted volume. Nothing here is specific to Fly, Render, Railway or a VPS, so
# moving between them is a matter of where you push it, not a rewrite.
#
# Node 24 is a hard floor, not a preference -- the backend uses node:sqlite,
# which does not exist earlier.
FROM python:3.12-slim-bookworm AS image-decoder-runtime
COPY scripts/image-decoder-requirements.txt /tmp/image-decoder-requirements.txt
RUN python -m venv /opt/kmt-image-decoder \
  && /opt/kmt-image-decoder/bin/pip install --no-cache-dir --only-binary=:all: -r /tmp/image-decoder-requirements.txt

FROM node:24-bookworm-slim
COPY --from=image-decoder-runtime /usr/local/ /usr/local/
COPY --from=image-decoder-runtime /opt/kmt-image-decoder /opt/kmt-image-decoder
ENV KMT_IMAGE_DECODER_PYTHON=/opt/kmt-image-decoder/bin/python

# Chromium, its shared libraries, and Xvfb.
#
# Xvfb is the load-bearing one. Supplier refreshes drive Chromium with
# `headless: false` because giga-tires' WAF refuses headless browsers outright,
# and a headful browser needs a display even on a machine that has no screen.
# Xvfb is that display. Without it, refreshes fail on this host and nowhere else.
#
# tini reaps the browser processes a cancelled refresh leaves behind; without an
# init, they accumulate as zombies until the container is restarted.
# xauth is not optional and not pulled in by xvfb: xvfb-run shells out to it to
# create the X authority file, and without it exits 3 with "xauth command not
# found" before Node ever starts. That reads as the app crash-looping.
# sqlite3 is here for the operator, not the app: nothing in the server shells
# out to it -- the backend uses node:sqlite. docs/operations.md reaches for it
# in three procedures that run against this container by ssh -- the pre-restore
# row counts, the monthly off-Fly `.backup` copy, and the by-hand redaction a
# privacy request triggers -- and every one of them failed at the prompt with
# "executable file not found in $PATH", found by running the restore drill.
# The third is the expensive one: a privacy obligation, under time pressure,
# failing in a way that reads as a broken machine rather than a missing binary.
# gosu drops privileges in docker-entrypoint.sh. Purpose-built for it: no
# intermediate shell and no TTY handling, so signals reach the process tini
# supervises. `su` would fork one and break that.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation xvfb xauth tini ca-certificates sqlite3 gosu \
  && rm -rf /var/lib/apt/lists/*

# Use the distro's Chromium rather than downloading a second copy through
# Playwright: it is already patched by the base image's updates, and it halves
# the image.
# NODE_ENV is deliberately NOT set here. npm treats NODE_ENV=production as
# `--omit=dev`, so setting it before `npm ci` skips devDependencies -- which is
# where Vite lives, and the build then fails with `vite: not found`. It is set
# after the build instead, where it only affects the running server.
# HOME is set explicitly because gosu does not change it. Left at /root, the
# process runs as `node` with a home it cannot write, and xvfb-run's call to
# xauth fails -- which surfaces as Chromium never starting, with nothing in the
# log naming a home directory.
#
# KMT_CHROMIUM_NO_SANDBOX stays 1 for now, and that is deliberate rather than
# forgotten. Dropping root removes the layer that made a renderer compromise
# total; enabling Chromium's own sandbox needs user namespaces this container
# may not have, and turning it on unverified would trade a proven improvement
# for a browser that silently fails to launch on the next refresh. That is its
# own change, and it can only be proved by running a real refresh (#87 part two).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    KMT_CHROMIUM_PATH=/usr/bin/chromium \
    KMT_CHROMIUM_NO_SANDBOX=1 \
    HOME=/home/node \
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
# --include=dev is explicit rather than relying on NODE_ENV being unset, so
# re-adding NODE_ENV above cannot quietly break the build again.
RUN npm ci --include=dev

COPY . .
RUN npm run build

# Only now, so it governs the server and not the install.
ENV NODE_ENV=production

# Which commit this image was built from.
#
# The site says nothing about what is running on it -- not the footer, not a
# meta tag, and /api/health answers exactly {"ok":true}. So "confirm the
# deployed SHA", which is step one of the live-test checklist, currently needs
# `flyctl`. The server reads KMT_RELEASE and puts it in an X-KMT-Release header,
# which rides API answers and redirects alike, so a cutover step is confirmed
# with one `curl -sI`.
#
# Deliberately down here, after npm ci and the build. An ARG invalidates every
# layer below it, so declaring this near the top would rebuild Chromium's apt
# layer and reinstall node_modules on every commit -- minutes added to each
# deploy to carry seven characters.
#
# Empty by default, and the server omits the header when it is empty rather
# than emitting a placeholder: a missing header is honest, and `unknown` is a
# value that ends up in somebody's comparison. So a local `docker build` with no
# --build-arg produces an image that simply does not claim a release.
ARG GIT_SHA=""
ENV KMT_RELEASE=$GIT_SHA

# The database lives on a volume mounted here. Without one it still runs, but
# every offer and price disappears when the container is replaced.
VOLUME ["/data"]
RUN mkdir -p /data

EXPOSE 8080

# xvfb-run gives Chromium the display it needs; the server ignores it entirely
# until someone presses Refresh.
# -s registers tini as a child subreaper. Fly's own init takes PID 1, so without
# it tini reaps nothing and the browser processes a cancelled refresh leaves
# behind accumulate as zombies.
# The entrypoint chowns /data and drops to `node` before exec'ing CMD. It runs
# under tini so the browser processes a cancelled refresh leaves behind are
# still reaped, and so signals still reach the server after the drop.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x1024x24", \
     "node", "backend/server.mjs"]
