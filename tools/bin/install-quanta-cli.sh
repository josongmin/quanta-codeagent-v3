#!/usr/bin/env bash
# Build dist/agent and install `quanta` on PATH (~/.local/bin by default).
#
# Usage (from repo root):
#   bun run install:cli
#   bash tools/bin/install-quanta-cli.sh
#
# Env:
#   QUANTA_INSTALL_DIR   — target directory (default: $HOME/.local/bin)
#   QUANTA_INSTALL_NAME  — binary name (default: quanta)
#
# Flags:
#   --skip-build   — install existing dist/agent without compiling
#   --link         — symlink instead of copy (faster dev; breaks if repo moves)
#   --dry-run      — print actions only
#   -h, --help

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="${REPO_ROOT}/dist/agent"
INSTALL_DIR="${QUANTA_INSTALL_DIR:-${HOME}/.local/bin}"
INSTALL_NAME="${QUANTA_INSTALL_NAME:-quanta}"
TARGET="${INSTALL_DIR}/${INSTALL_NAME}"

SKIP_BUILD=0
USE_LINK=0
DRY_RUN=0

usage() {
  cat <<'EOF'
install-quanta-cli — build and install the Quanta CLI globally

  bun run install:cli
  bash tools/bin/install-quanta-cli.sh [--skip-build] [--link] [--dry-run]

Environment:
  QUANTA_INSTALL_DIR   Target directory (default: ~/.local/bin)
  QUANTA_INSTALL_NAME  Installed command name (default: quanta)

After install, run `quanta` from any directory (ensure INSTALL_DIR is on PATH).
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    --skip-build)
      SKIP_BUILD=1
      ;;
    --link)
      USE_LINK=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      echo "install-quanta-cli: unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

warn_path() {
  case ":${PATH}:" in
    *:"${INSTALL_DIR}":*) return 0 ;;
  esac
  echo "install-quanta-cli: warning: ${INSTALL_DIR} is not on PATH." >&2
  echo "  Add to ~/.zshrc:  export PATH=\"${INSTALL_DIR}:\$PATH\"" >&2
}

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  # Bump the patch segment of the version in package.json before each build.
  current_ver=$(bun -e "console.log(require('${REPO_ROOT}/package.json').version)")
  IFS='.' read -r v_major v_minor v_patch <<< "$current_ver"
  new_patch=$(printf "%03d" $((10#$v_patch + 1)))
  new_ver="${v_major}.${v_minor}.${new_patch}"
  bun -e "
    const fs = require('fs');
    const p = '${REPO_ROOT}/package.json';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.version = '${new_ver}';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "install-quanta-cli: version ${current_ver} → ${new_ver}"
  echo "install-quanta-cli: building ${SOURCE} ..."
  run cd "$REPO_ROOT"
  run bun run build
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "install-quanta-cli: missing ${SOURCE} (build failed or --skip-build without prior build)" >&2
  exit 1
fi

run mkdir -p "$INSTALL_DIR"

if [[ "$USE_LINK" -eq 1 ]]; then
  echo "install-quanta-cli: linking ${TARGET} -> ${SOURCE}"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    ln -sf "$SOURCE" "$TARGET"
  fi
else
  tmp="${TARGET}.tmp.$$"
  echo "install-quanta-cli: copying ${SOURCE} -> ${TARGET}"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    cp -f "$SOURCE" "$tmp"
    chmod +x "$tmp"
    mv -f "$tmp" "$TARGET"
  fi
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! command -v "$TARGET" >/dev/null 2>&1 && [[ ! -x "$TARGET" ]]; then
    echo "install-quanta-cli: install failed — ${TARGET} not executable" >&2
    exit 1
  fi
  # Smoke: compiled entry handles --help before any session wiring.
  if ! "$TARGET" --help >/dev/null 2>&1; then
    echo "install-quanta-cli: warning: ${TARGET} --help failed (binary may still work)" >&2
  fi
fi

warn_path

echo "install-quanta-cli: done — $(command -v "$TARGET" 2>/dev/null || echo "$TARGET")"
if [[ "$USE_LINK" -eq 1 ]]; then
  echo "  (symlink; rebuild + re-run install:cli updates dist/agent in place)"
else
  echo "  Run \`bun run install:cli\` again after code changes to refresh the global binary."
fi
