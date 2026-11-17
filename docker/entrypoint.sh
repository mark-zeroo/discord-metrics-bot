#!/bin/sh
# Runs as root only long enough to make the data volume writable, then drops
# privileges permanently. If the image is started non-root (the default), this
# is a pure pass-through and the chown branch never executes.
#
# Why this exists: on a rootless or userns-remapped daemon the container's uid
# 1000 is NOT the host's uid 1000. Container root maps to the host user, and
# container uid 1000 maps to a high subuid (e.g. 100999). So a host-side
# `chown 1000:1000` sets the file to "container root", and the unprivileged app
# user still cannot write. The only place the mapping is unambiguous is inside
# the container, so the fix belongs here.

set -eu

DATA_DIR="${DATA_DIR:-/data}"
APP_UID="${PUID:-1000}"
APP_GID="${PGID:-1000}"

if [ "$(id -u)" != "0" ]; then
  # Already unprivileged: whatever ownership it has is what it gets.
  exec "$@"
fi

if [ ! -d "$DATA_DIR" ]; then
  echo "entrypoint: $DATA_DIR is not a directory or not mounted" >&2
  exit 1
fi

current="$(stat -c '%u:%g' "$DATA_DIR")"
if [ "$current" != "$APP_UID:$APP_GID" ]; then
  echo "entrypoint: taking ownership of $DATA_DIR ($current -> $APP_UID:$APP_GID)" >&2
  # -R so an existing metrics.db and its -wal/-shm siblings are fixed too.
  chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null \
    || echo "entrypoint: chown failed; continuing and letting the app report EACCES" >&2
fi

# SQLite needs the directory writable, not just the file: it creates
# metrics.db-wal and metrics.db-shm next to the database.
if ! su-exec "$APP_UID:$APP_GID" test -w "$DATA_DIR" 2>/dev/null; then
  echo "entrypoint: $DATA_DIR still not writable by $APP_UID:$APP_GID after chown." >&2
  echo "            If this is a bind mount on rootless docker, set PUID/PGID to" >&2
  echo "            the host uid/gid that owns the directory (see 'id -u')." >&2
fi

# exec replaces this shell, so no privileged parent is left behind. -c 0 keeps
# a shell from being the thing that reaps the app.
exec su-exec "$APP_UID:$APP_GID" "$@"
