# ADR-0516 — `quanta attach` CLI → daemon session client

- **Status**: Proposed (2026-06-09)
- **Related**: [[0315-web-daemon-surface]], [[0303-thin-surface-headless-core]], [[surface-model]]
- **Distinct from**: ADR-0486 (PTY/tmux attach-to-existing-terminal) and
  ADR-0420 (daemon-SIDE served-WebSocket observability sink). This ADR is the
  CLI-SIDE WS *client* that joins a daemon's shared `session.v1` endpoint.
- **References**:
  - `src/ipc/session` — `SessionTransport*`, `createSessionTransportClient`,
    `wrapWebSocketLikeAsSessionTransport` (transport-only; reused verbatim).
  - `src/protocol/session` — `SessionCommand` / `SessionEvent` wire types.
  - `src/apps/web-daemon/` (ADR-0315) — the daemon this client attaches to.
  - `apps/web-frontend/src/ws/client.ts` — the browser `SessionClient` whose
    discovery→adopt dance this slice reproduces (the transport client itself
    deliberately does NOT replicate that loop).

## Problem

The legacy CLI builds an **in-process** `RuntimeSession`, so it can never see
or drive a session that a *separate* running daemon owns. ADR-0315 gave us a
`Bun.serve` daemon publishing `RuntimeSession` over WebSocket using the
`@/ipc/session` wire format, and a browser frontend that connects to it — but
there was no way to join that same shared session from a terminal.

The daemon publishes ONE shared session per WS, and a joining client does not
know the canonical session id up front. The browser solves this with a
discovery→adopt handshake; the CLI needs the same, plus terminal rendering,
stdin→command translation, and an interactive approval prompt — without
regressing the existing bare-`quanta` in-process REPL path.

## Decision

New slice `src/apps/cli/attach/` (+ the impure `src/apps/cli/attach-cmd.ts`
shell), dispatched by `src/apps/cli/index.ts` ONLY when `process.argv[2] ===
"attach"` (dynamic `import("./attach-cmd")` keeps the WS slice off the common
startup path). Default-OFF / byte-identical: a bare `quanta` run never reaches
here, so the in-process REPL is untouched.

Five files, each a single responsibility (4 of them PURE, unit-testable
without a socket):

- `handshake.ts` — PURE session.v1 discovery→adopt driver. Sends a `connect`
  frame carrying the discovery sentinel `"ui-session"` (verbatim match to the
  frontend); the bridge rejects with `target: "connect"`,
  `reason: "session_id_mismatch"`, `sessionId: <canonical>` (see
  `src/ipc/session/bridge.ts`), which the driver ADOPTS and re-handshakes to.
  A `snapshot` settles `ready`. **v1 carries no resume cursor** — there is no
  reconnect path, so tracking `resumeFromSeq` would be misleading dead code.
- `commands.ts` — PURE builders. A typed line becomes TWO commands
  (`input.append{text}` then `turn.run`), each with a DISTINCT `commandId` so
  the daemon's dedup window never collapses them (mirrors the frontend send
  shape). Blank lines yield no commands. Approval answers map
  `y`/`yes` → approve, everything else → **deny** (fail-safe).
- `render.ts` — PURE `SessionEvent` → terminal text. Returns the exact string
  (no implicit newlines, so `turn.output.delta` streams a token at a time) or
  `""` for low-signal churn events.
- `attach-client.ts` — the impure transport orchestrator. Opens the socket via
  `wrapWebSocketLikeAsSessionTransport` + `createSessionTransportClient`,
  seeds the discovery sentinel id, owns the close/error wiring the transport
  wrapper omits, serializes approval prompts, and runs the stdin read loop
  (each line waits for handshake readiness, then sends the command pair).
- `attach-cmd.ts` — the impure CLI shell: pure argv parse (`parseAttachArgs`),
  real stdin line iterator + stdout writer + interactive y/N prompt, SIGINT/
  SIGTERM → best-effort `turn.cancel` + clean close.

Token auth: `--token` / `QUANTA_WEB_AUTH_TOKEN` → appended as `?token=…`
(matches the daemon's browser-fallback query path from ADR-0315).

## Consequences

- The CLI becomes a first-class client of the daemon's shared session — the #1
  multi-surface unlock (terminal + browser can drive the SAME live session).
- A daemon-initiated close / error / `session.closed` tears the client down
  cleanly (one-line banner, resolve `done`, stop the read loop) instead of
  hanging on a dead socket or silently re-dialing.
- A send that throws after the socket dies latches `sendBroken` and surfaces
  `[disconnected from daemon (send failed)]` so a typed line is never silently
  lost.
- No reconnect/resume in v1 — a dropped connection ends the attach. Re-running
  `quanta attach` re-discovers from scratch.

## Alternatives considered

- **Reuse the browser `SessionClient` directly.** It is DOM/`WebSocket`-event
  coupled and owns rendering for the web UI; lifting it would drag web concerns
  into the CLI. We reproduce only the pure discovery→adopt decision here.
- **Teach `createSessionTransportClient` the adoption loop.** Rejected: the
  transport client is deliberately transport-only (it validates command
  `sessionId` against its own seed and nothing more). Keeping adoption in a
  pure `handshake.ts` keeps the codec untouched and the logic unit-testable.
- **Add reconnect/resume now.** Deferred: no daemon-side resume cursor is
  exercised yet; speculative `resumeFromSeq` plumbing would be dead code.

## Test plan

- `tests/unit/apps/cli/attach/attach-pure.test.ts` — handshake adoption,
  command builders, event rendering (no socket).
- `tests/unit/apps/cli/attach/attach-client.test.ts` — transport orchestration
  with an injected fake socket (close/error teardown, send-broken latch).
- `tests/unit/apps/cli/attach/attach-cmd.test.ts` — argv parse + `runAttachCmd`
  (`--help` returns 0 without opening a socket).
- `tests/unit/apps/cli/attach/attach-routing-guard.test.ts` — asserts the
  `index.ts` dispatch lazily `await import("./attach-cmd")`s.
- `tests/unit/apps/cli/attach/attach-e2e.test.ts` — full loop against an
  EPHEMERAL in-process `@/apps/web-daemon` (port 0, stub runtime — no LLM).
