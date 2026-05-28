# ADR-0408 — Observability UI pane (Running / Waiting / Completed + Objective + Approvals)

**Status:** Accepted (2026-05-28)
**Slices:**
- `src/protocol/observability/` (NEW — types + codec + barrel)
- `src/apps/web-daemon/observability-emitter.ts` (NEW — daemon-side
  poller/emitter)
- `apps/web-frontend/src/ws/observability-hooks.ts` (NEW — React reducer +
  hook over the WS channel)
- `apps/web-frontend/src/components/ObservabilityPane.tsx` (NEW — the pane)
- `apps/web-frontend/src/types/protocol.ts` (additive — re-exports message
  types + structural mirrors of `RunEntry` / `Objective` / `ApprovalRequest`)
- `src/apps/web-daemon/index.ts` (env knob `QUANTA_OBSERVABILITY=on` wires the
  emitter scaffold)
- `apps/web-frontend/src/App.tsx` (mounts `<ObservabilityPane>` alongside
  `<ChatPanel>`)

**Default-OFF:** Yes. The emitter only ticks when `QUANTA_OBSERVABILITY=on`
AND ports are injected by the composition root. The frontend pane renders
empty placeholders when no `observability.*` frames arrive — no behaviour
change on the byte-identical happy path.

## Context

Wave-1 / Wave-2 introduced the three closed ports that model long-running
agent work and human-in-the-loop pauses:

- **`RunLedgerPort`** (ADR-0395) — unified `running` / `waiting` /
  `completed` / `failed` / `stopped` records across shell-detached,
  subagent-background, MCP-task, and one-shot exec work.
- **`ObjectivePort`** (ADR-0394) — per-thread Objective (goal / success
  criteria / blockers / nextActions / budget).
- **`ApprovalStateMachinePort`** (ADR-0403) — first-class typed pauses
  (`permission` / `clarification` / `escalation`) attributed to both the
  Objective's blockers and the Run Ledger's waiting set.

Together these three state machines answer the operator's three core
questions during a long agent turn: *what is in flight? what is waiting on
me? what is the agent actually trying to do?* But none of that state is
visible in the chat — the chat is a serial event stream, and the operator
has to infer status from scrollback. That is the structural gap this ADR
closes.

User explicit: *"UI는 채팅과 별도여야 합니다. 하단 또는 우측에 Running /
Waiting / Completed pane. 클릭하면 로그, stdout, child summary, retry 버튼.
이게 Codex/Claude의 체감 차이를 만드는 핵심."*

## Decision

Render the three Wave-1/2 state machines in a **separate pane** alongside the
chat, fed by a new pair of WS messages on the existing transport.

### Protocol

Two closed messages over the existing daemon WebSocket:

```ts
observability.snapshot  // full state push (initial / reconnect)
  { runs, objective, approvals, emittedAt }

observability.delta     // incremental updates
  { runChanges?, objectiveChanged?, approvalChanges?, emittedAt }
```

Slice fence: `src/protocol/observability/` imports TYPES ONLY from
`@/agent/run-ledger`, `@/agent/objective`, `@/agent/approval-state-machine`.
The wire envelope mirrors the session-protocol shape
(`{ version, kind: "observability", payload }`) so any transport that already
routes session frames can route observability frames with a one-line dispatch
addition.

`runChanges[].entry === null` ⇒ remove that id from the pane (LRU eviction).
Same null-arm semantics for `approvalChanges[].approval`. `objectiveChanged ===
null` ⇒ the active objective went away; `objectiveChanged === undefined` ⇒ no
change. This distinguishes *"no change"* from *"removed"* without an extra
opcode.

### Emitter

`createObservabilityEmitter({ objective?, runLedger?, approvalSM?, ws,
intervalMs? })` polls the three ports on a 250ms cadence, diffs against the
last sent state, and emits:

- **First tick** (or after `requestSnapshot()`) — full `observability.snapshot`.
- **Subsequent ticks** — `observability.delta` carrying only the axes that
  differ.
- **No diff** — no message emitted (coalesced).

Structural equality via `JSON.stringify` (the stores return freshly frozen
copies on every read, so reference equality would flood the wire). Hostile
ports (throwing on `list` / `get` / `pending`) are caught — the offending
axis is skipped this tick, the previous captured value is retained, and the
emitter survives. A throwing `ws.send` is similarly caught; subsequent ticks
do NOT retry. All-undefined ports ⇒ the emitter is a no-op.

### Frontend

`useObservabilityState(source)` runs a small reducer over the snapshot/delta
stream and returns `{ runs, objective, approvals, lastEmittedAt }`. The pane
component (`ObservabilityPane`) renders:

- An **Objective card** — goal + status badge + blockers (with `waitingOn`
  marker) + nextActions list.
- A **Pending Approvals** list — amber-tinted card per pending approval with
  `reason` / `proposedAction` (code-formatted) / `resumeStep`.
- Three **run columns** (Running / Waiting / Completed) — each row collapses
  by default; click expands to show `id` / `waitingOn` / `resumeAction` /
  artifacts / `error`. A "Retry" button appears on settled rows when the host
  supplies `onRetryRun`.

The frontend NEVER imports `@/agent/*` runtime — it consumes the message
shapes structurally via `apps/web-frontend/src/types/protocol.ts` re-exports.
With no `observability.*` frames received, the pane renders empty
placeholders so the env-OFF path stays byte-identical.

### Wiring

`src/apps/web-daemon/index.ts` initialises the emitter scaffold when
`QUANTA_OBSERVABILITY=on`. Live wire-up of the three ports through
`runtimeFactory` is a follow-up — the composition root currently does not
expose them via the public `RuntimeFacade`. The scaffold lets the env knob
ship today without modifying `src/agent/*` (which is out of scope for this
ADR).

The frontend mounts `<ObservabilityPane>` to the right of `<ChatPanel>` and
passes `null` as the event source for now. When the daemon-side composition
work lands, the source becomes a small adapter over `SessionClient` that
filters `observability.*` frames out of the wildcard handler.

## Hellgate

Two new hellgates:

- `tests/unit/observability-protocol-hellgate.test.ts` — 24 cases / 47
  expects pinning the shape guard, the encoder, and the wire envelope
  round-trip (extra-fields forward-compat, missing version / kind / payload
  rejected, NaN emittedAt rejected, etc.).
- `tests/unit/observability-emitter-hellgate.test.ts` — 21 cases / 41
  expects across six sections: disabled path, snapshot semantics,
  delta diffing (add / mutate / remove on all 3 axes), coalescing, hostile
  ports (throwing `list` / `get` / `pending` / `send`), and wire round-trip
  via the decoder.

Total 45 hellgate cases / 88 expects / 0 fail.

## Negative invariants

- **NOT** a tool surface. The pane reads from existing ports; it does not
  mint new LLM tools. The agent never knows the pane exists.
- **NOT** a polling-from-the-frontend surface. The diff lives in the daemon;
  the frontend just applies a snapshot/delta reducer. Re-deriving the diff
  in N tabs would burn CPU AND drift across tabs.
- **NOT** wired into `src/agent/*`. Every modification stays in the protocol
  slice, the daemon slice, the frontend, and the new files. The chat, the
  Objective store, the RunLedger store, the Approval state machine, the
  loop, dispatch, prompt, features, types — all unchanged.
- **NOT** a transcript replacement. The chat keeps the serial transcript;
  the pane keeps the *state*. Each surface owns exactly one concern.

## Consequences

- **+** Single glance answers "what's running, what's waiting, what's the
  goal" — the Codex/Claude experience differentiator the user called out.
- **+** Default-OFF & byte-identical: the env knob OR the empty-source path
  makes the entire feature non-fatal. Existing chat is unchanged.
- **+** Closed wire shape + forward-compat decoder: future axes (cost
  ticker, sub-thread tree) can land without a protocol version bump.
- **−** Live wiring of the three ports through `runtimeFactory` is a
  follow-up. Today the scaffold is connected but the ports are not exposed
  by `RuntimeFacade`; the emitter starts but tick-emits nothing useful.
  Acceptable trade-off: the alternative (modifying `src/agent/*` /
  `src/sdk/runtime`) is explicitly out of scope per the ADR's hard-fence.

## Smoke verification (manual)

1. `bun run dev` the frontend; the pane appears to the right of the chat
   with three empty placeholder columns + an empty Objective / Approvals
   card. No frames received ⇒ everything reads "Empty." — no crash.
2. With `QUANTA_OBSERVABILITY=on` set, the daemon logs
   `web-daemon: observability emitter scaffold ready` to stderr.
3. Snapshot/delta round-trip is exercised by the protocol hellgate via
   `encodeObservabilityFrame` ⇄ `decodeObservabilityFrame`.

Browser-side reducer behaviour is intentionally not TDD'd in this wave —
UI dynamics live behind the wire and are exercised E2E in a follow-up.
