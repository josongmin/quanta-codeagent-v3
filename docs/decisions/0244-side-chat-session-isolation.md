# ADR-0244: Side-chat session isolation (auxiliary conversation seam)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0201 (fork-session — parent/child snapshot branching; the
  sibling primitive for *branching* a checkpoint), ADR-0049 (side-conversation
  seam — out-of-band dispatch that shares the parent loop), ADR-0124
  (`ConversationCheckpointStore`).

## Context

Claude Desktop's `LocalSessions` namespace ships three IPC methods —
`startSideChat`, `sendSideChatMessage`, `stopSideChat` — that let a parent
session run a **temporary auxiliary conversation** without polluting its own
`messages[]` history. The classic use case: the user wants a quick
"what does this stack-trace mean?" turn while the main agent is mid-task;
the side chat answers, then exits; the main session continues from the
exact same context it had before, byte-identical.

quanta today has two adjacent primitives but neither covers this shape:

- **ADR-0201 fork-session** — clones a *snapshot* into a NEW
  `ConversationCheckpointStore` entry and mints a new sessionId. Useful
  for "branch this conversation and continue exploring", but the forked
  session is a peer of the parent, not a transient helper, and the loop
  is uninvolved.
- **ADR-0049 side-conversation seam** — dispatches an out-of-band
  prompt to the existing dispatcher (sharing the parent loop's
  resources). It is anonymous (no addressable id, no list, no stop),
  meant for quick prompt rewrites mid-turn.

The missing piece is the **addressable, isolated auxiliary conversation**:
a SideChat with its own id, its own message list, its own start/send/stop
lifecycle, and a HARD invariant that the parent session's `messages[]`
array is NEVER mutated by anything the side chat does. Future surfaces
(REPL `/sidechat` slash, IDE inline panel) sit cleanly on top of this
primitive.

Negative invariants we are NOT violating:

- **Parent context immutability (CORE).** No operation on a SideChatId
  reaches the parent session's `messages[]`. Deep-equal of the parent's
  snapshot before-vs-after every side-chat op is the load-bearing seal
  (HELL-SC-04 / HELL-SC-09).
- **Byte-identical default-OFF.** The slice exports a port + default-impl
  but is NOT wired into the composition root by this ADR. Sessions that
  never construct a `SideChatManager` see zero new state, zero new
  surface area.
- **Closed-port DIP.** `SideChatManager` is the port; `defaultSideChatManager`
  is the default-impl. Future test doubles satisfy the port without
  reaching into the slice internals.
- **`exactOptionalPropertyTypes: true`.** Every optional field is absent
  rather than `undefined` literal (conditional-spread on the construction
  side).
- **No loop coupling.** The slice does NOT import `@/agent/loop` /
  `@/agent/dispatch`. It is a helper primitive at the same plane as
  `fork-session/` and `conversation-checkpoint.ts`.
- **Cross-parent isolation.** A side chat started under parent A is
  invisible to `list(parentB)` (HELL-SC-07) and unreachable from any
  send / stop call that does not first look it up under the right
  parent. The Map keys this — parent id is implicit in the SideChatId
  lookup table.
- **Untouched directories.** Per the task constraint this ADR does NOT
  modify `src/agent/{conversation-checkpoint,fork-session,error-routing,
  git-directives,thread-tools,identity,stream-timeout,auto-background,
  focus-chain,dispatch-guard,stop-reason,n-phase}/`.

## Decision

Stand up a new helper slice `src/agent/side-chat/` (4 files + barrel) with
a closed-port DI seam.

```
src/agent/side-chat/
  types.ts              — SideChatId, SideChatMessage, SideChatState, SideChatError
  port.ts               — `SideChatManager { start, send, stop, list }`
  default-manager.ts    — Map-backed in-memory + parent isolation
  index.ts              — barrel
```

Public shape of `SideChatManager`:

```ts
interface SideChatManager {
  start(input: {
    readonly parentSessionId: string
    readonly prompt: string
    readonly signal?: AbortSignal
  }): Result<{ readonly id: SideChatId; readonly state: SideChatState }, SideChatError>

  send(input: {
    readonly id: SideChatId
    readonly message: string
    readonly signal?: AbortSignal
  }): Result<{ readonly reply: SideChatMessage }, SideChatError>

  stop(input: { readonly id: SideChatId }): Result<{ readonly state: SideChatState }, SideChatError>

  list(input: { readonly parentSessionId: string }): ReadonlyArray<SideChatId>

  // Internal helper — surface for tests + parent-end automatic cleanup.
  closeAllForParent(input: { readonly parentSessionId: string }): number
}
```

Semantics:

- `start(parent, prompt)` mints a SideChatId (UUID v4) under the parent
  scope, records the initial prompt as the first user-side message, and
  returns the id + `state="active"`.
- `send(id, msg)` requires the chat to be `active`; appends the user
  message and synthesises a placeholder assistant reply (the LLM wiring
  belongs to a higher layer — this slice owns only the lifecycle). The
  reply is recorded in the side-chat's own message list, NOT the parent's.
- `stop(id)` flips state to `stopped`. Subsequent `send` returns
  `Err("not-active")`. `list` continues to omit stopped chats (HELL-SC-10).
- `list(parentId)` returns ACTIVE SideChatIds owned by that parent,
  newest-first. Unknown parent ⇒ `[]` (no throw).
- `closeAllForParent(parentId)` is the parent-end hook: invoked when a
  parent session ends (HELL-SC-15), it flips every active side chat to
  stopped and returns the count of affected entries.

Errors (closed 6-arm union):

```ts
type SideChatError =
  | { code: "unknown-id"; message: string }
  | { code: "not-active"; message: string }
  | { code: "aborted"; message: string }
  | { code: "invalid-prompt"; message: string }
  | { code: "invalid-parent"; message: string }
  | { code: "capacity-exceeded"; message: string }
```

State (closed 2-arm union):

```ts
type SideChatState = "active" | "stopped"
```

The 2-arm exhaustive switch (HELL-SC-14) is sealed by an
`assertNever(state)` in the manager.

Default-OFF wiring posture:

- The slice exports the port + default-impl but does NOT register itself
  on `AgentConfig` or `buildSessionFeatures`. A future ADR adds
  `config.sideChat?: { manager: SideChatManager }` when a REPL slash
  command (`/sidechat`) consumes this primitive.
- HELL-SC-12 seals that constructing a `defaultSideChatManager` and
  never calling its methods produces no observable mutation on any
  caller-shared structure (the only state is the slice's own internal
  Map, deliberately walled off).

## Hellgate (15 cases)

`tests/unit/agent/side-chat-hellgate.test.ts`:

| id          | seal                                                                          |
|-------------|-------------------------------------------------------------------------------|
| HELL-SC-01  | `start(parent, prompt)` → `Ok({ id, state: "active" })`, id UUID v4           |
| HELL-SC-02  | `send(id, msg)` round-trips: `reply.role === "assistant"`                     |
| HELL-SC-03  | `stop(id)` → `state: "stopped"`; subsequent `send` → `Err("not-active")`      |
| HELL-SC-04  | parent context NEVER mutated (deep-equal pre/post start+send+stop)            |
| HELL-SC-05  | `list(parentId)` returns the active side-chats owned by that parent          |
| HELL-SC-06  | `send`/`stop` with unknown id → `Err("unknown-id")` (no throw)                |
| HELL-SC-07  | Cross-parent isolation: parent B's `list` excludes parent A's chats           |
| HELL-SC-08  | Nested depth=2 MVP — side chat started from a side-chat context is allowed   |
| HELL-SC-09  | `send` reply NEVER appears in parent's `messages[]`                          |
| HELL-SC-10  | After `stop`, `list(parent)` does NOT include the stopped id                  |
| HELL-SC-11  | 1000 concurrent side chats — every id only sees its own messages              |
| HELL-SC-12  | Default-OFF byte-identical: constructing the manager mutates nothing external |
| HELL-SC-13  | `AbortSignal.aborted` at call-site → `Err("aborted")`; no state mutates       |
| HELL-SC-14  | State 2-arm exhaustive (`assertNever` guarded)                                |
| HELL-SC-15  | `closeAllForParent(parent)` flips every active chat of that parent to stopped |

## Consequences

- **+ Parity** with Claude `LocalSessions.{startSideChat, …}` without
  coupling the loop or polluting the parent's history.
- **+ Composable.** Future REPL `/sidechat` slash command + IDE inline
  panel can consume this primitive directly; nested depth (HELL-SC-08)
  is MVP-supported so an in-side-chat-side-chat works.
- **+ Subagent-adjacent.** A future `subagent_with_side_context` variant
  can pass a SideChatId as the seed for a background scheduler without
  touching parent history.
- **−** One new in-memory Map per `SideChatManager` instance. Cap = 1000
  active entries (HELL-SC-11 exercises the cap surface); LRU eviction of
  STOPPED entries first, then `Err("capacity-exceeded")` on overflow.
- **−** LLM wiring is deferred — this slice owns only the lifecycle.
  The send-reply path returns a synthesised acknowledgement so the
  pipeline is fully exercisable in tests; a future ADR plugs in
  `LLMPort.complete` behind the same port shape.

## Follow-up

- `/sidechat` slash command in `src/apps/cli/repl` (separate ADR).
- LLM-backed reply: replace the synthesised acknowledgement with a
  `LLMPort.complete` call seeded with the side-chat's message list
  (the parent's `messages[]` remains untouched — same invariant).
- Persistence: today the manager is in-memory only. A `SideChatStore`
  port for durable side-chat replay would be a sibling ADR.
