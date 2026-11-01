#!/bin/bash
# Copyright 2026 zrdt contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# demo/run-demo.sh: the one command for the live demo (demo/DEMO.md).
#
#   run-demo.sh               Alice, Bob, Carol linked, warm-ups sent, the
#                             villain's panel opened in the browser
#   run-demo.sh --smoke       the F2 smoke test instead (beats 1-3, ~1 min);
#                             exit 0 only when every check passes
#   run-demo.sh --stop        kill desktops a crashed run left behind
#
# Flags: --background (windows do not wait to become visible: only for a
# locked screen or SSH; the demo wants them visible), --link-dave (link Dave
# at once, for rehearsals), --no-open (do not open the panel), --port N
# (panel port, default 7357), --resign (ad-hoc re-sign zrdtd, node and
# Electron first), --verbose.
#
# Works in the packed kit (zrdt-demo-kit/app/demo/run-demo.sh: uses the kit's
# node/ and bin/zrdtd) and in a fork checkout (Node on PATH, zrdtd from
# zrdt/core/.lake/build/bin). Bash 3.2 (macOS /bin/bash).

set -uo pipefail

NODE_WANT=v24.22.0
ELECTRON_WANT=44.9.1

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
KIT=$(cd "$ROOT/.." && pwd)

say() { echo "[run-demo] $*"; }
die() {
  echo "[run-demo] ERROR: $*" >&2
  exit 1
}

MODE=demo
BACKGROUND=
NO_OPEN=
RESIGN=
DAEMON_ARG=
PORT=${ZRDT_PANEL_PORT:-7357}
LAUNCH_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --smoke) MODE=smoke ;;
    --stop) MODE=stop ;;
    --background) BACKGROUND=1 ;;
    --no-open) NO_OPEN=1 ;;
    --resign) RESIGN=1 ;;
    --link-dave) LAUNCH_ARGS+=(--link-dave) ;;
    --verbose) LAUNCH_ARGS+=(--verbose) ;;
    --port)
      PORT=$2
      shift
      ;;
    --daemon)
      DAEMON_ARG=$2
      shift
      ;;
    -h | --help)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    *) die "unknown argument $1 (try --help)" ;;
  esac
  shift
done

# --- where things are ----------------------------------------------------------

if [ -x "$KIT/node/bin/node" ] && [ -x "$KIT/bin/zrdtd" ]; then
  IN_KIT=1
  export PATH="$KIT/node/bin:$PATH:/usr/bin:/bin:/usr/sbin:/sbin"
  DAEMON="$KIT/bin/zrdtd"
else
  IN_KIT=
  export PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin"
  DAEMON="${ZRDT_DAEMON:-$ROOT/zrdt/core/.lake/build/bin/zrdtd}"
fi
[ -n "$DAEMON_ARG" ] && DAEMON=$DAEMON_ARG
ELECTRON_APP="$ROOT/node_modules/electron/dist/Electron.app"
ELECTRON="$ELECTRON_APP/Contents/MacOS/Electron"
# Every Electron process of ours runs from here (pnpm's real path).
ELECTRON_MARK="$ROOT/node_modules/.pnpm/electron@"

kill_ours() {
  local n
  n=$(pgrep -f "$ELECTRON_MARK" | wc -l | tr -d ' ')
  if [ "$n" != 0 ]; then
    say "killing $n leftover Electron processes from $ROOT"
    pkill -9 -f "$ELECTRON_MARK" || true
  fi
}

if [ "$MODE" = stop ]; then
  # launch.ts serves the panel: ask it to close the desktops, then make sure.
  PID=$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -n "$PID" ]; then
    say "asking the demo (pid $PID, port $PORT) to close"
    kill -INT "$PID" 2>/dev/null
    for _ in $(seq 1 30); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$PID" 2>/dev/null
  fi
  kill_ours
  exit 0
fi

# --- macOS: quarantine, signatures --------------------------------------------

[ "$(uname -s)" = Darwin ] || die "the demo kit runs on macOS"
[ "$(uname -m)" = arm64 ] || die "the kit is built for Apple silicon (arm64); this Mac is $(uname -m)"

# A kit that arrived by AirDrop, a browser or Finder carries the quarantine
# flag, and Gatekeeper then blocks node, zrdtd, Electron and the native
# modules. Clear it once (the marker records that), or again if it came back.
if [ -n "$IN_KIT" ]; then
  if [ ! -e "$KIT/.unquarantined" ] ||
    xattr -p com.apple.quarantine "$KIT/node/bin/node" >/dev/null 2>&1 ||
    xattr -p com.apple.quarantine "$ELECTRON" >/dev/null 2>&1; then
    say "clearing the macOS quarantine flag on the kit (once, up to a minute)"
    xattr -dr com.apple.quarantine "$KIT" 2>/dev/null || true
    touch "$KIT/.unquarantined"
  fi
fi

resign() { # path [--deep]
  say "ad-hoc signing $1"
  codesign --force ${2:-} -s - "$1" >/dev/null 2>&1 || say "codesign failed on $1"
}
if [ -n "$RESIGN" ]; then
  resign "$DAEMON"
  [ -n "$IN_KIT" ] && resign "$KIT/node/bin/node"
  resign "$ELECTRON_APP" --deep
fi

# Each binary must start; one that macOS kills on sight (status 137: a bad
# signature) is ad-hoc re-signed once.
NODE_HAVE=$(node -v 2>/dev/null)
rc=$?
if [ $rc = 137 ] && [ -n "$IN_KIT" ]; then
  resign "$KIT/node/bin/node"
  NODE_HAVE=$(node -v 2>/dev/null)
fi
[ -n "$NODE_HAVE" ] || die "node does not start (try: $0 --resign)"
[ "$NODE_HAVE" = "$NODE_WANT" ] || say "warning: node is $NODE_HAVE, the kit was tested with $NODE_WANT"

[ -x "$DAEMON" ] || die "no zrdtd at $DAEMON"
daemon_line() { LEAN_ABORT_ON_PANIC=1 "$DAEMON" </dev/null 2>&1 | head -1; }
DAEMON_LINE=$(daemon_line)
case "$DAEMON_LINE" in
  "zrdtd: protocol"*) ;;
  *)
    resign "$DAEMON"
    DAEMON_LINE=$(daemon_line)
    ;;
esac
case "$DAEMON_LINE" in
  "zrdtd: protocol"*) ;;
  *) die "zrdtd does not start: ${DAEMON_LINE:-killed} (try: $0 --resign)" ;;
esac

[ -x "$ELECTRON" ] || die "no Electron at $ELECTRON"
electron_version() { ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -p process.versions.electron 2>/dev/null; }
ELECTRON_HAVE=$(electron_version)
if [ -z "$ELECTRON_HAVE" ]; then
  resign "$ELECTRON_APP" --deep
  ELECTRON_HAVE=$(electron_version)
fi
if [ -z "$ELECTRON_HAVE" ]; then
  say "warning: could not run Electron to check it (if the desktops do not start: $0 --resign)"
  ELECTRON_HAVE="(not checked)"
elif [ "$ELECTRON_HAVE" != "$ELECTRON_WANT" ]; then
  say "warning: Electron is $ELECTRON_HAVE, want $ELECTRON_WANT"
fi

# --- environment for the harness and the desktops ----------------------------

export ZRDT_DAEMON="$DAEMON"
export ZRDT_REQUIRE_LEAN=1 # the demo runs on the verified Lean core, never the stub
export LEAN_ABORT_ON_PANIC=1
export ZRDT_RESEND_DELAY_MS="${ZRDT_RESEND_DELAY_MS:-4000}"
export ZRDT_AUTHOR_FASTPATH_DELAY_MS="${ZRDT_AUTHOR_FASTPATH_DELAY_MS:-3000}"
export ZRDT_PANEL_PORT="$PORT"
if [ -n "$BACKGROUND" ]; then
  export SIGNAL_MOCK_TESTS_BACKGROUND=1
  unset ZRDT_FOREGROUND
else
  # Visible windows: demo/harness.ts sets SIGNAL_MOCK_TESTS_BACKGROUND=1
  # unless ZRDT_FOREGROUND is set.
  unset SIGNAL_MOCK_TESTS_BACKGROUND
  export ZRDT_FOREGROUND=1
fi

if [ -n "$IN_KIT" ]; then WHERE="kit $KIT"; else WHERE="fork checkout $ROOT"; fi
if [ -n "$BACKGROUND" ]; then WINDOWS=background; else WINDOWS=visible; fi
say "running:  $WHERE"
say "node:     $NODE_HAVE ($(command -v node))"
say "electron: $ELECTRON_HAVE"
say "zrdtd:    $DAEMON_LINE"
say "env:      ZRDT_REQUIRE_LEAN=1 ZRDT_RESEND_DELAY_MS=$ZRDT_RESEND_DELAY_MS ZRDT_AUTHOR_FASTPATH_DELAY_MS=$ZRDT_AUTHOR_FASTPATH_DELAY_MS windows=$WINDOWS"

cd "$ROOT" || die "cannot cd to $ROOT"

if [ "$MODE" = smoke ]; then
  say "smoke test (beats 1-3); artifacts in $ROOT/demo/artifacts/smoke"
  node --import tsx demo/smoke.ts
  rc=$?
  kill_ours
  say "smoke test exit status $rc ($([ $rc = 0 ] && echo GO || echo NO-GO)); screenshots: $ROOT/demo/artifacts/smoke"
  exit $rc
fi

# The live demo. The panel port must be free (a previous run still up?).
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is in use (a previous demo still running? $0 --stop, or --port N)"
fi

WATCHER=
if [ -z "$NO_OPEN" ]; then
  # Open the panel in the browser once it answers (the harness prints READY).
  (
    for _ in $(seq 1 300); do
      sleep 1
      if curl -s -o /dev/null "http://127.0.0.1:$PORT/rules"; then
        open "http://127.0.0.1:$PORT/"
        exit 0
      fi
    done
  ) &
  WATCHER=$!
fi
cleanup() {
  [ -n "$WATCHER" ] && kill "$WATCHER" 2>/dev/null
  kill_ours
}
trap cleanup EXIT

say "starting the demo; press Ctrl-C ONCE to close everything (wait for 'closed')"
node --import tsx demo/launch.ts --port "$PORT" ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"}
rc=$?
say "launch.ts exit status $rc; artifacts in $ROOT/demo/artifacts/demo"
exit $rc
