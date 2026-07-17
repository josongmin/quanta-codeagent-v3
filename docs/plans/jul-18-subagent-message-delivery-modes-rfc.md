# RFC — Subagent Message Delivery Modes, SOTA Plan

- **Status**: PROPOSED — revised after live-code audit (jul-18)
- **Decision class**: extend + migrate existing owners; no parallel mailbox/control plane
- **Scope**: unify targeted child delivery around three explicit timing modes —
  `queue`, `steer`, and `interrupt` — while preserving the separate decision of whether
  delivery should wake/continue an idle child.
- **North star**: one deterministic, typed command path from a caller's intent to the
  child's effective behavior, with no silent downgrade, duplicate delivery, lifetime-kill
  confusion, or second state authority.
- **Protocol**: interface-first RED → owner-local implementation → static contradiction
  closure → targeted behavioral GREEN → live smoke. Broad suites run after the owner batch.

---

## 1. Executive decision

The original draft's current-state premise was wrong. quanta already has:

1. a passive peer mailbox,
2. targeted `followup_task` delivery with task-id → mailbox-label translation,
3. queue/wake behavior for idle and busy children,
4. a working targeted interrupt that aborts only the child's current turn and re-enters,
5. a root-thread `queue | weave | interrupt` policy router,
6. an `ActiveTurnState`/`steer()` engine with expected-turn and turn-kind guards.

The missing product capability is therefore **targeted child steer plus one canonical command
contract across the existing pieces**. This RFC does not add mode semantics to the passive
mailbox and does not build another interrupt path.

### 1.1 Normative choices

- **Extend** `followup_task`, `TurnWakeRegistry`/`SubagentTurnGate`,
  `ConversationActionSurface`, and the existing inbound-mode planner.
- **Keep mailbox responsibility narrow**: retention, FIFO, delivery cursor, quotas,
  snapshot, and peer payload transport. A mailbox message never commands an abort or steer.
- **Separate two orthogonal axes**:
  - `mode`: when the model receives the message (`queue | steer | interrupt`),
  - `activation`: whether an idle child should be scheduled (`passive | ensure-turn`).
- **Expose requested and effective behavior separately**. A downgrade is a typed result,
  never a successful-looking silent fallback.
- **Use per-turn abort only** for interrupt. `TaskRegistry.forceStop()` remains terminal
  cancellation and is never reused for report-and-continue.
- **Register a narrow child control endpoint**, not a mutable `ActiveTurnState` handle that
  callers can poke directly.

### 1.2 Compatibility names

The current root-thread SSOT uses `weave` for Codex-style steer. The canonical internal term
after this RFC is `steer`.

- `InboundMode` keeps accepting `weave` at existing CLI/config boundaries during migration.
- The boundary maps `weave → steer` before policy evaluation.
- New subagent APIs expose only `queue | steer | interrupt`.
- The compatibility mapping is deleted after all persisted/config consumers migrate; there is
  never a second policy implementation.

---

## 2. Evidence and live baseline

Truth snapshot: `HEAD 5ad635b1d794` plus the untracked RFC working copy on jul-18.

### 2.1 Codex pattern: evidence vs inference

Local corpus evidence (`.extracted_source/codex*`, build 5059) proves:

- `followUpQueueMode` accepts `queue | steer | interrupt`.
- app-server verbs include `turn/start`, `turn/steer`, and `turn/interrupt`.
- multi-agent v2 has dedicated subagent handlers including `interrupt_agent.rs`.
- direct app-server input into v2 subagents is rejected; sanctioned handlers own control.

It does **not** prove that Codex stores a delivery mode on each mailbox message or that one
subagent RPC implements all three modes. This RFC absorbs the behavior and security posture,
not an inferred internal representation.

### 2.2 Existing quanta owners

| Existing capability | Live owner | Contract | Decision |
|---|---|---|---|
| Passive peer message | `src/agent/subagent-mailbox/{types,store}.ts` | bounded FIFO, per-reader cursor, no target liveness requirement | reuse unchanged |
| Targeted deliver + wake | `src/subagent/introspect-tools.ts` `followup_task` | registry validation, lineage/self-target guards, mailbox-label translation, wake outcome | extend |
| Busy/idle child control | `src/subagent/{turn-wake,turn-gate}.ts` | idle=`woke`, busy queue=`queued`, busy interrupt=per-turn abort + pending resume | extend endpoint shape |
| Child lifetime cancel | `src/subagent/registry.ts` `forceStop()` | terminal `stopped`, lifetime signal abort, registry cleanup | keep separate |
| Three-mode root policy | `src/agent/inbound-mode.ts` | queue, weave/steer, interrupt, typed queue fallback | extract/reuse policy kernel |
| Steerability authority | `src/agent/steering.ts` | active turn, expected turn id, review/compact/standalone deny, size checks | reuse |
| Mid-turn action queue | `src/agent/conversation-action-surface.ts` | FIFO action port + loop-owned active-turn ref | instantiate per controllable child |
| Child execution | `src/agent/subagent-runner.ts` | child config, task-id/waker registration, mailbox identity lifecycle | extend wiring |

### 2.3 Already-proven baseline

The following owner rails are green at the truth snapshot:

```text
bun test \
  tests/unit/subagent-turn-interrupt-hellgate.test.ts \
  tests/unit/subagent-turn-wake-gate-hellgate.test.ts \
  tests/unit/subagent-introspect-hellgate.test.ts

55 pass / 0 fail
```

These prove that `followup_task(interrupt:true)` already aborts a busy child's in-flight
stream, runs a fresh child turn, preserves non-interrupt queue behavior, maps task id to the
mailbox label, enforces lineage/self-target guards, and degrades honestly when no waker exists.

### 2.4 Actual remaining gaps

1. `followup_task` expresses only `interrupt?: boolean`, not a closed delivery-mode request.
2. A running child's `ConversationActionSurface`/`ActiveTurnState` is not registered on the
   sanctioned child control endpoint, so targeted steer cannot be evaluated or injected.
3. Root inbound routing and child follow-up use adjacent but separate vocabularies/results.
4. Current results do not distinguish requested mode, effective mode, fallback reason, target
   turn, queued payload, and control effect precisely enough for UI/telemetry.
5. Burst, stale-turn, downgrade, control-unavailable, and abort-uncooperative-tool contracts
   are not closed for the new mode API.

---

## 3. Semantic model

### 3.1 Delivery mode and activation are independent

```ts
export type DeliveryMode = "queue" | "steer" | "interrupt"
export type ActivationPolicy = "passive" | "ensure-turn"
```

| Request | Active steerable child | Busy non-steerable/stale child | Idle child |
|---|---|---|---|
| `queue + passive` | mailbox only; current turn untouched | mailbox only | mailbox only; do not wake |
| `queue + ensure-turn` | mailbox; next turn scheduled after current | same | mailbox + wake now |
| `steer + *` | inject once into current turn; no mailbox copy; no abort | typed downgrade to queue, then apply activation | typed downgrade to queue, then apply activation |
| `interrupt + *` | mailbox first, abort current per-turn signal, resume fresh turn | typed downgrade to queue if already interrupted/non-interruptible | queue + `ensure-turn` behavior; nothing exists to abort |

`subagent_send_message` remains `queue + passive` only. `followup_task` uses
`activation:"ensure-turn"` and accepts all three modes. This preserves the existing distinction:
passive mail does not create work; a follow-up guarantees an eligible child gets another turn.

For an active-turn interrupt, replacement-turn scheduling is intrinsic to `interrupt`; otherwise
the queued replacement could never be handled. `activation` controls ordinary queue delivery and
the fallback/idle behavior of live modes, not whether a successfully interrupted turn re-enters.

### 3.2 Canonical request

```ts
export type SubagentDeliveryRequest = {
  readonly targetTaskId: string
  readonly from: string
  readonly body: string
  readonly mode: DeliveryMode
  readonly activation: ActivationPolicy
  readonly expectedTurnId?: string
  readonly correlationId?: string
}
```

Rules:

- `targetTaskId` is always the registry task id. Only the controller resolves its mailbox label.
- `expectedTurnId` is honored for `steer` and optional for `interrupt`; mismatch never writes
  into a different turn.
- empty/oversized/malformed input is rejected before mailbox or control mutation.
- raw/unknown mode is rejected at the schema boundary; it never normalizes to queue.
- the caller's lineage and self-target authorization are checked before any payload is retained.

### 3.3 Canonical outcome

```ts
export type SubagentDeliveryOutcome =
  | {
      readonly kind: "accepted"
      readonly deliveryId: string
      readonly requestedMode: "steer"
      readonly effect: "steer_pending"
      readonly targetTurnId: string
    }
  | {
      readonly kind: "applied"
      readonly deliveryId: string
      readonly requestedMode: "queue"
      readonly effectiveMode: "queue"
      readonly effect: "queued" | "woke"
      readonly messageId: string
    }
  | {
      readonly kind: "applied"
      readonly deliveryId: string
      readonly requestedMode: "interrupt"
      readonly effectiveMode: "interrupt"
      readonly effect: "interrupted"
      readonly messageId: string
      readonly targetTurnId: string
    }
  | {
      readonly kind: "degraded"
      readonly deliveryId: string
      readonly requestedMode: "steer" | "interrupt"
      readonly effectiveMode: "queue"
      readonly effect: "queued" | "woke"
      readonly reason: DeliveryDegradeReason
      readonly messageId: string
    }
  | {
      readonly kind: "rejected"
      readonly reason: DeliveryRejectReason
    }
```

Closed reasons:

```ts
export type DeliveryDegradeReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "non_steerable_review"
  | "non_steerable_compact"
  | "non_steerable_standalone"
  | "already_interrupted"
  | "superseded_by_interrupt"
  | "action_queue_full"
  | "same_turn_budget_exhausted"
  | "control_unavailable"
  | "no_waker"

export type DeliveryRejectReason =
  | "target_unknown"
  | "target_settled"
  | "ownership_denied"
  | "self_target"
  | "invalid_input"
  | "mode_disabled"
  | "internal_control_error"
```

No boolean `ok` may erase these distinctions. A payload retained in the mailbox but not woken
is `degraded`, not `rejected`, because delivery already occurred.

Steer is asynchronous relative to the caller: enqueueing a conversation action is admission,
not proof that the child consumed it. The controller returns `accepted/steer_pending`; the loop
emits a correlated final receipt when it consumes or downgrades that action:

```ts
export type SubagentDeliveryReceipt =
  | {
      readonly deliveryId: string
      readonly kind: "applied"
      readonly effectiveMode: "steer"
      readonly targetTurnId: string
    }
  | {
      readonly deliveryId: string
      readonly kind: "degraded"
      readonly effectiveMode: "queue"
      readonly reason: DeliveryDegradeReason
      readonly effect: "queued" | "woke"
      readonly messageId: string
    }
  | {
      readonly deliveryId: string
      readonly kind: "cancelled"
      readonly reason: "target_settled" | "session_aborted"
    }
```

The controller mints `deliveryId` through an injected id factory. Tests use a deterministic
factory; production may use the repository's existing crypto id posture. Acceptance and final
receipt share that id. Every `accepted` delivery must produce exactly one final `applied`,
`degraded`, or `cancelled` receipt. Session finalization closes any still-pending delivery; it
must not leave an admission permanently unresolved.

### 3.4 Ordering and exactly-once model injection

- **Queue**: write once to the mailbox; the existing per-reader cursor owns model delivery.
- **Steer success**: push one sanitized/provenance-stamped conversation action; do not also
  enqueue it in the mailbox. Return `accepted`, then emit `applied` only at loop consumption.
- **Steer downgrade**: enqueue once in the mailbox; do not push a conversation action.
- **Steer admission pressure**: if the remote-steer backlog or remaining same-turn budget is
  exhausted, do not admit it to the action queue; enqueue once and return a typed degrade.
- **Interrupt**: enqueue first, then fire the per-turn abort/wake. If the control effect fails,
  return a typed degraded outcome while leaving the queued payload recoverable.
- Multiple busy queue/interrupt requests may coalesce to one pending wake, but every mailbox
  payload remains FIFO and is delivered once. Outcome wording must not promise one turn per
  message.

This is at-most-once model injection inside one process. Cross-process/RPC retry idempotency is
owned by the ingress request-id layer and is not invented inside the mailbox.

### 3.5 Steer safe-point contract

Quanta cannot rewrite a provider response already being sampled. `steer` therefore means:

> admitted during an active steerable turn, then consumed at the earliest transcript-safe
> boundary before that logical turn is allowed to finish; the next model call sees it and the
> current turn is not aborted.

The current conversation-action queue is polled at turn start and same-turn retry boundaries,
but an `end_turn` response can finish before another retry poll occurs. WS4 therefore adds a
post-stream safe-point check before `runTurn` honors `step.done`:

1. if no steer is pending, return exactly as today,
2. if a matching steer is pending, append the sanitized injection,
3. keep the current turn header/id,
4. continue the same-turn engine into one more model call,
5. emit the final `applied/steer` receipt,
6. never interrupt or create a mailbox duplicate.

If a later interrupt wins before this safe point, it supersedes the pending steer. The steer
payload is preserved through the queue fallback path and its receipt records
`superseded_by_interrupt`; the interrupt payload has deterministic precedence on the fresh turn.

Remote steer actions are FIFO and bounded. The child surface accepts at most the configured
remote-steer backlog and at most the loop's remaining same-turn rounds; excess requests degrade
to mailbox delivery instead of creating unbounded memory or unbounded extra model calls. A
same-turn safe point applies one admitted steer action per round in FIFO order. Cancellation,
interrupt, and lifetime abort take precedence and finalize every displaced delivery explicitly.

---

## 4. Owning architecture

### 4.1 Canonical mode vocabulary

Add the literal vocabulary to a pure shared leaf, e.g.
`src/shared/delivery-mode.ts`. It owns only:

- `DeliveryMode`,
- `ALL_DELIVERY_MODES`,
- strict parsing/validation,
- two-way compile drift guards.

Policy remains in `@/agent`. `src/agent/inbound-mode.ts` consumes the shared type and maps the
legacy boundary name `weave` to canonical `steer`. The child controller consumes the same
planner semantics; no second fallback table is allowed.

### 4.2 Sanctioned child control endpoint

Migrate `TurnWakeRegistry` into a typed `SubagentControlRegistry` in the same owner slice. This
is a replacement, not a parallel registry. Each running child registers one endpoint:

```ts
export interface SubagentControlEndpoint {
  readonly mailboxLabel: string
  wake(): WakeOutcome
  interrupt(): InterruptControlOutcome
  steer(request: SubagentSteerSubmission): SteerSubmitOutcome
}
```

The endpoint exposes typed commands only. The `steer` closure is built in `@/agent`, reads the
child's private `activeTurnRef`, and delegates to the existing `steer()` authority. The registry
never owns or exposes `ActiveTurnState`, `ConversationActionSurface`, or `AbortController`.
`interrupt()` returns a closed result such as `woke_idle | interrupted_active |
already_interrupted | not_armed`; it does not overload a free-form `reason` string.

`SubagentSteerSubmission` carries `deliveryId`, one immutable untrusted peer envelope, and the
concrete expected turn id. The child surface adds a typed `submitSteer()` path that returns
`accepted`, `no_active_turn`, `turn_mismatch`, or `queue_full`; the endpoint must not call the
existing void-returning `pushUserMessage()` and infer success. The submitted conversation action
retains `deliveryId` and that envelope so the loop can finalize or queue-fallback the correct
request without a second payload registry.

Lifecycle:

1. `createSubagentRunner` creates the child gate and child `ConversationActionSurface`.
2. The child config receives the surface's `port` + `activeTurnRef`.
3. The runner registers one endpoint under `req.taskId`, with the mailbox label minted for the
   same child.
4. The disposer unregisters the endpoint before the task record settles.
5. A stale disposer cannot remove a newer endpoint for the same task id.

### 4.3 Delivery controller

Add `src/agent/subagent-delivery/` as the behavior owner. `@/agent` is the correct composition
slice because it may consume registry, mailbox, steering policy, and redaction ports.

Responsibilities:

- validate target running state,
- enforce requester lineage and self-target rules,
- resolve task id → endpoint/mailbox label,
- call the endpoint's typed steer/interrupt command, whose `@/agent` closure reuses the canonical
  turn policy,
- apply exactly one of mailbox enqueue, steer action, or per-turn interrupt,
- return the closed outcome taxonomy,
- emit admission immediately and final application/degrade receipts at the owning safe point.

It must not own mailbox retention, child lifetime, UI rendering, or environment parsing.
The loop receives a narrow `SubagentSteerFinalizationPort`: applied actions emit a receipt;
late policy rejection, interrupt supersession, or same-turn budget exhaustion asks the
controller to perform the one mailbox fallback from the action's immutable envelope and emit the
final receipt. This keeps pending actions as data, avoids callback-bearing queue entries and a
second payload registry, and keeps mailbox mutation in one owner.

### 4.4 Tool adapters

- `subagent_send_message`: remains the passive mailbox tool. Do not add a misleading mode field.
- `followup_task`: replace `interrupt?: boolean` with `mode?: DeliveryMode`, default `queue`.
- Compatibility window: accept legacy `interrupt:true` only when `mode` is absent; both supplied
  is `invalid_input`. The tool description marks the boolean deprecated.
- After all in-tree callers/tests migrate, delete the boolean and its compatibility tests in the
  same planned cleanup wave. No indefinite dual truth.
- The tool consumes a narrow `SubagentDeliveryPort`; it no longer performs mailbox-send and
  wake sequencing itself.

### 4.5 Trust and provenance

Export one peer-message sanitizer/formatter from the mailbox owner and reuse it for queue drain,
steer injection, interrupt re-entry, and surfacing:

```text
redact(body) → escape line/control chars → stamp untrusted sender provenance
```

Steer may never inject the raw teammate body as an ordinary trusted user string. The model-facing
header remains `[teammate <from> — untrusted] ...` for every effective mode.

### 4.6 Observability

When jul-15's `peer_message` event exists, extend it with outcome facts:

```ts
{
  deliveryId,
  phase, // admitted | finalized
  requestedMode,
  effectiveMode?, // finalized only
  effect,
  degradeReason?,
  cancelReason?,
  targetTaskId,
  targetTurnId?,
  admissionToFinalMs?
}
```

Emit each phase only after its owning component has determined that phase. UI text must render
effective behavior,
e.g. `steer requested; queued because expected_turn_mismatch`, never merely `steered` from the
request field. Recorder, protocol projection, CLI timeline, web bridge, and debug tracer are one
consumer cascade and land in the same commit.

Admission and finalization are separate phases on the same `deliveryId`; consumers must tolerate
the final phase arriving after the caller tool result. Metrics use bounded mode/reason/effect
labels and numeric latency/backlog fields. Message bodies, sender text, task ids, turn ids, and
delivery ids are event fields only, never metric labels.

---

## 5. Failure and concurrency contract

1. **Unknown/settled target**: reject before mailbox mutation.
2. **Cross-lineage/self target**: reject before target lookup details or payload mutation leak.
3. **Endpoint absent but task running**:
   - queue+passive: applied queued,
   - ensure-turn or live mode: queue once and return typed `control_unavailable`/`no_waker` degrade.
4. **Expected-turn mismatch**: never inject into the replacement turn; queue once with the
   mismatch reason.
5. **Repeated interrupt**: the first aborts; later requests see `already_interrupted`, queue in
   FIFO order, and share the pending resume. No double aborted-turn capture.
6. **Interrupt after accepted steer**: interrupt wins; steer is preserved as a queue fallback,
   final receipt says `superseded_by_interrupt`, and neither payload is duplicated.
7. **Remote-steer burst**: bounded admission preserves FIFO; overflow degrades once to mailbox
   with `action_queue_full`. Same-turn round exhaustion uses `same_turn_budget_exhausted`.
8. **Target settles during command handling**: the endpoint/disposer ordering decides the result.
   No callback into a disposed loop; an already-retained payload is reported as degraded, not
   rolled back or reported as rejected.
9. **Target settles after steer admission**: finalization emits exactly one `cancelled` receipt;
   no stale endpoint callback and no false `applied` event.
10. **Tool ignores abort signal**: interrupt is cooperative. The outcome promises that the
   per-turn signal fired, not that an arbitrary external process was force-killed. Surface this
   latency bound in docs/telemetry.
11. **Throwing mailbox/control/sink**: controller converts to a typed failure/degrade; UI emission
   never changes delivery behavior.
12. **Mailbox burst**: mailbox quota and per-turn drain cap remain authoritative. Wake coalescing
   cannot drop or reorder mailbox payloads.
13. **Snapshot/replay**: mode is command metadata, not mailbox snapshot state. Existing mailbox
   snapshots remain byte-compatible.

---

## 6. Workstreams and RED-first rails

### WS0 — freeze baseline and supersession

- Mark original claims “no targeted interrupt” and “reuse `forceStop`” as superseded.
- Cross-link ADR-0437 and the existing feature-catalog entry.
- Freeze current 55-test baseline before interface changes.

DoD: no implementation ticket may describe interrupt as absent or route report-and-continue
through terminal `forceStop()`.

### WS1 — canonical types and command contract

- Add shared `DeliveryMode` and closed arrays.
- Add request/outcome/reason unions.
- Update `followup_task` schema with the bounded compatibility rule.
- Keep `subagent_send_message` queue-only.

RED rails:

- compile failure until every mode/reason classifier is exhaustive,
- unknown mode rejected rather than normalized,
- `interrupt:true + mode:*` rejected,
- requested/effective mode cannot be omitted from degraded outcomes.

### WS2 — control endpoint migration

- Replace wake-only registration with the typed endpoint.
- Preserve task-id → mailbox-label mapping and last-writer-safe disposal.
- Create and inject a child `ConversationActionSurface` only when the control capability is wired.
- Add bounded, typed `submitSteer()` admission; retain `deliveryId` in the action data.
- Keep default-OFF sessions free of the surface/ref allocation.

RED rails:

- a registered child exposes typed wake/interrupt/steer commands but no mutable controller,
- disposer removes endpoint and label together,
- stale disposer cannot remove a replacement endpoint,
- knob/capability OFF keeps the prior child config shape.
- admission at capacity returns `queue_full`; it never silently drops or grows without bound.

### WS3 — delivery controller and migration

- Implement the single decide/apply controller.
- Move ownership/self/settled checks and mailbox-label resolution into it.
- Route `followup_task` through the narrow delivery port.
- Remove direct mailbox→wake sequencing from the tool handler.

RED rails:

- unknown/settled/foreign/self target performs zero mailbox/control calls,
- queue passive performs send only,
- queue ensure-turn performs send + wake,
- missing endpoint returns a typed retained-payload degrade,
- burst wake coalescing preserves all FIFO messages exactly once.

### WS4 — targeted steer

- Use the child endpoint's steer command and the existing `steer()` authority captured by its
  private `@/agent` closure.
- Submit accepted steer through the child's conversation-action port.
- Inject the finalization port and close every accepted delivery exactly once.
- Add the post-stream safe-point drain before `step.done` so accepted steer cannot disappear on
  an otherwise-final response.
- Reuse peer sanitization/provenance.
- Never enqueue a second mailbox copy on accepted steer.

RED rails:

- active main turn ending with `end_turn`: a second model call runs under the same turn id, sees
  the injection, and emits an applied receipt; no abort and no mailbox copy,
- review/compact/standalone: typed queue downgrade,
- stale expected turn: queue downgrade; replacement turn receives no direct steer,
- idle/already-interrupted: queue downgrade,
- accepted steer raced by interrupt: deterministic interrupt precedence + one queue fallback +
  correlated degraded receipt,
- remote-steer overflow or exhausted same-turn budget: no action admission, one mailbox fallback,
- lifetime abort after admission: one correlated cancelled receipt and no stale callback,
- planted secret/newline: same redacted, escaped, untrusted shape across all modes.

### WS5 — interrupt convergence

- Keep the existing per-turn `SubagentTurnGate` interrupt implementation.
- Route the new `mode:"interrupt"` request to that owner.
- Delete the deprecated boolean after caller migration.

RED rails:

- busy child: signal fires, partial turn is captured once, fresh turn drains payload,
- child task record stays running across the interrupt,
- `forceStop` remains terminal and distinct,
- repeated interrupts cause one abort/resume but preserve every payload,
- abort-ignoring tool exposes the documented cooperative latency bound.

### WS6 — observation and catalog

- Extend jul-15 `peer_message` rather than creating another event type.
- Update every closed event consumer in the same change.
- Add/refresh the feature-catalog YAML and rebuild generated markdown.
- Record dependency on `subagent-introspect-tools`, `peer-teammate-messaging`, and the jul-15
  surfacing feature.

Required commands:

```text
bun fc validate
bun fc build
bun fc diff
bun fc check-evidence
```

### WS7 — live smoke and rollout

Run with a real spawned child:

1. queue+passive while busy → current turn completes; payload appears next turn only,
2. queue+ensure-turn while idle → child wakes and drains once,
3. steer while busy → current turn changes course without abort,
4. interrupt while blocked in a cooperative tool → per-turn signal fires; child reports on a
   fresh turn and remains running,
5. stale expected turn → explicit queued downgrade visible to caller/operator.

Only WS7 can promote the catalog maturity from owner-local L3 proof to a product-path claim.

---

## 7. Verification ladder

### Static

- bounded consumer inventory for `InboundMode`, `followup_task`, `TurnWakeRegistry`,
  `SubagentTurnGate`, mailbox send, and `peer_message`,
- no second delivery-mode union or fallback table,
- no `process.env` outside runtime-config authority,
- no `forceStop()` in non-terminal delivery paths,
- slice-boundary and god-code ratchets,
- generated feature-catalog drift check.

### Compile

```text
bun run typecheck
```

### Owner-local behavior

```text
bun test tests/unit/subagent-introspect-hellgate.test.ts
bun test tests/unit/subagent-turn-wake-gate-hellgate.test.ts
bun test tests/unit/subagent-turn-interrupt-hellgate.test.ts
bun test tests/unit/inbound-mode-router-hellgate.test.ts
bun test <new subagent-delivery-controller hellgate>
bun test <new targeted-child-steer hellgate>
```

Every filtered rail must report non-zero tests. Static name-presence scans are insufficient;
negative mutation must remove or misroute one real control call and make the rail RED.

### Cross-boundary

- real `createSubagentRunner` + real controller + scripted blocking LLM,
- host composition root with feature gate OFF/ON,
- CLI/web event consumer cascade when jul-15 surfacing is present,
- real spawned-child smoke after landing.

### Governance

```text
bunx @biomejs/biome check <touched paths>
bun test tests/unit/god-code-ratchet.test.ts
bun fc validate
bun fc diff
git diff --check
```

---

## 8. Landing order and stop conditions

| Wave | Content | Stop condition |
|---|---|---|
| 0 | baseline correction + contract RED | existing 55-test baseline not green |
| 1 | shared mode/outcome types + tool schema | dual enum/fallback authority remains |
| 2 | control endpoint migration | endpoint lifecycle/id mapping not proven |
| 3 | delivery controller + queue migration | any reject mutates mailbox/control |
| 4 | targeted steer | accepted steer duplicates mailbox delivery or bypasses trust formatter |
| 5 | interrupt API convergence | task becomes terminal or double-capture occurs |
| 6 | observation/catalog | requested/effective behavior not distinguishable on every consumer |
| 7 | live smoke | product-path mode behavior not observed end-to-end |

Waves 1–5 are one authority-local campaign. Do not ship a new mode enum in Wave 1 and leave the
old boolean/direct tool sequence indefinitely. If WS4 steer is blocked, queue+interrupt remain
the pre-existing product baseline; the RFC stays partial rather than claiming three-mode parity.

---

## 9. Feature gating and default behavior

- Reuse `QUANTA_SUBAGENT_FOLLOWUP` for the existing targeted control capability.
- Add no broad `QUANTA_SUBAGENT_MSG_MODES` gate that pretends interrupt is new.
- If staged rollout is required, gate only the genuinely new child-steer endpoint with
  `QUANTA_SUBAGENT_STEER` through the full runtime-config/knob-inventory/default-OFF SSOT.
- Gate OFF:
  - `followup_task` queue/interrupt behavior is byte-identical to the current baseline,
  - `mode:"steer"` is rejected as `mode_disabled`; it does not silently queue,
  - no child conversation-action surface or steer endpoint is allocated.
- Gate ON: steer may still downgrade to queue for runtime state reasons, but the result carries
  requested/effective mode and the exact reason.

---

## 10. Out of scope

- forcibly killing tools/processes that ignore `AbortSignal` — separate execution-runtime work,
- root-thread global default UX beyond the existing inbound-mode surface,
- arbitrary direct access to child `ActiveTurnState` or `AbortController`,
- replacing mailbox retention/persistence,
- clickable cross-task navigation owned by the jul-15 surfacing RFC,
- cross-process retry-idempotency; ingress request ids own that contract.

---

## 11. Definition of done

The RFC is implemented only when all are true:

1. exactly one canonical mode vocabulary and one policy implementation exist,
2. passive delivery and turn activation are independently expressible,
3. existing queue and interrupt rails remain green,
4. targeted child steer is first acknowledged as pending, then reaches a real child current turn
   at the post-stream safe point with a correlated applied receipt, without abort or duplicate
   mailbox copy,
5. every accepted steer terminates in exactly one correlated final receipt, including
   interruption, budget exhaustion, and session teardown,
6. remote-steer admission and extra same-turn rounds are bounded; overflow preserves the payload
   through one typed mailbox fallback,
7. interrupt uses a resettable per-turn controller and never terminal `forceStop`,
8. every rejection happens before mutation,
9. every runtime downgrade is typed and operator-visible,
10. task-id/label, lineage, self-target, stale-turn, repeated-interrupt, burst, and no-waker rails pass,
11. all modes share the same redaction/escaping/untrusted provenance formatter,
12. feature-gate OFF is behaviorally and structurally pinned,
13. feature-catalog YAML and generated markdown agree,
14. owner-local tests, typecheck, touched lint/ratchets, and the real-child smoke are green with
    non-zero execution receipts.

Until item 14 is satisfied, status remains `PARTIAL` or `VALIDATION PENDING`, never SOTA parity.
