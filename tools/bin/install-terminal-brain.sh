#!/usr/bin/env bash
# Put `quanta-terminal-brain` on PATH.
#
# WHY THIS EXISTS. Harbor executes the Terminal-Bench Python hands on the HOST
# (the bench CLI drives it through the adapter's uv project), and the hands spawn
# the brain as an ordinary subprocess — so the shim has to be on the host's PATH.
# Its only definition used to live inside the adapter Dockerfile, which put it in
# a container image and nowhere else; `terminal doctor` therefore reported
# `BLOCKED: brain-shim` on every machine and no 2.1 canary could start.
#
# A SYMLINK, not a copy: the shim is a tracked file and the link must never go
# stale against it. Same target dir convention as install-quanta-cli.sh.
#
#   QUANTA_INSTALL_DIR   target directory (default: $HOME/.local/bin)
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/adapters/terminal-bench/bin/quanta-terminal-brain"
INSTALL_DIR="${QUANTA_INSTALL_DIR:-${HOME}/.local/bin}"
TARGET="$INSTALL_DIR/quanta-terminal-brain"

[ -f "$SOURCE" ] || { echo "install-terminal-brain: missing $SOURCE" >&2; exit 1; }

mkdir -p "$INSTALL_DIR"
chmod +x "$SOURCE"
ln -sf "$SOURCE" "$TARGET"
echo "installed: $TARGET -> $SOURCE"

# Prove it answers the probe `quanta_agent.setup()` and the doctor both make,
# rather than reporting success on the strength of having created a symlink.
if ! out="$("$TARGET" --version 2>&1)"; then
  echo "install-terminal-brain: the installed shim failed \`--version\`: $out" >&2
  exit 1
fi
echo "probe ok: $out"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "note: $INSTALL_DIR is not on PATH — add it, or set QUANTA_TERMINAL_BRAIN_CMD=$SOURCE" >&2 ;;
esac
