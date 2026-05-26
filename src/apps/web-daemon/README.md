# `src/apps/web-daemon` — local agent surface over WebSocket

Default-OFF Bun process that publishes the existing agent SDK
(`@/sdk/runtime`) over a WebSocket. The Tauri shell and the web frontend
both connect to the same wire format (`@/ipc/session`'s
`SessionTransportMessage`).

## Run

```bash
bun run web:daemon
# or
bun run src/apps/web-daemon/index.ts
```

Defaults: `127.0.0.1:4096`, no auth. Override:

```bash
QUANTA_WEB_PORT=4196 \
QUANTA_WEB_BIND=127.0.0.1 \
QUANTA_WEB_AUTH_TOKEN=dev-only \
bun run web:daemon
```

> The entry script requires a composition root to inject a `runtimeFactory`
> via `main({ runtimeFactory })`. Running `bun run` with no override exits
> non-zero (fail-loud) — the production CLI bootstrap wiring lives in a
> follow-up.

## Wire protocol

Endpoint: `ws://<bind>:<port>/` (or `/ws`). Each WebSocket text frame is
one JSON-encoded `SessionTransportMessage` (`@/ipc/session#codec`).

Handshake:

1. Client connects.
2. Client sends `{ kind: "connect", sessionId, resumeFromSeq? }`.
   - `sessionId` MUST equal the value the daemon assigned at session
     creation. (For v1 the daemon discovers this from the first inbound
     `connect` frame and forwards it back as a snapshot.)
3. Daemon replies with `{ kind: "snapshot", snapshot }` and (optionally)
   any tail `{ kind: "event", event }` frames.
4. Client sends commands as `{ kind: "command", command }`. Each command
   carries its own `sessionId` / `commandId` / `expectedRevision`.
5. Daemon streams `{ kind: "event", event }` frames as the agent executes.

## Health

```bash
curl http://127.0.0.1:4096/health
# {"status":"ok","sessions":0,"uptime_ms":12345}
```

## Auth

When `QUANTA_WEB_AUTH_TOKEN` is set, every upgrade request must carry
either:

- `Authorization: Bearer <token>` header (Node / native clients), or
- `?token=<token>` query string (browser `WebSocket` constructor cannot
  set custom upgrade headers).

Constant-time compare. Missing / wrong token returns HTTP `401`.

## Hard rules

- No npm dependencies — uses `Bun.serve` built-in WebSocket support.
- One `RuntimeSession` per WS connection (multiplexing later).
- Graceful shutdown: SIGINT / SIGTERM closes every session, then stops
  the listener (drains in-flight HTTP, then exits 0).
- CLI surface (`src/apps/cli/`) is unchanged.

ADR: [`docs/decisions/0315-web-daemon-surface.md`](../../../docs/decisions/0315-web-daemon-surface.md).
