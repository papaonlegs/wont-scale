#!/bin/sh
# wont-scale installer (plan U8, KTD6/KTD8).
#
# The hero command:  curl -fsSL <release-url>/install.sh | sh
# Two-step, verifiable:  curl -fsSL <url>/install.sh -o install.sh && less install.sh && sh install.sh
#
# POSIX sh (not bash), set -eu (no pipefail — not portable to dash). The whole
# body is inside main() called on the last line, so a truncated download fails
# to parse the closing brace and executes NOTHING rather than a partial prefix.
#
# The payload is a pinned GitHub Release tarball verified against the SHA-256
# EMBEDDED IN THIS SCRIPT — never fetched from the release, so whoever can
# publish an asset cannot also publish its checksum. A cached kit is re-verified
# against that digest on every run, not just first fetch.

set -eu

# --- pinned release + embedded integrity anchor (KTD6) ----------------------
WONT_SCALE_VERSION="v0.1.0"
WONT_SCALE_TARBALL_URL="https://github.com/papaonlegs/wont-scale/releases/download/${WONT_SCALE_VERSION}/wont-scale-${WONT_SCALE_VERSION}.tar.gz"
# The expected tarball digest is written here at release time by scripts/release.mjs.
# A literal placeholder means an unreleased checkout; the script refuses to run.
WONT_SCALE_SHA256="__WONT_SCALE_SHA256__"

SERIES="https://papa.onle.gs/writing/index.html"
KIT_URL="https://github.com/papaonlegs/wont-scale"

say() { printf '%s\n' "$*" >&2; }
die() { say "wont-scale: $*"; exit 1; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else die "no shasum/sha256sum available to verify the download"; fi
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

install_hint() {
  if command -v brew >/dev/null 2>&1; then echo "brew install node";
  elif command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y nodejs";
  else echo "install Node 18+ from https://nodejs.org"; fi
}

main() {
  # Reject an unreleased script rather than fetching an unpinned payload.
  case "$WONT_SCALE_SHA256" in
    __WONT_SCALE_SHA256__|"") die "this install.sh has no pinned digest — build a release with scripts/release.mjs first" ;;
  esac

  # Target directory: `sh -s -- /path/to/app`, else the current directory.
  TARGET="${1:-$PWD}"

  # Node is required for the session; no silent runtime install (parallel to the
  # no-silent-paid-tool-install rule). Fetch+unpack first so we can still hand
  # the reader front door one.
  CACHE_ROOT="${TMPDIR:-/tmp}/wont-scale-kit-$(id -u 2>/dev/null || echo 0)"
  mkdir -p "$CACHE_ROOT" 2>/dev/null || true
  chmod 700 "$CACHE_ROOT" 2>/dev/null || true
  KIT_DIR="$CACHE_ROOT/${WONT_SCALE_VERSION}"
  MARKER="$KIT_DIR/.wont-scale-complete"

  # Reuse only a cache whose recorded digest still matches (KTD6): a completeness
  # marker proves the unpack finished, not that the bytes are still trustworthy.
  reuse=0
  if [ -f "$MARKER" ]; then
    recorded="$(cat "$MARKER" 2>/dev/null || echo '')"
    if [ "$recorded" = "$WONT_SCALE_SHA256" ]; then reuse=1; else say "cached kit failed re-verification — refetching"; rm -rf "$KIT_DIR"; fi
  fi

  if [ "$reuse" -eq 0 ]; then
    command -v curl >/dev/null 2>&1 || die "curl is required"
    tmptar="$(mktemp "${TMPDIR:-/tmp}/wont-scale-XXXXXX.tar.gz")"
    say "Fetching wont-scale ${WONT_SCALE_VERSION}…"
    curl -fsSL "$WONT_SCALE_TARBALL_URL" -o "$tmptar" || die "download failed"
    got="$(sha256_of "$tmptar")"
    [ "$got" = "$WONT_SCALE_SHA256" ] || { rm -f "$tmptar"; die "integrity check failed (expected $WONT_SCALE_SHA256, got $got) — refusing to run"; }
    rm -rf "$KIT_DIR"; mkdir -p "$KIT_DIR"
    tar -xzf "$tmptar" -C "$KIT_DIR" --strip-components=1 || die "unpack failed"
    rm -f "$tmptar"
    printf '%s' "$WONT_SCALE_SHA256" > "$MARKER"
  fi

  say "Kit ${WONT_SCALE_VERSION} ready at $KIT_DIR"

  if ! node_ok; then
    say ""
    say "Node 18+ is not available, so the interactive session can't run."
    say "You still have the kit itself:"
    say "  - the ten reasons: $SERIES"
    say "  - the checklist:   $KIT_DIR/audit/CHECKLIST.md"
    say "  - install Node with: $(install_hint)"
    exit 1
  fi

  # Interactive under a pipe: curl | sh consumes stdin, so re-attach the terminal
  # for the session's prompts (rustup pattern). No TTY at all -> require --yes.
  say ""
  if [ ! -t 0 ] && [ -t 1 ]; then
    exec node "$KIT_DIR/scripts/audit-session.mjs" --target "$TARGET" < /dev/tty
  elif [ ! -t 0 ] && [ ! -t 1 ]; then
    exec node "$KIT_DIR/scripts/audit-session.mjs" --target "$TARGET" --yes
  else
    exec node "$KIT_DIR/scripts/audit-session.mjs" --target "$TARGET"
  fi
}

main "$@"
