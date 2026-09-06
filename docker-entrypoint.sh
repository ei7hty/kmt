#!/bin/sh
# Give the volume to the user the app runs as, then stop being root.
#
# Chromium renders third-party supplier pages on this machine, beside
# /data/owner.sqlite -- every customer's name, email, phone and address. Running
# that as root means a renderer compromise reads and writes all of it. Dropping
# to `node` does not stop a compromise; it stops the compromise from owning the
# machine, and it is the layer that turns "total" into "bounded" (#87).
#
# Root is needed for exactly one thing: a Fly volume arrives owned by root, so
# the app cannot open its database as `node` until someone changes that. Doing
# it here rather than by hand over ssh means the drill, a fresh volume, and a
# restored volume all work the same way with nobody remembering a step.
set -e

if [ "$(id -u)" = "0" ]; then
  # Not `|| true`. If this cannot be done the app cannot open its database, and
  # failing here with chown's own error is far better than failing three lines
  # later inside SQLite, where the message names a file rather than a cause.
  chown -R node:node /data

  # gosu rather than su: no intermediate shell, no TTY games, signals reach the
  # process tini is supervising. exec so the server is PID-of-record rather than
  # a child of this script.
  exec gosu node "$@"
fi

# Already non-root: a local `docker run --user`, or a platform that drops for us.
exec "$@"
