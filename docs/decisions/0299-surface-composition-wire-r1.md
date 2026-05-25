# ADR-0299 — REPL surface composition wire (R1 — ADR-0291/0292/0293/0294)

## Status

Accepted — landed `src/apps/cli/repl/surface-compose.ts` (extended) +
`src/apps/cli/repl/session-loop.ts` (4 new deps) +
`src/apps/cli/repl/prompt-pipeline.ts` (textInbox drain) +
`src/apps/cli/repl.ts` (`composeSurfaceWires` call). 20 hellgate cases /
92 expects / 0 fail.

## Context

ADR-0291 (T1, 2026-05-25) added 8 new `ReplSlashCtx` ctx slots and the
adapter factories under `src/apps/cli/repl/ctx-adapters/`. ADR-0292 (T2)
added `ConvCheckpointWire` + `startConvCheckpointWire` + `/rewind-conv`.
ADR-0293 (T3) added `maybeStartPlaybookTriggerWire` + the
`PlaybookTriggerSurfaceSeam`. ADR-0294 (T4) added `/session export|import`
+ `SlashContext.sessionIo`. Each shipped its surface contract and its
slash-side hellgate, but the REPL composition root never plugged in the
upstream ports — the slash commands still printed "not wired in this
surface" end-to-end.

This decision is the wire — one slice, one ADR, four families. It is
strictly composition-root work; no T1-T4 internal file is modified.

## Decision

A new `composeSurfaceWires(setup, surfaceState, envSource)` builder in
`src/apps/cli/repl/surface-compose.ts` returns a typed `ReplSurfaceWires`
bundle that exposes:

- `slashCtx` — fully wired `ReplSlashCtx` projection.
- `convCheckpointWire` — `null` when `QUANTA_CHECKPOINT_CONV !== "on"`;
  otherwise a live wire over a shared `ConversationCheckpointStore`.
- `convStore` — the shared store backing BOTH the wire AND
  `/fork-checkpoint` adapter (ADR-0291 reuse — single store per session).
- `playbookSeam` — the `PlaybookTriggerSurfaceSeam` the loop attaches
  the handle to once it owns `ExternalPromptQueue`.
- `composerHandle` — surface-owned mutable text holder for `/edit-message`.
- `textInbox` — surface-owned `TextInbox` singleton drained by
  `PromptSource.next()`.
- `setReplaceMessages` — setter the loop calls once with its
  `surfaceState`-history swap closure (lazy-bound because the loop owns
  the `let` history).
- `dispatchSlash` — closure that routes through the FULL augmented
  `SlashContext` (legacy + ADR-0291 + ADR-0292 + ADR-0294 slots), so
  `convCheckpoint` and `sessionIo` actually reach `runSlashCommand`.

### Env knob → upstream port (ADR-0299/0291)

- `QUANTA_TOOL_PROFILE=<write|ask|minimal|code-only>` → builds
  `AgentConfig.toolProfile` block via `defaultToolProfileResolver()`.
- `QUANTA_IDENTITY_MODE=<default|plan|review|audit|architect|editor>`
  → builds `AgentConfig.identityModeVariant` via
  `defaultModeVariantRegistry()`. Shares the env var with the legacy
  ADR-0198 `pickIdentity()` — both honour the same value.
- `QUANTA_FOCUS_CHAIN_EVERY=<N>` (positive int) → builds
  `defaultFocusChainTracker({ reinjectEveryN: N })`.

Each helper logs a `logger.warn` line on garbage input and falls through
to the default-OFF "slot omitted" arm — never throws, never silently
accepts.

### Always-on adapters

`composerHandle`, `textInbox`, and `convStore` are always allocated (cheap
in-memory holders). Their ctx slots become reachable whenever the
upstream factory is wired:

- `composerEdit` slot ⇒ wired via `composerHandle`
- `textInbox` slot ⇒ wired via `textInbox`
- `forkSession` slot ⇒ wired via `convStore`

The corresponding T1 slash commands (`/edit-message`, `/web`,
`/fork-checkpoint`) move from "not wired in this surface" to live behavior
on this wire.

### Conv-checkpoint turn-end auto-record (ADR-0292)

`session-loop.ts` now calls `convCheckpointWire?.recordTurn(messages)` in
two spots:

- one-shot path's `onAfterResult` (post-state-update)
- interactive path's `onTurnEnd` (post-state-update)

Both are wrapped in a `recordTurnSnapshot()` helper that no-ops when the
wire is `null` (default-OFF byte-identical) and catches any store throw.

The same wire's `replaceMessages` (built into `convCheckpointSlot`) is
mutated through `setReplaceMessages` once the loop has the
`SessionState` `let` in scope. Before the loop installs it, the closure
is a no-op stub — `/rewind-conv` still resolves against the store but the
surface transcript stays stale until the loop is reached. The closure is
wrapped in try/catch + `logger.warn` (no-throw).

### Playbook trigger lifecycle (ADR-0293)

`session-loop.ts` builds a `PlaybookPlanQueueSink` around
`externalPromptQueue.push(text)` and calls
`maybeStartPlaybookTriggerWire({ env: process.env, threadId,
planQueueSink, cliFlag? })`. The helper itself implements the
env-wins-over-flag precedence + the NOOP-handle short-circuit, so the
loop ALWAYS calls it but only an opt-in actually constructs a watcher.

The returned handle is attached to `playbookSeam`; the loop's `finally`
block calls `playbookSeam.detach()` so the watcher is always stopped
on abnormal shutdown.

### Session-IO adapter (ADR-0294)

`buildDefaultSessionIo()` constructs a `SessionIoState` adapter that
delegates to `loadSessionById` / `saveSessionById` (id-addressable V2
session store) plus `crypto.randomUUID()` for `mintNewId()`. Read failures
surface as `null` + `logger.warn`. Write failures rethrow — the slash
catches them and surfaces as exit 1 + `ctx.err` per the existing
`/session` contract.

### Text-inbox drain (ADR-0291 follow-through)

`prompt-pipeline.ts.localPayload` now optionally drains a `TextInbox` on
every accepted local prompt and prepends the rendered preamble to the
user's literal text. Default-OFF: when the inbox slot is absent the call
chain is byte-identical to pre-wire code (no drain, no preamble).

## Consequences

- 8 slash commands move from "not wired in this surface" to live
  behavior the moment the operator's env / CLI flag opt-in is set.
- `/rewind-conv` becomes a complete loop with turn-end auto-record + the
  surface-side history swap.
- The playbook trigger watcher lifecycle is bound to the session lifetime
  end-to-end (start at loop init, stop in `finally`).
- `/session export|import` round-trips against the V2 store with no
  storage API change.

Default-OFF byte-identical (RFC §1.2) is enforced on every path: when
all four env / CLI gates are absent, the projection key-set is byte-
identical to the pre-wire baseline (see `HELL-WIRE-15`).

## Negative invariants

- The wire MUST NOT touch `src/agent/types.ts` (Track A is fixing the
  duplicate `searchPipeline` slot there).
- The wire MUST NOT modify T1-T4 internal files (`slash-surface.ts`,
  `conv-checkpoint-wire.ts`, `playbook-trigger-{wire,surface-seam}.ts`,
  `session-cmd.ts`). It only calls their factories.
- The wire MUST NOT introduce a default `process.env` parameter in any
  function (the `no-process-env-outside-config` scanner rejects it). The
  CLI entry point (`runRepl`) is the single touchpoint that passes
  `process.env` into `composeSurfaceWires`.

## Held for follow-up

- Per-tool checkpoint registry has no upstream source yet — the slot
  stays omitted (the T1 adapter's "not-yet-wired" stub is still the path
  the slash would hit if the registry were partially wired).
- CLI flag echo (`agentArgs.playbookTrigger`) → the env knob is the only
  active gate today; threading the boolean through `setup` is a one-line
  follow-up once `bootstrapSession` carries it.
- Composition-root re-build of system prompt when `/identity` mutates
  the active mode — the adapter is surface-state today; mid-session
  prompt rebuild is a separate ADR.
