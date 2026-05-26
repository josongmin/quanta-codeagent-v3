# ADR-0315 — Web daemon surface (Bun.serve + WebSocket → RuntimeSession)

- **Status**: accepted (2026-05-26)
- **Related**: [[0303-thin-surface-headless-core]], [[0309-surface-wire-r2]], [[0310-surface-composition-wire-r1]], [[surface-model]]
- **References**:
  - `src/sdk/runtime` — `createRuntime` / `RuntimeFacade` / `RuntimeSession`
  - `src/ipc/session` — `SessionTransport*` + `createSessionTransportBridge` + `wrapWebSocketLikeAsSessionTransport`
  - Bun.serve built-in WebSocket support (no `ws` npm package)

## Problem

Worker C (web frontend) and Worker D (Tauri shell) both need a single,
process-local way to drive the existing agent SDK without re-implementing
the runtime composition twice. The CLI already wires the runtime via
`createRuntime()` and dispatches via `RuntimeSession`; the wire format
exists (`@/ipc/session#SessionTransportMessage`); a WebSocket
adapter skeleton ships (`wrapWebSocketLikeAsSessionTransport`). What is
missing is a long-lived bun process that:

1. Boots once and exposes the runtime over WebSocket on a known port.
2. Lets browser/Tauri clients connect with no extra protocol layer (one
   JSON envelope per WS text frame — identical to the CLI test fixture).
3. Stays opt-in: nothing in `src/apps/cli/` or any library slice may
   change because the daemon exists.

## Decision

New slice `src/apps/web-daemon/` (6 files):

- `index.ts` — `main(overrides?)` entry. Reads env (`QUANTA_WEB_PORT` /
  `QUANTA_WEB_BIND` / `QUANTA_WEB_AUTH_TOKEN`), installs SIGINT/SIGTERM
  handlers only when run as `import.meta.main`, and delegates to
  `startWebDaemon`. The `runtimeFactory` is required and intentionally
  unset by default: the entry script throws if nobody injects one. This
  preserves the "library-first, entry-script-second" pattern from
  `src/apps/agent` and keeps Worker D / production composition decoupled
  from this slice.
- `server.ts` — `startWebDaemon(config)`:
  - `Bun.serve<WSData, never>({ fetch, websocket })` (no npm deps).
  - `GET /health` → `{status:"ok", sessions, uptime_ms}`.
  - WS upgrade on `/` or `/ws`. Auth via `Authorization: Bearer <token>`
    OR `?token=<token>` (browsers cannot set upgrade headers — the query
    path is the fallback the spec requires). Constant-time compare.
  - On `open()`, build the per-connection adapter, then construct one
    `RuntimeSession` via `runtime.createSession(config.sessionConfig)`,
    wrap the Bun WS into `SessionWebSocketLike`, create a
    `SessionTransportBridge` over that transport, and forward every
    runtime event into `bridge.publishEvents`.
  - `stop()` calls `server.stop(true)` FIRST (force-close so Bun delivers
    the close frame), then `registry.closeAll()`, then `runtime.close()`.
    Doing it in the other order hangs the macOS Bun runtime on the
    in-flight WS — verified in the test probe.
- `ws-adapter.ts` — `createBunWebSocketAdapter(ws)` returns
  `{ socket, pushMessage, handleClose }`. The `socket` field is the
  `SessionWebSocketLike` the existing IPC slice consumes verbatim.
  `pushMessage` is the server-side hook the `Bun.serve` `message`
  callback calls; `handleClose` is the server-side hook the `close`
  callback calls (it does NOT call back into `ws.close()` — avoids
  double-close).
- `session-registry.ts` — `Map<wsKey, RegisteredSession>` with `add` /
  `evict` / `closeAll`. Idempotent and no-throw on partial failure.
- `types.ts` — closed config + handle types.
- `README.md` — usage.

`package.json`: one new script `"web:daemon": "bun run src/apps/web-daemon/index.ts"`.

Wire protocol is unchanged from `@/ipc/session#codec`: each WS text frame
is one JSON-encoded `SessionTransportMessage` (`connect` / `command` /
`event` / `snapshot` / `rejected`). The daemon is structurally identical
to a CLI-attached transport bridge — Worker C / D code that already
speaks the SessionTransport wire works without modification.

Tests in `tests/unit/apps/web-daemon/`:
- `ws-adapter.test.ts` — 10 cases covering string/binary frame routing,
  UTF-8 fatal decode, double-close idempotence, server-side `handleClose`
  vs client-side `socket.close()` separation, and listener-poison
  isolation.
- `server.test.ts` — 4 end-to-end cases via real Bun WS client: connect
  handshake yields snapshot frame, wrong sessionId yields
  `rejected/session_id_mismatch`, `/health` tracks live session count
  across connect/disconnect, `handle.stop()` idempotently closes sessions
  + runtime + listener.
- `auth.test.ts` — 15 cases covering constant-time compare invariants,
  `Bearer` parsing (case-insensitive, whitespace-only rejection), header
  precedence over query, 401 on missing/wrong token, 404 on unknown path,
  health endpoint always-public (no secrets exposed there).

29 tests / 45 expectations / 0 fail.

## Alternatives considered

1. **Run a real `RuntimeFacade` in the entry script (bootstrap from CLI
   composition root)**. Rejected for now: the CLI bootstrap is heavy
   and not slice-isolated. Worker D will wire it from outside; the daemon
   stays a thin shell.
2. **Use the `ws` npm package**. Rejected: forbidden by spec ("no npm
   deps") and unnecessary — Bun ships WebSocket support in `Bun.serve`.
3. **Multi-session multiplexing per WS**. Deferred to v2. The wire
   protocol already carries `sessionId` so the multiplex story is purely
   server-side bookkeeping; v1 = one-WS-one-session is enough for
   browser/Tauri front-ends.
4. **`server.stop()` before `registry.closeAll()` order swap**. Verified
   empirically the other order hangs on macOS Bun when an in-flight WS
   exists — we tear down the adapter before the OS gets the close frame,
   leaving the stop promise waiting forever for an ack. The chosen order
   is locked by a `handle.stop()` test that times out if we regress.

## Negative invariants

- DO NOT add an npm dependency to this slice. The whole point is `Bun.serve`'s
  built-in WebSocket. A future TLS/SNI requirement should reach for Bun's
  native TLS options, not import `ws` / `socket.io` / etc.
- DO NOT modify `src/apps/cli/`, `src/sdk/`, `src/ipc/`, `src/protocol/`,
  or any other library slice for this surface. The daemon depends on
  those barrels from the outside only — if it cannot do something with
  the public API, that's a Worker D / composition-root fix, not a slice
  edit.
- DO NOT enable the daemon by default. It is opt-in via `bun run web:daemon`
  (or `main({...})` from a composition root). No CLI session boots a
  daemon as a side effect.
- DO NOT default `authToken` to a string. Unset means open (loopback only
  by default — `127.0.0.1`). The composition root is responsible for
  picking up `QUANTA_WEB_AUTH_TOKEN` or wiring a stronger gate when
  exposing on a non-loopback interface.
- DO NOT log the bearer token. The `web-daemon: listening` log records
  `auth: true|false`, never the token itself.
- DO NOT call `server.stop(true)` AFTER `registry.closeAll()` — the
  ordering is enforced by `tests/unit/apps/web-daemon/server.test.ts#handle.stop()`.

## Test plan

- `bun test tests/unit/apps/web-daemon/` — 29 pass / 0 fail.
- `bun run typecheck` — 0 new errors in the slice (pre-existing errors
  in `@/observability/coverage` are unrelated).
- `bun x biome check src/apps/web-daemon tests/unit/apps/web-daemon`
  — 0 errors / 0 warnings.
