# ADR-0406 — Composition-root observability wire

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/observability-wire/` (new: `types.ts` + `wire.ts` +
`index.ts`) + composition-root patch in `src/apps/agent/index.ts` + hellgate +
catalog row.
**Default-OFF:** Yes — `QUANTA_OBSERVABILITY !== "on"` ⇒ the wire returns a
shared frozen NOOP handle. No port instances allocated; no hook subscription;
the `objective` / `shadowVerify` `AgentConfig` slots remain OMITTED so every
downstream consumer is byte-identical to legacy (RFC §1.2).

## Context

Five sibling slices shipped over the prior waves:

- ADR-0394 (Objective port) — pure store, ZERO consumers wired at runtime.
- ADR-0395 (Run Ledger) — pure store, ZERO consumers wired at runtime.
- ADR-0396 / ADR-0400 (Shadow Verify port + real adapters) — port + adapter
  bag both exist; the `AgentConfig.shadowVerify` slot is OMITTED by the
  composition root.
- ADR-0401 (Run Ledger attribution via hook bus) — pure subscriber factory;
  no one calls `hookBus.on("post_tool_use", subscriber)`.
- ADR-0403 (Approval state machine) — port + store with optional cross-
  attribution into Objective + RunLedger; nothing wires it.

Net effect: `AgentConfig.objective === undefined`,
`AgentConfig.shadowVerify === undefined`, no `RunLedgerPort` exists in the
process, the hook subscriber is dead code. Every downstream consumer
(`buildObjectiveBlock`, `buildShadowVerifyBlock`, future surface readers
of `ledger.running()` / `ledger.waiting()`, etc.) no-ops because their
slot's existence-check fails.

That is the structural gap this ADR closes — a SINGLE composition-root
helper that:

1. instantiates the four ports once per host,
2. cross-wires them so `ApprovalStateMachine` attributes into Objective +
   RunLedger,
3. subscribes the run-ledger attribution closure to the host's hook bus,
4. returns an idempotent NO-THROW `detach()` for shutdown.

## Decision

Add a new sealed slice `@/agent/observability-wire` with a single seam:

```ts
export const wireObservability: (opts?: ObservabilityWireOpts) => ObservabilityWireHandle
```

### Inputs (`ObservabilityWireOpts`)

- `enabled?: boolean` — strict equality with `true` ⇒ wire on. Any other
  value (incl. truthy non-true like `"true"` / `1`) ⇒ NOOP handle. The
  composition root projects `process.env.QUANTA_OBSERVABILITY === "on"`.
- `repoRoot?: string` — required for `shadowVerify` only (the adapters need
  a fs anchor). Absent ⇒ `shadowVerify` left `undefined`; other three ports
  still wire.
- `now?: () => number` — forwarded to every clock-aware factory
  (`objective` / `runLedger` / `approvalStateMachine`).
- `hookBus?: ObservabilityHookBus` — DUCK-TYPED minimum surface
  (`subscribe(event, handler) → () => void`). The slice NEVER imports
  `@/agent/hooks` (`HookBus`) so the slice fence holds. The host adapts
  its bus into this shape at the composition root.

### Outputs (`ObservabilityWireHandle`)

```ts
interface ObservabilityWireHandle {
  readonly objective?: ObjectivePort
  readonly runLedger?: RunLedgerPort
  readonly approvalStateMachine?: ApprovalStateMachinePort
  readonly shadowVerify?: ShadowVerifyPort
  readonly detach: () => void
}
```

All four port slots are OPTIONAL. The composition root spreads the two
slots that exist on `AgentConfig` today (`objective` + `shadowVerify`)
conditionally; the other two (`runLedger` + `approvalStateMachine`)
ride the wire handle for future consumers (a host can stash them on a
local closure and surface them via `/status` or `ledger.waiting()`).

### Defense-in-depth (NO-THROW)

- Every port factory is wrapped in `tryConstruct(() => ...)` — a single
  factory throw degrades THAT slot to `undefined`; the other three wire.
- `setupSubscription(...)` swallows three failure modes: missing ledger,
  missing hookBus, throwing `subscribe()`. Each ⇒ noop detach. The
  remaining ports are unaffected.
- `detach()` is idempotent (captured boolean flag) + NO-THROW (the host's
  unsubscribe closure can throw without leaking).
- Default-OFF code path: shared frozen `NOOP_HANDLE`. ZERO closures
  allocated. Strict-equals on `enabled` (truthy non-true rejected).

### Slice fence

Imports allowed: `@/agent/objective`, `@/agent/run-ledger`,
`@/agent/run-ledger-attribution`, `@/agent/approval-state-machine`,
`@/agent/shadow-verify`, `@/agent/shadow-verify-adapters`. NO
`@/agent/loop`, NO `@/agent/dispatch`, NO `@/agent/prompt`, NO
`@/agent/hooks`, NO `@/agent/types`. The wire is a leaf module.

### Composition-root patch

`src/apps/agent/index.ts` adds:

1. One import block (`wireObservability`, types).
2. One helper `resolveObservabilityWire(env)` (~10 LOC) that projects the
   env knob into `enabled` + passes `process.cwd()` as `repoRoot`.
3. One invocation inside `buildBaseFromArgs`.
4. Two conditional spreads on the AgentConfig base — the existing
   `objective` and `shadowVerify` slots (Wave-2 added these; the other
   two ports live only on the wire handle).

Total diff: < 25 lines.

`hookBus` is intentionally NOT wired in this slice. AgentConfig has no
first-class HookBus seam at the surface entry; a follow-up slice can
adapt the surface's bus via the duck-typed `ObservabilityHookBus`
surface (a ~10-LOC closure). Until then, attribution is silently
skipped — but the four ports themselves are populated and observable.

## Consequences

- **+** Five sibling observability ports now have a single composition-
  root home. Operators flip ONE env knob (`QUANTA_OBSERVABILITY=on`) to
  light up Objective + ShadowVerify on `AgentConfig` plus RunLedger +
  ApprovalStateMachine on the wire handle.
- **+** Default-OFF byte-identical (RFC §1.2): legacy path is a single
  strict-equality check + a shared frozen sentinel; nothing wires,
  nothing allocates, no behaviour delta.
- **+** Factory-isolation: a single port factory throw cannot zero out
  the others (hellgate pins this).
- **+** Slice fence preserves wave-1/2 independence — the wire is the
  ONLY place that imports all five slices in one file.
- **−** Hook-bus subscription is deferred. The wire's `setupSubscription`
  is implemented + tested, but the composition root passes `hookBus =
  undefined` today. Attribution remains silently inert until a follow-
  up adapts the surface's `HookBus`. The wave-1/2 slots still populate
  so this is a strict improvement over the prior state.
- **−** The `runLedger` + `approvalStateMachine` ports live ONLY on the
  wire handle (no `AgentConfig` slot for either). A surface that wants
  them must hold the handle. The follow-up that wires the hook bus will
  also surface these (likely via `/status` or a session-meta query).

## Alternatives considered

- **Inject ports through `AgentConfig` slots for all four** — rejected:
  Wave-2 sealed `AgentConfig.types.ts` with only two slots. Adding
  `runLedger` + `approvalStateMachine` slots would mutate that file (and
  drag a Wave-3 sibling out of scope). The wire handle is the right
  carrier for those.
- **Wire each port in its own composition site** — rejected: four
  scattered invocations would each duplicate the env knob projection +
  the failure isolation + the cross-wire (ASM over Objective + Ledger).
  ONE site = one place to audit.
- **Use the real `HookBus` type directly (not duck-typed)** — rejected:
  importing `@/agent/hooks` would breach the slice fence (the wire would
  then transitively pull in the entire hook bus + structured logger + tool
  matcher graph). The duck-typed surface keeps the wire as a leaf module
  and gives the host adapter flexibility.

## Tests

`tests/unit/observability-wire-hellgate.test.ts` — 21 hellgate cases / 75
expects. Pins:

- Default-OFF: `enabled` undefined / false / non-true (string "true",
  number 1) ⇒ ALL four ports undefined + noop detach.
- Full wire: `enabled + hookBus + repoRoot` ⇒ all four ports present;
  attribution subscribed exactly once to `"post_tool_use"`; hook fire
  drives the ledger via the bash banner.
- Cross-wire: ApprovalStateMachine sees Objective + RunLedger
  (attribution writes a blocker on `request`).
- Clock forwarding: `opts.now` is honored by Objective + RunLedger +
  ApprovalStateMachine (a const clock keeps timestamps stable).
- Partial inputs: w/o `hookBus` ⇒ ports OK, no sub, no throw; w/o
  `repoRoot` ⇒ `shadowVerify === undefined`, others OK; w/o both ⇒
  3/4 ports, no sub, no throw.
- Detach contract: unsubscribes the hook; idempotent on repeat calls;
  NO-THROWs even when the host's unsubscribe closure throws.
- Double wire: two independent handles; detaching one leaves the other
  live.
- Surface guarantees: `detach` is a function on every code path; the
  subscribe event literal is `"post_tool_use"`; malformed hook payloads
  (null / string / wrong shape / wrong types) are silently dropped by
  the inner subscriber (NO-THROW + no ledger corruption).
