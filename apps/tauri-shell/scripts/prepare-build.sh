#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TAURI_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd -- "${TAURI_ROOT}/../.." && pwd)"
BINARY_ROOT="${TAURI_ROOT}/binaries"
RELEASE_ROOT="${TAURI_ROOT}/target/release"
BUNDLE_MACOS_ROOT="${TAURI_ROOT}/target/release/bundle/macos/Quanta.app/Contents/MacOS"
SWIFT_CACHE_ROOT="${TAURI_ROOT}/target/swiftpm-cache"
SWIFT_CONFIG_ROOT="${TAURI_ROOT}/target/swiftpm-config"
SWIFT_SECURITY_ROOT="${TAURI_ROOT}/target/swiftpm-security"
SWIFT_CLANG_MODULE_CACHE_ROOT="${TAURI_ROOT}/target/clang-module-cache"
HOST_TRIPLE="$(rustc -vV | awk '/^host: / { print $2 }')"

if [[ -z "${HOST_TRIPLE}" ]]; then
  echo "failed to resolve rust host triple" >&2
  exit 1
fi

mkdir -p \
  "${BINARY_ROOT}" \
  "${RELEASE_ROOT}" \
  "${SWIFT_CACHE_ROOT}" \
  "${SWIFT_CONFIG_ROOT}" \
  "${SWIFT_SECURITY_ROOT}" \
  "${SWIFT_CLANG_MODULE_CACHE_ROOT}"

build_web_frontend() {
  echo "[prepare-build] building web frontend"
  (
    cd "${REPO_ROOT}/apps/web-frontend"
    bun run build
  )
}

build_web_daemon() {
  echo "[prepare-build] compiling bun web daemon"
  bun build \
    --compile \
    --outfile "${BINARY_ROOT}/quanta-web-daemon" \
    "${REPO_ROOT}/src/apps/web-daemon/index.ts"
  stage_binary "quanta-web-daemon"
}

build_screen_ocr() {
  echo "[prepare-build] building swift screen-ocr"
  (
    cd "${REPO_ROOT}/native/screen-ocr"
    CLANG_MODULE_CACHE_PATH="${SWIFT_CLANG_MODULE_CACHE_ROOT}" \
      swift build \
        -c release \
        --cache-path "${SWIFT_CACHE_ROOT}" \
        --config-path "${SWIFT_CONFIG_ROOT}" \
        --security-path "${SWIFT_SECURITY_ROOT}" \
        --disable-sandbox \
        --manifest-cache local \
        --scratch-path "${REPO_ROOT}/native/screen-ocr/.build"
  )
  cp "${REPO_ROOT}/native/screen-ocr/.build/release/screen-ocr" \
    "${BINARY_ROOT}/screen-ocr"
  stage_binary "screen-ocr"
}

stage_binary() {
  local name="$1"
  local source="${BINARY_ROOT}/${name}"
  local triple_name="${BINARY_ROOT}/${name}-${HOST_TRIPLE}"
  local release_name="${RELEASE_ROOT}/${name}"
  local release_triple_name="${RELEASE_ROOT}/${name}-${HOST_TRIPLE}"

  cp "${source}" "${triple_name}"
  cp "${source}" "${release_name}"
  cp "${source}" "${release_triple_name}"
}

sync_existing_bundle_macos_app() {
  if [[ ! -d "${BUNDLE_MACOS_ROOT}" ]]; then
    return
  fi

  echo "[prepare-build] syncing existing Quanta.app bundle contents"
  cp "${RELEASE_ROOT}/quanta-tauri-shell" "${BUNDLE_MACOS_ROOT}/quanta-tauri-shell"
  cp "${RELEASE_ROOT}/quanta-web-daemon" "${BUNDLE_MACOS_ROOT}/quanta-web-daemon"
  cp "${RELEASE_ROOT}/screen-ocr" "${BUNDLE_MACOS_ROOT}/screen-ocr"
}

build_web_frontend
build_web_daemon
build_screen_ocr
sync_existing_bundle_macos_app
