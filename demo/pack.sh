#!/bin/bash
# Copyright 2026 zrdt contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# demo/pack.sh: build the MacBook demo kit (demo/DEMO.md, "The kit").
#
# Run on the build Mac (darwin-arm64), in a fork tree that is fully built:
#   pnpm install && pnpm run generate && pnpm run build:preload-cache
#   (cd zrdt/core && lake build)
# then:
#   demo/pack.sh [--out DIR] [--no-tar] [--no-prune]
#
# It writes DIR/zrdt-demo-kit/ (default DIR: ~/demo-kit-build) and
# DIR/zrdt-demo-kit.tar.gz:
#   zrdt-demo-kit/run-demo.sh   the one command (calls app/demo/run-demo.sh)
#   zrdt-demo-kit/DEMO.md       the live script
#   zrdt-demo-kit/KIT-INFO.txt  versions, commits, checksums, linkage
#   zrdt-demo-kit/node/         the Node 24.22.0 runtime
#   zrdt-demo-kit/bin/zrdtd     the Lean daemon (macOS system libraries only)
#   zrdt-demo-kit/app/          the built fork: sources, bundles, preload
#                               cache, node_modules with Electron, demo/
# Nothing is rebuilt on the MacBook; git internals, artifacts, Lean build
# trees and packaging-only tools are left out.
#
# Environment: NODE_DIR (default: the Node on PATH; must be v24.22.0),
# ZRDT_DAEMON (default: zrdt/core/.lake/build/bin/zrdtd).

set -euo pipefail

NODE_WANT=v24.22.0
ELECTRON_WANT=44.9.1

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$HOME/demo-kit-build"
MAKE_TAR=1
PRUNE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$2; shift 2 ;;
    --no-tar) MAKE_TAR=; shift ;;
    --no-prune) PRUNE=; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "pack.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
KIT="$OUT/zrdt-demo-kit"
TARBALL="$OUT/zrdt-demo-kit.tar.gz"

say() { echo "[pack] $*"; }
die() { echo "[pack] ERROR: $*" >&2; exit 1; }

# --- preconditions -----------------------------------------------------------

[ "$(uname -s)" = Darwin ] || die "run this on the build Mac (darwin), not $(uname -s)"
[ "$(uname -m)" = arm64 ] || die "the kit is darwin-arm64; this machine is $(uname -m)"
case "$KIT/" in
  "$ROOT"/*) die "--out must be outside the fork tree ($ROOT)" ;;
esac

NODE_BIN=$(command -v node || true)
NODE_DIR=${NODE_DIR:-${NODE_BIN:+$(cd "$(dirname "$NODE_BIN")/.." && pwd)}}
[ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ] ||
  die "no Node runtime (set NODE_DIR to an unpacked node-$NODE_WANT-darwin-arm64)"
NODE_HAVE=$("$NODE_DIR/bin/node" -v)
[ "$NODE_HAVE" = "$NODE_WANT" ] || die "Node at $NODE_DIR is $NODE_HAVE, want $NODE_WANT"

DAEMON=${ZRDT_DAEMON:-$ROOT/zrdt/core/.lake/build/bin/zrdtd}
[ -x "$DAEMON" ] || die "no zrdtd at $DAEMON (cd zrdt/core && lake build)"

for f in package.json ci.js bundles/main.js bundles/config.js preload.bundle.cache \
  config/default.json node_modules/tsx/package.json demo/launch.ts demo/smoke.ts \
  demo/run-demo.sh; do
  [ -e "$ROOT/$f" ] || die "missing $f: build the fork first (see the header)"
done
ELECTRON_APP="$ROOT/node_modules/electron/dist/Electron.app"
[ -x "$ELECTRON_APP/Contents/MacOS/Electron" ] || die "no Electron binary under node_modules/electron"
ELECTRON_HAVE=$(cat "$ROOT/node_modules/electron/dist/version")
[ "$ELECTRON_HAVE" = "$ELECTRON_WANT" ] || die "Electron is $ELECTRON_HAVE, want $ELECTRON_WANT"

# zrdtd must link only macOS system libraries (the MacBook has no Lean).
LIBS=$(otool -L "$DAEMON" | tail -n +2 | awk '{print $1}')
for lib in $LIBS; do
  case "$lib" in
    /usr/lib/*|/System/Library/*) ;;
    *) die "zrdtd links $lib, which is not a macOS system library" ;;
  esac
done
DAEMON_LINE=$(LEAN_ABORT_ON_PANIC=1 "$DAEMON" </dev/null 2>&1 | head -1)
case "$DAEMON_LINE" in
  "zrdtd: protocol"*) ;;
  *) die "zrdtd does not start: $DAEMON_LINE" ;;
esac

# --- the kit -----------------------------------------------------------------

say "fork tree $ROOT"
say "writing $KIT"
rm -rf "$KIT" "$TARBALL"
mkdir -p "$KIT/app" "$KIT/bin" "$KIT/node"

# Copies with tar (keeps pnpm's relative symlinks); no AppleDouble files, no
# extended attributes (no quarantine or provenance flags travel along).
copytree() { # src dst [tar args...]
  local src=$1 dst=$2
  shift 2
  (cd "$src" && COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -cf - "$@") |
    (cd "$dst" && tar -xpf -)
}

say "copying Node $NODE_HAVE from $NODE_DIR"
copytree "$NODE_DIR" "$KIT/node" .

# Top-level entries of the fork that the demo never needs.
SKIP_TOP=" .git .github .vscode .idea .cache .oxlint artifacts release codemods danger dangerfile.mjs reproducible-builds "
TOP=()
for e in $(cd "$ROOT" && ls -A); do
  case "$SKIP_TOP" in *" $e "*) continue ;; esac
  TOP+=("$e")
done
# Nested: demo artifacts, the zrdt submodule's git file and Lean build trees
# (zrdtd is copied to bin/), node_modules caches; with pruning, packaging
# tools (electron-builder's binaries, Storybook) that nothing at run time loads.
EXCLUDES=(--exclude 'demo/artifacts' --exclude 'zrdt/.git' --exclude '.lake'
  --exclude 'node_modules/.cache')
if [ -n "$PRUNE" ]; then
  for p in 'app-builder-bin@*' 'electron-winstaller@*' '7zip-bin@*' \
    '@storybook+*' 'storybook@*'; do
    EXCLUDES+=(--exclude "node_modules/.pnpm/$p")
  done
fi
say "copying the fork (${#TOP[@]} top-level entries${PRUNE:+, packaging tools pruned})"
copytree "$ROOT" "$KIT/app" "${EXCLUDES[@]}" "${TOP[@]}"
mkdir -p "$KIT/app/demo/artifacts"

say "copying zrdtd"
cp -p "$DAEMON" "$KIT/bin/zrdtd"

# The top-level launcher: the real script lives in the fork (demo/run-demo.sh).
cat >"$KIT/run-demo.sh" <<'EOF'
#!/bin/bash
# zrdt demo kit: the one command. See DEMO.md; --help for the flags.
exec "$(cd "$(dirname "$0")" && pwd)/app/demo/run-demo.sh" "$@"
EOF
chmod +x "$KIT/run-demo.sh" "$KIT/app/demo/run-demo.sh"
if [ -e "$ROOT/demo/DEMO.md" ]; then
  cp "$ROOT/demo/DEMO.md" "$KIT/DEMO.md"
fi

# --- checks ------------------------------------------------------------------

ABS=$(find "$KIT" -type l -lname '/*' | head -5)
[ -z "$ABS" ] || die "absolute symlinks in the kit (not relocatable): $ABS"
DANGLING=0
for l in "$KIT/app/node_modules"/* "$KIT/app/node_modules"/@*/* "$KIT/app/node_modules/.pnpm/node_modules"/*; do
  if [ -L "$l" ] && [ ! -e "$l" ]; then DANGLING=$((DANGLING + 1)); fi
done

# --- KIT-INFO.txt --------------------------------------------------------------

git_head() { git -C "$1" rev-parse --short=12 HEAD 2>/dev/null || echo unknown; }
git_dirty() { [ -z "$(git -C "$1" status --porcelain 2>/dev/null)" ] || echo " (dirty)"; }
minos() { otool -l "$1" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}'; }
{
  echo "zrdt demo kit, packed $(date -u '+%Y-%m-%dT%H:%M:%SZ') on $(hostname -s) (macOS $(sw_vers -productVersion), $(uname -m))"
  echo "fork:      $(git_head "$ROOT")$(git_dirty "$ROOT") ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null))"
  echo "zrdt:      $(git_head "$ROOT/zrdt")$(git_dirty "$ROOT/zrdt")"
  echo "node:      $NODE_HAVE (minos $(minos "$KIT/node/bin/node"))"
  echo "electron:  $ELECTRON_HAVE"
  echo "zrdtd:     $DAEMON_LINE"
  echo "zrdtd sha256 $(shasum -a 256 "$KIT/bin/zrdtd" | awk '{print $1}') (minos $(minos "$KIT/bin/zrdtd"))"
  echo "zrdtd links:"
  otool -L "$KIT/bin/zrdtd" | tail -n +2
  if [ -n "$PRUNE" ]; then
    echo "pruned:    app-builder-bin, electron-winstaller, 7zip-bin, storybook (packaging only)"
  fi
  echo "dangling top-level node_modules links: $DANGLING (the pruned packages)"
} >"$KIT/KIT-INFO.txt"

KIT_SIZE=$(du -sh "$KIT" | awk '{print $1}')
say "kit directory: $KIT ($KIT_SIZE)"

if [ -n "$MAKE_TAR" ]; then
  say "writing $TARBALL"
  (cd "$OUT" && COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$TARBALL" zrdt-demo-kit)
  TAR_SIZE=$(du -h "$TARBALL" | awk '{print $1}')
  echo "tarball: $(basename "$TARBALL") $TAR_SIZE sha256 $(shasum -a 256 "$TARBALL" | awk '{print $1}')" >>"$KIT/KIT-INFO.txt"
  say "tarball: $TARBALL ($TAR_SIZE)"
fi
cat "$KIT/KIT-INFO.txt"
say "done. On the MacBook: tar -xzf zrdt-demo-kit.tar.gz -C ~ && ~/zrdt-demo-kit/run-demo.sh --smoke"
