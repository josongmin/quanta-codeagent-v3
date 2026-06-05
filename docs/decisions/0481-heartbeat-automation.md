# ADR-0481: Heartbeat automation — thread-attached repeating agent (kind cron|heartbeat)

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0453 (heartbeat autorun ELIGIBILITY — the per-thread approval gate; that ADR decides WHETHER a due automation may fire, THIS ADR decides WHERE/HOW the heartbeat fire is routed. The two compose: eligibility is consulted at step 2b, heartbeat routing is applied at step 5 of the same `processAutomation` body.)
  - ADR-0161 (scheduled agent — defines the `Automation` record, the JSONL store, and the `SchedulerRuntime.tickOnce` RRULE fire path. THIS ADR extends that record with the `kind`/`targetThreadId`/`inheritedPolicy` discriminator and routes the fire onto an existing thread instead of a fresh one.)
  - ADR-0132 (autonomous proactive reactor — the runtime calls the same `AgentLoopPort.enqueueUserMessage` seam that reactor's `manual_resume` uses. Heartbeat adds `targetThreadId`/`inheritedPolicy` to that seam's opts; absent ⇒ byte-identical to reactor's fresh-thread enqueue.)
  - ADR-0046 (permission state store — `ThreadPermission.approvalPolicy` and the thread's sandbox/collaboration posture are the source the `HeartbeatPolicySnapshot` is captured FROM at creation time. The snapshot is the host's per-thread posture frozen so each fire re-applies the SAME stance and never silently escalates.)
- **참조**:
  - `src/scheduler/types.ts` — `AutomationKind = "cron" | "heartbeat"` + `ALL_AUTOMATION_KINDS`; `HeartbeatPolicySnapshot` (`approvalPolicy`/`sandboxPolicy`/`collaborationMode`, all opaque strings); `Automation.kind?` / `Automation.targetThreadId?` / `Automation.inheritedPolicy?`; `AgentLoopPort.enqueueUserMessage` opts extended with `targetThreadId?` / `inheritedPolicy?`.
  - `src/scheduler/heartbeat.ts` — `validateHeartbeatCandidate(candidate, existing) → HeartbeatValidation`; `activeHeartbeatForThread(automations, threadId)`; closed `HeartbeatRejectReason = "missing-target-thread" | "missing-policy" | "thread-occupied"`.
  - `src/scheduler/runtime.ts` — `processAutomation` step 5: the `heartbeat` opts spread that routes a `kind:"heartbeat"` + `targetThreadId` fire onto the existing thread; `cron` (absent kind) stays byte-identical (only `modelOverride`).
  - `src/scheduler/store-jsonl.ts` — `heartbeatFields(r)` + `parseInheritedPolicy(raw)`: JSONL round-trip of the three new fields, partial-policy drop (never half-inherited), and the cron byte-identical (no `kind` key) guarantee.
  - Tests: `tests/unit/scheduler/heartbeat-automation-hellgate.test.ts` (creation-boundary invariants + JSONL round-trip), `tests/unit/scheduler/heartbeat-fire-routing-e2e-hellgate.test.ts` (real `tickOnce()` fire-routing e2e).
  - Feature catalog: `tools/feature-catalog/features/09-integration/h8-heartbeat-automation.yaml`.

## 맥락

The scheduler (ADR-0161) modeled exactly one kind of automation: a **cron** — each fire enqueues the prompt onto a FRESH agent loop (thread-detached), in effect a fresh worktree with no inherited posture. `Automation` had no `kind`, no `targetThreadId`, and no posture snapshot; the runtime simply called `enqueueUserMessage(prompt, { modelOverride })` and the host spun a new loop.

Codex's automation model has TWO kinds (`cron` vs `heartbeat`). A **heartbeat** is not a fresh fire — it attaches to an EXISTING conversation thread and *keeps working that thread* on a schedule, INHERITING the thread's approval / sandbox / collaboration posture so each fire runs under the same stance the user already established for that thread. Without a `kind`/`targetThreadId`/snapshot model, the scheduler could not express "repeat on THIS thread under ITS posture" — every fire was a posture-less fresh loop.

This is the AUTOMATION feature itself, distinct from ADR-0453: 0453 is the per-thread approval GATE (eligibility — may a due automation fire at all). THIS ADR is the discriminated `kind`, the `targetThreadId`, the inherited posture snapshot, the one-active-per-thread constraint, and the routing of the fire onto the existing thread. The two compose in `processAutomation`: 0453's gate at step 2b, this ADR's routing at step 5.

## 결정

A discriminated extension of the `Automation` record plus a routing branch on the existing fire seam. No new env flag, no new trigger, no new store — additive on ADR-0161's substrate.

**1. The `kind` discriminator (`types.ts`).** `AutomationKind = "cron" | "heartbeat"`, closed via `ALL_AUTOMATION_KINDS`. `Automation.kind?` is OPTIONAL: ABSENT ⇒ `"cron"` ⇒ byte-identical legacy (a thread-detached fresh fire). Only `"heartbeat"` activates the routing. This keeps every pre-H8 automation on disk and on the wire unchanged.

**2. `targetThreadId` + the inherited posture snapshot (`types.ts`).** A `heartbeat` carries `targetThreadId?` (the conversation thread the fire is enqueued onto) and `inheritedPolicy?: HeartbeatPolicySnapshot`. The snapshot is three opaque strings — `approvalPolicy` / `sandboxPolicy` / `collaborationMode` — captured FROM the target thread (ADR-0046) at creation time and re-applied on EVERY fire. The scheduler stores + forwards them verbatim; the host owns the closed vocabularies. WHY a frozen snapshot rather than a live re-read: a heartbeat must run under the SAME stance the user approved when they attached it — re-reading live policy could silently escalate (or de-escalate) a long-running repeating agent without the user's knowledge.

**3. One ACTIVE heartbeat per thread + creation-boundary validation (`heartbeat.ts`).** `validateHeartbeatCandidate(candidate, existing)` is PURE / NO-THROW (returns a typed verdict; never reads the store). A `cron` candidate is always `ok`. A `heartbeat`:
   - MUST carry a non-empty `targetThreadId` (else `missing-target-thread`) — a heartbeat with no thread is meaningless and would silently degrade to a fresh cron fire, losing the "keep working THIS thread" intent.
   - MUST carry an `inheritedPolicy` (else `missing-policy`) — a heartbeat with no posture cannot re-apply a stance.
   - MUST be the only ACTIVE heartbeat on its `targetThreadId` (else `thread-occupied`), via `activeHeartbeatForThread`. Same-`id` re-occupation is allowed (an UPDATE re-takes its own slot). Two repeating agents on one thread under one posture would double-drive it. Only `status === "active"` occupies — a `paused`/`deleted` heartbeat frees the thread.

The HOST enforces these at CREATION time so the fire path stays simple — `runtime.ts` just routes a well-formed heartbeat.

**4. Heartbeat-fire routing (`runtime.ts`, step 5).** Inside `processAutomation`, after the status gate, the RRULE-due gate, the ADR-0453 eligibility gate (2b), model-resolve, and persist-before-dispatch, the fire enqueues:
```
const heartbeat =
  automation.kind === "heartbeat" && automation.targetThreadId !== undefined
    ? { targetThreadId, ...(inheritedPolicy ? { inheritedPolicy } : {}) }
    : {}
await opts.agentLoop.enqueueUserMessage(automation.prompt, { modelOverride: chosen.chosen, ...heartbeat })
```
A `kind:"heartbeat"` + `targetThreadId` fire carries `targetThreadId` + `inheritedPolicy` on the enqueue opts; the host binds those to "resume THAT thread under THAT posture." A `cron` (absent kind) fire carries ONLY `modelOverride` — byte-identical to the pre-H8 enqueue. The reactor (ADR-0132) uses the exact same `AgentLoopPort` seam for `manual_resume`; this is a new shape on that seam, not a new trigger. A malformed heartbeat that reaches the fire path WITHOUT a `targetThreadId` (creation validation should have rejected it) degrades safely to a fresh fire — the prompt still runs, no thread route is invented.

**5. JSONL persistence (`store-jsonl.ts`).** `heartbeatFields(r)` + `parseInheritedPolicy(raw)` round-trip the three new fields preserving `exactOptionalPropertyTypes` (absent keys OMITTED, never `undefined`-set). A cron row carries NO `kind`/`targetThreadId` keys (byte-identical legacy). A partial `inheritedPolicy` (any of the three strings missing) is DROPPED on load — a posture is inherited whole or not at all, never half-inherited.

**Default-OFF / byte-identical**: with no `kind` (or `kind:"cron"`), every path — validation, fire routing, JSONL — is byte-identical to ADR-0161. Heartbeat is purely additive: it never changes what a cron automation does.

## 결과

- The scheduler can now express a repeating agent that keeps working ONE conversation thread under a FIXED inherited posture, matching Codex's heartbeat kind — without abandoning the fresh-worktree cron behavior, which remains the default and byte-identical.
- The inherited posture is captured ONCE at creation and re-applied every fire, so a heartbeat never silently escalates its approval/sandbox/collab stance across its lifetime.
- The one-active-per-thread constraint prevents two heartbeats double-driving a thread; same-id updates re-take the slot cleanly.
- Composition with ADR-0453: a due heartbeat is still subject to the per-thread autorun-eligibility gate (step 2b). A thread marked `never` blocks the fire BEFORE routing — eligibility decides WHETHER, this ADR decides WHERE.
- The fire seam is shared with the reactor (ADR-0132): the host binds `targetThreadId`/`inheritedPolicy` at one place, and the scheduler stays a pure caller of `AgentLoopPort`.

## Trade-offs / Negative invariants

- **One-active-per-thread is enforced at CREATION, not at fire.** `validateHeartbeatCandidate` rejects a second active heartbeat (`thread-occupied`) before persisting; the fire path trusts a well-formed row. A row that bypasses validation (hand-edited JSONL) could in principle co-occupy — but the fire path degrades safely (it routes whatever `targetThreadId` it finds; it never invents one), and `activeHeartbeatForThread` is the single SSOT scan used for the constraint. Hellgate locks: second active heartbeat → `thread-occupied`; same-id update → `ok`; paused/deleted heartbeat does NOT occupy (`activeHeartbeatForThread` returns undefined).
- **Snapshot inheritance is whole-or-nothing.** A partial `inheritedPolicy` (e.g. a 2-field posture missing `collaborationMode`) is DROPPED on load — the heartbeat never runs under a half-inherited stance. Trade-off: a corrupted snapshot silently demotes the row to "no policy" rather than failing loudly; the host's creation validation (`missing-policy`) is the loud guard, the loader's drop is defense-in-depth. Hellgate locks: partial policy → `inheritedPolicy` undefined on load.
- **Routing-to-existing-thread requires a host binding.** The scheduler only places `targetThreadId`/`inheritedPolicy` on the enqueue opts; the actual "resume that thread under that posture" is the host's binding of `AgentLoopPort.enqueueUserMessage`. Until the host binds it, a heartbeat fire is shape-correct but lands as an ordinary enqueue (the prompt runs; thread/posture routing is a no-op). This is the L4 catalog boundary. Hellgate locks: heartbeat fire carries `targetThreadId` + `inheritedPolicy` + `modelOverride`; cron fire carries ONLY `modelOverride` (`Object.keys === ["modelOverride"]`); a heartbeat with NO `targetThreadId` degrades to a fresh fire (no `targetThreadId` on opts).
- **`HeartbeatPolicySnapshot` fields are opaque strings.** The scheduler does not validate the posture vocabulary — the host owns the closed enums (ADR-0046). This keeps the scheduler slice dependency-free (it imports nothing from `@/permission`), at the cost of the scheduler being unable to reject a semantically-invalid posture; that validation is the host's responsibility at the bind site.
