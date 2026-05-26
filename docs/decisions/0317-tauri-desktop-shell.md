# ADR-0317 — Tauri desktop shell (macOS v1)

- **Status**: accepted (2026-05-26) — scaffold + sidecar wiring landed; production signing/notarization deferred
- **Related**: [[0303-thin-surface-headless-core]] (multi-surface posture this shell consumes), [[0309-surface-wire-r2]] (web-frontend ↔ web-daemon contract), [[0311-github-actions-trigger-adapter]] (sibling Tier-0 surface), [[surface-model]] (multi-surface ROI rule)
- **References**:
  - Tauri 2.x ([tauri.app/v1/docs](https://v2.tauri.app/)) capability ACL + sidecar bundling
  - Apple ScreenCaptureKit TCC consent model (`NSScreenCaptureUsageDescription`)
  - Codex Desktop build 2867 (Skybridge microVM separates concerns analogously; we keep it simpler at v1 — see `codex-desktop-build-2867-round-2`)

## Problem

The multi-surface roadmap (see `surface-model` memory) calls for a desktop surface alongside CLI, IDE/daemon, and CI/webhook. On macOS specifically, the desktop surface unlocks two capabilities the browser tab cannot give us:

1. A **global hotkey** — capture-anywhere → push into the agent's working context without window-switching cost.
2. **System-level screen capture + OCR** — drive the React app from the content of an arbitrary window (e.g. paste a stack trace from a terminal in a different desktop).

These need a real native shell. We do not want to ship Electron (60+MB runtime; Chromium auto-update + signing complexity exceeds v1 budget) and we do not want to write a full AppKit app (surface area too wide; React app + IPC bridge would have to be rebuilt).

## Decision

Ship `apps/tauri-shell/` — a Tauri 2.x desktop app, **macOS-only for v1**, that:

1. **Wraps the existing web-frontend SPA** (`apps/web-frontend/dist`, worker C) — `tauri.conf.json` `frontendDist` points there; no webview-side rewrite needed.
2. **Spawns the bun web-daemon as a sidecar** (worker B's `src/apps/web-daemon/index.ts`, pre-compiled with `bun build --compile` into `binaries/quanta-web-daemon`). Random free port + 256-bit hex auth token at boot; both surfaced to the React app via `window.__QUANTA_CONFIG__ = { wsUrl, httpUrl, authToken }` injected at webview boot.
3. **Drives the Swift `screen-ocr` sidecar on demand** (worker E's `native/screen-ocr/`, copied to `binaries/screen-ocr`). Two `#[tauri::command]` entry points: `list_windows`, `capture_window`.
4. **Registers `Cmd+Shift+Q` as a global hotkey** — **OFF by default**. The frontend must explicitly call `enable_hotkey`. On trigger the pipeline is `list_windows → pick (last-selected | frontmost non-Quanta) → capture_window → emit 'quanta:hotkey-capture'`.
5. **Capability ACL is default-DENY.** `capabilities/default.json` grants only: global-shortcut register/unregister, process control, log, and a narrow `shell:allow-execute` allowlist containing exactly the two sidecar names with argument-shape validators. `shell.open` is explicitly disabled in the conf.

Crate structure mirrors the existing `crates/darwin-vz-helper/` posture but lives at `apps/tauri-shell/` (not `crates/`) because it is a binary application, not a napi-rs library. It is intentionally **not** a member of the root Cargo workspace at `crates/Cargo.toml` (Tauri's transitive dep tree is large; coupling sandbox-helper `cargo check` to it would slow every unrelated build).

Files:
- [[../../apps/tauri-shell/Cargo.toml]] — Tauri 2.x + plugins (`global-shortcut`, `shell`, `process`, `log`)
- [[../../apps/tauri-shell/tauri.conf.json]] — bundle + security config (CSP, externalBin allowlist, macOS entitlements path)
- [[../../apps/tauri-shell/capabilities/default.json]] — Tauri 2 ACL (default-DENY, narrow sidecar allowlist)
- [[../../apps/tauri-shell/entitlements.plist]] — dev profile (app-sandbox=false; JIT=false; library-validation disabled)
- [[../../apps/tauri-shell/src/main.rs]] — Builder + plugin install + daemon autostart + `__QUANTA_CONFIG__` injection
- [[../../apps/tauri-shell/src/daemon.rs]] — supervisor (free-port pick, token mint, exponential restart backoff)
- [[../../apps/tauri-shell/src/ocr.rs]] — Swift sidecar driver + `pick_window` selection heuristic
- [[../../apps/tauri-shell/src/hotkey.rs]] — opt-in global shortcut + capture pipeline + event emit
- [[../../apps/tauri-shell/src/commands.rs]] — nine `#[tauri::command]` exports
- [[../../apps/tauri-shell/src/error.rs]] — `AppError` enum + hand-written `Serialize` (`{ code, message }`)

## Alternatives considered

- **Electron** — rejected. ~80MB runtime, separate auto-update story, Chromium security cadence we'd have to track. No upside over Tauri once the React app is the only frontend.
- **Native AppKit app** — rejected. Forces a second UI codebase (Swift / AppKit), duplicates the slash command + transcript surface, doubles the maintenance footprint. The hotkey + OCR primitives we need can sit behind a thin Rust shell.
- **PWA install** — rejected. No global hotkey API, no ScreenCaptureKit access, no sidecar process.
- **Existing `tauri-plugin-updater`** — deferred. Auto-update is an attack surface we do not want on a v1 unsigned build; signed updates require Apple Developer ID + notarization pipeline (not in v1 scope).

## Security model

- **TCC-gated screen capture.** `Info.plist` (merged from `tauri.conf.json`) ships `NSScreenCaptureUsageDescription`. macOS prompts the user at first capture; consent is per-app, persisted by the OS. We do not bypass.
- **Sandbox OFF for dev.** `entitlements.plist` sets `com.apple.security.app-sandbox = false` so unsigned local builds (developer iteration + first-cut users) work without code signing. A follow-up ADR will tighten this once we have Developer ID + notarization.
- **Allowlisted sidecars only.** `shell:allow-execute` in `capabilities/default.json` names exactly `binaries/quanta-web-daemon` and `binaries/screen-ocr`, with argument-shape validators on `screen-ocr` (the `--window-id` value must match `^[0-9]{1,10}$`).
- **No `shell.open`.** Explicitly disabled in `tauri.conf.json` — the webview cannot launch arbitrary URLs / files via the shell plugin.
- **CSP.** `connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* ipc: http://ipc.localhost` — the webview can talk to the local daemon and the Tauri IPC bridge, nothing else.
- **No unsafe.** `#![deny(unsafe_code)]` on both `lib.rs` and `main.rs`. The "SIGTERM → wait 2s → SIGKILL" graceful-shutdown ladder is intentionally truncated at SIGTERM in this scaffold because `libc::kill` would require `unsafe`; the supervisor's restart-counter surfaces wedged children to the operator via `daemon_status.restart_count`. A future ADR can add a tiny `nix`-wrapper crate to restore SIGKILL escalation without breaking the no-unsafe invariant in this slice.
- **Per-process auth token.** 256-bit hex token minted at every daemon boot, scoped to one local port, never persisted to disk. Compromise of one app instance does not leak across sessions.

## Test plan

- **Compile-correct review** — slice is reviewed for `cargo check` compatibility (network-blocked agent cannot run cargo); upstream user runs `cargo tauri build` per `README.md`. Failures land as a follow-up patch.
- **Manual smoke** (operator):
  1. Build the three sidecar artifacts (worker B compile, worker E swift build, worker C vite build).
  2. `cargo tauri build` from `apps/tauri-shell/`.
  3. Launch `Quanta.app`. Confirm: window opens, React app renders, `window.__QUANTA_CONFIG__` populated, WS connects to the per-app daemon port.
  4. Call `await __TAURI__.invoke('enable_hotkey')` from the devtools console. Press `Cmd+Shift+Q`. Confirm: `quanta:hotkey-capture` event arrives with non-empty `text`.
- **Future: tauri-driver e2e** — a follow-up ADR will wire `tauri-driver` for headless integration tests in CI.

## Negative invariants

- **macOS only for v1.** No Windows / Linux bundles. Adding either is a fresh ADR (the entitlements + capability model is OS-specific).
- **No auto-update v1.** `tauri-plugin-updater` is intentionally not in `Cargo.toml`. Adding it requires signing + notarization first.
- **Hotkey is OFF by default.** `enable_hotkey` must be invoked explicitly. The accelerator MUST NOT be registered from `setup`.
- **No main-repo mutation.** This slice MUST NOT modify any source under `src/`, `apps/web-frontend/`, `native/`, `crates/`, root `Cargo.toml`, or root `package.json`. The shell consumes worker B/C/E artifacts at build time via `binaries/` drop-in — they remain in their own slices.
- **No `shell.open`.** Re-enabling it removes the URL-launch guarantee documented in the security model.
- **No `unsafe`.** Adding `unsafe` to the supervisor (e.g. for SIGKILL via `libc`) requires a new ADR that justifies the carve-out.
- **No bundled hardcoded ports.** The free-port pick + token mint is the load-bearing isolation between concurrent app instances; removing either is a regression.
