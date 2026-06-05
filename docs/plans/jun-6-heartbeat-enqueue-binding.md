# RFC: H8 last-mile — heartbeat enqueue → thread-resume + posture binding

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADR: 0480 (heartbeat-thread-binding) — completes H8 (the scheduler core is ADR-0161 + the H8 kind extension).
> Predecessor: the H8 automation core (`src/scheduler/heartbeat.ts`, `src/scheduler/types.ts`) — **LANDED**.

---

## 1. 요약 (Summary)

H8 added a `heartbeat` automation kind: a repeating agent that keeps working **ONE
conversation thread** under that thread's inherited posture, vs a `cron` automation that
fires a fresh thread-detached prompt. The **core is live**: the kind type
(`AutomationKind = "cron" | "heartbeat"`, `src/scheduler/types.ts:126`), the creation-boundary
invariants (`validateHeartbeatCandidate` — must carry `targetThreadId` + `inheritedPolicy`,
≤1 active heartbeat per thread, `src/scheduler/heartbeat.ts:45-61`), the posture snapshot type
(`HeartbeatPolicySnapshot { approvalPolicy, sandboxPolicy, collaborationMode }`,
`types.ts:138-142`), the JSONL round-trip (`src/scheduler/store-jsonl.ts:202-220`), and the
runtime fire path that **passes** `{ targetThreadId, inheritedPolicy }` into
`AgentLoopPort.enqueueUserMessage` (`src/scheduler/runtime.ts:243-256`) are all done.

**The GAP (last-mile):** the runtime correctly *forwards* the heartbeat routing, but **no
host `AgentLoopPort` implementation actually binds it.** The CLI's `enqueueUserMessage`
(`src/apps/cli/repl/session-loop.ts:322-326`) does `externalPromptQueue.push(message)` — it
**ignores the second `opts` argument entirely**, so `targetThreadId` and `inheritedPolicy`
are dropped on the floor. A heartbeat fire therefore degrades to a plain prompt pushed onto
the *current* session's queue: no resume of the *target* thread, no re-application of the
inherited permission/collaboration posture. The unified-agent host's `enqueueUserMessage`
(`agent-arg-builder.ts:1001`) is an even more explicit stub that `logger.warn`s and does
nothing.

This RFC designs the **host enqueue → thread-resume + posture binding**: an `AgentLoopPort`
implementation that, when `targetThreadId` is present, (1) resolves/loads the target thread,
(2) re-applies the `inheritedPolicy` (permission mode + sandbox + collaboration mode) for
the resumed turn, and (3) enqueues the prompt onto **that** thread — while the `cron` path
(`opts` without `targetThreadId`) stays byte-identical to today.

---

## 2. 경쟁사 레퍼런스 (Competitor reference — verified)

### 2.1 Codex (codex-rs 0.135) — heartbeat resumes a thread under a fixed posture

The H8 core was absorbed FROM Codex's automation model (the `cron` vs heartbeat split,
`types.ts:117-126` doc cites Codex `automation-schedule-BpeIuMts.js`). Codex's heartbeat
fire **resumes the original thread** (`thread_id` on the turn envelope) rather than starting
a fresh conversation, and the resumed turn carries the thread's **approval_policy /
sandbox_policy** verbatim (from the session JSONL `turn_context` —
`codex-session-jsonl-envelope` memory: `turn_context` 17 fields incl. approval/sandbox). The
"keep working THIS thread under the SAME approval stance" semantics are the whole point of a
heartbeat — which is exactly the binding quanta is missing.

### 2.2 quanta's own reactor `manual_resume` — the in-repo precedent

`src/reactor/self-wake.ts:146` calls the **same** `AgentLoopPort.enqueueUserMessage(message,
{ signal })` seam (`types.ts:219` doc: *"The scheduler calls this exactly the same way
reactor's `manual_resume` does"*). The reactor proved the enqueue seam; the scheduler reuses
it. What neither yet exercises is the *thread-targeted + posture-carrying* variant of that
enqueue — this RFC adds it without inventing a new seam (the `opts` fields already exist on
the port signature, `types.ts:219-231`).

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 The H8 core is **LANDED** end-to-end EXCEPT the host bind

- Kind + posture types — `src/scheduler/types.ts:126` (`AutomationKind`), `:138-142`
  (`HeartbeatPolicySnapshot`), `:168-174` (`Automation.{kind,targetThreadId,inheritedPolicy}`).
- Creation invariants — `validateHeartbeatCandidate` (`src/scheduler/heartbeat.ts:45-61`):
  rejects `missing-target-thread` / `missing-policy` / `thread-occupied`;
  `activeHeartbeatForThread` (`:30-36`) enforces the ≤1-active-per-thread rule.
- Persistence — `store-jsonl.ts:202-220` round-trips `kind`/`targetThreadId`/`inheritedPolicy`
  (`exactOptionalPropertyTypes`-safe: keys omitted when absent).
- **Runtime fire — already forwards the routing** (`src/scheduler/runtime.ts:243-256`):
  ```ts
  const heartbeat =
    automation.kind === "heartbeat" && automation.targetThreadId !== undefined
      ? { targetThreadId: automation.targetThreadId,
          ...(automation.inheritedPolicy !== undefined ? { inheritedPolicy: ... } : {}) }
      : {}
  await opts.agentLoop.enqueueUserMessage(automation.prompt, { modelOverride, ...heartbeat })
  ```
- Port signature — `AgentLoopPort.enqueueUserMessage(message, opts?: { signal?, modelOverride?,
  targetThreadId?, inheritedPolicy? })` (`src/scheduler/types.ts:219-231`). The `opts` carry
  the heartbeat fields **and are documented** (`:225-229`: *"the host enqueues onto THIS
  existing thread … and re-applies `inheritedPolicy`"*).

### 3.2 The GAP — **no host actually binds the routing.** Two impls, both drop it.

- **CLI REPL** (`src/apps/cli/repl/session-loop.ts:322-326`):
  ```ts
  agentLoop: { enqueueUserMessage: async (message) => { externalPromptQueue.push(message) } }
  ```
  The handler signature **omits the `opts` parameter** — `targetThreadId` /
  `inheritedPolicy` are never read. The fire becomes a plain text push onto the **current**
  session's `ExternalPromptQueue` (`external-prompt-queue.ts:14`, element type
  `CliPromptInput = string | {text, images?}`, `prompt-types.ts:3-5`). No target-thread
  resolution, no posture re-application.
  - A second instance at `session-loop.ts:649-651` (the reactor-wire path) is identically
    `opts`-blind.
- **Unified-agent host** (`src/host/runtime/agent-arg-builder.ts:1000-1013`): an explicit
  **stub** — `enqueueUserMessage: async (_message) => { logger.warn("…stub agent loop — fire
  ignored…") }`. It does nothing AND drops `opts`.
- `grep -rn "targetThreadId\|inheritedPolicy" src/apps src/host --include="*.ts"` → **0 hits**
  outside this RFC's targets. No host reads either field.

### 3.3 What the host DOES have (the parts the bind will reuse)

- Per-turn permission posture is already host-owned and **re-applied each turn**:
  `permissionMode: ux?.modeCycle?.current().permissionMode ?? runtimeContext.permissionMode()`
  (`session-loop.ts:404`), written into an engine-owned cell
  `runtimeContext.permissionModeState()?.set(...)` (`session-loop.ts:534`,
  `context-binding.ts:44` `permissionModeState?: PermissionModeSessionState`). The bind hooks
  HERE — a heartbeat fire writes the inherited posture into that SAME cell for the resumed turn.
- Session identity — `surfaceState.sessionId` / `threadId: setup.sessionId`
  (`session-loop.ts:310,487`). A heartbeat's `targetThreadId` is compared/resolved against this.

### 3.4 Verdict — **NOT superseded.** Honest gap: the routing is forwarded but never bound.

The core is a clean, fully-tested seam that **terminates in a no-op** at every host. This RFC
is the single last-mile wire that makes a heartbeat actually keep its thread.

---

## 4. 설계 (Design)

### 4.1 The bind — a thread-targeted `AgentLoopPort` over closed ports

Replace the `opts`-blind CLI handler with one that branches on `targetThreadId`:

```ts
const heartbeatLoop: AgentLoopPort = {
  enqueueUserMessage: async (message, opts) => {
    // CRON path (no target thread) — BYTE-IDENTICAL to today.
    if (opts?.targetThreadId === undefined) {
      externalPromptQueue.push(message)   // fresh thread-detached fire
      return
    }
    // HEARTBEAT path — resume the target thread under its inherited posture.
    await heartbeatBinder.resume({
      targetThreadId: opts.targetThreadId,
      prompt: message,
      ...(opts.inheritedPolicy !== undefined ? { inheritedPolicy: opts.inheritedPolicy } : {}),
      ...(opts.modelOverride !== undefined ? { modelOverride: opts.modelOverride } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
  },
}
```

The `heartbeatBinder` is a **closed port** (injected, not reached-into) so the scheduler/CLI
slices stay testable with a fake:

```ts
export interface HeartbeatThreadBinder {
  /** Resume `targetThreadId` with `prompt`, re-applying `inheritedPolicy` for the
   *  turn. NO-THROW (returns a typed verdict; a failed resume must not crash the
   *  scheduler tick — the runtime already treats enqueue throws as observable
   *  errors, `runtime.ts:257-277`). */
  resume(req: HeartbeatResumeRequest): Promise<HeartbeatResumeResult>
}
export interface HeartbeatResumeRequest {
  readonly targetThreadId: string
  readonly prompt: string
  readonly inheritedPolicy?: HeartbeatPolicySnapshot
  readonly modelOverride?: string
  readonly signal?: AbortSignal
}
export type HeartbeatResumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "thread-not-found" | "posture-rejected" | "enqueue-failed" }
```

### 4.2 Thread resolution — same-thread fast path + cross-thread guard

Two cases for `targetThreadId`:

1. **It IS the live session** (`targetThreadId === surfaceState.sessionId`,
   `session-loop.ts:310`): the common case — the heartbeat was created FOR this conversation.
   Resume = re-apply posture (§4.3) + `externalPromptQueue.push(prompt)`. The existing turn
   loop drains the queue next iteration; the prompt lands on the right thread because it IS the
   current one.
2. **It is a DIFFERENT thread** than the one this REPL is driving: a single CLI process drives
   ONE interactive session, so it cannot resume an arbitrary other thread in-process. The
   binder returns `thread-not-found` (the scheduler surfaces it as `scheduler.error`,
   `runtime.ts:257-277`), and the heartbeat stays armed (the anchor already advanced — the
   error does NOT re-fire, per the persist-before-dispatch invariant `runtime.ts:216-237`).
   A future multi-thread host (web daemon / background agent) supplies a binder that CAN load
   the foreign thread; the **port is the seam** for that without touching the scheduler.

This keeps the CLI honest: a heartbeat attached to the *current* thread works fully; one
attached to a thread this process is not driving fails loudly rather than silently mis-routing
onto the wrong conversation.

### 4.3 Posture re-application — write the inherited snapshot into the per-turn cell

`HeartbeatPolicySnapshot` carries three opaque strings (`types.ts:138-142`); the host owns the
closed vocabularies. The binder maps them onto the host's per-turn posture cells **for the
resumed turn only** (it never mutates the user's interactive mode cycle permanently):

- `approvalPolicy` → `runtimeContext.permissionModeState()?.set(mapApproval(policy))`
  (the SAME cell `session-loop.ts:534` writes from the mode-cycle). The next turn reads it at
  `session-loop.ts:404`. This is the load-bearing "never silently escalates" guarantee: the
  heartbeat re-applies the SNAPSHOT captured at creation (`heartbeat.ts:53`), so a heartbeat
  cannot drift to a more permissive stance than the user granted.
- `sandboxPolicy` → the sandbox-profile resolution the host already runs
  (`agent-arg-builder.ts:435` `resolvePermissionModeFromProfile`); the binder pins the
  resumed turn's sandbox to the snapshot.
- `collaborationMode` → the collaboration-mode cell (Plan/Default, the `mode.ts` seam).

**Validation:** the binder REJECTS (`posture-rejected`) any snapshot value outside the host's
closed vocabulary — a corrupt/forged JSONL `inheritedPolicy` (the store round-trips opaque
strings, `store-jsonl.ts:218-220`) must never widen the resumed turn's authority. Fail-closed:
an unknown approval value maps to the MOST restrictive mode, never the most permissive (the
provenance-gate "most-restrictive" discipline from prior security work).

### 4.4 Closed-port DI (no globals in the slices)

- The scheduler slice is already DI-clean (`types.ts:6-19`: imports nothing from the project;
  clock/env/agentLoop are ports). No change there.
- `HeartbeatThreadBinder` is a new closed port. The **real** binder (the one that touches
  `runtimeContext.permissionModeState()` / `externalPromptQueue`) lives in the CLI host
  (`session-loop.ts` / a new `src/apps/cli/repl/heartbeat-binder.ts`), constructed at the
  composition root and injected into the `AgentLoopPort` closure. No `Date.now` /
  `Math.random` / `process.env` in the binder; any clock it needs is injected (it needs none —
  the runtime stamps `at` from `opts.clock.now()`, `runtime.ts:89`).
- The unified-agent stub (`agent-arg-builder.ts:1001`) keeps its `logger.warn` for the *cron*
  path (no loop) but now ALSO logs a distinct "heartbeat fire reached a host with no binder"
  when `opts.targetThreadId` is present — so the gap is observable per-fire if a host forgets
  to wire the binder (the same observability discipline `runtime.ts:99-106` uses for store faults).

### 4.5 Default-OFF / byte-identity

- The whole scheduler is already default-OFF (`SCHEDULER_ENV_FLAG = "QUANTA_SCHEDULER"`,
  `runtime.ts:44,116`: `start()` is a no-op unless `"1"`). No heartbeat fires unless the
  operator opted in.
- The CRON path (`opts.targetThreadId === undefined`) is **untouched** — same
  `externalPromptQueue.push(message)`. Existing cron automations are byte-identical.
- A host that does not wire a `HeartbeatThreadBinder` behaves exactly as today (the
  `opts`-blind push) for cron, and surfaces an observable warn for heartbeat — no new default
  behavior, no silent change.

---

## 5. 통합 (Integration)

### 5.1 Knob

No new env. The binding rides the existing `QUANTA_SCHEDULER` gate (the scheduler must be
on for any fire) plus the existing per-thread autorun-eligibility gate
(`QUANTA_AUTORUN_POLICY`, consulted at `runtime.ts:168` BEFORE dispatch — a heartbeat under a
`never` policy is blocked before it ever reaches the binder). The inherited posture itself is
NOT a new knob — it is data captured at heartbeat creation.

### 5.2 No new tool / no manifest / no AgentEvent variant

This is a host-wiring RFC, not a tool RFC. No `BASE_TOOL_NAMES` / `GATED_TOOLS` change, no
new stream event. The scheduler already emits `scheduler.fired` / `scheduler.error`
(`types.ts:275-305`); a failed bind surfaces as `scheduler.error` via the existing
enqueue-throw path (`runtime.ts:257-277`). No drift-guard impact.

### 5.3 fc

Update the existing scheduler/heartbeat fc node's `evidence.code` to add the binder file +
the now-non-stub `enqueueUserMessage`, and flip its `maturity`/`status` from "seam" to
"wired" (the `partial-wiring` ledger lesson: do not label a seam "complete" without the host
bind — H8 was exactly such a seam). `depends_on` the permission-mode-state cell feature.

### 5.4 Slice / fence

- New `src/apps/cli/repl/heartbeat-binder.ts` — `createHeartbeatBinder(deps)` returning a
  `HeartbeatThreadBinder`. Imports the CLI session cells + the closed `HeartbeatPolicySnapshot`
  type from `@/scheduler`. CLI-layer file (it touches CLI session state), so it is allowed to.
- `HeartbeatThreadBinder` / `HeartbeatResumeRequest` types: define in `@/scheduler` (next to
  `AgentLoopPort`) so both the scheduler runtime-wire and the CLI host reference one SSOT.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (`tests/.../heartbeat-binder.hellgate.test.ts`, over a fake binder + fake cells)

- **cron untouched:** `enqueueUserMessage(msg)` (no `targetThreadId`) pushes to the queue and
  NEVER calls the binder — byte-identical to today (assert the binder mock is uncalled).
- **same-thread resume:** `targetThreadId === sessionId` → binder pushes the prompt AND writes
  the inherited `approvalPolicy` into the permission-mode cell; assert the cell holds the
  mapped mode for the next turn.
- **posture never escalates:** a snapshot with a MORE permissive `approvalPolicy` than the
  current session is still applied as the SNAPSHOT (it is the captured grant), but a snapshot
  value OUTSIDE the closed vocabulary → `posture-rejected` mapped to the MOST restrictive mode
  (fail-closed; never the most permissive). Forge a corrupt JSONL `inheritedPolicy` and prove
  it cannot widen authority.
- **cross-thread guard:** `targetThreadId !== sessionId` (no multi-thread binder) →
  `thread-not-found`; assert NO push onto the wrong thread's queue.
- **NO-THROW:** binder `resume` that rejects/throws → the CLI handler resolves (does not throw
  out of `enqueueUserMessage`); the scheduler runtime records `scheduler.error` and the anchor
  stays advanced (`runtime.ts:257-277` — no re-fire).
- **≤1 active per thread (already core-tested) end-to-end:** a second heartbeat targeting an
  occupied thread is rejected at creation (`validateHeartbeatCandidate`, `heartbeat.ts:56-59`)
  so two binders never drive one thread.

### 6.2 e2e through scheduler → runtime → binder

- Wire `createSchedulerRuntime` (`runtime.ts:80`) with a fake clock, a JSONL store holding ONE
  active `heartbeat` automation (`targetThreadId = S`, posture snapshot P), and the REAL CLI
  binder over fake session cells (sessionId = S). `tickOnce()` at a due time →
  assert: (1) the prompt landed on thread S's queue, (2) the permission cell holds P's mapped
  mode, (3) `scheduler.fired` emitted, (4) the fire anchor advanced + persisted
  (persist-before-dispatch, `runtime.ts:216-237`).
- Negative: same setup but sessionId = T (≠ S) → `thread-not-found` → `scheduler.error`,
  prompt NOT enqueued, anchor still advanced (no re-fire loop).

---

## 7. 단계 (Phasing)

- **P0 — port + CLI binder (same-thread).** Define `HeartbeatThreadBinder` in `@/scheduler`;
  implement `createHeartbeatBinder` for the same-thread case + posture re-application;
  replace the two `opts`-blind CLI handlers (`session-loop.ts:323,650`) with the branching
  one. Hellgate (§6.1) + e2e (§6.2). Cron byte-identical.
- **P1 — observability for unwired hosts.** Distinct warn in the unified-agent stub
  (`agent-arg-builder.ts:1001`) when a heartbeat fire arrives with no binder, so a misconfigured
  host is visible per-fire.
- **P2 (future) — cross-thread binder.** A web-daemon / background-agent host supplies a binder
  that LOADS a foreign thread (session store) and resumes it out-of-band. Same port; no
  scheduler change. (Out of scope; the port is the seam.)

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **Posture escalation via forged JSONL (primary security risk).** `inheritedPolicy` is
  round-tripped as opaque strings (`store-jsonl.ts:218`). A tampered store could carry a more
  permissive policy. Mitigation (§4.3): the binder validates every snapshot value against the
  host's CLOSED vocabulary and fail-closes unknown values to the most-restrictive mode — a
  forged value cannot widen the resumed turn. The snapshot is also re-validated, never trusted
  to exceed what `validateHeartbeatCandidate` admitted at creation.
- **Mis-routing onto the wrong conversation.** A naïve "just push to the current queue"
  (today's accidental behavior) silently injects a heartbeat into whatever thread the REPL
  happens to be on. The cross-thread guard (§4.2) makes `targetThreadId !== sessionId` a loud
  `thread-not-found`, not a silent mis-route.
- **Double-drive a thread.** Two heartbeats on one thread would double-enqueue. Already closed
  at creation by the ≤1-active-per-thread invariant (`activeHeartbeatForThread`,
  `heartbeat.ts:30-36,56-59`) — this RFC does not weaken it.
- **At-least-once on a mutating prompt.** Covered by the existing persist-before-dispatch order
  (`runtime.ts:216-237`): the anchor advances + persists BEFORE the binder is called, so a
  crash/bind-failure never re-fires the prompt. The binder's `enqueue-failed` records the error
  on the ADVANCED record (`runtime.ts:268`), not the original.
- **Alternative — bind inside the scheduler runtime.** Rejected: the runtime is slice-pure
  (`types.ts:18` "imports nothing else from the project"); reaching into CLI session cells
  there would break the fence. The closed `HeartbeatThreadBinder` port keeps the runtime pure
  and the host concrete.
- **Alternative — make heartbeat just a cron with a thread label.** Rejected: that is exactly
  today's broken degradation (the label is dropped). The point of H8 is thread CONTINUITY +
  posture inheritance, which requires the real resume bind.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (this RFC, when implemented)**
- `src/scheduler/types.ts` — add `HeartbeatThreadBinder` / `HeartbeatResumeRequest` /
  `HeartbeatResumeResult` (type-only; next to `AgentLoopPort`).
- `src/apps/cli/repl/heartbeat-binder.ts` — `createHeartbeatBinder(deps)` (same-thread resume +
  posture re-application via the existing permission-mode cell).
- `tests/.../heartbeat-binder.hellgate.test.ts` + the scheduler→binder e2e.
- `docs/decisions/0480-heartbeat-thread-binding.md`.

**Touched (host wiring only)**
- `src/apps/cli/repl/session-loop.ts:322-326` AND `:649-651` — replace the two `opts`-blind
  `enqueueUserMessage` handlers with the branching (cron-vs-heartbeat) one.
- `src/host/runtime/agent-arg-builder.ts:1000-1013` — distinct warn when a heartbeat fire
  reaches the no-loop stub (P1 observability).
- fc scheduler/heartbeat node — evidence + maturity "seam"→"wired".

**Audited ground truth (cited, NOT modified)**
- `src/scheduler/heartbeat.ts:30-61` — creation invariants (LANDED core).
- `src/scheduler/types.ts:126,138-142,168-174,219-231,275-305` — kind/posture/port/events.
- `src/scheduler/runtime.ts:88-127,168,216-288` — fire path (already FORWARDS the routing).
- `src/scheduler/store-jsonl.ts:202-220` — JSONL round-trip of heartbeat fields.
- `src/apps/cli/repl/session-loop.ts:310,322-326,404,487,534,649-651` — **the dropped `opts`
  + the per-turn permission cell the bind reuses.**
- `src/apps/cli/repl/external-prompt-queue.ts:14` + `prompt-types.ts:3-5` — the CLI queue shape.
- `src/host/runtime/agent-arg-builder.ts:1000-1013` — the no-loop stub.
- `src/host/runtime/internal/context-binding.ts:44` — `permissionModeState` cell.
- `src/reactor/self-wake.ts:146` — the in-repo `enqueueUserMessage` precedent.
