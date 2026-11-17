#!/bin/sh
# Host-side diagnostic for "docker can't read my files" / "chown doesn't help".
# Read-only: writes nothing, changes nothing.
#
#   ./app/scripts/doctor.sh [path-to-data-dir]     (run from the repo root)
#
# Run it on the DOCKER HOST (not inside the container). The Node project is in app/,
# but the data directory and the compose files are at the repository root, so the
# default argument is ./data and the compose commands below are root-relative.

set -u

DATA_DIR="${1:-./data}"
fail=0

note() { printf '  %s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*"; fail=$((fail + 1)); }

printf '\n=== docker daemon ===\n'

if ! command -v docker >/dev/null 2>&1; then
  bad "docker not on PATH"
else
  info="$(docker info 2>/dev/null)"
  if [ -z "$info" ]; then
    bad "cannot talk to the docker daemon as $(id -un)"
  else
    case "$info" in
      *"rootless"*) ok "rootless docker — uid mapping WILL differ from the host" ;;
      *) ok "rootful docker (or userns-remap disabled)" ;;
    esac
    note "$(printf '%s\n' "$info" | grep -i 'docker root dir' || true)"
  fi
fi

printf '\n=== uid mapping ===\n'

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  mapped="$(docker run --rm --entrypoint sh alpine:3 -c 'id -u' 2>/dev/null)"
  if [ -n "$mapped" ]; then
    note "container uid 0 == host uid $(id -u)"
    note "container uid 1000 == host uid $(( ${SUBUID_START:-100000} + 999 ))"
  fi
else
  note "skipped (no daemon access)"
fi

if [ -f /etc/subuid ]; then
  note "subuid: $(grep "^$(id -un):" /etc/subuid || echo 'none for this user')"
else
  note "no /etc/subuid"
fi

printf '\n=== target directory ===\n'

if [ ! -e "$DATA_DIR" ]; then
  bad "$DATA_DIR does not exist"
else
  stat -c '  %A %u:%g  %n' "$DATA_DIR" 2>/dev/null || bad "cannot stat $DATA_DIR"

  owner_uid="$(stat -c '%u' "$DATA_DIR")"
  owner_gid="$(stat -c '%g' "$DATA_DIR")"

  if [ "$owner_uid" = "$(id -u)" ]; then
    warn "$DATA_DIR is owned by your user ($(id -u)), not by a container uid."
    warn "  rootless: container sees this as root:root -> app user cannot write."
    warn "  fix: set PUID=$(( ${SUBUID_START:-100000} + 999 )) or use a named volume."
  fi

  # Traversal: every parent needs +x even if the leaf is fine. This is the
  # failure that looks like a permissions bug but isn't in the leaf at all.
  p="$DATA_DIR"
  while [ "$p" != "/" ] && [ -n "$p" ]; do
    p="$(dirname "$p")"
    if [ -d "$p" ] && [ ! -x "$p" ]; then
      bad "parent $p is not traversable (+x) — this blocks access to everything below it"
    fi
  done

  if [ -n "$(find "$DATA_DIR" -maxdepth 0 -perm -o+rwx 2>/dev/null)" ] && [ -n "$(command -v getfacl)" ]; then
    warn "world-accessible directory — consider chmod 750"
  fi

  # Privacy here is mode bits, not encryption: a 0600 metrics.db sitting next to a
  # 0644 metrics.db-wal is the same data under a different filename. SQLite creates
  # the sidecars itself, so they follow the umask rather than our chmod.
  for f in "$DATA_DIR"/metrics.db "$DATA_DIR"/metrics.db-wal "$DATA_DIR"/metrics.db-shm "$DATA_DIR"/tokens.json; do
    [ -e "$f" ] || continue
    m="$(stat -c '%a' "$f" 2>/dev/null || echo '')"
    [ -n "$m" ] || continue
    case "$m" in
      *[1-7]) bad "$(basename "$f") is world-accessible (0$m) — chmod 600 or 640" ;;
      *) ok "$(basename "$f") 0$m" ;;
    esac
  done
fi

printf '\n=== acl and attributes ===\n'

if command -v getfacl >/dev/null 2>&1 && [ -e "$DATA_DIR" ]; then
  acl="$(getfacl -p "$DATA_DIR" 2>/dev/null | grep -v '^#' | tr '\n' ' ')"
  case "$acl" in
    *mask*) warn "POSIX ACL present — it overrides the mode bits: $acl" ;;
    *) ok "no surprising ACLs" ;;
  esac
else
  note "getfacl not installed (apt install acl / apk add acl)"
fi

if command -v lsattr >/dev/null 2>&1 && [ -e "$DATA_DIR" ]; then
  attrs="$(lsattr -d "$DATA_DIR" 2>/dev/null | awk '{print $1}')"
  case "$attrs" in
    *i*) bad "immutable flag (chattr +i) — chown and writes will fail until 'chattr -i'" ;;
    *a*) warn "append-only flag (chattr +a)" ;;
    *) ok "no immutable/append-only flags" ;;
  esac
else
  note "lsattr not installed (e2fsprogs)"
fi

printf '\n=== filesystem ===\n'

if command -v findmnt >/dev/null 2>&1; then
  fs="$(findmnt -no FSTYPE -T "$DATA_DIR" 2>/dev/null)"
  note "fstype: ${fs:-unknown}"
  case "$fs" in
    ntfs*|vfat|exfat|9p|cifs|smb*)
      bad "$fs cannot store unix ownership — chown is impossible here."
      bad "  move the project onto a real Linux filesystem (ext4/xfs/btrfs)."
      ;;
    overlay) warn "overlayfs: chown inside the container will not reach the host" ;;
    ext4|xfs|btrfs|zfs) ok "$fs stores ownership normally" ;;
  esac
fi

if command -v mount >/dev/null 2>&1 && [ -e "$DATA_DIR" ]; then
  opts="$(findmnt -no OPTIONS -T "$DATA_DIR" 2>/dev/null)"
  case "$opts" in
    *nosuid*) : ;;
    *) ;;
  esac
  case "$opts" in
    *ro,*|*,ro|ro) bad "$DATA_DIR is on a read-only mount" ;;
    *) ok "mount is rw" ;;
  esac
fi

printf '\n=== selinux / apparmor ===\n'

if command -v getenforce >/dev/null 2>&1; then
  e="$(getenforce 2>/dev/null)"
  note "selinux: $e"
  [ "$e" = "Enforcing" ] && warn "if chown works but the container still fails, check 'ausearch -m avc'"
else
  note "selinux: not present"
fi

printf '\n=== summary ===\n'
if [ "$fail" -eq 0 ]; then
  ok "no blocking permission problems found"
else
  bad "$fail blocking problem(s) — see FAIL lines above"
fi

cat <<'EOF'

  If you just want it working, stop fighting the bind mount:

    docker compose down
    # ./data is now a named volume (metrics-data); no host ownership involved
    docker compose up -d --build

  To keep a host directory instead, use the bind-mount overlay:

    PUID=$(id -u) PGID=$(id -g) docker compose \
      -f docker-compose.yml -f docker-compose.bindmount.yml up -d --build

EOF

exit "$fail"
