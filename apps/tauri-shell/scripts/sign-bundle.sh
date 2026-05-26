#!/usr/bin/env bash
# Post-build adhoc deep-sign with STABLE bundle-relative identifiers.
#
# Why: Tauri's bundler leaves the shell as Rust's linker-signed identifier
# (`quanta_tauri_shell-<random-hex>`) and the sidecars as their default
# binary names (`screen-ocr`, `a.out`). TCC keys permission grants by the
# code-signature identifier, so:
#   - The random suffix changes every release build → screen recording /
#     accessibility prompts re-fire on every install.
#   - The sidecars sign as completely separate apps → granting "Quanta"
#     ScreenCapture does NOT cover the `screen-ocr` child process that
#     actually calls ScreenCaptureKit, so TCC re-prompts at first use.
#
# This script normalises identifiers to:
#   - `ai.quanta.desktop`             (shell + bundle)
#   - `ai.quanta.desktop.screen-ocr`  (Swift sidecar — the one TCC asks about)
#   - `ai.quanta.desktop.daemon`      (bun-compile sidecar)
#
# Run AFTER `cargo tauri build`. Default target is the dev build output;
# pass an explicit path to re-sign an installed copy.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TAURI_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

APP_PATH="${1:-${TAURI_ROOT}/target/release/bundle/macos/Quanta.app}"
ENTITLEMENTS="${TAURI_ROOT}/entitlements.plist"
BUNDLE_ID="ai.quanta.desktop"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "sign-bundle: .app not found at ${APP_PATH}" >&2
  exit 1
fi
if [[ ! -f "${ENTITLEMENTS}" ]]; then
  echo "sign-bundle: entitlements.plist not found at ${ENTITLEMENTS}" >&2
  exit 1
fi

MACOS_DIR="${APP_PATH}/Contents/MacOS"

sign_inner() {
  local rel="$1"
  local ident="$2"
  local path="${MACOS_DIR}/${rel}"
  if [[ ! -f "${path}" ]]; then
    echo "sign-bundle: skipping ${rel} (not present)"
    return
  fi
  echo "sign-bundle: signing ${rel} as ${ident}"
  codesign --force --sign - \
    --identifier "${ident}" \
    --options runtime \
    --entitlements "${ENTITLEMENTS}" \
    --timestamp=none \
    "${path}"
}

# Order matters: deep-sign sidecars FIRST so the outer --deep below doesn't
# re-sign them with their default identifiers.
sign_inner "screen-ocr"          "${BUNDLE_ID}.screen-ocr"
sign_inner "quanta-web-daemon"   "${BUNDLE_ID}.daemon"

echo "sign-bundle: signing bundle as ${BUNDLE_ID}"
# NO --deep here: --deep would re-sign the sidecars too, clobbering the
# stable identifiers we just set on them. Without --deep, codesign signs
# the main MacOS/<exe> and seals Contents/ resources; the sidecars' own
# signatures are preserved as part of the resource seal.
codesign --force --sign - \
  --identifier "${BUNDLE_ID}" \
  --options runtime \
  --entitlements "${ENTITLEMENTS}" \
  --timestamp=none \
  "${APP_PATH}"

echo "sign-bundle: verifying"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}" 2>&1 | tail -5
echo "sign-bundle: done"
echo
echo "Resulting identifiers:"
codesign -dvv "${APP_PATH}" 2>&1 | grep Identifier
codesign -dvv "${MACOS_DIR}/screen-ocr" 2>&1 | grep Identifier
codesign -dvv "${MACOS_DIR}/quanta-web-daemon" 2>&1 | grep Identifier
