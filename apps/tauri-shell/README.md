# `apps/tauri-shell` — quanta desktop shell

macOS-only Tauri 2.x desktop wrapper for quanta (ADR-0317).

## What it does

- Wraps the web frontend built by `apps/web-frontend/` (see [worker C]).
- Spawns the bun-compiled `quanta-web-daemon` (`src/apps/web-daemon/`) as a
  Tauri sidecar, picks a free local port, mints a 256-bit auth token, and
  exposes that tuple to the webview via the Tauri `daemon_info` command.
  Best-effort `window.__QUANTA_CONFIG__` injection remains only as a
  compatibility fallback.
- Spawns the Swift `screen-ocr` sidecar (`native/screen-ocr/`) on demand:
  `list_windows` enumerates capturable windows, `capture_window` runs OCR.
- Auto-registers a global hotkey (`Cmd+\` default). On trigger, captures
  the frontmost non-Quanta window and emits `quanta:hotkey-image-capture`.

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
| `enable_hotkey`  | `void`                 | Idempotent re-enable                      |
| `disable_hotkey` | `void`                 | Idempotent                                |
| `hotkey_status`  | `boolean`              | Whether the accelerator is registered     |

All commands return `Result<T, AppError>`. `AppError` serialises as
`{ code: string, message: string }`.

## Build recipe

```sh
# 0. Prereqs (one-time)
#    - Rust toolchain (stable, 2021 edition)
#    - Bun (https://bun.sh)
#    - Xcode CLT (`xcode-select --install`)
#    - Tauri 2 CLI (`cargo install tauri-cli --version '^2'`)
#    - just (`brew install just`)
#
# `just build` = `cargo tauri build` + `scripts/sign-bundle.sh`. The sign
# step is mandatory: Tauri's bundler leaves Rust's linker-signed random
# identifier on the shell and the sidecars as `screen-ocr` / `a.out`, so
# without it every release prompts again for ScreenCapture / Accessibility
# (TCC keys grants by code-signature ID).
cd apps/tauri-shell && just build
# Output: target/release/bundle/{app,dmg}/Quanta.{app,dmg}

# Other recipes:
#   just install    # build + copy to /Applications + re-sign in place
#   just sign PATH  # re-sign an existing .app (defaults to the release one)
#   just tcc-reset  # clear stale ScreenCapture/Accessibility grants
#   just dev        # cargo tauri dev (no sign step)
```

For a release binary without DMG packaging:

```sh
cd apps/tauri-shell && just build-nobundle
```

For dev iteration on the React app:

```sh
cd apps/web-frontend && bun run dev   # vite at http://localhost:5173
cd apps/tauri-shell && just dev       # loads devUrl from tauri.conf.json
```

## Security model (TL;DR)

- **Default-DENY capabilities.** See `capabilities/default.json`. The only
  shell-executable surface is the two sidecars by name; argument shapes are
  validated by the ACL.
- **App sandbox = OFF** for the dev profile (unsigned builds). TCC consent
  is requested at first screen-capture invocation (handled by
  ScreenCaptureKit on the Swift side). `entitlements.plist` lives in this
  directory and is referenced from `tauri.conf.json`.
- **Hotkey is ON by default.** Registration happens during app boot. The
  `disable_hotkey` command remains available if the user wants it off.
- **Auth token is per-process random.** A 256-bit hex token is minted at
  daemon boot and served to the frontend over the Tauri `daemon_info`
  command. There is no on-disk credential.

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
