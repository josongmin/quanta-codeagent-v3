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

Defaults: `127.0.0.1:4096`, no auth. This keeps the daemon local to the
machine unless LAN exposure is explicitly requested. Bind a wildcard with a
non-empty bearer token to let phones or other LAN devices connect:

```bash
QUANTA_WEB_PORT=4196 \
QUANTA_WEB_BIND=0.0.0.0 \
QUANTA_WEB_AUTH_TOKEN=dev-only \
bun run web:daemon
```

An unauthenticated IPv4 or IPv6 wildcard bind fails startup unless the operator
sets the exact acknowledgement below. This keeps unauthenticated LAN use
possible, but makes the exposure deliberate:

```bash
QUANTA_WEB_BIND=0.0.0.0 \
QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD=1 \
bun run web:daemon
```

Values such as `true`, `on`, an empty token, or whitespace-only token do not
satisfy the acknowledgement/auth requirement.

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

`QUANTA_WEB_BIND=0.0.0.0` or `QUANTA_WEB_BIND=::` additionally requires a
non-empty `QUANTA_WEB_AUTH_TOKEN`, unless
`QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD=1` explicitly acknowledges the
unauthenticated network exposure. The default bind is loopback.

## Hard rules

- No npm dependencies — uses `Bun.serve` built-in WebSocket support.
- One `RuntimeSession` per WS connection (multiplexing later).
- Graceful shutdown: SIGINT / SIGTERM closes every session, then stops
  the listener (drains in-flight HTTP, then exits 0).
- CLI surface (`src/apps/cli/`) is unchanged.

ADR: [`docs/decisions/0315-web-daemon-surface.md`](../../../docs/decisions/0315-web-daemon-surface.md).
