# ADR-0232 — Git directive turn-collector wire (phase-aware emit)

**Status**: Accepted
**Date**: 2026-05-25
**ADR-number-collision note**: 0232 and 0233 are also claimed by a parallel
in-flight track (shell-snapshot wire and composition-root mega-wire,
respectively, both seen in `src/agent/types.ts`). This slice's ADR was
originally requested as 0231 by the user, but `docs/decisions/0231-radar-
cards-proposal-queue.md` already exists. **Used ADR-0234 in code references
and reserved this number (0232) for the doc** to align with the closest free
slot at the time the doc was written. The two NUMBER references in this
slice are:
  * `docs/decisions/0232-…` — **this file** (the ADR doc lives at 0232).
  * In-code (`AgentConfig.gitDirectiveEmit`, helper, tools, ADR comments) —
    references **ADR-0234** because 0232/0233 were taken in `src/agent/types.ts`
    by the in-flight tracks when the code was written.

This is a deliberate, documented deviation from the usual "doc-and-code share
the ADR number" rule — the parallel-track collision matrix made a perfect
match impossible. Future readers: the protocol is the same regardless of
number; cross-references in the codebase use `ADR-0234`.

## Context

ADR-0221 landed a **phase-guarded git-directive emitter**:

* 5 directive kinds (`create-branch`, `stage`, `commit`, `push`, `create-pr`).
* HARD guard: directives may be emitted ONLY in `phase: "final-answer"`.
* `commentary` / `intermediate` phases are rejected with a typed `wrong-phase`
  error before any sink write.

The slice shipped with `noopEmitter` (default-OFF) plus a 7-file
`src/git/directive-emit/` slice. 33 hellgate cases pinned the contract.

**Gap left by ADR-0221**: the mutating git tools (`git_commit`,
`git_branch_switch`, future `gh_pr_create`) execute as `tool_use` calls in
the LLM's **intermediate** phase. None of them sits inside a "final-answer"
boundary. So:

* If a tool calls `emitter.emit(d, { phase: "intermediate" })`, the guard
  rejects it and nothing reaches the wire.
* If a tool calls `emitter.emit(d, { phase: "final-answer" })` (lying about
  phase), the guard becomes ceremonial — directives leak ahead of the model's
  committed final answer, exactly the failure the guard was built to
  prevent.
* The legacy ADR-0220 emitter wire (kept in `commit.ts` / `branch-switch.ts`)
  bypasses the phase guard entirely and emits immediately — sufficient for a
  UI that does not care about phase, but the wrong place to add new phase-
  aware consumers.

The `deliberate_hold` block in the catalog YAML
(`tools/feature-catalog/features/08-observability/221-git-directive-emit-
protocol.yaml`) flagged the wire as deferred. This ADR closes that hold.

## Decision

Introduce a **per-turn collector** between the tools and the emitter:

1. **Tools call `collector.record(directive)`** during their intermediate-
   phase execution, immediately after the underlying mutation succeeds. The
   collector buffers the typed directive — no emit happens yet.
2. **The loop calls `collector.flush()`** at the turn boundary (after
   `turnDiffSession.endTurn`, before `emitWorkMetrics`). Flush drains every
   buffered entry through the wired emitter with `phase: "final-answer"`
   — the natural moment that satisfies the ADR-0221 phase invariant.
3. **Result**: the phase invariant survives intact; the call sites stay
   1-line; the directives arrive on the wire in submission order, after the
   turn body has stopped mutating anything else.

### Public surface

* `src/git/directive-emit/turn-collector.ts` — `GitDirectiveCollector` port
  + `buildGitDirectiveCollector(emitter, options?)` + `noopCollector`
  sentinel + `GitDirectiveCollectorOptions` (`includeIntermediate?: boolean`).
* `src/git/directive-emit/index.ts` — barrel re-exports.
* `AgentConfig.gitDirectiveEmit` — opt-in block on the agent config:
  ```ts
  gitDirectiveEmit?: {
    readonly enabled: boolean
    readonly sink?: "stdout" | "stderr" | ((line: string) => void)
    readonly includeIntermediate?: boolean
    readonly emitter?: DirectiveEmitterPort        // test-injection
    readonly collector?: GitDirectiveCollector     // test-injection
  }
  ```
* `loop-helpers#buildGitDirectiveEmit(cfg)` — builds the collector (when
  `enabled === true`), wires the resolved emitter, mutates
  `cfg.gitDirectiveEmit.collector` so the downstream `gitTools` wire reads
  the SAME instance.
* `loop.ts` — calls `buildGitDirectiveEmit` once per session, calls
  `gitDirectiveCollector?.flush()` once per turn (after `endTurn`, before
  `emitWorkMetrics`).
* `GitToolsOpts.gitDirectiveCollector` — new sibling field to the legacy
  `gitDirectiveEmitter`. Either / both / neither may be wired; the two
  surfaces are orthogonal.
* `src/tool/git/_directive-publish.ts` — shared dual-surface helper
  `publishGitDirective(directive, { emitter?, collector? })`. Used by
  `commit.ts` and `branch-switch.ts` to cap cognitive complexity at the
  tool-body level.

### Behavioral invariants

* **Default-OFF byte-identical (RFC §1.2)**. Absent block, or
  `enabled !== true`, ⇒ `buildGitDirectiveEmit` returns `undefined`, no
  collector built, no emitter instantiated, `flush()` never called,
  byte-identical to the pre-ADR path.
* **Phase invariant from ADR-0221 unchanged.** The collector always emits
  with `phase: "final-answer"`. The phase-guard module is the SOLE
  enforcer; the collector is its caller.
* **No-throw public surface.** `record()` returns `void`. `flush()` returns
  `ReadonlyArray<Result<void, EmitError>>` (test-only observability;
  production callers ignore). The collector itself never throws.
* **FIFO order.** Entries arrive in record order and emit in record order.
* **Per-turn vs per-session.** One collector instance per session; flush
  empties the buffer so subsequent turns start clean.
* **Eager emit opt-in** (`includeIntermediate: true`). Records ALSO emit at
  record time (live-progress surfaces). Buffer is still drained at flush
  (single canonical event stream). Eager-emit failure does NOT prevent the
  buffer entry (the deferred flush is the SOURCE OF TRUTH).
* **Re-entrant emit safe.** A sink that synchronously records back into the
  collector during flush does NOT cause double-drain — flush snapshots the
  buffer (`splice`) before iterating.

### What this slice deliberately does NOT do

* **Does not write a `gh_pr_create` tool.** The push / create-pr directives
  are part of the closed union, but the tools that would produce them live
  in `bash` today (HARD_DENY-gated). When they graduate to first-class
  tools, the same `publishGitDirective` helper is the wire site.
* **Does not modify CTK skills.** The 8 CTK git skills (memory:
  `may-23-git-axis-absorption.md` — commit / branch / stage / push /
  pr-create / pr-comment / pr-thread / pr-resolve) execute through the
  same `git_commit` / `git_branch_switch` tools and therefore inherit the
  wire transparently. No per-skill change required.
* **Does not change ADR-0220** (legacy direct-emit). The two surfaces are
  orthogonal; a host that wants the legacy semantics keeps wiring the
  emitter; a host that wants phase-aware semantics wires the collector.
  Both is supported but redundant.

## Consequences

### Wins

* The catalog's `deliberate_hold` on ADR-0221 is closed.
* Phase-aware emit becomes the recommended surface for new consumers
  (replacing the legacy direct-emit).
* The wire site for future mutating git tools is now 1 line:
  `publishGitDirective(directive, surfaces)`.
* Cognitive complexity at the tool body dropped (-3 on branch-switch.ts)
  because the dual-surface dance moved into the helper.

### Negative invariants pinned by hellgate

* `tests/unit/git-directive-turn-collector-hellgate.test.ts` — 18 cases:
  noop collector / FIFO / 5-kind round-trip / phase=final-answer always /
  empty-flush no-op / multi-record / reset between turns / noop-emitter
  drains / includeIntermediate eager emit / default OFF / Result-shape
  surface / wrong-shape errors propagate / throwing emitter caught /
  length accessor / re-entrant emit / eager-emit failure / 2-turn
  independence / directive identity preserved (no defensive copy).

### Test counts

* New: 18 cases (collector hellgate).
* Sibling regression: 0 (the 37-case ADR-0220 + ADR-0221 hellgate batteries
  remain green).
* Slice-boundary: green after adding `loop-helpers.ts` to the agent
  slice's `stdioAllowFiles` (the sink resolver references `process.stdout`
  / `process.stderr` as documented default sinks — fully injectable).

## Wire-time map

```
┌────────────────────────┐   record   ┌──────────────────┐
│ git_commit / branch... │ ─────────▶ │  Collector       │
│ (intermediate phase)   │            │  (buffer)        │
└────────────────────────┘            └────────┬─────────┘
                                               │ flush()
              loop.ts: turn-end ───────────────┤  phase="final-answer"
                                               ▼
                                       ┌──────────────────┐
                                       │ Emitter (ADR-0221│
                                       │  phase-guarded)  │
                                       └────────┬─────────┘
                                                ▼
                                          stdout / stderr / fn sink
                                          (UI grep ^::git-*)
```

## Files

* `src/git/directive-emit/turn-collector.ts` (new)
* `src/git/directive-emit/index.ts` (extended barrel)
* `src/agent/types.ts` (`AgentConfig.gitDirectiveEmit` slot)
* `src/agent/loop-helpers.ts` (`buildGitDirectiveEmit` factory +
  `defaultEmitterFor` sink resolver)
* `src/agent/loop.ts` (build once + flush once-per-turn)
* `src/tool/git/_directive-publish.ts` (dual-surface helper)
* `src/tool/git/commit.ts` (collector wire via helper)
* `src/tool/git/branch-switch.ts` (collector wire via helper)
* `src/tool/git/index.ts` (`GitToolsOpts.gitDirectiveCollector` +
  threading)
* `tests/unit/_arch/slice-boundary-configs.ts` (allow
  `loop-helpers.ts` raw-stdio)
* `tests/unit/git-directive-turn-collector-hellgate.test.ts` (18 cases)
* `tools/feature-catalog/features/08-observability/221-git-directive-emit-
  protocol.yaml` (deliberate_hold released)
