# RFC — C5: force_background (preempt a turn-boundary-deferred bg task to run NOW)

**Date:** 2026-06-06
**Status:** Design (NOT implementation). This doc proposes a seam; it ships no code.
**Slice:** `@/agent/subagent-background` (the scheduler) + a small admission-queue addition + a typed control-op + one gated meta tool. No new slice.
**Candidate ADR:** 0487 (next free after 0486).
**Default posture:** OFF, byte-identical. Absent the knob + control-op, the scheduler's `fork`/`poll`/`await` surface and the bash-bg registry are byte-for-byte unchanged.
**ROI:** LOW. This is an ergonomics lever for the niche where a user/agent has parked work and then wants it RIGHT NOW. The honest core of this RFC (§3, §4) is that quanta has **no turn-boundary deferral queue today** — bg tasks either run immediately or are rejected at a concurrency cap. So "preempt a waiting task" first requires *introducing the waiting state* (a small admission queue), then the promote op. The design is deliberately minimal because the payoff is small.

---

## 1. 요약 (Summary)

`force_background` is the absorption of Cursor's `force_background_subagent` /
"run this queued task now" affordance: take a background task that is **waiting**
(not yet running) and **promote it to immediate execution**, bypassing the
turn-boundary / concurrency-cap gate that is holding it.

The crux this RFC resolves up front (and honestly): **quanta does not actually
DEFER bg tasks to a turn boundary or a wait-queue today.** Two background
substrates exist —

1. `BackgroundSubagentScheduler` (`src/agent/subagent-background.ts`) — `fork()`
   starts the runner **immediately** and returns a handle; when the running-count
   is at `maxConcurrent` (default 3) it **throws `cap-exceeded`**
   (`subagent-background.ts:474-479`). There is no queue: an over-cap fork is
   *rejected*, not *parked*.
2. `BashBgRegistry` (`src/runtime/bash-bg-registry.ts`) — a `timeout_behavior:
   "background"` bash detaches and drains **immediately**; over-cap it **evicts
   the OLDEST** (`bash-bg-registry.ts:304-306`). Again, no waiting state.

The only thing in the codebase that genuinely *waits for a future moment* is the
`SchedulerRuntime` (RRULE automations firing on a `tickOnce()` cadence,
`scheduler/runtime.ts:80`) — but those are calendar-scheduled, not "queued behind
a cap."

So a faithful `force_background` design is **two small parts**:

- **(a) Introduce the missing wait-state**: when `fork()` would exceed
  `maxConcurrent`, instead of throwing `cap-exceeded`, optionally **enqueue** the
  spec as a `queued` handle (a 5th non-terminal status). The queue drains
  automatically when a running slot frees (same `finally` hook that already runs
  `evictIfOver`, `subagent-background.ts:457-459`).
- **(b) The promote op**: `force_background(handleId)` moves a `queued` handle to
  the FRONT and, if a slot is free OR the caller opted into a transient
  over-budget burst, **starts it now** ahead of its queue position.

Both are **default-OFF**: with the knob unset, `fork()` keeps its exact current
throw-on-cap behavior (byte-identical), the queue is never populated, and the
tool/op never register. The wait-queue only exists when a host explicitly opts
in.

---

## 2. 경쟁사 레퍼런스 (Competitor reference — verified)

### 2.1 Cursor — `force_background_subagent` (the named pattern)

`src/agent/subagent-background.ts` already cites this in its own module doc as
the SOTA source (`subagent-background.ts:5-10`):

> "Cursor's `force_background_subagent` + `subagent_await` is the SOLE industry
> pattern for true detached subagent execution. Claude Code 2.1 / Codex / v0.dev
> all run subagents sequentially — the parent BLOCKS until the child returns."

Cursor's affordance is two-sided: a subagent can be *forced into the background*
(detach a would-be-blocking child), and — the half this RFC adds — a parked /
queued child can be *pulled forward* to run without waiting its turn. quanta
already absorbed the **detach** half (that IS `fork()`); the **promote-a-waiter**
half is the residual, and it only makes sense once a waiter state exists.

### 2.2 Codex — `spawn_agent` / `wait_agent` + the worker pool

From the agent-loop corpus (`agent-loop-4way-comparison`, `codex-subagent-tools`):
Codex runs a bounded worker pool (`spawn_agent` 6-tool family) and `wait_agent`
blocks on a specific child. Codex's pool admission is FIFO with a cap; it has no
explicit "jump the queue" op, but its `agent_role`/priority hints are the cue
that **admission order is a first-class, mutable concern** — which is exactly the
seam `force_background` formalizes.

### 2.3 Claude Code — auto-background after 2s (already absorbed)

quanta already has the *inbound* half of Claude's UX: `src/agent/auto-background/`
(ADR-0223) detects a tool stuck >2s and proposes "move to background?", and
`fork-on-accept.ts` flips it into `BackgroundSubagentScheduler.fork(...)`
(`auto-background/port.ts:137-148`). That is "push a slow FOREGROUND task into the
background." `force_background` is the **opposite vector**: "pull a parked
BACKGROUND task into the foreground of the bg pool (run it now)." The two are
complementary, not duplicative.

### 2.4 Synthesis (what we absorb, honestly scoped)

| Concept | Cursor | Codex | Claude | quanta C5 |
|---|---|---|---|---|
| Detach a blocking child | `force_background_subagent` | `spawn_agent` | auto-bg @2s | **already shipped** (`fork()`) |
| Park over-cap work | (implicit pool queue) | FIFO pool | n/a | **NEW** (opt-in `queued` status) |
| Pull a waiter forward | "run now" | priority hint | n/a | **NEW** (`force_background` op) |

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 There is NO turn-boundary / cap wait-queue. Over-cap = throw or evict.

- `BackgroundSubagentScheduler.fork()` throws `SubagentBackgroundError("cap-exceeded")`
  the instant `countRunning() >= maxConcurrent` (`subagent-background.ts:474-479`).
  The 4-arm status union is `"running" | "completed" | "failed" | "cancelled"`
  (`subagent-background.ts:61`) — **no `queued` arm exists**. `running` is the
  only non-terminal state (`subagent-background.ts:60`).
- `fork()` starts the runner immediately via `startRun(entry)`
  (`subagent-background.ts:499`); there is no admission gate between `fork` and
  `startRun`.
- The bash-bg registry has the same "no wait" posture: over `maxEntries` it
  **evicts the OLDEST** running shell (`bash-bg-registry.ts:285-296, 304-306`),
  it does not queue the new one.

**Grep verdict:** `grep -n "queued\|queue\|pending\|backlog" src/agent/subagent-background.ts`
→ 0 hits. There is literally nothing to "force." This RFC must *create* the
waiting state before it can promote out of it. Stated honestly because it changes
the ROI math: C5 is not "wire an existing parked-task promoter," it is "add a
small queue + a promoter," which is why ROI is LOW.

### 3.2 The slot the promote op rides already exists (control-op family)

- Typed control-ops are routed by `src/agent/control-op-handler.ts`
  (`cancel_subagent`, `interrupt`; `control-op-handler.ts:1-30`). `cancel_subagent`
  mutates a registry from OUTSIDE the model turn and returns a 3-way outcome
  (`stopped | not_found | registry_absent`, `control-op-handler.ts` `CancelSubagentOutcome`).
  `force_background` is a sibling: a typed op that mutates scheduler admission
  state and returns a small closed outcome union.

### 3.3 The drain hook the queue needs already exists

- Every terminal transition runs `evictIfOver()` inside `startRun`'s `finally`
  (`subagent-background.ts:457-459`). That is the EXACT point where a freed slot
  should pull the next `queued` entry. The queue-drain is a 3-line addition to an
  existing hook, not a new pump loop.

### 3.4 Concurrency cap + retained cap are already closed-port injected

- `maxConcurrent` (default 3) and `maxRetained` (default 32) are
  constructor-injected (`subagent-background.ts:367-368`), so a test/host can pin
  them deterministically. The queue MUST respect the same `maxConcurrent` when
  draining — `force_background` is the ONLY path allowed to transiently exceed it
  (and only behind an explicit `allowBurst` opt, §4.3).

---

## 4. 설계 (Design — closed-port DI)

### 4.1 Add a `queued` admission state (opt-in, default-OFF)

Extend the status union to a **5-arm** set, with `queued` as a second
non-terminal state:

```
SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled"
```

`fork()` gains one branch, gated by a constructor opt `admissionQueue?: boolean`
(default false ⇒ byte-identical throw-on-cap):

```
fork(spec):
  if countRunning() >= maxConcurrent:
    if !admissionQueue:  throw SubagentBackgroundError("cap-exceeded")   // UNCHANGED
    else: create entry { status:"queued" }, append to FIFO, return handle  // NEW
  else: start immediately (today's path)
```

A `queued` entry holds its `spec` + `abortCtrl` but has NOT called `startRun`.
`poll`/`list`/`await` already project from `entry.result` so they surface
`queued` for free; `await` on a queued handle blocks until it runs AND completes
(its `promise` is wired at promotion time, see §4.4).

### 4.2 Auto-drain on slot-free (no new pump)

In `startRun`'s existing `finally` (`subagent-background.ts:457-459`), after
`evictIfOver()`, add `drainQueue()`:

```
drainQueue():
  while countRunning() < maxConcurrent:
    next = first FIFO entry with status === "queued"
    if next === undefined: break
    promote(next)   // status → running, wire promise via startRun
```

This is the natural FIFO admission Codex's pool implies — no `force_background`
needed for the common case. The promote op is ONLY for "I want THIS one ahead of
its FIFO position, possibly now."

### 4.3 The `force_background(handleId, opts?)` promoter

```
force_background(id, opts?: { allowBurst?: boolean }): ForceBackgroundOutcome
```

Outcome — a closed union mirroring `CancelSubagentOutcome`:

```
type ForceBackgroundOutcome =
  | "promoted_now"        // a slot was free (or burst) → started immediately
  | "moved_to_front"      // no slot free, no burst → re-ordered to FIFO head; runs next
  | "already_running"     // handle was already running/terminal → no-op
  | "not_found"           // unknown handle
  | "queue_disabled"      // admissionQueue off ⇒ nothing to promote (default path)
```

Logic:
- `not_found` / terminal / running ⇒ early closed-outcome (no throw — sibling of
  `cancel_subagent`'s no-throw posture, `control-op-handler.ts`).
- queued + slot free ⇒ `promote()` now → `promoted_now`.
- queued + no slot + `allowBurst:true` ⇒ promote NOW, transiently exceeding
  `maxConcurrent` by AT MOST 1 (§8 R2) → `promoted_now`.
- queued + no slot + no burst ⇒ move to FIFO head → `moved_to_front` (runs the
  instant the next slot frees, ahead of everyone else).

### 4.4 Promote wires the runner exactly as `fork` would have

`promote(entry)` is the deferred half of today's `fork` body
(`subagent-background.ts:480-506`): set `status="running"`, build
`startRun(entry)`, replace the placeholder `Promise.resolve()` with the real
promise (the same `;(entry as {promise}).promise = realPromise` move at
`subagent-background.ts:500`). Cancellation, eviction, and serialize/hydrate all
already handle a running entry — **no new lifecycle paths**. A `queued` entry that
is `cancel()`-ed before promotion goes straight to `cancelled` (its `abortCtrl`
already exists) and is removed from the FIFO.

### 4.5 Interaction with the turn loop

`force_background` is a **control-op**, not a turn-step. Like `cancel_subagent`
it is routed by `control-op-handler.ts` from OUTSIDE the model's tool-call path
(submission-op or `/bg now` slash), so it cannot stall the parent turn: it mutates
scheduler admission state and returns synchronously. The parent turn keeps running
(the explicit invariant the cancel-op family already honors,
`control-op-handler.ts` "the parent turn KEEPS running"). The promoted subagent
runs on the scheduler's own async lineage (`startRun`), never inline on the loop.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF)

- Constructor opt `admissionQueue?: boolean` on
  `BackgroundSubagentSchedulerOpts` (default false). The host opts in at
  composition (`apps/agent` bootstrap, where `defaultBackgroundSubagentScheduler`
  is constructed). Mirror env `QUANTA_SUBAGENT_BG_QUEUE` parsed at that one site.
- **Default-OFF byte-identical**: `admissionQueue` absent ⇒ `fork()` throws on
  cap exactly as today (`subagent-background.ts:474-479`), no `queued` entry can
  exist, `drainQueue` is never reachable (no queued entries), and
  `force_background` always returns `queue_disabled`.

### 5.2 Tool + control-op

- **Control-op** `force_background` in the typed family alongside
  `cancel_subagent` (`control-op-handler.ts`) — the primary surface (host/slash
  driven). No-throw; returns `ForceBackgroundOutcome`; emits a
  `force_background` AgentEvent the way `cancel_subagent` emits `subagent_cancel`.
- **Optional model-facing tool** `subagent_force_background` in
  `src/tool/subagent-bg/` (sibling to `subagent_fork`/`poll`/`await`,
  `tool/subagent-bg/index.ts:41-45`). `risk: "meta"` (it reorders the agent's own
  pool — no new exec capability; it cannot exceed the cap except by ≤1 under
  explicit `allowBurst`). Wired through the same duck-typed
  `BackgroundSubagentSchedulerPort` so `@/tool` keeps its no-`@/agent` fence
  (`tool/subagent-bg/index.ts:8-15`).

### 5.3 Manifest row (risk: meta)

```ts
{
  name: "subagent_force_background",
  origin: "@/tool/subagent-bg",
  gate: { kind: "config-slot", slot: "subagent.bgQueue", env: "QUANTA_SUBAGENT_BG_QUEUE" },
  default: {},                       // OFF everywhere (no surface key ⇒ opt-in)
  risk: "meta",
  adr: "0487",
  note: "Promote a queued background subagent to run NOW (or to the FIFO head). " +
        "Only meaningful when subagent.bgQueue admission-queue is on; default-OFF. " +
        "allowBurst may transiently exceed maxConcurrent by at most 1.",
}
```

The drift guard (`tests/unit/tool-surface-manifest-hellgate.test.ts`) requires a
manifest row for every new tool name — recall it caught `apply_patch_structured`
as an fc-orphan (`manifest.ts:13-21`). Add the row + matching fc node.

### 5.4 Feature catalog (fc)

Add a `force_background` fc node on the subagent/scheduling axis under
`tools/feature-catalog/` (sibling to the `subagent_fork`/background-scheduler
nodes), and wire reachability so `feature-catalog-reachability.test.ts` sees the
`force_background` op → scheduler `promote` path. Update `baseline.json` so the
fc audit stays green.

### 5.5 Slice / fence

- All scheduler changes stay inside `src/agent/subagent-background.ts` (the
  plane-clean store: imports only `@/subagent` types + `node:crypto`,
  `subagent-background.ts:50-56`). The queue is in-memory `Map`/FIFO, same as the
  existing store — no new I/O, no new import.
- The tool stays in `src/tool/subagent-bg/` behind the duck-typed port
  (`tool/subagent-bg/index.ts:8-15`); the composition root in
  `src/agent/tier1/subagent-bg.ts` adapts the concrete scheduler.

---

## 6. 테스트 계획 (Hellgate + e2e)

New `tests/unit/force-background-hellgate.test.ts`, scheduler built with an
injected fake `runner` + pinned `now`/`idGen`/`maxConcurrent` (the closed-port
seams at `subagent-background.ts:367-370`).

### 6.1 Hellgate (adversarial)

1. **Default-OFF byte-identity.** `admissionQueue` absent: 4th `fork()` over
   `maxConcurrent=3` still THROWS `cap-exceeded` (assert exact code); no `queued`
   status ever appears; `force_background(any)` → `queue_disabled`.
2. **Queue admission.** `admissionQueue:true`, fill 3 running, `fork()` 4th →
   handle with `status:"queued"`; `poll` shows `queued`; `list` includes it.
3. **Auto-drain FIFO.** Complete one running child → the OLDEST queued entry
   auto-promotes to `running` (no `force_background` call); order is FIFO.
4. **promote_now.** With a free slot, `force_background(queuedId)` → `promoted_now`
   and the runner started (assert the fake runner saw the spec).
5. **moved_to_front.** No free slot, no burst: `force_background(qLast)` →
   `moved_to_front`; next slot-free promotes `qLast` BEFORE `qFirst` (jumped the
   line).
6. **allowBurst cap discipline.** No free slot, `allowBurst:true`:
   `force_background` → `promoted_now`; `countRunning()` is `maxConcurrent+1` and
   NEVER `+2` (a second burst while still over-cap is rejected to `moved_to_front`,
   §8 R2).
7. **No-throw outcomes.** `force_background("bogus")` → `not_found`;
   `force_background(runningId)` → `already_running`; `force_background(doneId)` →
   `already_running`. None throw.
8. **cancel a queued handle.** `cancel(queuedId)` before promotion → `cancelled`,
   removed from FIFO, never runs (fake runner never invoked); `force_background`
   on it afterwards → `already_running` (terminal).
9. **serialize/hydrate.** A `queued` entry serialized then hydrated across a
   "restart" reborn as `failed` "lost across restart" (a queued task had no
   running promise to resume) — mirrors the running-entry resurrection rule
   (`subagent-background.ts:643-652`). Assert it does NOT silently re-run.

### 6.2 e2e

Through the control-op router: enqueue 4 forks (cap 3) so #4 is `queued`; route a
`force_background(#4, {allowBurst:true})` submission-op; assert #4 runs to
completion while the parent turn's `await(#4)` resolves and the parent loop never
blocked. Flip the knob off and assert the same submission sequence is a no-op
(`queue_disabled` + #4 fork threw cap-exceeded upstream).

---

## 7. 단계 (Phases)

- **Phase 1 (queue, this RFC's core):** `queued` status arm + `admissionQueue`
  opt + `drainQueue` in the `finally` hook + serialize/hydrate handling. Hellgate
  1–3, 9. Default-OFF. This alone is the genuinely-useful half (FIFO admission
  instead of throw-on-cap).
- **Phase 2 (the promoter):** `force_background` control-op + outcome union +
  `allowBurst`. Hellgate 4–8. The `subagent_force_background` model-facing tool +
  manifest/fc rows. e2e §6.2.
- **Phase 3 (optional surfaces, deferred):** `/bg now <id>` slash command + a
  status pill showing `queued(N)`; auto-promote heuristic (NOT in scope per
  `no-heuristics-only-validated` — no threshold without measurement).

---

## 8. 리스크 / 대안 (Risks & Alternatives)

**R1 — the feature has thin value (the headline, honest risk).** ROI is LOW
because (a) the common case is already covered by auto-drain FIFO (Phase 1), and
(b) a user who wants work to run now can usually just `fork()` it (which runs
immediately unless at cap). `force_background` only earns its keep in the narrow
window: at-cap + the parked task matters more than the running ones. *Mitigation:*
ship Phase 1 (the queue) for its own sake (FIFO > throw-on-cap is a real UX win);
treat the promoter (Phase 2) as optional polish gated behind its own knob so it
costs nothing when unused.

**R2 — `allowBurst` defeats the concurrency cap (the security/resource risk).**
A promoter that exceeds `maxConcurrent` could be used to spawn unbounded parallel
subagents. *Mitigation, fail-closed:* burst is capped at **+1** over
`maxConcurrent` — a second `force_background{allowBurst}` while already over-cap
degrades to `moved_to_front`, never a second over-budget start (hellgate 6). The
cap is the resource ceiling; burst is a one-slot courtesy, not a bypass.

**R3 — changing `fork()`'s throw-on-cap behavior breaks callers.** Today callers
branch on `SubagentBackgroundError("cap-exceeded")`
(`subagent-background.ts:162-170`). *Mitigation:* `admissionQueue` defaults false,
so the throw path is byte-identical for every existing caller; only a host that
explicitly opts into the queue sees `fork()` return a `queued` handle instead of
throwing. The behavioral change is opt-in, not a default flip.

**R4 — queued-task starvation / staleness.** A `moved_to_front` storm could
starve FIFO-fair tasks; a long-queued task may reference stale state by the time
it runs. *Mitigation:* `moved_to_front` is strictly LIFO-at-head (last forcer
wins the head) so it cannot livelock; `prune(maxAgeMs)` already drops stale
TERMINAL entries (`subagent-background.ts:584-596`) and should be extended to drop
`queued` entries older than `maxAgeMs` (a queued task abandoned for an hour is
almost certainly irrelevant). No auto-promote heuristic without measurement
(`no-heuristics-only-validated`).

**R5 — interaction with serialize/hydrate across restart.** A `queued` entry has
no in-flight promise, so it cannot resume. *Mitigation:* reborn as `failed`
"lost across restart" like a running entry (`subagent-background.ts:643-652`) —
never silently re-run, which would double-execute a side-effecting task (hellgate
9).

**Alternative considered — reuse the `SchedulerRuntime` RRULE engine.** Rejected:
that engine is calendar/cron-scheduled (`scheduler/runtime.ts`), a different axis
("fire at 9am") from "run this parked task now." Bolting a priority queue onto it
would conflate two clean abstractions. The bg-subagent scheduler is the right
home.

**Alternative considered — do nothing.** Defensible given the LOW ROI. The
counter-argument is Phase 1 alone (queue instead of throw-on-cap) is a small,
self-justifying improvement, and Phase 2 then rides for cheap. Net: ship Phase 1,
make Phase 2 opt-in, do not over-invest.

---

## 9. 코드 위치 요약 (Code-location summary)

**Audited (read, grounds the design):**
- `src/agent/subagent-background.ts` — the scheduler. `fork()` throw-on-cap
  (`:474-479`), 4-arm status union (`:60-61`), `startRun`+`finally` drain hook
  (`:449-461`), constructor caps (`:367-368`), serialize/hydrate resurrection
  (`:643-652`), prune (`:584-596`). **No queue exists** (grep: 0 `queued` hits) —
  this RFC adds the 5th status + FIFO.
- `src/agent/tier1/subagent-bg.ts` — duck-typed wire of the scheduler into the
  tier-1 tool builder (`:30-38`).
- `src/tool/subagent-bg/index.ts` — the 3 bg tools + no-`@/agent` fence
  (`:8-15, 41-45`); `subagent_force_background` joins here.
- `src/runtime/bash-bg-registry.ts` — the OTHER bg substrate; evict-oldest, not
  queue (`:285-296, 304-306`). Out of scope (one-shot shells, not promotable
  tasks) but cited as proof "no wait-queue anywhere."
- `src/agent/control-op-handler.ts` — typed control-op family
  (`cancel_subagent`, no-throw, 3-way outcome) that `force_background` joins.
- `src/agent/auto-background/port.ts` — the INVERSE vector (foreground→bg @2s,
  `:137-148`); cited to show `force_background` is complementary, not duplicative.
- `src/scheduler/runtime.ts` — the only true deferral engine (RRULE), rejected as
  the home (`:40-78`).

**To add (implementation, NOT in this RFC):**
- `src/agent/subagent-background.ts` — `queued` status arm, `admissionQueue` opt,
  FIFO + `drainQueue`, `forceBackground(id, opts)` method, prune-queued.
- `src/agent/control-op-handler.ts` (+ submission types) — `force_background` op +
  `ForceBackgroundOutcome` union + AgentEvent.
- `src/tool/subagent-bg/force-background.ts` — the model-facing tool.
- `src/tool/surface/manifest.ts` — the `subagent_force_background` row (§5.3).
- `tools/feature-catalog/…` + `baseline.json` — the `force_background` fc node.
- CLI REPL — optional `/bg now <id>` slash.
- `tests/unit/force-background-hellgate.test.ts` — the §6 battery.
