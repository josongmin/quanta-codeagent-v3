# RFC-04 — Worktree-init staged progress surface + optional local-env setup hook

**Status:** **R6 ARCHITECTURE FROZEN — subscription/progress BUILD; setup execution PARKED**
**Absorbs:** Codex 6662 `worktreeInitV2.progress.*` (2026-08-13 refresh; detail `.extracted_source/_deep-codex-ui-high.md §3`).
**Relation:** sits ON TOP of aug-02 RFC-06 B3 (persisted worktree transaction) + RFC-02 B6 (operation-correlated phase producer), both of which are ALREADY LANDED and live-wired (see Current-state). Cloud/remote selectors are ChatGPT-only → out of scope.

---

## Final audit incorporation — current-HEAD authority (R5)

> R5 and the revised Design/TDD/Sequencing are authoritative. The prior `READY` decision and
> “producer metadata is surface progress” assumption are superseded.

The current CLI creates a private ActivityStore, awaits the complete worktree transition, and only
then renders one snapshot. `renderActivity` does not render `node.meta`. Therefore staged nodes and
checkout percentage would be inert data, not progress visible while the operation runs. Proposed
step nodes also used `kind:"agent"`, which would falsely increase aggregate agent/running counts.

### Final disposition

| Slice | Verdict | Admission condition |
|---|---|---|
| Persisted worktree transaction + coarse activity + shell stream | ALREADY | Reuse verbatim |
| D0 live progress delivery | **BUILD FIRST** | Incremental consumer exists before D1/D2 producer expansion |
| D1 staged steps | BUILD after D0 | Non-agent node kind; aggregate counts invariant |
| D2 real checkout percentage | BUILD after D0 | Git-owned progress only; retry/reset semantics pinned |
| ADR-0455 declarative environment selection | ALREADY | Reuse as config authority |
| D3 arbitrary setup execution | **PARK** | Trusted config owner, mode/capability, outcome state, and decision port exist |
| D3b repair agent | PARK | Depends on D3 and explicit user action |
| D4 selector core | ALREADY | Additional web UI independently PARKED |

### Canonical live progress contract

1. Register `QUANTA_WORKTREE_PROGRESS` in shared runtime-config knob schema/inventory/default parity;
   resolve once in composition. The existing optional ActivityStore is not the feature gate.
2. Extend `SessionCommandDeps` with an optional live activity sink/subscription. CLI subscribes
   before invoking the transaction, renders each materialized change, and unsubscribes in `finally`.
   One-shot final rendering remains a fallback/receipt, not the progress implementation.
3. `renderActivity` or a dedicated progress renderer consumes typed progress fields. Do not encode
   percentage only in free-form `meta` strings.
4. Worktree step nodes use structural `phase` or `tool` kind, never `agent`; aggregate agent count
   must be identical before/after enabling progress.
5. Web/daemon progress is not claimed until its event broadcaster and actual client consumer exist.

### D3 authority boundary

ADR-0455 already owns declarative local-environment selection. No repository file is auto-executed.
An executable setup extension remains PARKED until a trusted user/host config source, authoritative
run mode, bounded execution capability, and durable `setupStatus` outcome are specified. Worktree
creation success remains `ready`; setup failure may produce `ready-with-setup-warning`/`skipped`,
never rewrite a successfully persisted worktree as failed. “Proceed anyway” requires a real user
decision port, not a post-hoc activity rewrite.

---

## Architecture integration — R6 (normative)

R6 replaces the prior “add child nodes/meta and render the final snapshot” approach. Current CLI
construction creates a fresh `ActivityStore` for the command and renders only after
`transitionThreadToWorktree` returns; `renderActivity` ignores free-form meta. Therefore live
progress requires a session-owned subscription contract, typed progress and pre-operation
subscription. Shared rules are in
[`00-architecture-blueprint.md`](./00-architecture-blueprint.md).

### Existing owner map

| Concern | Current owner | R6 decision |
|---|---|---|
| Activity graph/state | `src/activity/{types,store,spine,producers}.ts` | Extend in place with typed operation/step and subscription |
| Worktree effect | `src/runtime/worktree-fork.ts` | Atomically split into `runtime/worktree/` |
| Thread transition | `src/runner/session-ops/current-thread-worktree.ts` | Keep orchestration in runner, split cohesive files |
| Store construction | CLI REPL/lifecycle/stdio/slash fallback, terminal scaffold and headless fake each create a store | Every production session receives one assembled handle; explicit test fakes remain local |
| CLI command/render | `src/runner/session-ops/index.ts`, `src/apps/cli/repl.ts` | Subscribe before command; render events, not only final snapshot |
| Existing workflow step producer | `src/activity/spine.ts` / workflow sink | Do not copy its `kind:"agent"` accounting error |

### Target write set

```text
src/activity/
  types.ts             # ActivityKind += operation | step; ActivityEvent += node_progress
  progress.ts          # indeterminate | ratio; validation/clamping policy
  subscription.ts      # ActivityReader/Writer/Subscription narrow ports
  store.ts             # monotonic seq + snapshot + subscribe
  producers/worktree.ts
src/runtime/worktree/
  types.ts             # WorktreeCreateProgress closed effect-level union
  create.ts            # existing create behavior split into observable stages
  progress-parser.ts   # git progress parser; ambiguity -> indeterminate
src/runtime/worktree-fork.ts         # deleted after import cutover
src/runner/session-ops/worktree/
  transition.ts
  activity-adapter.ts  # runtime progress -> activity events
src/runner/assemble/session-authorities/build.ts # one session ActivityStore
src/apps/cli/repl/factories/lifecycle.ts         # consume supplied store
src/apps/cli/{repl.ts,serve-stdio-cmd.ts}        # call assembly, no command-local store
src/apps/cli/slash/registry-surface.ts            # remove fallback mint
src/apps/terminal/brain-mode-session-scaffold.ts # call assembly
src/apps/cli/repl/activity-renderer.ts
tests/unit/{activity,runtime/worktree}/
tests/integration/cli-worktree-live-progress.test.ts
```

Reuse the existing `activity` and `runtime` boundary configurations and entrypoint tests; they are
already registered at HEAD. Activity does not import runtime; runtime does not import activity.
Runner owns their adapter because it is the composition/orchestration layer. Any required import
that would need a new allowlist is a design stop, not permission to widen the existing fence.

### Domain contracts

```ts
type ActivityKind = ExistingActivityKind | "operation" | "step"
type Progress = { kind: "indeterminate" } | { kind: "ratio"; completed: number; total: number }

type WorktreeCreateProgress =
  | { kind: "stage-started"; stage: WorktreeStage }
  | { kind: "checkout-progress"; completed: number; total: number }
  | { kind: "stage-completed"; stage: WorktreeStage }
  | { kind: "failed"; stage: WorktreeStage; code: WorktreeFailureCode }
```

Activity hierarchy is:

```text
thread agent (existing)
  -> worktree-transition operation
      -> validate step
      -> create-worktree step
      -> checkout step (progress)
      -> bind-thread step
```

Only the real child agent is `kind:"agent"`; operation/step nodes do not change active/total agent
aggregates. Stage ids are deterministic within an operation, retries mint a new operation id and
reset progress. Malformed, regressing or unavailable totals become `indeterminate`; no invented
percentage is shown.

`ActivityStore` emits a monotonically increasing per-session sequence and supports subscribe plus
snapshot. Subscription delivery may coalesce progress but cannot reorder lifecycle transitions.
A subscriber can obtain `{snapshot, nextSeq}` atomically so it cannot miss the edge between initial
render and subscription.

### Effect and UI flow

```text
CLI starts subscription
  -> session command begins
  -> runner creates operation node
  -> runtime create emits typed local progress callback
  -> runner adapter writes activity node/stage/progress
  -> CLI renderer updates current operation
  -> transition success/failure closes step and operation
```

Runtime owns parsing actual git/process output and emits no UI labels. Runner owns semantic mapping
to activity. CLI owns terminal redraw/coalescing only. Gating is resolved from shared runtime config
at composition; optional sink presence is not used as a hidden feature gate.

Trust-gated setup hooks remain PARKED. No `setup-hook.ts`, hook runner, approval bypass, or progress
stage for unimplemented execution is added. When admitted later, setup is a separately authorized
effect after worktree creation, with its own sandbox/permission contract.

### Atomic landing plan

1. **D1 — activity protocol:** typed kinds/progress, sequence/subscription, aggregate invariants and
   atomic snapshot+subscribe.
2. **D2 — runtime split:** move existing worktree creation without semantic change, then add typed
   progress callbacks and parser tests. Delete the old file in the same commit.
3. **D3 — runner adapter:** staged nodes and terminal transitions; no app dependency.
4. **D4 — session ownership/UI:** replace CLI REPL/lifecycle/stdio/slash and terminal production
   constructors with the assembled session handle; subscribe before invoking the operation.
5. **D5 — receipt:** a deliberately delayed checkout visibly updates before the command resolves.

### Executable work packets

Use [`01-execution-board.md`](./01-execution-board.md). D1 and D2 are disjoint leaf packets and may
develop in parallel. D3 consumes both. D4 takes the shared assembly/CLI lock after RFC-01 A2/A4.

#### D1 — activity progress/subscription (`codex/aug22-d1-activity-progress`)

- **Prerequisite/owner:** none; owns `activity/{types,progress,subscription,store}.ts`, barrel exports
  and `tests/unit/activity/{progress,subscription,aggregate}.test.ts`.
- **RED first:** current store cannot subscribe atomically; operation/step nodes would need agent
  kind; an event injected between snapshot and listener registration is lost.
- **Implement:** closed progress union, operation/step kinds, `node_progress`, monotonic sequence,
  atomic `{snapshot,nextSeq}` subscription, ordered lifecycle delivery and bounded coalescing.
- **Verify:** targeted tests plus existing activity boundary, typecheck and god-code ratchet.
- **Receipt:** injected race has no loss/duplication and 3 step nodes leave agent aggregate unchanged.
  **Stop** if progress must use free-form meta or activity imports runtime.

#### D2 — observable worktree runtime (`codex/aug22-d2-worktree-runtime`)

- **Prerequisite/owner:** none; exclusive owner of the atomic move from
  `runtime/worktree-fork.ts` to `runtime/worktree/{types,create,progress-parser}.ts` and all imports.
- **RED first:** pin current create success/failure behavior, then parser table for chunked carriage-
  return progress, malformed/regressing counts, cancellation and no-progress output.
- **Implement:** move behavior first without semantic change, add optional typed observer and exact
  git-owned ratio parser, delete old file/barrel export in the same commit.
- **Verify:** runtime worktree tests, import-zero scan for old path, runtime boundary, typecheck and
  existing worktree transition tests.
- **Receipt:** observer absent is behavior-identical; unparseable output emits indeterminate, never a
  guessed ratio. **Stop** if progress depends on localized prose beyond admitted git grammar.

#### D3 — runner activity adapter (`codex/aug22-d3-worktree-activity-adapter`)

- **Prerequisite/owner:** D1+D2; owns `runner/session-ops/worktree/{transition,activity-adapter}.ts`,
  migration of `current-thread-worktree.ts`, `activity/producers/worktree.ts` and runner tests.
- **RED first:** delayed runtime events do not materialize staged nodes and a failed stage cannot
  deterministically settle parent/children.
- **Implement:** deterministic operation/stage ids, exhaustive runtime->activity mapping, terminal
  success/failure/cancel settlement and retry isolation. Runner is the only cross-domain adapter.
- **Verify:** adapter transition table, existing worktree session-op tests, activity/runtime/runner
  boundaries and typecheck.
- **Receipt:** every runtime terminal arm closes all open stages exactly once; retry mints a new
  operation and resets progress. **Stop** if adapter logic leaks into runtime or CLI.

#### D4 — session ownership and live CLI (`codex/aug22-d4-worktree-live-cli`)

- **Prerequisite/owner:** D3 and RFC-01 A2/A4 integrated; exclusive lock on session-authority build,
  CLI lifecycle/repl/stdio/slash registry, terminal scaffold and `runner/session-ops/index.ts`.
- **RED first:** timestamped CLI test proves first render currently occurs after
  `transitionThreadToWorktree` resolves; constructor scan finds command/surface-local stores.
- **Implement:** one assembled ActivityStore, remove production fallback constructors, subscribe
  atomically before invoking the command, terminal renderer consumes sequence and final snapshot.
- **Verify:** CLI/stdio/terminal composition tests, constructor-owner ratchet, surface coupling,
  terminal defaults and touched slice boundaries.
- **Receipt:** progress render timestamp precedes command completion and all surfaces use one session
  store. **Stop** if slash code owns reusable activity state or polling replaces subscription.

#### D5 — product and negative-control receipt (`codex/aug22-d5-worktree-e2e`)

- **Prerequisite/owner:** D4; fixture/test-only except a demonstrated narrow missing wire.
- **RED first:** temporary repo with intentionally delayed worktree checkout; require at least two
  observable stage/progress changes before process exit.
- **Implement:** only if the RED exposes one, close the missing live adapter/renderer wire; no new
  state/model.
- **Verify:**
  `bun test tests/integration/cli-worktree-live-progress.test.ts --parallel=1`, then shared ladder.
- **Receipt:** validate -> create -> checkout -> bind order, pre-completion progress, unchanged agent
  count, failure settlement, retry reset, and gate-OFF legacy output. **Stop** if the fixture cannot
  prove pre-completion timing independently of buffered output.

#### Setup execution (PARKED, no branch)

Do not create a setup runner, approval prompt or stage. Unpark only with an admitted trust policy,
sandbox/permission route, cancellation owner and a real configured setup producer. ADR-0455 remains
environment-selection authority; arbitrary repository commands are not inferred as setup hooks.

### Architectural completion gates

- Live-time hellgate records the first progress render timestamp and proves it precedes operation
  completion; a final-snapshot-only implementation fails.
- Agent-count invariant stays identical while 3–4 operation/step children exist.
- Atomic subscribe test injects an event between snapshot and listener registration and proves no
  loss/duplication.
- Parser table covers chunk boundaries, carriage-return updates, malformed counts, regression,
  non-English/no-progress output and cancellation.
- Retry rail proves a failed attempt closes and a new attempt starts at indeterminate/zero.
- Gate-OFF receipt preserves current command output and activity snapshot shape.
- Constructor-owner ratchet matches `createActivityStore(` calls, permits only the authority
  builder and explicit test/fake helpers, and goes RED on any new slash/command-local store.

**R6 status:** architecture frozen; progress is BUILD after D1. Setup hooks remain PARKED.

---

## Prior review incorporation (R4, superseded where R5 conflicts)

Adversarial review (`_review-04.md`, verdict **READY**) verified every `file:line` claim against the tree at HEAD `9d5369d31`. Confirmed: the live-wire is real (not a phantom — `apps/cli/repl.ts:155` constructs `createActivityStore()` into the `session worktree <id>` deps), the container+child-step pattern (`createWorkflowSink`/`deriveContainerStatus`) is the correct one to copy, and **D1/D2/D3 all BUILD**. Write-set is conflict-free with the 69-file bench/dataset dirty sweep (no overlap with `src/activity/**`, `src/runtime/worktree*`, `src/runner/session-ops/**`). Two pre-conditions gate **D3 only** — **neither blocks D1 or D2**:

1. **D3 config-owner gate (HARD):** `worktreeSetup` config **does NOT exist** (`grep worktreeSetup src/ tests/` → **0 hits**, confirmed at review). Open-Q #3 — *which config system owns the setup-command field* — MUST be decided against `knob-config-systems-inventory` **before D3 starts**, to avoid spawning a **4th parallel config system**. This is a genuine D3 pre-req, not a detail. D1/D2 do not touch config and are unaffected.
2. **D2 duplicate `git()` seam → effort M (not S):** the checkout-% work must thread `--progress` + `onShellEvent` streaming through the **module-private `git()` runner, which is DUPLICATED** at `src/runtime/worktree.ts:31` AND `src/runtime/worktree-fork.ts:25` (both `const git = async (repoRoot, args) => …`, calling `runShell(…, { cwd })` with **no** observer). `runWorktreeAddWithRetry` (`worktree.ts:80`) carries no observer either. Widening both signatures (so progress threading doesn't fork behavior) makes **D2 effort M, not S** — corrected in Effort/§H below.

**PARK reaffirmed:** D4 (selector UI) + D3b (auto-fix repair thread) stay deferred to last (multi-surface; D3b coupled to the agent-spawn seam) — out of D1–D3.

**Stale-doc cross-ref (aug-02 RFC-06):** RFC-06's **Status header** ("RE-AUDITED … Not yet implemented") and its **execution-order line 20** ("current-thread CLI/setup activity" pending) are **STALE for the worktree lane** — RFC06-0/1/2/3 all LANDED (imports live at `current-thread-worktree.ts:31-51`, `session-ops/index.ts`); only *staged* activity + *setup* remain (exactly this RFC's delta). Treat those two RFC-06 lines as superseded by current HEAD.

**Container regression:** real but well-sealed — the two live tests survive child emission via a **correlation filter** (`worktree-cmd-activity-e2e.test.ts:110-113`, children are `kind:"agent"` without `correlation`) + **empty-children** (`deriveContainerStatus([]) = asserted`) + the **flag-off byte-identical fence**. The only genuine break is a **fatal `setup` child flipping a caller-settled `done` → `failed`** — that is the **intended Codex semantic** (Risk MED), kept as-is.

---

## Motivation

Codex renders new-worktree creation as a **staged progress card**, not one opaque spinner:

- `workspace` **"Preparing workspace"** → `checkout` **"Checking out files"** with a live `{progress}%` (= real git checkout ratio) → `setup` **"Setting up environment"** (runs the repo's `.codex/environments` script) → terminal **"Worktree created"** | **"Worktree setup failed"**.
- Setup failure is a *distinct* outcome: toast pointing at the setup-script location, an auto-fix repair thread (**"Fix worktree setup"**), and if the user proceeds anyway the step is marked **"Environment setup skipped"** (the worktree itself still exists).
- A **local environment selector**: "Select a local environment" / "Work without environment" / "Default environment".

quanta already creates worktrees as a durable transaction AND already emits an operation-correlated activity node for it — but as **one coarse node** (`running` → single terminal `done|failed`). There are no intermediate stages, no checkout %, and **no setup-script concept at all**. This RFC refines the single node into the staged sub-progress Codex shows, reusing the existing spine and its container-status honesty rule, and adds an OPTIONAL, trust-gated setup hook.

## Non-goals

- **No cloud/remote environment selectors** (ChatGPT-cloud only).
- **No new activity node kind, no new event type, no second phase machine, no status bus, no per-feature store.** Everything rides the existing `phase`/`agent` kinds + `AgentActivityEvent` (`src/activity/types.ts:26,40,138`).
- **No auto-execution of a repo-authored setup script by default**, and never in untrusted modes (see Trust gate). Absorbing Codex's `.codex/environments` verbatim (auto-run whatever the repo ships) is explicitly rejected.
- **No worktree lifecycle/binding/reaper redesign** — that is RFC-06 B3's persisted contract, already landed and reused as-is.
- No re-litigation of RFC-06 B3 ownership/GC/dirty-refusal semantics.

## Current-state (file:line — the REAL delta)

**The phase spine + a worktree producer already exist AND are live-wired** (RFC-02 B6's "live caller undecided" is RESOLVED):

- `src/runner/session-ops/index.ts:842,872-874` — `cmdWorktree` (the `worktree <id>` front door) mints an `ownershipId` and passes an **optional** `TransitionActivity` sink. Absent sink ⇒ byte-identical, no activity (`:871`).
- `src/runner/session-ops/current-thread-worktree.ts:202` — `transitionThreadToWorktree`: persists `creating` intent → emits `worktreeOpenActivity` (`:260`) → runs the git effect → emits `worktreeSettleActivity` `failed` (`:283`) or `ready` (`:307`). This IS the front door RFC-02 B6 said was undecided.
- `src/activity/producers/worktree.ts:74,105` — the producer emits exactly **one** `phase` node: `running` at open, then **one** terminal (`node_status done|failed`). No children, no sub-steps, no percent.
- `src/runtime/worktree-fork.ts:112-150` — `createPersistentWorktree` runs a **single opaque** `git worktree add --no-track -B … -- … HEAD` via `runWorktreeAddWithRetry` (`src/runtime/worktree.ts:80`) and returns only after the whole add completes. **No `--progress`, no streamed checkout ratio, no intermediate stage boundaries.**
- `src/activity/store.ts:113-188` — `createWorkflowSink` is the **existing pattern to copy**: a container node (`workflow`/`phase`) with child step nodes emitted `running → done|skipped|failed`; the reducer derives the container's honest status from its children.
- `src/activity/spine.ts:183-199` — `deriveContainerStatus`: a CLOSED container reads `failed` iff a child failed, else its asserted status; `skipped` does **not** trigger `failed`. This is the load-bearing rule that lets "setup skipped" coexist with "worktree created."
- `src/runtime/shell.ts:109-124` — `runShell` **already supports a streaming closed-union event path** (per-stream byte offsets). This de-risks checkout %: `git worktree add --progress` writes `Updating files: N% (x/y)` to stderr and can be consumed through this existing seam — no new streaming infra.

**Trust substrate already exists:**

- `src/agent/run-mode/repo-rules-policy.ts:26-39` — `MODE_REPO_RULES_POLICY` / `modeLoadsRepoRules(mode)`: the SSOT that classifies each `AgentMode` as `load` (trusted user repo: `interactive`/`headless`/`ide`) vs `rule-less` (untrusted/hermetic: `batch`/`ci-bot`/`daemon`). Untrusted trees must NEVER smuggle repo-authored instructions into a trusted context. A repo-shipped setup script is exactly that class of input.

**No setup-script equivalent exists.** `grep` for `postCreate|setup.?script|\.codex/environ|envSetup` in `src/` finds nothing for worktrees. The only hit — `environmentSetupCommit` (`src/runner/batch/corpus/dataset.ts:42,313`) — is a **SWE-bench dataset field** (a base commit to prep a bench container), entirely unrelated to per-worktree setup.

**Net delta:**
1. A real incremental consumer/front door for the existing activity stream.
2. Single coarse node → non-agent staged children (`workspace → checkout`; setup PARKED).
3. Real checkout percentage from git's own progress stream.

## Design

### D0 — Live progress delivery/front door

Build the canonical live progress contract from R5 before adding finer producer events. The command
front door must expose an incremental sink and the CLI must render while
`transitionThreadToWorktree` is still pending. A producer-only ActivityStore unit is necessary but
not product evidence.

### D1 — Staged worktree-init producer (the core; reuses spine, no new types)

Refine `worktreeOpenActivity`/`worktreeSettleActivity` (`src/activity/producers/worktree.ts`) so the worktree-op node becomes a **parent container** with child step nodes — mirroring `createWorkflowSink` (`store.ts:113`). New producer helpers (pure, deterministic, no `@/runner`/`@/session` value import — same discipline the file already documents at `:14`):

- `worktreeStepId(operationId, step)` → `worktree-op/<enc(op)>/<step>` where `step ∈ {"workspace","checkout","setup"}` (a closed union → `Record<WorktreeStep, …>` labels so adding a step fails to compile until labelled — the drift-guard pattern from `exhaustive-record-classification`).
- `worktreeStepOpen(op, step, at)` → `node_open` child (`kind: "phase"` or `"tool"`,
  **never `"agent"`**; parent = `worktreeOpNodeId(op)`, status `running`). Pin the existing
  aggregate agent/running counts unchanged.
- `worktreeStepSettle(op, step, "done"|"failed"|"skipped", at)` → `node_status`.
- `worktreeCheckoutProgress(op, ratio)` → surface-rendered `{progress}%` on the `checkout` node's `meta` (`checkoutPercentage`). **No `node_metric` abuse** — percent is a presentational hint, not a cumulative counter. Ratio is git's own reported `(done/total)`; when unparseable the node stays indeterminate `running` (never a fabricated number → no-heuristics compliance).

The **parent terminal stays `worktreeSettleActivity`** exactly as today; but because the node now has children, its rendered status is **derived** by `deriveContainerStatus` (`spine.ts:188`). This gives the Codex semantics for free:
- git add fails → `checkout` child `failed` → parent derives `failed` ("Worktree setup failed" at the git level).
- setup fails but user proceeds → `setup` child **`skipped`** (NOT `failed`) → parent still derives `done` → **worktree created, "Environment setup skipped."** This is precisely why `skipped ≠ failed` in `deriveContainerStatus` is load-bearing (audit R2).
- setup fails and is treated as fatal → `setup` child `failed` → parent `failed`.

### D2 — Wiring the stage boundaries into the transaction

In `transitionThreadToWorktree` (`current-thread-worktree.ts`), the stage emissions sit at the boundaries that already exist:

- After intent persist + target resolve, before the git effect: emit `workspace` open→done (the intent/target is the "prepared workspace").
- Around `createPersistentWorktree`: emit `checkout` open; on return emit `checkout` done (fail path → `checkout` failed, before the existing `worktreeSettleActivity(failed)`).
- **Checkout %:** inject an observer-bound `git worktree add` closure from
  `worktree-fork.ts` into the existing retry callback seam. Do not widen the unrelated duplicate
  `withWorktree` helper unless a concrete caller requires it. Retry attempt changes reset progress;
  monotonicity is per attempt, not fabricated across retries.
- `setup` step (D3) runs after `ready`, before the parent terminal, only when configured+trusted.

All of these are **self-gated on the same optional `activity` sink** already present (`current-thread-worktree.ts:82,103`). No sink ⇒ not one extra event, no callback threaded ⇒ git effect unchanged.

### D3 — Optional executable setup hook — PARK

The setup step is **OFF unless a setup command is configured**, and even then **never runs in a `rule-less` mode**.

> **⛔ HARD D3 GATE:** reuse/extend ADR-0455's trusted user/host environment authority. Do not
> create `worktreeSetup` in a fourth config system and do not auto-run checkout-owned files.

- **Source of the command = quanta config only** (a `worktreeSetup` field on the run config / profile), NOT a repo file, NOT model-authored — the RFC-06 B3 rule (`rfc-06:218` "config, NOT model-authored"). Auto-adopting a repo-shipped script (Codex's literal `.codex/environments`) is rejected: it is attacker-authored text in any PR/untrusted checkout.
- **Trust gate:** the setup step is enumerated only when `modeLoadsRepoRules(mode) === true` (`repo-rules-policy.ts:38`) AND a command is configured AND the master feature flag is on. In `batch`/`ci-bot`/`daemon` the step is **omitted entirely** (not even `skipped` — it never appears). This reuses the exact SSOT that gates repo-rule loading; no parallel trust decision.
- **Execution:** run the configured command with cwd = the new worktree path, through the hardened `runShell` (env-scrubbed, timeouted). Output is **bounded + redacted evidence** onto the `setup` node meta (rfc-06:83) — a "More details" affordance, never the full unbounded log.
- **Failure handling:** worktree transaction and setup outcome are separate. Non-zero setup cannot
  turn a durable ready worktree into failed. Persist/return a ready worktree plus typed setup warning;
  a real user decision may convert warning to skipped. Repair is a separate explicitly invoked task.
- **node_modules hazard (audit R2):** the setup command runs a REAL install in the worktree; the hook NEVER symlinks `node_modules` to main (worktree-node-modules-hazard). We add no symlink shortcut; the doc + a test pin this.

### D4 — Local environment selector (surface, thin)

ADR-0455 already owns local-environment selection and the CLI knob. Reuse it; only genuinely
missing web/IDE affordances remain separate PARK slices. Do not introduce a second selector or
reinterpret selection as permission to execute arbitrary commands.

## Default-OFF gate

One BUILD-ready observability gate; setup remains unregistered:

1. **Observability:** `QUANTA_WORKTREE_PROGRESS` is registered in shared runtime config and controls
   both producer granularity and live consumer wiring. Optional ActivityStore presence is not a gate.
2. **Setup:** no production gate or schema is added while PARKED.

Byte-identical proof obligation: with both flags unset, `transitionThreadToWorktree` produces the identical event stream (open + single settle) and the identical git command — pinned by a golden test.

## TDD + hellgate

Hellgate RED before green; real sinks + real command exec (jul-13/jul-15: fake endpoints hid seam bugs).

- **RED (live front door):** start a real slow worktree add and assert at least one workspace/
  checkout line is emitted before the command promise settles. Final-only rendering must fail.
- **Staged spine:** materialize non-agent child nodes and assert aggregate agent/running counts are
  identical to the coarse baseline.
- **Red-on-injection #1:** flip the "proceed anyway" emission from `skipped` → `failed`; the parent-derivation assertion must go RED (proves `skipped ≠ failed` is actually load-bearing, not cosmetic).
- **Red-on-injection #2:** make git add fail → `checkout` child `failed`; assert parent derives `failed` and the single `worktreeSettleActivity` still fires. Flip the producer to emit parent `done` on child-failed → derived-status test goes RED.
- **Byte-identical test:** run the transaction with `activity: undefined` and with flags off; assert the emitted event list is empty and the git arg string equals today's exact `worktree add --no-track -B …`.
- **Gate matrix:** store present/gate off, store absent/gate on, and store present/gate on. Only the
  last emits staged/live progress; OFF snapshots and argv are byte-identical.
- **Checkout %:** parse real git progress, assert typed ratio reaches the live renderer, retry resets
  attempt progress, and unparseable/localized lines stay indeterminate.
- D3 trust/exec tests are prerequisite specifications only and do not justify un-parking setup.
- **Leaf-crate units** (punchcard: static-first, leaf-crate only): `src/activity/*` is a pure-of-I/O leaf (`index.ts:6`) — producer/spine tests are cheap and need no build. Exec/trust tests live at `session-ops` but are still fast (git in a temp dir).

## Effort

- **D0 live delivery + gate + renderer:** M.
- **D1 staged producer:** S/M after D0.
- **D2 checkout %:** M; cost is closing the live front door and retry semantics, not widening every
  duplicate helper.
- **D3 setup:** PARK/unestimated.
- **D3b auto-fix repair thread + D4 selector UI:** M across three surfaces — deferred, sequence last.

## Risks + traps

- **`skipped ≠ failed` inversion (HIGH):** if the "proceed anyway" path emits `failed` instead of `skipped`, a created worktree wrongly reads `failed`. Pinned by red-on-injection #1. This is the single most important semantic.
- **Aggregate corruption (HIGH):** structural steps marked `agent` fabricate worker counts. Pin kind
  and aggregate invariants before producer rollout.
- **node_modules symlink corruption (HIGH, worktree-node-modules-hazard):** the setup hook must do a REAL install in the worktree, never symlink to main; the reaper must not follow symlinks. No symlink shortcut is added; pinned by e2e. Do not blame a corrupted main on the user without verifying symlink origin.
- **Untrusted setup script = RCE (HIGH):** executing a repo-shipped `.codex/environments`-equivalent in a PR/webhook checkout is attacker code execution. Mitigated by config-only source + `MODE_REPO_RULES_POLICY` gate. Never auto-run a repo file.
- **Worktree staleness (MED, feedback-worktree-staleness):** base-drift is already tracked via `baseSha` in the persisted intent (`current-thread-worktree.ts:251`); the progress producer is pure observability and adds no staleness surface. The setup step runs against the just-created tree (fresh by construction).
- **Checkout % fragility (LOW):** git's progress text varies by version/locale; parse defensively, fall back to indeterminate. Never a heuristic threshold — it reports git's own ratio or nothing.
- **Vacuous-test trap:** a producer-only test that never materializes through a real store, or asserts a single-literal status, would be vacuous. Mitigated by full `materialize` round-trips + red-on-injection on the derivation.

## Sequencing

0. **D0** register the gate and close the live CLI consumer/front-door RED rail.
1. **D1** add non-agent staged producer nodes; prove aggregate invariance.
2. **D2** add git-owned percentage, retry/reset semantics, and live renderer receipt.
3. **D3/D3b** remain PARKED pending trusted execution/outcome authority.
4. Reuse ADR-0455 selector; add web/IDE UX only with real consumers.

**Relation to prior RFCs:** RFC-06 B3's persisted transaction (`current-thread-worktree.ts`) and RFC-02 B6's single-node producer (`producers/worktree.ts`) are the **substrate this RFC extends** — both landed in aug-02. RFC-02 B6's Open-Q "which live caller?" is answered by this RFC (it is `transitionThreadToWorktree` via `cmdWorktree`). RFC-06 B3's Open-Q "does a reusable phase machine exist?" is answered: **yes** — `deriveContainerStatus` + the `createWorkflowSink` child-step pattern; D1 reuses it rather than forking a second machine.

## Open-Q

1. **Auto-fix repair thread:** PARK; only explicit user action after D3 authority lands.
2. **Checkout % granularity:** emit every git progress line, or throttle to deltas ≥5%? (ROI: fewer events vs smoother bar; measure event volume before deciding — no arbitrary threshold until measured.)
3. **Executable setup authority:** extend ADR-0455 only if a real product need justifies execution;
   bench run-config is not the owner.
4. **Default environment:** reuse ADR-0455 semantics; no duplicate selector contract.

---

## Audit log R1→R3 (adversarial)

**R1 — "the phase spine is already wired; is this RFC inventing a duplicate?"**
Broke it against code. The spine IS wired (`current-thread-worktree.ts:260,283,307` → real `ActivityStore`), and RFC-02 B6's "live caller undecided" is FALSE-as-of-now — the caller exists (`session-ops/index.ts:872`). So the RFC must NOT re-introduce a producer/caller; the honest delta is *granularity* (one node → staged children) + *checkout %* + *setup step*. **Finding:** the worktree-op node is currently a LEAF; adding children silently converts it to a CONTAINER, and its status flips from asserted to DERIVED (`spine.ts:266`). Any test asserting the parent's leaf status breaks. → Added to Risks (container-status regression) + a byte-identical golden test + a migration note. Also caught: I must not fork a second phase machine — `createWorkflowSink` (`store.ts:113`) is the pattern; D1 now explicitly reuses `deriveContainerStatus` instead of inventing terminal-rollup logic. Rewrote D1 to state "no new node kind / no new event type."

**R2 — "setup-script = code execution in an untrusted tree; and the skip semantics are a landmine."**
Two real holes. (a) Codex literally runs the repo's `.codex/environments` script. Absorbing that verbatim = RCE on any PR/webhook checkout (`ci-bot`/`daemon`) — a malicious `.codex/environments` self-approves, the exact `<pr_untrusted_data>` bypass `repo-rules-policy.ts:20` warns about. → Hard-gated: setup command is **config-only, never a repo file**, and enumerated only when `modeLoadsRepoRules(mode)` is true; untrusted modes omit the step entirely, pinned by a red-on-injection trust test. (b) The "proceed anyway" path: if I map setup-failure to a `failed` child, a *successfully created* worktree reads `failed` — wrong, and it contradicts Codex's "Environment setup skipped" (worktree still created). The spine already distinguishes: `deriveContainerStatus` treats `skipped` as non-fatal but `failed` as fatal (`spine.ts:193`). So proceed-anyway MUST emit `skipped`. → made this the #1 Risk with red-on-injection #1. Also surfaced the node_modules symlink hazard (memory): the exec hook must never symlink node_modules to main; pinned by e2e (file lands in worktree, not main; no symlink). **Finding:** without the `skipped` mapping the whole feature is dishonest-status; without the trust gate it is an RCE. Both now load-bearing + tested.

**R3 — "checkout % is unattainable / fabricated, and the tests are vacuous."**
Probed feasibility. `createPersistentWorktree` is one opaque `git worktree add` (`worktree-fork.ts:136`) that returns only on completion — so naive "checkout %" would be *fabricated* (a fake animated bar), violating no-heuristics/no-optimistic-signal. → Grounded a real path: `runShell` ALREADY exposes a streaming closed-union event seam (`shell.ts:109-124`), and `git worktree add --progress` writes real `Updating files: N% (x/y)` to stderr. So % is git's OWN reported ratio, threaded through an existing seam — real, not fabricated; unparseable ⇒ indeterminate `running`, never a made-up number. Marked checkout % a SEPARATE slice (D2) so D1 lands without it. **Vacuity check:** a producer-only test that never materializes, or asserts a single-literal status, is vacuous (memory: two-way-narrowing trap). → every status test now round-trips through a real `createActivityStore` + `materialize`, and each has a red-on-injection twin (flip skipped→failed; flip parent done-on-child-failed). **Residual finding:** the auto-fix repair thread couples to the agent-spawn path and can't be proven cheaply without that seam — demoted to Open-Q #1 (feature + why + ROI), not asserted as in-scope, so no phantom dependency (parallel-wave cascade lesson). Converged: no fabricated data, no vacuous assertions, no phantom scope.
