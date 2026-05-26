# Handoff — Quanta Tauri shell · web-daemon · web-frontend e2e debug
**Date:** 2026-05-26
**Branch:** `main`
**Status:** ⚠️ end-to-end send-message path **does NOT work**. UI shows "● connected" + `/health sessions=N>0` but messages sent from the chat input produce no visible result (no user bubble, no LLM reply, no error). Previous agent (me) made several **incorrect protocol-shape guesses** and partially reversed them. Read "What I got wrong" below before touching anything.

---

## 1. What's already shipped on `main`

Commits landing the 4-surface scaffold (these are SOLID and verified):

| SHA | Slice |
|---|---|
| `aaf6437f` | `src/apps/web-daemon/` — Bun.serve WS daemon (ADR-0315) |
| `8781a98c` | `apps/web-frontend/` — Vite + React + Tailwind SPA (ADR-0316) |
| `156c9e09` | `apps/tauri-shell/` — Tauri 2.x macOS shell (ADR-0317) |
| `b842c7fa` | `native/screen-ocr/` — Swift ScreenCaptureKit + Vision CLI (ADR-0318) |
| `75772a1c` | Catalog YAML schema fixes for 0316/0317 |
| `e57af1f7` | `fix(multi-surface)`: 3 cross-slice contract gaps (sidecar JSON keys, hotkey event payload, App.tsx config injection) |
| `a9ff19c5` | `Load production runtime factory in web daemon` |
| `81387264`, `0a482202` | user "done" commits (SDK refactor closeouts) |

Architecture lives at:
- daemon ⟵ Bun, `src/apps/web-daemon/`
- frontend ⟵ Vite SPA, `apps/web-frontend/`
- shell ⟵ Tauri 2 Rust, `apps/tauri-shell/`
- native sidecar ⟵ Swift, `native/screen-ocr/`

---

## 2. Verified facts (real evidence, not guesses)

- Tauri `.app` builds and launches. Window shows up, **UI renders correctly**.
- `apps/tauri-shell/binaries/screen-ocr list-windows` works (CGWindowList path, no NSApplication needed).
- `apps/tauri-shell/binaries/screen-ocr capture --window-id N` **crashes** with `CGS_REQUIRE_INIT` — Swift sidecar needs `NSApplicationLoad()` for ScreenCaptureKit. Not yet fixed.
- `curl http://127.0.0.1:4096/health` → `{"status":"ok","sessions":N>0,...}` proves the daemon is up AND WebSocket upgrade succeeds at least once (sessions counter increments per connect).
- Frontend status bar shows green dot "● connected" — meaning `ws.onopen` fired.
- **End-to-end send fails silently**: typing + Enter/Send produces nothing in the chat panel (no user bubble, no error message, no daemon-side log entry).

---

## 3. What I got wrong (read carefully, do not repeat)

### Wrong claim #1 — "envelope shape mismatch payload vs command"
I told the user the wire was `{kind:"command", command: ...}` (Worker B's `SessionTransportMessage` shape) and that Worker C's `{version, kind, payload}` was wrong. **Reverse is true.** Real wire is `{version:"1", kind:"command", payload: SessionCommand}` — see `src/protocol/session/codec.ts:60` (`encodeSessionCommand`) and `src/protocol/session/codec.ts:96` (`parseEnvelope` which throws `bad_version` on missing `version`).

Worker B's `{kind, command}` shape is the **decoded internal `SessionTransportMessage` type** *after* `decodeSessionTransportMessage` runs — it never appears on the wire.

I reverted my reverse-change. Current `apps/web-frontend/src/ws/envelope.ts` should now match the **canonical** shape (encode/decode/isEventEnvelope all use `payload`).

### Wrong claim #2 — "Tauri eval-inject silent-drop"
I added a 10× retry loop around `inject_config_into_main()` in `apps/tauri-shell/src/main.rs` blaming WKWebView timing. **This is still in place** and didn't help. The real reason inject "doesn't work" is unrelated — see Wrong claim #1 above; even if config is injected, the protocol mismatch prevents any message exchange.

### Wrong claim #3 — "fixed port 4096 + no-auth bypasses the inject race"
I changed `apps/tauri-shell/src/daemon.rs` so `spawn_once()` ignores `pick_free_port()` / `mint_auth_token()` and hardcodes `port=4096, token=""`. **This is still in place.** It does make connect "work" in the sense that the frontend's hardcoded default URL hits the daemon — but it's a workaround, not a fix. Restore random-port + token once the real protocol path is wired (frontend `daemon_info` Tauri-`invoke()` pull is the right path).

### Things that ARE legitimate fixes (keep them)
- `apps/tauri-shell/src/daemon.rs` — forward parent env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `HOME`, `PATH`, etc.) to the sidecar via `.env()` builder calls. Without this, the daemon's LLM provider pick fails. Verify with `ps eww -p $(pgrep -f quanta-web-daemon)` (macOS limits env visibility; trust the code).
- `apps/tauri-shell/src/daemon.rs` — `tokio::spawn` → `tauri::async_runtime::spawn` AND `spawn_once` made sync (not `async`). Reason: `app.shell()` returns `!Send` `State<'_, Shell>`, which poisons the future across the await point. Sync `spawn_once` avoids holding it across await.
- `apps/tauri-shell/src/main.rs` — `invoke_handler` uses fully-qualified `commands::list_windows` etc. (Tauri 2's `__cmd__<name>!` macro lookup requires the path).
- `apps/web-frontend/src/components/InputBar.tsx` — Korean IME composition guard (`isComposing`/`keyCode===229`).
- `apps/web-frontend/src/ws/client.ts` — Added `#sessionId` field, `onSessionId(handler)` subscription, `encodeConnectFrame` send in `onopen`, `decodeRejectedFrame` parse in `#handleMessage` to learn server-minted sessionId. **Status: code lands but UNVERIFIED at wire level.**

---

## 4. The real bug we haven't fixed

`useSendTurn` dispatches `input.append` + `turn.run` with `sessionId` set to either:
- `learnedSessionId` if the rejected-frame discovery succeeded, OR
- `SESSION_ID_PLACEHOLDER = "ui-session"` as fallback.

Server check in `src/ipc/session/bridge.ts:handleCommand`:
```ts
if (command.sessionId !== snapshot.sessionId) {
  await rejectCommand(peer, command, new SessionProtocolValidationError("session_id_mismatch"))
  return
}
```
→ any command with the placeholder is silently rejected.

**Open question I never verified at wire level:**
1. Does the daemon actually send a `rejected` frame when frontend's first connect-frame has empty `sessionId`?
2. If yes, is its wire shape `{version:"1", kind:"rejected", sessionId, target, reason, ...}` (flat — `encodeControlEnvelope`) as the upstream codec suggests?
3. If yes, does `decodeRejectedFrame` in `apps/web-frontend/src/ws/envelope.ts` correctly extract it?
4. Does the React app then re-dispatch `connect` with the learned id and unblock subsequent commands?

I **never** captured the raw WS frames flowing between the Tauri-spawned daemon and the frontend. My direct-spawn probe (`bun run src/apps/web-daemon/index.ts` on a different port) couldn't even upgrade WS — got `1006 Failed to connect`. The Tauri-spawned daemon does upgrade (proven by sessions count), but I couldn't intercept its frames without modifying it.

There's also a **suspected race** in `src/apps/web-daemon/ws-adapter.ts` (already patched, not yet rebundled+verified): `pushMessage` was fanning out to an empty listener set if a client frame arrived before `await buildRegisteredSession()` finished registering the transport handler. I added a `pendingFrames` buffer that drains on first `addEventListener`. **Verify this fix actually merged correctly and the daemon binary was rebuilt** (`bun build --compile --outfile apps/tauri-shell/binaries/quanta-web-daemon src/apps/web-daemon/index.ts`).

---

## 5. Current uncommitted file inventory

User has substantial in-flight work that overlaps. Diff `git status` before doing anything destructive. Notable files I touched that the user **also** touched (potential merge headaches):

| File | What I touched | What user added |
|---|---|---|
| `apps/tauri-shell/src/main.rs` | inject retry-loop @150ms × 10 | `Cmd+\` hotkey auto-enable block |
| `apps/tauri-shell/src/daemon.rs` | env-forward + fixed port + sync spawn_once + Send fix | (unclear — check `Cargo.toml` too) |
| `apps/tauri-shell/Cargo.toml` | — | user changes |
| `apps/web-frontend/src/App.tsx` | `learnedSessionId` state + `onSessionId` effect | `PendingImageCapture` interface + `Cmd+\` image-capture path + `submit(text, pngBase64)` signature |
| `apps/web-frontend/src/components/InputBar.tsx` | IME guard | `pendingImage` prop + preview chip UI |
| `apps/web-frontend/src/components/ChatPanel.tsx` | — | `pendingImage` plumbing |
| `apps/web-frontend/src/ws/client.ts` | sessionId discovery infra | — |
| `apps/web-frontend/src/ws/envelope.ts` | reverted my own wrong fix; added `encodeConnectFrame` + `decodeRejectedFrame` | — |
| `apps/web-frontend/src/ws/session-hooks.ts` | (signature of `useSendTurn` may need update) | likely takes a 2nd image arg now |
| `apps/web-frontend/src/types/protocol.ts` | — | likely `InputAppendCommand.images?` field added |
| `src/apps/web-daemon/ws-adapter.ts` | pre-listener buffer | — |
| `apps/tauri-shell/binaries/quanta-web-daemon` | rebuilt several times (not in git ideally — gitignore?) | — |

Plus a lot of other unrelated edits from user's SDK work (`src/agent/*`, `src/kernel/session/*`, `src/host/runtime/*`, etc.). **Do not touch those — they're the user's parallel track.**

---

## 6. Recommended next steps for the new agent

**Step 0 — Don't trust me.** Skim `src/protocol/session/codec.ts` and `src/ipc/session/bridge.ts` yourself before believing any claim here.

**Step 1 — Get real wire visibility.** Two options:
- (a) Modify `src/apps/web-daemon/server.ts` `Bun.serve` `message`/`websocket.open` to `logger.info("rx frame", {raw})` and `logger.info("tx frame", {raw})` around `transport.send`. Tauri's `tauri-plugin-log` will route those to `~/Library/Logs/ai.quanta.desktop/Quanta.log`.
- (b) Enable WebView devtools by adding `"app.security.devtools": true` (or feature flag `devtools` on the Tauri Cargo dep) and `window.open_devtools()` in `setup`. Then `console.log` from `client.ts` is visible.

**Step 2 — With visibility, answer the 4 open questions in section 4 above.**

**Step 3 — Once you've seen the rejected-frame on the wire, verify `decodeRejectedFrame` decodes it correctly. If yes, the sessionId-learning path should work end-to-end. If no, fix the decoder.**

**Step 4 — Restore random-port + token.** Remove the hardcoded `port=4096, token=""` in `apps/tauri-shell/src/daemon.rs` `spawn_once()`. Wire frontend to pull config via Tauri `invoke('daemon_info')` instead of relying on `webview.eval()` injection. The `daemon_info` Tauri command already exists at `apps/tauri-shell/src/commands.rs:daemon_info`; React just needs to `import { invoke } from '@tauri-apps/api/core'` and call it on mount.

**Step 5 — Fix Swift `screen-ocr capture` crash.** Add `NSApplicationLoad()` at the top of `native/screen-ocr/Sources/ScreenOcr/App.swift` before any ScreenCaptureKit call. `list-windows` doesn't need this, only `capture` does.

**Step 6 — Image-attach wire.** User added the UI half (`PendingImageCapture`, preview chip, `Cmd+\` capture). Wire backend half: `useSendTurn(text, pngBase64?)` must produce an `InputAppendCommand` with `images: [{type:"image", data: pngBase64, mediaType:"image/png"}]`. The protocol-level `InputAppendCommand.images?` field already exists at `src/protocol/session/commands.ts`. Frontend `types/protocol.ts` may need a parallel `images?` addition — check the diff first.

---

## 7. Build/run recipe (current state)

Order matters; sidecars must exist before `cargo tauri build`:

```bash
# 1. Swift screen-ocr (~30s)
cd native/screen-ocr && swift build -c release
cp .build/release/screen-ocr ../../apps/tauri-shell/binaries/screen-ocr
cp .build/release/screen-ocr ../../apps/tauri-shell/binaries/screen-ocr-aarch64-apple-darwin
cd ../..

# 2. Bun daemon single binary (~1s)
bun build --compile --outfile apps/tauri-shell/binaries/quanta-web-daemon src/apps/web-daemon/index.ts
cp apps/tauri-shell/binaries/quanta-web-daemon apps/tauri-shell/binaries/quanta-web-daemon-aarch64-apple-darwin

# 3. Frontend dist (~5s)
cd apps/web-frontend && bun install && bun run build && cd ../..

# 4. Tauri .app (~1m incremental, ~5m clean)
cd apps/tauri-shell && cargo tauri build --no-bundle && cd ../..
cp apps/tauri-shell/target/release/quanta-tauri-shell apps/tauri-shell/target/release/bundle/macos/Quanta.app/Contents/MacOS/

# 5. Launch
open apps/tauri-shell/target/release/bundle/macos/Quanta.app

# 6. Tail logs in another terminal
tail -F ~/Library/Logs/ai.quanta.desktop/Quanta.log
```

Daemon /health on `http://127.0.0.1:4096/health`.

---

## 8. Hard-earned hazards

1. **`cargo tauri build` without `--no-bundle` tries to `bundle_dmg.sh` and fails** unless you have signing identity. Use `--no-bundle` during dev and copy the binary into `Quanta.app/Contents/MacOS/` manually.
2. **Tauri sidecar names with `binaries/` prefix break in production**: ACL `"name"` must be just `"screen-ocr"` / `"quanta-web-daemon"` (basename), NOT `"binaries/screen-ocr"`. `externalBin` in `tauri.conf.json` is a separate setting and DOES use `binaries/...` because it's a source path.
3. **`webview.eval()` silently drops scripts evaluated before navigation**. Tauri 2 / WKWebView edge. Pulling config via Tauri `invoke` is more reliable than push-style eval injection.
4. **Frontend `dist` is embedded into the binary at compile time** via `tauri::generate_context!()`. After every frontend `bun run build`, you must `cargo tauri build` again. The dist files do NOT show up under `.app/Contents/Resources/` — that's correct (embedded), not a bug.
5. **`pickProvider` reads `~/.quanta/auth/chatgpt.json` for OAuth** — make sure `HOME` is in the daemon's forwarded env list. Already done in `apps/tauri-shell/src/daemon.rs`.
6. **ws-adapter pre-listener race**: server.ts `open` callback's `await buildRegisteredSession(...)` may not complete before the first client frame arrives. Buffer added in `ws-adapter.ts`. If you change adapter code, preserve the `pendingFrames` drain on first `addEventListener`.

---

## 9. One-line summary

**Stack assembles and connects, but the very first WS round-trip after `connect` never completes — most likely because the rejected-frame sessionId discovery loop isn't actually firing (or its wire shape doesn't match `decodeRejectedFrame`). Get wire-level visibility FIRST, then fix.**

— previous agent
