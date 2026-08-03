# RFC-07 — Claude orchestration: current-HEAD final scope

**Status:** FINAL PLAN — current `main@0a00ced392102073fe35eccd202bca92cabd71dc` audit complete; implementation not started.
**Decision:** the original audit's “structural maximum gap” was false. The workflow engine and the surrounding orchestration substrate are live. This RFC admits exactly three residual deltas and forbids reopening the rest.

## Final verdict

| candidate | current-HEAD truth | final action |
|---|---|---|
| Declarative Workflow | `src/workflow/index.ts` exports `agent`, `parallel`, `pipeline`, `phase`, `fanout` (plus `sequence`/`loop`); `run_workflow` compiles and executes through the real subagent runner; `QUANTA_WORKFLOW` controls registration | **DROP** — no second engine, DSL, executor, semaphore, or run registry |
| Task DAG | canonical plan store already owns `dependencies`, cycle rejection, phases, CAS version, `assignee`, and five CRUD/read tools | **KEEP only D3 projection** — no second task store/API |
| mailbox `to:id` | `subagent_send_message`/`subagent_read_messages`, stable `mailboxLabel`, parent/broadcast addressing, team fence, and per-agent inbox are live | **KEEP only D1 named address resolution** |
| fork/background/poll/stop | `fork_turns`, named-agent spawn definitions, background `TaskRegistry`, `task_output`, `task_stop`, and owner/lineage checks are live | **DROP** |
| named registry | `.quanta/agents/*.md` and `.claude/agents/*.md` load through `NamedAgentRegistry`; tool filters narrow only | **DROP registry work** — D1 resolves a live task name, not a definition file |
| lineage/ownership | `TaskRegistry.mailboxLabel`, spawn-owner ledger, `createTargetResolver`, `task_output` ownership denial, and child ownership narrowing are live | **REUSE; never bypass** |
| Monitor | background shell registry, reactor sources, self-wake, and the Unix-socket watch bridge exist; per-line delivery does not | **KEEP D2, MED, measure-first** |
| RemoteTrigger / remote isolation | hosted control-plane features; local webhook/reactor/scheduler and worktree isolation already cover the in-repo class | **DROP** |
| `dontAsk` | `acceptEdits` and `auto` already sit between `default` and `bypass`; HARD_DENY precedes mode handling | **DROP** — do not add another `PermissionMode` literal |
| REPL | QuickJS code-mode sandbox and registerable tool surface are live; each cell is intentionally torn down | **DROP** — no session-persistent JS heap |
| workflow resume/cache | persistence authority belongs to RFC-01 and product value is unmeasured | **DROP from RFC-07**; no bespoke workflow store |

The only admitted scope is:

1. **D1 named-`to:` resolver — S / READY**
2. **D2 line-stream watch — MED / NOT READY until measurement admission**
3. **D3 owner/blocks read projection — S / READY**

## Single-owner design

### D1 — named-`to:` resolver (S)

Goal: `subagent_send_message({to:"reviewer", ...})` reaches the one live, caller-visible child whose exact `agentType`/display label is `reviewer`.

Authoritative inputs already exist:

- `TaskRegistry.list()` / `TaskRecord.agentType` / `TaskRecord.mailboxLabel` — live task identity and routable mailbox address.
- `ownersForRegistry(registry)` + `ROOT_LINEAGE` — the same spawn-owner ledger used by `list_agents`, `followup_task`, `continue_from`, and `task_output`.
- `createTargetResolver` — current status/self/ownership resolution policy for task delivery.

Implementation boundary:

- Extract/factor one host-owned resolution core in `src/agent/subagent-delivery/target-resolver.ts`; do not create a global name registry.
- The tool slice receives only an optional narrow resolver callback. Literal `"parent"`, `"*"`, and a concrete mailbox id keep their existing path.
- A unique exact name match among **running records owned by the caller lineage** resolves to that record's `mailboxLabel`.
- Two visible matches are `ambiguous` and fail closed with candidate task ids; no nearest-depth, first-win, prefix, fuzzy, or case-fold heuristic.
- A foreign-lineage match is indistinguishable from no match. It must not disclose the task, name, status, or mailbox label.
- No match preserves the existing raw-id path so legacy concrete addresses remain compatible.
- Inherit the existing `QUANTA_SUBAGENT_MAILBOX` admission. Do not add a second env knob or a second address store.

Owner files:

- `src/agent/subagent-delivery/target-resolver.ts`
- `src/agent/tier1/subagent-mailbox.ts`
- `src/tool/subagent-mailbox/index.ts` (narrow callback consumption only)

RED / DoD:

- Same-depth `reviewer` and `tester`: `to:"reviewer"` is read only by reviewer.
- Duplicate visible `reviewer`: typed ambiguity, zero enqueue.
- A sibling lineage owns the only `reviewer`: zero delivery and no existence disclosure.
- Existing `to:"parent"`, `to:"*"`, and concrete mailbox-id fixtures stay byte-identical.
- Removing the owner-ledger filter or unique-match check makes the hellgate RED.

Stop rule: if implementation requires a new registry, inferred lineage from a user string, or mutation of `NamedAgentRegistry`, stop and redesign around `TaskRegistry`.

### D2 — line-stream watch (MED, measure-first)

This is a real absence, but not yet an admitted build. `/loop`, reactor polling, and `bash_await(regex)` may already satisfy the product need at lower complexity.

Admission measurement:

- First record a real use case requiring **every delimited stdout/stderr line**, not only completion or first regex match.
- Compare existing `bash_await`/reactor polling against a fixture with split chunks, split UTF-8, no trailing newline, non-zero exit, and a bounded burst.
- Build only if the consumer requires per-line ordering/latency that the existing completion/poll path cannot meet. “Claude has Monitor” is not admission evidence.

If admitted, the design is constrained as follows:

- Extend `BashBgRegistry.register` with an optional observation sink at its existing drain owner. Do not spawn through a new watcher process manager and do not poll truncated snapshots for deltas.
- A new pure line framer converts arbitrary stdout/stderr chunks to ordered `{shellId, stream, sequence, line}` records; it flushes the final unterminated line exactly once.
- The existing reactor-watch bridge/self-wake path consumes those records. Add a typed `shell_id` evidence variant if necessary; never mislabel a shell id as `log_path`.
- `/watch` is operator-only and returns the canonical background `shellId`; cancellation uses the existing `bash_kill`/registry lifecycle, not `task_stop` and not a second kill path.
- Bound line bytes, queued notifications, and rate. Overflow emits one dropped-count notice. Non-zero exit, signal death, observer failure, and rate cutoff are terminal visible events; silence is never reported as success.
- Gate OFF means no observer supplied, no extra drain call, no tool/help/event change.

Owner files if admitted:

- `src/runtime/bash-bg-registry.ts` (single process/drain owner)
- new pure leaf `src/reactor/line-framer.ts`
- `src/reactor/types.ts` / `src/reactor/self-wake.ts`
- `src/apps/cli/reactor-watch-bridge.ts` and the operator `/watch` surface

RED / DoD:

- `"a\n"`, split `"b"+"\n"`, split UTF-8, and trailing `"c"` produce exactly `a,b,c` in sequence.
- Non-zero exit after output produces the lines then one terminal failure event.
- Burst beyond the cap remains bounded and reports the exact dropped count.
- `bash_kill(shellId)` stops further line delivery and reaps the same process tree.
- Removing the registry observation hook makes the product-path test RED; a line-framer unit alone is not completion.

Stop rule: no measured consumer, need for a second registry/spawner/kill path, or inability to anchor a line to an authoritative shell id means **PARK**, not partial implementation.

### D3 — owner/blocks task projection (S)

This is a read-model compatibility gap, not a storage gap.

Canonical mapping:

```text
owner     := todo.assignee
blockedBy := todo.dependencies
blocks(A) := all todo ids B where A is in B.dependencies
```

Implementation boundary:

- Add one pure projection over the canonical `Plan` and surface it through `current_plan` (or the existing by-value read seam).
- Deterministic order is canonical todo order (`createdAt`, then `id`); each edge array follows that same order.
- Omit `owner` when `assignee` is absent. Empty `blockedBy`/`blocks` are explicit empty arrays in the task projection.
- Do **not** add stored `owner`, `blockedBy`, or `blocks` fields; do not change snapshots, DAG mutation, CAS, or cycle validation.
- `assignee` remains the sole write vocabulary. `owner` is a Claude-compatible read alias, not a second accountable/executor concept.

Owner files:

- new pure leaf `src/agent/plan/task-projection.ts`
- `src/agent/plan/mutator-adapter.ts` (project canonical plan by value)
- `src/tool/types/context-seams.ts` (slice-safe read mirror)
- `src/tool/plan/current-plan.ts` (model-visible render)

RED / DoD:

- For `A`, `B depends on A`, `C depends on A+B`: projection is `A.blocks=[B,C]`, `B.blocks=[C]`, `C.blocks=[]`; `blockedBy` remains the canonical inbound edge.
- `assignee:"tester"` renders `owner:"tester"`; absent assignee omits owner.
- Reordering object insertion cannot change output ordering.
- Mutation test that stores or independently accepts `blocks` must fail the structural guard.

Stop rule: any proposal to add task CRUD, a multi-objective store, or persisted reverse edges is duplicate development and must be rejected.

## Structural action packets

각 packet은 하나의 semantic owner만 변경한다. RED와 GREEN은 같은 revision에서 남기고, 다음 packet으로 넘어가기 전에 owner-local receipt를 고정한다.

### RFC07-3 — task compatibility projection (P0, S, READY)

**Owner:** canonical `Plan` read projection.

**Write-set:**

- new `src/agent/plan/task-projection.ts`
- `src/agent/plan/mutator-adapter.ts`
- `src/tool/types/context-seams.ts`
- `src/tool/plan/current-plan.ts`
- new tests only under `tests/unit/agent/plan/` and `tests/unit/tool/plan/`

**Actions:**

1. Add the RED fixture `A`, `B→A`, `C→A+B` and require deterministic `{owner, blockedBy, blocks}` output from the public `current_plan` path.
2. Implement one pure `projectPlanTasks(plan)` function. Sort once by `createdAt`, then `id`; build one reverse-edge map from `dependencies`.
3. Extend the by-value `PlanReadonlyView` mirror with the projected tasks and render it from `current_plan`.
4. Keep create/update schemas, `TodoItem`, snapshot codec, DAG validator, and CAS mutation untouched.
5. Add a structural negative test proving `owner`, `blockedBy`, and `blocks` are not accepted mutation fields.

**GREEN rails:**

```sh
bun test tests/unit/agent/plan/task-projection-hellgate.test.ts tests/unit/tool/plan/current-plan-task-projection-hellgate.test.ts tests/unit/agent/plan/dag-hell.test.ts tests/unit/agent/plan/mutations-hell.test.ts tests/unit/tool/plan/plan-tools-hell.test.ts
bun run typecheck
bun test tests/unit/god-code-ratchet.test.ts
```

**Exit artifact:** public `current_plan` output receipt plus pure projection fixture.

**Stop:** any snapshot migration, write-schema field, second task collection, or stored reverse edge appears.

### RFC07-1 — named mailbox address resolution (P1, S, READY)

**Owner:** `TaskRegistry` live records + spawn-owner ledger + existing delivery target policy.

**Write-set:**

- `src/agent/subagent-delivery/target-resolver.ts`
- `src/agent/tier1/subagent-mailbox.ts`
- `src/tool/subagent-mailbox/index.ts`
- new owner-local resolver test and one real-loop integration test

**Actions:**

1. Freeze RED cases for unique visible name, duplicate visible name, foreign-lineage-only name, concrete mailbox id, parent, and broadcast.
2. Factor a shared resolution core from `createTargetResolver`; add exact live-name lookup over `TaskRecord.agentType`/display label only after owner filtering.
3. Inject a narrow optional callback into the mailbox tool builder. The tool must not import `@/subagent` or enumerate registry state itself.
4. Resolve unique names to canonical `mailboxLabel`; ambiguous visible names return typed failure with zero enqueue.
5. Preserve current raw-id/parent/broadcast behavior and the team-scoped mailbox fence.

**GREEN rails:**

```sh
bun test tests/unit/subagent-delivery-target-resolver-hellgate.test.ts tests/unit/subagent-delivery-contract-hellgate.test.ts tests/unit/subagent-delivery-controller-hellgate.test.ts tests/integration/subagent-named-mailbox-real-loop-e2e.test.ts tests/integration/subagent-delivery-modes-real-loop-e2e.test.ts
bun run typecheck
bun test tests/unit/god-code-ratchet.test.ts
```

**Exit artifact:** parent sends to two same-depth named children; exactly one target receives, ambiguity/foreign lineage enqueue count is zero.

**Stop:** global/name cache, fuzzy/prefix/nearest-depth selection, raw user-provided lineage, or `NamedAgentRegistry` mutation is introduced.

### RFC07-2M — line-watch admission measurement (P2, MED analysis, REQUIRED BEFORE BUILD)

**Owner:** no production owner change. This packet produces a decision receipt only.

**Write-set:** measurement fixture/result under this plan directory; production `src/` remains untouched.

**Actions:**

1. Name the real consumer and required semantics: all lines vs first match, stdout/stderr ordering, maximum acceptable notification latency, session lifetime, cancellation behavior.
2. Run the same fixture through existing `bash_await(regex)` and reactor polling: split chunks, split UTF-8, missing trailing newline, non-zero exit, 100-line burst.
3. Record latency, missed/duplicated lines, retained bytes, wake count, and whether completion-only behavior already satisfies the consumer.
4. Issue exactly one verdict: `DROP` (existing path sufficient), `PARK` (no current consumer), or `ADMIT RFC07-2B` with numeric bounds.

**Admission gate:** RFC07-2B is allowed only when the receipt names a live consumer and shows an unmet per-line correctness/latency requirement.

**Stop:** competitor parity, a synthetic benchmark with no consumer, or “might be useful” is the only justification.

### RFC07-2B — bounded line-stream watch (P3, MED, CONDITIONAL)

This packet does not exist unless RFC07-2M returns `ADMIT`.

**Owner:** existing `BashBgRegistry` spawn/drain/kill lifecycle and reactor self-wake.

**Write-set ceiling:**

- `src/runtime/bash-bg-registry.ts`
- new `src/reactor/line-framer.ts`
- `src/reactor/types.ts`
- `src/reactor/self-wake.ts`
- `src/apps/cli/reactor-watch-bridge.ts`
- one operator `/watch` surface and focused tests

**Actions:**

1. Freeze the admitted numeric bounds as RED fixtures.
2. Add one optional chunk observer at the existing registry drain; absent observer must preserve call/event/output identity.
3. Frame chunks deterministically and flush one final unterminated line.
4. Project bounded records through the existing reactor bridge with authoritative `shell_id` evidence.
5. Reuse `bash_kill(shellId)` for cancellation and existing process-tree reaping.
6. Emit bounded dropped-count and terminal failure records; never convert watcher death into silence/success.

**GREEN rails:** focused line-framer, bg-registry, bridge, self-wake, and operator-surface tests; then `bun run typecheck` and god-code ratchet.

**Exit artifact:** real command → existing bg drain → line records → simulated turns, plus OFF-capture and kill receipt.

**Stop:** second spawner/registry/kill path, unbounded queue, polling truncated snapshots, or evidence without a canonical shell id.

## Execution order

1. **RFC07-3** — projection RED → implementation → owner-local receipt.
2. **RFC07-1** — resolver RED → implementation → lineage/product receipt.
3. **RFC07-2M** — measurement receipt.
4. **RFC07-2B** — only on explicit `ADMIT`; otherwise RFC-07 closes with D2 PARK/DROP.

The three code write sets are independent, but final verification should remain owner-local and serialized where they share the CLI/tool registry.

## SOTA++ acceptance

“SOTA++” here means authority reuse plus product proof, not feature count.

- No new workflow/task/address/process registry.
- No fuzzy address or inferred ownership.
- No stored reverse DAG edge or owner alias.
- No observer-only GREEN: D1 proves real mailbox delivery, D2 proves registry drain to simulated turn, D3 proves model-visible `current_plan` output.
- Gate/OFF and legacy-id behavior are captured at the real front door.
- Implementation, proof receipt, Git commit, and publication remain separate states.

## Permanently dropped register

- workflow engine/DSL/executor/cache store
- TaskCreate/Get/List clone or multi-objective store
- RemoteTrigger hosted CRUD and `isolation:"remote"`
- `dontAsk` permission literal
- persistent cross-cell JS heap
- output-file task polling
- global name-to-id map
- stored `blocks`/`blockedBy` or a second `owner` field
- watcher-specific process registry, spawner, event bus, or kill path
