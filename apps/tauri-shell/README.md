# `apps/tauri-shell` — quanta desktop shell

macOS-only Tauri 2.x desktop wrapper for quanta (ADR-0317).

## What it does

- Wraps the web frontend built by `apps/web-frontend/` (see [worker C]).
- Spawns the bun-compiled `quanta-web-daemon` (`src/apps/web-daemon/`) as a
  Tauri sidecar, picks a free local port, mints a 256-bit auth token, and
  injects `window.__QUANTA_CONFIG__ = { wsUrl, httpUrl, authToken }` into
  the main webview at boot.
- Spawns the Swift `screen-ocr` sidecar (`native/screen-ocr/`) on demand:
  `list_windows` enumerates capturable windows, `capture_window` runs OCR.
- Registers a global hotkey (`Cmd+Shift+Q` default) **only after the user
  opts in** via `enable_hotkey`. On trigger, captures the last-selected
  (or frontmost non-Quanta) window and emits `quanta:hotkey-capture`.

## Status

**Tier 1 scaffold, v1 = macOS only.** Production signing/notarization,
auto-update, and the window-picker UI are out of v1 scope (see ADR-0317
Negative Invariants).

## Tauri commands (frontend `invoke` surface)

| Command          | Returns                | Notes                                     |
|------------------|------------------------|-------------------------------------------|
| `list_windows`   | `WindowInfo[]`         | Calls `screen-ocr list-windows`           |
| `capture_window` | `CaptureResult`        | Calls `screen-ocr capture --window-id N`  |
| `start_daemon`   | `DaemonInfo`           | Idempotent; errors if already running     |
| `stop_daemon`    | `void`                 | SIGTERM (best-effort, no-unsafe policy)   |
| `daemon_status`  | `DaemonStatus`         | `{ running, port, uptime_ms, restart }`   |
| `daemon_info`    | `DaemonInfo`           | Current ws_url / auth_token snapshot      |
| `enable_hotkey`  | `void`                 | Default-OFF; opt-in registration          |
| `disable_hotkey` | `void`                 | Idempotent                                |
| `hotkey_status`  | `boolean`              | Whether the accelerator is registered     |

All commands return `Result<T, AppError>`. `AppError` serialises as
`{ code: string, message: string }`.

## Build recipe (5 steps)

> **None of these steps are run by Claude / the agent.** This README is
> the user-facing checklist.

```sh
# 0. Prereqs (one-time)
#    - Rust toolchain (stable, 2021 edition)
#    - Bun (https://bun.sh) — for compiling the web-daemon
#    - Xcode CLT (`xcode-select --install`) — for the Swift sidecar
#    - Tauri 2 CLI (`cargo install tauri-cli --version '^2'`)

# 1. Build the bun web-daemon as a standalone executable
bun build --compile --outfile apps/tauri-shell/binaries/quanta-web-daemon \
    src/apps/web-daemon/index.ts

# 2. Build the Swift screen-ocr sidecar and copy it in
cd native/screen-ocr && swift build -c release && cd -
cp native/screen-ocr/.build/release/screen-ocr \
    apps/tauri-shell/binaries/screen-ocr

# 3. Build the web frontend SPA (worker C's package)
cd apps/web-frontend && bun install && bun run build && cd -

# 4. Drop real icons into apps/tauri-shell/icons/
#    (the committed PNGs are 1x1 placeholders — replace before shipping)
#    Required filenames: 32x32.png, 128x128.png, 128x128@2x.png, icon.icns

# 5. Build the desktop bundle
cd apps/tauri-shell && cargo tauri build
# Output: target/release/bundle/{app,dmg}/Quanta.{app,dmg}
```

For dev iteration on the React app:

```sh
cd apps/web-frontend && bun run dev   # vite at http://localhost:5173
cd apps/tauri-shell && cargo tauri dev # loads devUrl from tauri.conf.json
```

## Security model (TL;DR)

- **Default-DENY capabilities.** See `capabilities/default.json`. The only
  shell-executable surface is the two sidecars by name; argument shapes are
  validated by the ACL.
- **App sandbox = OFF** for the dev profile (unsigned builds). TCC consent
  is requested at first screen-capture invocation (handled by
  ScreenCaptureKit on the Swift side). `entitlements.plist` lives in this
  directory and is referenced from `tauri.conf.json`.
- **Hotkey is OFF by default.** Registration happens lazily via the
  `enable_hotkey` command. Users see no global-shortcut prompt until they
  opt in from the UI.
- **Auth token is per-process random.** A 256-bit hex token is minted at
  daemon boot and injected into the webview as `__QUANTA_CONFIG__`. There
  is no on-disk credential.

## Negative invariants

- **Do not modify** any file outside `apps/tauri-shell/` from this slice.
- **Do not** wire auto-update (no `tauri-plugin-updater`) — out of v1 scope.
- **Do not** enable `shell.open` — it is explicitly disabled in
  `tauri.conf.json` so the webview cannot launch arbitrary URLs.
- **Do not** add Linux/Windows targets here — they will land as siblings
  (`apps/electron-shell` etc.) with their own ADRs.

## See also

- [ADR-0317](../../docs/decisions/0317-tauri-desktop-shell.md)
- [worker B] `src/apps/web-daemon/`
- [worker C] `apps/web-frontend/`
- [worker E] `native/screen-ocr/`
