# ADR-0479: Team DAG coordination — task dependency DAG over the subagent batch fan-out

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0436 (`spawn_batch` structured fan-out — the flat parallel worker pool this ADR layers dependency ordering onto; the `dependencies` map is an additive input field on its schema)
  - ADR-0416 (managed-subagent mailbox — the coordination TRANSPORT; this ADR is Capability A of the same multi-agent plan, `depends_on: subagent-mailbox`)
  - ADR-0196 (MCP Tasks capability — the canonical `TaskState` union; `dag.ts` MIRRORS it locally because the `src/subagent/**` fence forbids `@/mcp`, and the union is rmcp-0.15-closed so the mirror is safe)
  - ADR-0431 (MCP tasks live binding — sibling of the same task-lifecycle axis)
- **참조**:
  - `src/subagent/coordination/dag.ts` — PURE / NO-THROW core. `TaskNode {id, dependsOn[], state}` + closed `TaskState` mirror; `detectCycle(nodes) → CycleCheck` (3-colour iterative DFS, rejects cycle / unknown-dep / duplicate-id); `readyTasks` / `blockedTasks` (monotone fixpoint) / `onComplete(nodes,id) → {nodes, newlyReady}`. Deterministic `byteCompare` order.
  - `src/subagent/coordination/dag-gate.ts` — effectful seam. `createDagGate(initial) → CreateGateResult` (validates BEFORE returning a gate); `DagGate` (`awaitReady`/`markComplete`/`markFailed`/`ready`/`blocked`); closed `GateOutcome = "ready" | "blocked"`; `wrapRunnerWithDagGate` + `DAG_BLOCKED_TEXT` sentinel.
  - `src/subagent/coordination/index.ts` — slice barrel.
  - `src/tool/subagent-batch/port.ts` — duck-typed `BatchDagNode` / `BatchDagGate` / `BatchDagGateFactory` (the `@/tool` slice mirror; it may NOT import `@/subagent`).
  - `src/tool/subagent-batch/run-batch.ts` — `runBatch` builds the gate from the items' `dependencies`, `await gate.awaitReady(id)` OUTSIDE the semaphore, `settle()` marks the gate exactly once per item.
  - `src/tool/subagent-batch/batch.ts` — `spawn_batch` input schema's optional `dependencies: Record<itemId, itemId[]>` field.
  - `src/agent/tier1/subagent-batch.ts` — composition root: adapts `createDagGate` behind `BatchDagGateFactory`, injected ONLY when `runtimeConfig().teamDag`.
  - `src/shared/runtime-config.ts` — `teamDag` knob (`QUANTA_TEAM_DAG === "1"`).
  - Tests: `tests/unit/coordination/team-dag-hellgate.test.ts` (31 core cases), `tests/unit/coordination/team-dag-batch-e2e-hellgate.test.ts` (gate-over-`runBatch` wiring), `tests/unit/coordination/team-dag-spawn-batch-live-e2e-hellgate.test.ts` (REAL `createDagGate` driving REAL `runBatch`).
  - Feature catalog: `tools/feature-catalog/features/09-integration/team-dag-coordination.yaml`.

## 맥락

`spawn_batch` (ADR-0436) fans out N templated child subagents over a bounded worker pool — but **flat and unordered**: every item is admitted to the semaphore as soon as a slot frees, in no relation to the others. That is correct for an embarrassingly-parallel "do X for each of these N things" batch, but it cannot express the common multi-agent shape where one worker **depends on another's output**: a `summarize` task that must run only after its three `gather` tasks finish, a `merge` that fans in two branches, a pipeline `A → B → C`.

Today the user's only recourse is to issue the dependent items in a *separate* `spawn_batch` call after the first returns — serializing the whole wave and losing the partial parallelism inside each stage. Worse, there was no way to say "if the upstream task FAILS, do not even dispatch the downstream one" — a flat batch would fire the dependent against missing input.

Claude Code's `--agent-teams` models exactly this: a leader fans work out as a **task dependency DAG**, and the harness schedules each node only when its prerequisites complete. quanta already had the two halves — the mailbox TRANSPORT (ADR-0416) and the parallel fan-out (ADR-0436) — but not the **coordination protocol** that orders them. This ADR absorbs the task-dependency-DAG arm of `--agent-teams` (the sibling leader-broker and team-idle-barrier arms are waves B/C — pure cores sealed, host triggers deliberately NOT wired here).

## 결정

A **PURE, NO-THROW DAG core** in `@/subagent/coordination` (`dag.ts`) + a **bounded effectful gate** (`dag-gate.ts`) that drives it over the *unmodified* `spawn_batch` worker pool. Default-OFF behind `QUANTA_TEAM_DAG`.

### The DAG data model (`dag.ts`, PURE)

```
TaskNode { id; dependsOn: readonly string[]; state: TaskState }
TaskState = "pending" | "in_progress" | "completed" | "failed" | "cancelled"
```

`dependsOn` is the `blockedBy` edge set (the ids a task is blocked by); the reverse `blocks` edges are *derived*, never stored. `TaskState` is a LOCAL MIRROR of `@/mcp/tasks/types#TaskState` (ADR-0196) — the `src/subagent/**` biome fence forbids `@/subagent → @/mcp`, and the union is rmcp-0.15-closed (a 6th arm would be an MCP spec change), so the mirror is safe and exhaustiveness-anchored at the bottom of the file (`_ALL_TASK_STATES`). The whole core is a **NO-THROW leaf**: no I/O, no clock, no `Date.now`/`Math.random`/`localeCompare`. Every adversarial input returns a typed value, never an exception — so the side-effecting layer never has to `try/catch` the model.

Four total functions:

- **`detectCycle(nodes) → { ok: true } | { ok: false; cycle }`** — rejects, at submit, three classes of bad graph, each carrying the offending path: a **cycle** (iterative 3-colour white/grey/black DFS — a grey→grey back-edge is a cycle; iterative, not recursive, to survive a 5000-deep chain without a stack overflow), an **edge to an unknown id** (a dangling dep is a modeling bug surfaced loudly rather than a node made permanently un-ready), and **duplicate ids** (an ambiguous graph). WHY: a bad graph is NEVER dispatched.
- **`readyTasks(nodes)`** — the `pending` nodes whose EVERY `dependsOn` is `completed`, in deterministic `byteCompare` order (locale-independent, never input order). This is the dispatch frontier.
- **`blockedTasks(nodes)`** — the `pending` nodes that can NEVER become ready because a dependency is `failed`/`cancelled`, DIRECTLY or TRANSITIVELY. WHY a **monotone fixpoint** over the dead set (seed = directly failed/cancelled; a node joins once ANY dep is dead, until no change) rather than recursion: it is **cycle-safe by construction** even on a graph that was NOT cycle-checked (a recursive memo would poison a `false` for a node whose only dead path runs through a still-visiting cycle member) and stack-safe on a long chain. This is the **dead-branch surface** — the leader sees the dead branch instead of waiting forever (the liveness invariant).
- **`onComplete(nodes, id) → { nodes, newlyReady }`** — marks `id` `completed` and returns EXACTLY the set it just unblocked. Only a `pending`/`in_progress` node transitions; completing an unknown id, an already-`completed` node, or — load-bearing — a TERMINAL-FAILURE node is a no-op. WHY the failure case matters: a dead branch must STAY dead; `onComplete` must NEVER resurrect a `failed`/`cancelled` node into `completed` (which would silently re-arm its dependents). Idempotent on re-completion.

### The dispatch gate (`dag-gate.ts`, effectful seam)

`createDagGate(initial)` runs `detectCycle` FIRST and returns a typed rejection (`reason: "cycle" | "invalid"`, with the offending `cycle` path) for any bad graph BEFORE a gate exists — so a bad graph can never be dispatched. On success it returns a live `DagGate`:

- `awaitReady(id) → Promise<GateOutcome>` — resolves `"ready"` (deps all completed) or `"blocked"` (a transitive dep failed/cancelled, OR the id is unknown — it can never be dispatched). `GateOutcome` is a **closed 2-arm enum**, not free text, so the dispatcher branches exhaustively.
- `markComplete(id)` / `markFailed(id, state?)` — apply a state transition and `flush()` any waiters whose node is now ready/blocked.

`wrapRunnerWithDagGate(inner, gate, idOf)` is the wiring primitive: it gates each child call on `awaitReady`, runs the inner runner, then marks the node `completed` (ok) / `failed` (not-ok or threw). A `"blocked"` outcome returns a typed dead-branch result (`DAG_BLOCKED_TEXT`) WITHOUT dispatching and marks the node failed so its OWN dependents block in turn. A request whose id is not in the graph runs UNGATED — a batch that mixes DAG and non-DAG items degrades gracefully.

### How the batch runner consumes the DAG

The dependency edges arrive **per `spawn_batch` call**, not at build time, so the composition root injects a per-call **factory** (`BatchDagGateFactory`) rather than wrapping the runner once. In `runBatch` (`run-batch.ts`):

1. Item ids derive from `id_field` (object items) or `String(index)`. `BatchDagNode[]` are built `pending`.
2. The gate is built ONLY when `deps.dagGateFactory` is present AND the items actually declare edges (`hasEdges`). A dependency **KEY** that is not an item id is rejected SYMMETRICALLY with the gate's dangling-**VALUE** rejection (a typo whose ordering constraint would otherwise silently vanish). A cyclic/dangling/duplicate/unknown-key graph ⇒ the WHOLE batch returns all-error (`dag rejected: …`), zero dispatch.
3. Each task does `await gate.awaitReady(id)` **BEFORE** acquiring a worker semaphore slot — the wait is OUTSIDE the slot, so a blocked item never holds a worker (deadlock-free). A `"blocked"` outcome settles the item as a typed `dependency failed — task blocked` error WITHOUT spawning a worker.
4. `settle()` marks the gate **EXACTLY ONCE** per item on EVERY terminal path (ok / worker-failed / timeout / cancelled / template-broken / blocked) — `markComplete` on ok, `markFailed` otherwise — so a dead/cancelled item always releases its transitive dependents (no fan-in deadlock).

The `@/tool/subagent-batch` slice fence forbids `@/tool → @/subagent`, so `BatchDagNode`/`BatchDagGate`/`BatchDagGateFactory` are **duck-typed mirrors**; the composition root (`src/agent/tier1/subagent-batch.ts`) is the only place that imports the real `createDagGate` and adapts it behind the factory.

### Default-OFF posture

`runtimeConfig().teamDag` is a strict `QUANTA_TEAM_DAG === "1"` opt-in. The tier1 builder injects the `dagGateFactory` ONLY when the knob is on:

```ts
...(runtimeConfig().teamDag ? { dagGateFactory } : {})
```

Knob OFF (or a batch with no `dependencies` map) ⇒ no factory ⇒ `runBatch` is **byte-identical** to the pre-ADR flat parallel pool; the `dependencies` field is simply ignored. The gate can only RESTRICT dispatch order and BLOCK dead branches an existing batch would have fired blindly — it never changes a single-stage batch.

## 결과

- `spawn_batch` can now express inter-task dependencies in ONE call: pipelines, diamonds, fan-in/fan-out — fan-out still runs at full parallelism *within* a stage, bounded by the existing worker ceiling, with no edit to the sealed ADR-0436 slice.
- A failed/cancelled upstream surfaces its dependents as a typed dead branch (`dependency failed — task blocked, not dispatched`) instead of either firing the dependent against missing input or hanging forever — the leader sees the dead branch.
- No new timers, no clock, no `Date.now`/`Math.random` anywhere in the path: the only async is plain promise plumbing (a per-node deferred resolved when readiness changes), so the entire hellgate suite runs with no LLM, no disk, no real timers.
- The core is reusable: `dag.ts` is pure leaf logic that the (not-yet-wired) leader-broker (wave B) and team-idle-barrier (wave C) sit alongside in the same slice.

## Trade-offs / Negative invariants

- **Cycle detection is fail-closed at submit.** A cyclic graph is rejected WHOLE (`createDagGate` → `{ ok: false }`, `runBatch` → every item `dag rejected`, zero dispatch) — we never dispatch the acyclic prefix of a cyclic graph. Hellgate pins self-loop (A→A), 2-node (A→B→A), and 3-node (A→B→C→A) rejection, each carrying the cycle member ids.
- **Dangling and duplicate edges are rejected, not silently tolerated.** An edge to an unknown id, or a dependency KEY that is not an item id, would silently make a node permanently un-ready / silently drop an ordering constraint — both are rejected (typed) symmetric with the dangling-value rejection. Duplicate ids ⇒ ambiguous graph ⇒ rejected.
- **Deadlock-free by construction.** `awaitReady` is awaited OUTSIDE the worker semaphore, so a blocked item never holds a slot; and `settle()` marks the gate exactly once per item on EVERY terminal path (template-broken / cancelled-before-start / timeout / worker-failed / blocked included), so every fan-in eventually releases. The live e2e proves a failed-dep batch SETTLES (no hang).
- **A failed/cancelled dependency blocks its dependents PERMANENTLY and TRANSITIVELY** — this is intentional dead-branch propagation, NOT a retry. `blockedTasks` is computed via a monotone fixpoint so it is correct even on a graph carrying a cycle (the audit-#1 memo-poison regression: `X↔Y` where `Y` also depends on a cancelled node ⇒ X, Y, Z ALL blocked; the old recursive memo wrongly returned only `["Y"]`). A pure cycle with NO dead member blocks nothing (terminates, no false-dead).
- **No resurrection.** `onComplete` on a `failed`/`cancelled` node is a no-op (audit-#2 regression) — a dead branch must STAY dead even though `markComplete(id)` is a public method callable on any id.
- **Determinism is locale-independent.** `readyTasks` / `blockedTasks` / `newlyReady` are sorted by `byteCompare`, never `localeCompare`, never input order — telemetry and tests assert a stable frontier.
- **Scope: Capability A only.** No leader-broker (wave B, `QUANTA_TEAM_BROKER` — pure core sealed, host trigger NOT wired) and no team-idle barrier (wave C, `QUANTA_TEAM_IDLE` — pure core sealed, host beacon NOT wired). The `id_field`-derived node id is the ordering key; a future leader that wants to address a node by a stable name beyond the batch's `id_field` is an additive change.
