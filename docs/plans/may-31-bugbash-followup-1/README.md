# May 31 Bugbash Final Solve Set

Audit source: `docs/bugbash/may-31-gqlang-audit/`

Snapshot used for final carry decision:
- Repo HEAD: `57d78b8a`
- Audit pass timestamp: `2026-05-31 06:05:44 KST`

What changed from the previous followup draft:
- This pass re-checked the carry set against current source and added several previously omitted `live + verified` medium issues on active surfaces.
- This pass also kept some previously deferred items back out when they were `latent`, `unverified`, `false-positive`, or not current live risk.
- One explicit current-source drop remains: L8 `M1` is still excluded because `DEFAULT_PERMISSION_PROFILE.fileSystem.entries` and `DEFAULT_FILE_SYSTEM_SANDBOX_POLICY.entries` are both empty today, so that specific path is not currently fail-open.

Decision rule:
- Keep only issues that are confirmed by the audit docs, still present in current source, and either live now or directly on an active product boundary.
- Group by fix unit, not raw issue count. One entry can absorb multiple audit IDs when they share the same owning seam.

## Structural Remediation Rules

- Fix at the owning seam, not at the last visible caller. If the same failure can happen through two adapters, the contract is wrong, not just one adapter.
- Introduce the shared primitive first, then migrate callers, then add a ratchet or hellgate so the old shape cannot creep back.
- Do not add new local booleans or per-surface forks when the semantics are cross-cutting. Shared concerns here are cancellation, closeout, no-throw hooks, fail-closed policy, atomic persistence, and SSOT decoding.
- For best-effort paths, make degradation typed and observable. Silent swallow is only acceptable behind a single helper with an error sink.
- For mutable state, one reducer/store owns the invariant. Callers may request changes; they must not manually keep mirrored structures in sync.

## Structural Execution Plan

### Track A. Single Turn Lifecycle Authority

- Owns: `L1 H1/H2/M1/M2/M3`, `L1 M5`, `L5 C-1/H-8/M-5`.
- Owning seam: [src/agent/loop.ts](../../../src/agent/loop.ts) + [src/kernel/session/scheduler.ts](../../../src/kernel/session/scheduler.ts) + [src/host/runtime/internal/context-binding.ts](../../../src/host/runtime/internal/context-binding.ts).
- Structural move:
  - Create one closeout path that every terminal turn outcome must pass through: normal finish, refusal, budget exhaustion, user abort, approval throw/pause, and hard error.
  - Move transcript sealing, outcome classification, turn-diff finalization, git-directive flush, and work-metrics flush behind that single authority.
  - Collapse “early-start allowed” to a stricter contract: only read-only tools can overlap before final turn outcome is known.
  - Make kernel cancel real by having one turn-owned controller and one cancel action path, rather than reducer no-op plus host-local workarounds.
- Patch-on-patch to avoid:
  - No more per-branch `wm.append(...)` fixes in budget/refusal/error branches.
  - No more adapter-local abort classification patches that bypass the turn outcome authority.
- Proof rail:
  - Add end-to-end tests for abort, refusal, budget exhaustion, and approval pause asserting identical transcript invariants: no orphan `tool_use`, correct reason, observability flushed once.

### Track B. One Abort/Deadline Primitive Across Boundaries

- Owns: `L3 C-6/C-9/C-10`, `L5 H-2/H-5/M-6/M-8/M-10/M-14`, `L6 C2`, `L9 H1/H3/H4/H11/H12`.
- Owning seam: composition roots in `src/apps/**`, plus shared boundary helpers in `@/shared` or `@/runtime`.
- Structural move:
  - Add one shared boundary toolkit for `AbortSignal` propagation: `throwIfAborted`, `abortableSleep`, `fetchWithDeadline`, and `spawn/read loop` wrappers.
  - Make composition roots own real controllers. Ban `new AbortController().signal` placeholders in presets and runtimes.
  - Thread typed `signal?: AbortSignal` through ports instead of retrofitting leaf callsites one by one.
  - Use the same primitive for eval verify, OTel POST, HTTP-SSE POST/GET, STT fetches, shadow verify, and long sleeps/retries.
- Patch-on-patch to avoid:
  - No one-off `if (signal?.aborted)` checks without also wiring the underlying I/O.
  - No duplicate timeout wrappers per adapter.
- Proof rail:
  - Add boundary tests that prove underlying work stops, not just caller promises resolving early.

### Track C. No-Throw / Best-Effort Hook Standardization

- Owns: `L3 C-2/C-3/C-4`, `L5 H-3/M-1`, `L6 H1/H8`, `L6 M4/M7/M8`, parts of `L9 M9/M10/M18`.
- Owning seam: cross-slice observer and callback invocation sites.
- Structural move:
  - Introduce one shared `invokeNoThrow` or equivalent helper for optional callbacks, loggers, hook sinks, and background continuations.
  - Standardize an optional error sink interface for “best-effort but observable” paths.
  - Split “domain failure” from “observer failure” in kernel/session and transport code.
- Patch-on-patch to avoid:
  - No more inline `try/catch {}` around each hook with ad hoc logging.
  - No more `.catch(() => undefined)` in transport/observer code without a routed sink.
- Proof rail:
  - Add hellgates where hostile callbacks throw and verify domain state still completes and the error is surfaced exactly once.

### Track D. Single-Owner State Invariants

- Owns: `L1 H3/M4`, `L2 H6+H7/H3`, `L3 C-1/C-5`, `L9 H5/M7/M8`.
- Owning seam: reducers/stores, not callers.
- Structural move:
  - `PlanStore` becomes the only owner of `todo.phaseId` ↔ `phase.todoIds`; callers stop composing multi-step mutations.
  - Session registry activity gets one `touchOnActivity` helper covering append/cache-hit, not scattered `lastTouched` writes.
  - Subagent resume/continue must validate ownership at the registry/API boundary, not at a higher-level caller.
  - Scheduler runtime and engine need one idempotent mutation model for `enqueue + markRun + retry`, not loosely coupled runtime and storage behavior.
  - Stage1 memory stores should expose one semantic operation for “reuse consumed once” instead of two independently mutating methods.
- Patch-on-patch to avoid:
  - No caller-side mirrored list repair after the store mutates.
  - No “remember to also update X” comments as the invariant.
- Proof rail:
  - Store-level tests asserting invariants directly after each mutation, plus replay/restart tests for session registry and scheduler persistence.

### Track E. Fail-Closed Permission and Sandbox Base

- Owns: `L8 H1/H3/H4/H5/M2/M5/M6`, plus `L8 M4/M8` from Tier 2.
- Owning seam: `@/permission`, `@/runtime/shell`, plugin-isolation loaders.
- Structural move:
  - Replace ambiguous booleans with typed verdicts where needed: `allow | deny | defer`, `sandboxApplied | degraded(reason)`.
  - Centralize path normalization and root checking behind one helper reused by permission checks and sandbox wrappers.
  - Make deny precedence explicit in one evaluator instead of relying on bucket ordering.
  - Make persistence failure part of the permission-store contract so callers can distinguish “decision applied in memory” from “durably persisted”.
- Patch-on-patch to avoid:
  - No callsite-specific fixes for `custom` host mode semantics.
  - No more direct prefix checks or empty-root special cases scattered across callers.
- Proof rail:
  - Permission-focused hellgates for protected-branch reset, lexical traversal, empty writable roots, and degraded sandbox honesty.

### Track F. Durable Persistence and Honest Recovery

- Owns: `L9 H7/H8/H9`, `L9 M4/M6/M9/M10/M14`, plus session/index pieces from Tier 2.
- Owning seam: persistence adapters in `@/connectors`, `@/session`, `@/scheduler`, `@/migration`.
- Structural move:
  - Standardize one atomic write / rewrite helper where full-file persistence is intended, instead of bespoke tmp+rename or direct overwrite mixes.
  - Separate “write succeeded”, “write partially failed”, and “write deferred” in result types where current code lies by returning empty/ok.
  - For dedup/idempotency stores, persist the authoritative set instead of documenting persistence that does not exist.
  - For recovery/reconcile paths, make compensation explicit rather than relying on a future read side-effect.
- Patch-on-patch to avoid:
  - No more “warn once and return []” for registry/store outages.
  - No more silent index drift that assumes later load will repair it.
- Proof rail:
  - Crash-window tests around custom-3p registry, webhook idempotency, session export/index writes, and stale import-log locks.

### Track G. Boundary I/O Correctness

- Owns: `L9 C1`, `L9 H3/H4/H6/H10/H12`, `L9 M17/M18`, `L6 M9/M10`.
- Owning seam: external process / fetch / transport adapters.
- Structural move:
  - Move all shell/process/network boundary work behind typed helpers that encode quoting, draining, timeout, and close semantics once.
  - For skybridge and remote runners, make capability reporting derive from actually applied policy, not intended policy.
  - For IPC/MCP transports, unify close/error/version handling at the transport boundary instead of layering fixups in callers.
- Patch-on-patch to avoid:
  - No direct `bash -c` assembly in adapters.
  - No transport that reports `sandboxApplied: true` or “connected” without applying the policy/version contract it advertises.
- Proof rail:
  - Injection tests for Lima/PR-comment paths, socket leak tests for HTTP-SSE, and protocol-version rejection tests for IPC control frames.

### Track H. SSOT Consolidation

- Owns: `L6 M1/M11`, `L9 H13`, plus any duplicated parser/evaluator pair already listed.
- Owning seam: canonical factories/codecs/parsers.
- Structural move:
  - Pick one canonical implementation for each duplicated semantic surface and delete or demote the shadow copy.
  - Keep provider credential metadata, parser logic, and protocol decoding in one exported authority and have all callers consume that authority.
- Patch-on-patch to avoid:
  - No “fix both copies” strategy. Delete or invert one side.
  - No new comments claiming two modules stay in sync manually.
- Proof rail:
  - Exact-zero ratchet or import-fence tests for duplicate conflict parser usage and duplicated provider metadata logic.

## Recommended Program Order

1. Track A first. It closes the largest concentration of live correctness defects and removes the worst patch-on-patch risk in `loop.ts`.
2. Track B and Track C next. They provide the shared primitives the rest of the boundary fixes should consume.
3. Track D and Track E after that. These are state-ownership and fail-closed corrections; they should land on top of the new lifecycle primitives, not beside them.
4. Track F and Track G next. They are large boundary sweeps and benefit from the shared deadline/no-throw infrastructure already being in place.
5. Track H last. It is cleanup with high leverage, but it should follow once the owning seams are already stabilized.

## Do-Not-Do List During Execution

- Do not fix the same semantic bug independently in `apps`, `runner`, and adapter layers. Move the contract down and delete the duplicate branch.
- Do not add new “best-effort” comments without a typed sink or result shape.
- Do not add new retry/timeout helpers locally to one slice if Track B has not defined the shared primitive yet.
- Do not keep duplicate parser/evaluator modules alive once one becomes the authority.
- Do not claim closeout on a track without the owning proof rail green.

## Ticket Breakdown

These tickets are the execution units. Most own one primary seam family; `T01` is a shared-foundation ticket and `T13` is a cleanup ratchet ticket. Each ticket still needs one clear proof rail before the next dependent ticket starts.

### T01. Boundary Primitive Kit

- Supports: `L3 C-6/C-9/C-10`, `L5 H-2/H-5/M-6/M-8/M-10`, `L6 C2`, `L9 H1/H3/H4/H11/H12`.
- Touch files:
  - new shared helper(s) under `src/shared/**` or `src/runtime/**` for `throwIfAborted`, `abortableSleep`, `fetchWithDeadline`, and stream/process drain wrappers
  - [headless.ts](../../../src/apps/agent/mode-presets/headless.ts), [batch.ts](../../../src/apps/agent/mode-presets/batch.ts), [daemon.ts](../../../src/apps/agent/mode-presets/daemon.ts), [ide.ts](../../../src/apps/agent/mode-presets/ide.ts), [ci-bot.ts](../../../src/apps/agent/mode-presets/ci-bot.ts), [interactive.ts](../../../src/apps/agent/mode-presets/interactive.ts)
  - [driver.ts](../../../src/runner/batch/eval/driver.ts), [python-swebench.ts](../../../src/apps/bench/python-swebench.ts), [session-memory-auto.ts](../../../src/runner/session-memory-auto.ts)
  - [apply-v4a.ts](../../../src/agent/shadow-verify-adapters/apply-v4a.ts), [scratch-worktree.ts](../../../src/agent/shadow-verify-adapters/scratch-worktree.ts), [http-sse.ts](../../../src/mcp/transports/http-sse.ts), [deepgram-adapter.ts](../../../src/media/stt/deepgram-adapter.ts), [openai-whisper-adapter.ts](../../../src/media/stt/openai-whisper-adapter.ts)
- Core logic:
  - create one reusable abort/deadline contract and make composition roots own the real controller
  - remove dead placeholder signals and pass the same signal to leaf I/O instead of checking abort only at the caller
  - encode timeout, cleanup, and stream close semantics once so boundary adapters stop open-coding it
- Implementation shape:
  - primitive first, then mode-preset/controller wiring, then boundary adoption
  - if a boundary cannot support cancellation, make that explicit in the result/error path instead of pretending it was cancellable
- DoD:
  - no `new AbortController().signal` placeholder remains on the carried surfaces
  - long sleep/retry/fetch/stream paths stop underlying work when the signal aborts
  - all touched boundaries return a typed timeout or abort reason instead of silent fallback
- Proof rail:
  - add slice-local hellgates proving cancelled eval, shadow verify, STT, and HTTP-SSE sessions terminate underlying work

### T02. Turn Outcome Authority

- Covers: `L1 H1/H2/M1/M2/M3`, `L1 M5`.
- Touch files:
  - [loop.ts](../../../src/agent/loop.ts), [streaming-dispatch.ts](../../../src/agent/streaming-dispatch.ts), [compaction-breaker.ts](../../../src/agent/compaction-breaker.ts)
  - likely new helper near `src/agent/loop-helpers.ts` for terminal turn closeout
  - new tests under `src/agent/**/__tests__/`
- Core logic:
  - every terminal turn outcome must pass one authority path: success, refusal, budget stop, approval pause, abort, hard error
  - transcript sealing, `turn-diff` finalization, git-directive flush, and work-metrics flush must happen inside that authority, not in per-branch cleanup
  - early-start must become a capability-gated mode; mutating work cannot commit before the turn outcome is known
- Implementation shape:
  - factor terminal outcome classification into one function returning a typed closeout plan
  - make the loop consume that plan exactly once and delete branch-local cleanup fragments
  - compaction breaker should feed the same outcome path, not inject a side branch
- DoD:
  - no terminal branch in `loop.ts` can exit without invoking the shared closeout authority
  - refusal/budget/abort cannot leave orphan tool state or skip observability flush
  - proactive breaker either works through the same authority or is removed
- Proof rail:
  - e2e or high-level hellgates for refusal, budget exhaustion, user cancel, and approval pause asserting identical transcript invariants

### T03. Kernel Cancel and Approval Lease Isolation

- Covers: `L5 C-1/H-8/M-5`, `L5 H-1/M-2/M-3`.
- Touch files:
  - [reducer.ts](../../../src/kernel/session/reducer.ts), [scheduler.ts](../../../src/kernel/session/scheduler.ts), [context-binding.ts](../../../src/host/runtime/internal/context-binding.ts)
  - likely companion tests under `src/kernel/session/__tests__/` and `src/host/runtime/internal/__tests__/`
- Core logic:
  - `turn.cancel` must mutate real turn-owned cancel state and propagate to the same controller used by active host work
  - approval grants must become lease-like and scoped to one turn/action instance instead of being shared across same-key concurrent work
  - `onCommitted` and similar observer failures must not redefine turn success/failure semantics
- Implementation shape:
  - reducer owns cancel state; scheduler only executes it
  - context binding stores grants by turn instance or opaque lease id, not by broad action key alone
  - observer failures route to a no-throw sink instead of bubbling as primary turn failure
- DoD:
  - public cancel changes active turn behavior in a deterministic way
  - concurrent host actions with the same action key do not share approval state
  - host observer failure is observable but cannot corrupt terminal turn classification
- Proof rail:
  - reducer/scheduler tests for cancel propagation plus host-runtime concurrency tests for grant isolation

### T04. Plan and Session Invariant Ownership

- Covers: `L1 H3/M4`, `L2 H6+H7/H3`.
- Touch files:
  - [mutations.ts](../../../src/agent/plan/mutations.ts), [mutator-adapter.ts](../../../src/agent/plan/mutator-adapter.ts)
  - [disk-store.ts](../../../src/agent/session-resource-registry/disk-adapter/disk-store.ts), [gc.ts](../../../src/agent/session-resource-registry/disk-adapter/gc.ts), [agent-tool.ts](../../../src/subagent/agent-tool.ts)
  - likely new tests in `src/agent/plan/__tests__/` and existing disk-adapter test folders
- Core logic:
  - `PlanStore` becomes the only owner of `todo.phaseId` and `phase.todoIds`
  - metadata update and reorder must be one atomic store mutation, not two caller-visible steps
  - session registry freshness must have one `touchOnActivity` path covering append and cache-hit
  - `continue_from` must validate task lineage/ownership at the registry or API boundary before data access
- Implementation shape:
  - introduce store-level semantic operations such as `moveTodo`, `updateMetaAndReorder`, `touchOnActivity`, and `loadContinueFromForOwner`
  - delete caller-side mirrored repair and ad hoc `lastTouched` writes
- DoD:
  - no caller outside the owning store updates both sides of a mirrored invariant manually
  - append/cache-hit activity extends liveness consistently
  - foreign task id cannot read settled subagent output without lineage proof
- Proof rail:
  - store mutation invariant tests and restart/GC replay tests for disk registry behavior

### T05. Memory Contract Normalization

- Covers: `L3 C-1/C-2/C-3/C-4/C-5/C-7/C-18/C-20`.
- Touch files:
  - [memory-consolidator-hook.ts](../../../src/agent/memory-consolidator-hook.ts)
  - [sqlite.ts](../../../src/agent/memory/stage1-store/sqlite.ts), [in-memory.ts](../../../src/agent/memory/stage1-store/in-memory.ts)
  - [sqlite.ts](../../../src/memory/adapters/sqlite.ts), [memory.ts](../../../src/agent/memory.ts)
  - [inject.ts](../../../src/agent/context-change/inject.ts)
  - likely new tests in `src/agent/memory/**/__tests__/` and `src/memory/**/__tests__/`
- Core logic:
  - stage1 reuse must become one semantic operation so consumption and usage accounting cannot drift
  - optional logger/hook invocation must be no-throw by construction
  - adapter methods promised as async must never sync-throw
  - persistence and eviction loops must honor caller abort mid-flight
  - context-event builders must fail exhaustively when new event kinds are added
- Implementation shape:
  - introduce one `reuseConsumedEntry` operation in stage1 stores
  - wrap observer calls with a shared no-throw helper instead of inline `try/catch`
  - make adapter APIs return `Promise<Result>` or `Promise<void>` consistently and normalize thrown failures at the boundary
- DoD:
  - stage1 reuse cannot double-bump usage
  - no logger/hook throw can abort consolidation or memory persistence flows
  - corrupt embedding / persist / evict degradation is surfaced with a typed observable path
  - adding a new context event fails compile or test until builder logic is updated
- Proof rail:
  - hellgates for hostile callbacks, async delete errors, mid-flight abort, and context-event exhaustiveness

### T05A. Issue-Hint Tail Preservation

- Covers: `L3 C-11/C-12`.
- Touch files:
  - [extract-code.ts](../../../src/agent/issue-hint/extract-code.ts), [extract-tracebacks.ts](../../../src/agent/issue-hint/extract-tracebacks.ts)
  - likely tests under `src/agent/issue-hint/__tests__/`
- Core logic:
  - issue-hint compression must not silently drop the highest-signal tail segments when input exceeds budget
  - code and traceback extraction should share one explicit overflow policy instead of each truncating opportunistically
- Implementation shape:
  - introduce one budgeted segment collector that decides head/tail reservation once
  - make overflow explicit in the returned shape or metadata so downstream consumers can tell when compaction occurred
- DoD:
  - oversized code and traceback inputs preserve the carried tail evidence that was previously dropped
  - both extractors use the same budget policy instead of forked truncation logic
  - overflow is observable, not silent
- Proof rail:
  - targeted hellgates with over-budget snippets and tracebacks asserting the final frames/lines survive compaction

### T06. Search, Bridge, and CLI Lifecycle Ownership

- Covers: `L5 H-3/H-4/H-7/M-1/M-9/M-11/M-12/M-13/M-14`, plus `L9 M4/M6`.
- Touch files:
  - [session.ts](../../../src/sdk/runtime/session.ts), [search-index-backend.ts](../../../src/runner/assemble/search-index-backend.ts), [search-pipeline.ts](../../../src/runner/assemble/search-pipeline.ts)
  - [session-loop.ts](../../../src/apps/cli/repl/session-loop.ts), [result-store.ts](../../../src/apps/eval/storage/result-store.ts), [external-prompt-queue.ts](../../../src/apps/cli/repl/external-prompt-queue.ts)
  - [import-export.ts](../../../src/session/import-export.ts), [store.ts](../../../src/session/store.ts), [index-store.ts](../../../src/session/index-store.ts)
  - likely tests under `src/sdk/runtime/__tests__/`, `src/runner/assemble/__tests__/`, `src/session/__tests__/`, `src/apps/eval/**/__tests__/`
- Core logic:
  - explicit `QUANTA_VECTOR_STORE` selection must fail closed at the backend owner seam
  - bridge/search lifecycle must own interval start/stop, teardown ordering, and error-state surfacing in one place
  - partial CLI init must register compensating cleanup before any later step can fail
  - result-store and export/index writes must be atomic or compensating, not multi-step optimistic commits
- Implementation shape:
  - search backend returns typed `ready | degraded | failed` state instead of silent fallback
  - session/CLI lifecycles use a single close stack or disposer registry
  - export/store code writes payload and index through one atomic helper or explicit rollback path
- DoD:
  - invalid explicit vector-store config does not silently fall back
  - no interval, process, DB handle, or queue watcher survives partial session init failure
  - session export digest and index metadata are stable and compensating on failure
- Proof rail:
  - config-fail-closed tests for search backend, teardown leak tests for session loop, and crash-window tests for export/index writes

### T07. Realtime and LLM Wire Contracts

- Covers: `L6 C1/C2/H1/H2/H3/H4/H7/H8`, `L6 M1/M2/M3/M4/M5/M6/M7/M8/M9/M10/M11`.
- Touch files:
  - [default-adapter.ts](../../../src/realtime/default-adapter.ts)
  - [stream-timeout.ts](../../../src/llm/stream-timeout.ts), [openai-responses-wire.ts](../../../src/llm/openai-responses-wire.ts), [openai.ts](../../../src/llm/adapters/openai.ts)
  - [chatgpt-oauth.ts](../../../src/llm/adapters/chatgpt-oauth.ts), [refresh.ts](../../../src/auth/chatgpt-oauth/refresh.ts), [provider-router.ts](../../../src/llm/provider-router.ts), [factory.ts](../../../src/llm/factory.ts), [responses-stream.ts](../../../src/llm/responses-stream.ts), [jsonl-recorder.ts](../../../src/stream/adapters/jsonl-recorder.ts), [replay-llm.ts](../../../src/llm/replay/replay-llm.ts), [foundry-adapter.ts](../../../src/llm/providers/foundry-adapter.ts)
  - likely tests under `src/realtime/__tests__/`, `src/llm/**/__tests__/`, `src/auth/chatgpt-oauth/__tests__/`
- Core logic:
  - stream/realtime close paths must be idempotent and shield sibling listeners from each other
  - best-effort callback failure must not abort primary stream delivery
  - OpenAI/provider adapters must preserve structured error classification through finalize/abort/replay paths
  - provider metadata and auth validation must come from one authority, not duplicated truth tables
- Implementation shape:
  - add a shared no-throw listener dispatcher for realtime and stream observers
  - route finalize/abort through one error-mapping function
  - consolidate provider capability metadata into one exported authority consumed by router/factory/adapters
- DoD:
  - close is safe under racing callbacks and repeated calls
  - replay/recorder/foundry/openai paths classify abort vs provider failure consistently
  - `chatgpt-oauth` metadata and refresh validation are aligned across router and adapter surfaces
- Proof rail:
  - hostile-listener tests, iterator-throw cleanup tests, and provider-metadata SSOT ratchets

### T08. Permission Fail-Closed Base

- Covers: `L8 H1/H3/H4/H5/M2/M4/M5/M6/M8`.
- Touch files:
  - [shell.ts](../../../src/runtime/shell.ts), [trust-scope-store.ts](../../../src/permission/trust-scope-store.ts), [branch-only.ts](../../../src/permission/branch-only.ts), [access-check.ts](../../../src/permission/access-check.ts)
  - [per-host-mode.ts](../../../src/permission/per-host-mode.ts), [json-state-file.ts](../../../src/permission/json-state-file.ts), [per-thread-store.ts](../../../src/permission/per-thread-store.ts)
  - [entropy-scanner.ts](../../../src/security/secret-detection/entropy-scanner.ts), [dxt-loader.ts](../../../src/plugin-isolation/dxt-loader.ts)
  - likely tests under `src/permission/**/__tests__/`, `src/security/**/__tests__/`, `src/plugin-isolation/__tests__/`
- Core logic:
  - permission and sandboxing must return typed verdicts and typed degradation, not booleans plus logs
  - path evaluation must normalize real paths and explicit roots once
  - deny precedence must be explicit and testable
  - persistence failures and plugin-path escapes must be surfaced as deny/degraded, not implicit allow
- Implementation shape:
  - introduce one permission verdict model and make shell/runtime report whether sandbox policy was actually applied
  - centralize root/path containment helper reused by permission checks and DXT resolution
  - treat `custom` host mode as defer/unknown until resolved, not allow
- DoD:
  - protected branch reset, lexical traversal, empty-root widening, and DXT path escape all fail closed
  - persistence failure is visible to callers and cannot masquerade as durable success
  - secret scan catches the carried 64-hex hole or explicitly scopes why it is not a supported detector class
- Proof rail:
  - permission hellgates for branch reset, path traversal, empty roots, degraded sandbox honesty, and DXT containment

### T09. Boundary I/O Hardening

- Covers: `L3 C-13/C-14`, `L9 C1/H1/H2/H3/H4/H11`, `L9 M1/M2/M3`.
- Touch files:
  - [inline-trigger-watcher.ts](../../../src/skill/playbook/inline-trigger-watcher.ts), [fs-watch-adapter.ts](../../../src/skill/playbook/trigger/fs-watch-adapter.ts)
  - [lima-adapter.ts](../../../src/remote/runner/lima-adapter.ts), [docker-adapter.ts](../../../src/remote/runner/docker-adapter.ts)
  - [otel-exporter.ts](../../../src/observability/otel-exporter.ts), [otel-sink.ts](../../../src/observability/metrics/otel-sink.ts), [health-snapshot-watcher.ts](../../../src/observability/metrics/health-snapshot-watcher.ts)
  - [local-whisper-transcriber.ts](../../../src/voice/transcriber/local-whisper-transcriber.ts), [deepgram-adapter.ts](../../../src/media/stt/deepgram-adapter.ts), [openai-whisper-adapter.ts](../../../src/media/stt/openai-whisper-adapter.ts)
  - likely tests under `src/remote/**/__tests__/`, `src/observability/**/__tests__/`, `src/voice/**/__tests__/`, `src/skill/playbook/**/__tests__/`
- Core logic:
  - shell/process/network boundaries need one typed helper for quoting, draining, timeout, close, and fire-and-forget error routing
  - playbook watcher input expansion must be bounded and validated
  - OTel exporter queueing/temporality/timer semantics must be bounded by policy, not open-ended retries
  - local whisper and STT adapters must drain outputs and honor timeout/cancel semantics
- Implementation shape:
  - remove raw shell string assembly where structured argv or escaped args are possible
  - replace naked fire-and-forget promises with tracked background tasks routed through a sink
  - use bounded buffer/queue settings plus deterministic flush/exit semantics in telemetry code
- DoD:
  - Lima path has no injectable shell assembly on the carried surface
  - watchers cannot explode work from unbounded brace expansion
  - telemetry exporters cannot grow without bound on sustained failure
  - local whisper/STT work closes streams and honors timeout/abort
- Proof rail:
  - injection tests, bounded-queue soak tests, and drain/timeout hellgates

### T10. Scheduler Runtime Correctness

- Covers: `L9 H5/M7/M8/M9/M10/M11`.
- Touch files:
  - [ticker.ts](../../../src/scheduler/automation-engine/ticker.ts), [runtime.ts](../../../src/scheduler/runtime.ts), [sqlite.ts](../../../src/scheduler/automation-engine/sqlite.ts), [store-jsonl.ts](../../../src/scheduler/store-jsonl.ts)
  - likely companion files [runtime-wire.ts](../../../src/scheduler/runtime-wire.ts) and `src/scheduler/**/__tests__/`
- Core logic:
  - runtime dispatch, retry, and persistence need one idempotent run model keyed by stable run identity
  - same-ms ids and ticker overlap must not produce duplicate execution
  - JSONL/sqlite persistence failures must be first-class runtime errors, not warning-only drift
- Implementation shape:
  - define a single `claim -> execute -> finalize` state machine with durable run markers
  - add in-flight guard at ticker/runtime boundary
  - persist retry/backoff intent explicitly instead of reconstructing it from loose side effects
- DoD:
  - one scheduled fire produces at most one owned execution attempt unless an explicit retry state exists
  - errored automations retry according to durable policy after restart
  - storage failures are observable and cannot silently mark work as complete
- Proof rail:
  - restart/replay tests for retry and dedup plus same-timestamp collision tests

### T11. Durable Persistence Sweep

- Covers: `L9 H7/H8/H9`, `L9 M12/M13/M14`.
- Touch files:
  - [rest-registry.ts](../../../src/connectors/rest-registry.ts), [jsonl-store.ts](../../../src/connectors/custom-3p/jsonl-store.ts)
  - [default.ts](../../../src/storage/shadow-odb/default.ts), [cleanup.ts](../../../src/storage/shadow-odb/cleanup.ts)
  - [persistence.ts](../../../src/migration/persistence.ts)
  - likely tests under `src/connectors/**/__tests__/`, `src/storage/shadow-odb/__tests__/`, `src/migration/__tests__/`
- Core logic:
  - full-file persistence must go through one atomic write/rewrite helper
  - outage vs empty state vs partial write must be distinct results
  - cross-process head registration and stale-lock cleanup must be serialized and reclaimable
- Implementation shape:
  - unify tmp-write-rename plus fsync expectations where applicable
  - return typed degraded/error states instead of `[]` or silent cleanup
  - add stale-lock timestamp/owner checks with bounded reclaim rules
- DoD:
  - connector outage cannot masquerade as an empty catalog
  - custom-3p store, shadow ODB state, and import-log persistence recover honestly after crash windows
  - size-cap cleanup still enforces limits on error paths
- Proof rail:
  - fault-injection tests around partial writes, stale locks, and concurrent head registration

### T12. GitHub, MCP, and IPC Boundary Hygiene

- Covers: `L9 H6/H9/H10/H12`, `L9 M17/M18`.
- Touch files:
  - [trigger-source-pr-comment.ts](../../../src/reactor/trigger-source-pr-comment.ts), [idempotency.ts](../../../src/integrations/github/idempotency.ts), [pr-output-sink.ts](../../../src/integrations/github/pr-output-sink.ts)
  - [http-sse.ts](../../../src/mcp/transports/http-sse.ts), [lima-microvm.ts](../../../src/mcp/skybridge/lima-microvm.ts)
  - [bridge.ts](../../../src/ipc/session/bridge.ts), [stdio.ts](../../../src/ipc/transports/stdio.ts), [codec.ts](../../../src/ipc/session/codec.ts)
  - likely tests under `src/integrations/github/**/__tests__/`, `src/mcp/**/__tests__/`, `src/ipc/**/__tests__/`
- Core logic:
  - GitHub comment/review outputs need durable dedup identity across verbs, not in-memory best effort
  - MCP HTTP-SSE must own both POST and SSE lifetime and abort them together on close
  - skybridge capability reporting must derive from applied policy
  - IPC transports must validate control-frame version and always drain end/error/close state into bridge bookkeeping
- Implementation shape:
  - promote dedup keying to a persisted store reused across pollers and sinks
  - make transport close semantics explicit and symmetric across request and event channels
  - command-state growth in bridge must be pruned on terminal transitions
- DoD:
  - review/comment dedup survives process restart
  - skybridge cannot report `sandboxApplied: true` when compiled policy was dropped
  - stdio end/error/version mismatch cannot leave bridge state hanging
- Proof rail:
  - restart dedup tests, lifecycle abort tests for HTTP-SSE, and protocol-version rejection hellgates

### T13. SSOT and Parser Consolidation

- Covers: `L6 M1`, `L9 H13`.
- Touch files:
  - [provider-router.ts](../../../src/llm/provider-router.ts) and the canonical provider metadata owner introduced in `T07`
  - [conflict-parser.ts](../../../src/git/conflict-parser.ts), [parse.ts](../../../src/tool/git/conflict-parser/parse.ts), plus any barrel files importing them
  - likely tests under `src/llm/**/__tests__/` and `src/git/**/__tests__/`
- Core logic:
  - duplicated semantic logic must be reduced to one exported authority
  - the shadow copy must be deleted or inverted into a thin forwarder with a ratchet that prevents re-divergence
- Implementation shape:
  - decide canonical owner once, update imports, then delete the duplicate body
  - add import-fence or exact-zero tests so future duplicate reintroduction fails fast
- DoD:
  - only one implementation owns provider credential metadata
  - only one implementation owns conflict parsing semantics
  - no manual “keep in sync” comments remain on the carried surfaces
- Proof rail:
  - import-fence tests or exact-source-equality ratchets covering the removed duplication

## Ticket Order

1. `T01` first. The abort/deadline primitive is the dependency for several other seams.
2. `T02` and `T03` next. They close the highest-risk live turn-integrity surface.
3. `T04`, `T05`, and `T05A` after that. They move invariants back into owning stores and close the remaining `L3` data-loss seam before more boundary fixes land.
4. `T06`, `T07`, and `T08` next. They repair live runtime, provider, and permission boundaries using the shared primitives.
5. `T09` through `T12` after that. They are large boundary and durability sweeps.
6. `T13` last. It should land once the canonical owners are already clear from earlier tickets.

## Tier 1 — Closeout Blockers

- `Agent early-exit integrity` — `L1 H1/H2/M1/M2/M3` — abort is still misclassified, `budget_exhausted` and `refusal` can still leave invalid transcript state, refusal can still land mutating early-start tool side effects, and the proactive breaker knob is still inert. Primary files: [loop.ts](../../../src/agent/loop.ts), [streaming-dispatch.ts](../../../src/agent/streaming-dispatch.ts), [compaction-breaker.ts](../../../src/agent/compaction-breaker.ts).

- `Plan phase membership drift` — `L1 H3` — `todo.phaseId` and `phase.todoIds` are still not updated atomically on add/move/remove. Primary file: [mutations.ts](../../../src/agent/plan/mutations.ts).

- `Session registry freshness` — `L2 H6+H7` — active session disk state can still be GC-evicted silently because append/cache-hit activity does not refresh `lastTouched`. Primary files: [disk-store.ts](../../../src/agent/session-resource-registry/disk-adapter/disk-store.ts), [gc.ts](../../../src/agent/session-resource-registry/disk-adapter/gc.ts).

- `continue_from isolation` — `L2 H3` — prior settled subagent output is still readable by task id without owner/lineage proof. Primary file: [agent-tool.ts](../../../src/subagent/agent-tool.ts).

- `Memory stage1 / consolidator contract` — `L3 C-1/C-2/C-3/C-4` — stage1 reuse still double-bumps usage and consolidator logger call sites still do not structurally enforce their no-throw contract. Primary files: [memory-consolidator-hook.ts](../../../src/agent/memory-consolidator-hook.ts), [sqlite.ts](../../../src/agent/memory/stage1-store/sqlite.ts), [in-memory.ts](../../../src/agent/memory/stage1-store/in-memory.ts).

- `Memory adapter promise / cancel contracts` — `L3 C-5/C-6/C-7` — `SqliteStore.delete()` still sync-throws, consolidation LLM requests still do not carry the caller signal, and `buildOne()` is still non-exhaustive for future context-event additions. Primary files: [sqlite.ts](../../../src/memory/adapters/sqlite.ts), [memory-consolidate.ts](../../../src/agent/memory-consolidate.ts), [inject.ts](../../../src/agent/context-change/inject.ts).

- `Shadow verify and hint extraction` — `L3 C-9/C-10/C-11/C-12` — shadow verify still ignores cancellation on apply/open and issue-hint compression still drops the tail under pressure. Primary files: [apply-v4a.ts](../../../src/agent/shadow-verify-adapters/apply-v4a.ts), [scratch-worktree.ts](../../../src/agent/shadow-verify-adapters/scratch-worktree.ts), [extract-code.ts](../../../src/agent/issue-hint/extract-code.ts), [extract-tracebacks.ts](../../../src/agent/issue-hint/extract-tracebacks.ts).

- `Playbook trigger safety` — `L3 C-13/C-14` — brace expansion is still DoS-capable and fire-and-forget watch dispatch can still surface as unhandled rejection. Primary files: [inline-trigger-watcher.ts](../../../src/skill/playbook/inline-trigger-watcher.ts), [fs-watch-adapter.ts](../../../src/skill/playbook/trigger/fs-watch-adapter.ts).

- `Kernel cancel and signal semantics` — `L5 C-1/H-8/M-5` — public turn cancel is still a no-op, dispatch still treats signal as advisory, and `onCommitted` failure is still not isolated from turn failure semantics. Primary files: [reducer.ts](../../../src/kernel/session/reducer.ts), [scheduler.ts](../../../src/kernel/session/scheduler.ts).

- `Runtime approval and host-side concurrency` — `L5 H-1/M-2/M-3` — approval grants still outlive the turn boundary and same-actionKey host-side concurrency still shares unsafe grant state. Primary file: [context-binding.ts](../../../src/host/runtime/internal/context-binding.ts).

- `Mode / eval signal plumbing` — `L5 H-2/H-5/M-6/M-8/M-10` — non-interactive presets still use dead signals, interactive still owns an inconsistent controller path, eval still has non-cancellable sleep/runtime segments, and session-memory auto setup still opens DB without an abort path. Primary files: [headless.ts](../../../src/apps/agent/mode-presets/headless.ts), [batch.ts](../../../src/apps/agent/mode-presets/batch.ts), [daemon.ts](../../../src/apps/agent/mode-presets/daemon.ts), [ide.ts](../../../src/apps/agent/mode-presets/ide.ts), [ci-bot.ts](../../../src/apps/agent/mode-presets/ci-bot.ts), [interactive.ts](../../../src/apps/agent/mode-presets/interactive.ts), [driver.ts](../../../src/runner/batch/eval/driver.ts), [python-swebench.ts](../../../src/apps/bench/python-swebench.ts), [session-memory-auto.ts](../../../src/runner/session-memory-auto.ts).

- `SDK bridge and broken search-index state surfacing` — `L5 H-3/H-4/M-11/M-12/M-13` — transport bridge errors still disappear, invalid explicit `QUANTA_VECTOR_STORE` still degrades too quietly, and the search pipeline still has loose teardown/error-state ownership around its interval-driven index wire. Primary files: [session.ts](../../../src/sdk/runtime/session.ts), [search-index-backend.ts](../../../src/runner/assemble/search-index-backend.ts), [search-pipeline.ts](../../../src/runner/assemble/search-pipeline.ts).

- `CLI / eval lifecycle leaks and write races` — `L5 H-7/M-1/M-9/M-14` — partial CLI session init can still leak resources, MCP stop failure is still silent, eval result-store chaining is still race-prone, and external prompt queue abort cleanup is still racy. Primary files: [session-loop.ts](../../../src/apps/cli/repl/session-loop.ts), [result-store.ts](../../../src/apps/eval/storage/result-store.ts), [external-prompt-queue.ts](../../../src/apps/cli/repl/external-prompt-queue.ts).

- `Realtime lifecycle` — `L6 C1/H7/H8` — `close()` is still race-fragile and handler throws can still break sibling delivery / close completion. Primary file: [default-adapter.ts](../../../src/realtime/default-adapter.ts).

- `Stream wrapper / OpenAI wire contract` — `L6 C2/H1/H2` — timer cleanup on iterator throw is still incomplete, best-effort callbacks can still abort the stream, and finalize logic still escapes structured OpenAI error mapping. Primary files: [stream-timeout.ts](../../../src/llm/stream-timeout.ts), [openai-responses-wire.ts](../../../src/llm/openai-responses-wire.ts), [openai.ts](../../../src/llm/adapters/openai.ts).

- `ChatGPT-OAuth and provider metadata correctness` — `L6 H3/H4/M1/M3` — model catalog fetches are still not deduped, token refresh validation is still incomplete, router credential metadata for `chatgpt-oauth` is still wrong, and parse failure is still conflated with "no model access". Primary files: [chatgpt-oauth.ts](../../../src/llm/adapters/chatgpt-oauth.ts), [refresh.ts](../../../src/auth/chatgpt-oauth/refresh.ts), [provider-router.ts](../../../src/llm/provider-router.ts).

- `Permission fail-closed core` — `L8 H1/H3/H4/H5/M2/M5/M6` — shell sandbox degrade is still silent, trust-scope deny still depends on order, protected-branch hard reset is still allowed, path-prefix access is still lexical, host mode `custom` still means allow instead of defer, permission persistence failure is still silent, and empty `workspace-write` roots still widen too far. Primary files: [shell.ts](../../../src/runtime/shell.ts), [trust-scope-store.ts](../../../src/permission/trust-scope-store.ts), [branch-only.ts](../../../src/permission/branch-only.ts), [access-check.ts](../../../src/permission/access-check.ts), [per-host-mode.ts](../../../src/permission/per-host-mode.ts), [json-state-file.ts](../../../src/permission/json-state-file.ts), [per-thread-store.ts](../../../src/permission/per-thread-store.ts).

- `Remote runner injection and timeout semantics` — `L9 C1/H11` — Lima still interpolates a shell string and the remote runner `timeoutMs` contract is still not honored end-to-end. Primary files: [lima-adapter.ts](../../../src/remote/runner/lima-adapter.ts), [docker-adapter.ts](../../../src/remote/runner/docker-adapter.ts).

- `OTel exporter hardening` — `L9 H1/H2/M1/M2/M3` — the exporter can still wedge or grow unbounded and, on the same surface, telemetry temporality/zero-first-sample/timer-exit semantics are still wrong enough to fix in the same closeout sweep. Primary files: [otel-exporter.ts](../../../src/observability/otel-exporter.ts), [otel-sink.ts](../../../src/observability/metrics/otel-sink.ts), [health-snapshot-watcher.ts](../../../src/observability/metrics/health-snapshot-watcher.ts).

- `Speech and transcription boundaries` — `L9 H3/H4` — local whisper still leaves stdout undrained and STT HTTP paths still lack timeout/cancel semantics. Primary files: [local-whisper-transcriber.ts](../../../src/voice/transcriber/local-whisper-transcriber.ts), [deepgram-adapter.ts](../../../src/media/stt/deepgram-adapter.ts), [openai-whisper-adapter.ts](../../../src/media/stt/openai-whisper-adapter.ts).

- `Scheduler runtime / engine correctness` — `L9 H5/M7/M8/M9/M10/M11` — errored automations still do not retry correctly, runtime dispatch is still at-least-once without idempotency, same-ms ids can still re-fire work, JSONL/error persistence still fails too quietly, and the ticker still has no in-flight guard. Primary files: [ticker.ts](../../../src/scheduler/automation-engine/ticker.ts), [runtime.ts](../../../src/scheduler/runtime.ts), [sqlite.ts](../../../src/scheduler/automation-engine/sqlite.ts), [store-jsonl.ts](../../../src/scheduler/store-jsonl.ts).

- `Connector / custom-3p registry integrity` — `L9 H7/H8` — connector outage still collapses to an empty catalog and custom 3P persistence is still non-atomic. Primary files: [rest-registry.ts](../../../src/connectors/rest-registry.ts), [jsonl-store.ts](../../../src/connectors/custom-3p/jsonl-store.ts).

- `GitHub integration durability and dedup` — `L9 H6/H9/H10` — PR comment polling still trusts raw path segments, delivery idempotency is still in-memory only, and dedup still does not cover review verbs. Primary files: [trigger-source-pr-comment.ts](../../../src/reactor/trigger-source-pr-comment.ts), [idempotency.ts](../../../src/integrations/github/idempotency.ts), [pr-output-sink.ts](../../../src/integrations/github/pr-output-sink.ts).

- `MCP HTTP-SSE lifecycle` — `L9 H12` — POST/SSE request lifetimes are still untracked and not abortable on close. Primary file: [http-sse.ts](../../../src/mcp/transports/http-sse.ts).

- `Conflict parser single source of truth` — `L9 H13` — the duplicate parsers are still both present and already diverged. Primary files: [conflict-parser.ts](../../../src/git/conflict-parser.ts), [parse.ts](../../../src/tool/git/conflict-parser/parse.ts).

## Tier 2 — Same-Sweep Validated Fixes

- `Plan meta reorder atomicity` — `L1 M4` — `updateMeta` still commits metadata before a potentially failing reorder step. Primary file: [mutator-adapter.ts](../../../src/agent/plan/mutator-adapter.ts).

- `Turn observability closeout` — `L1 M5` — throw/pause paths still skip `turn-diff` closeout, git-directive flush, and work-metrics finalization. Primary file: [loop.ts](../../../src/agent/loop.ts).

- `Memory persistence follow-through` — `L3 C-18/C-20` — corrupt embedding degradation is still silent and later persist/eviction loops still do not honor mid-flight abort cleanly. Primary files: [sqlite.ts](../../../src/memory/adapters/sqlite.ts), [memory.ts](../../../src/agent/memory.ts).

- `LLM replay / recorder / provider hygiene` — `L6 M2/M4/M5/M6/M7/M8/M9/M10/M11` — provider selection trim, response-body diagnostics, continuation-store clearing, recorder close/cap accounting, transport error visibility, replay abort semantics, Foundry abort/error classification, and duplicated truthy-env logic are all still validated issues on active surfaces. Primary files: [factory.ts](../../../src/llm/factory.ts), [responses-stream.ts](../../../src/llm/responses-stream.ts), [jsonl-recorder.ts](../../../src/stream/adapters/jsonl-recorder.ts), [replay-llm.ts](../../../src/llm/replay/replay-llm.ts), [foundry-adapter.ts](../../../src/llm/providers/foundry-adapter.ts), [provider-router.ts](../../../src/llm/provider-router.ts).

- `Secret scan / plugin-isolation follow-through` — `L8 M4/M8` — 64-hex secrets can still evade the entropy scanner and DXT entry resolution still lacks realpath containment. Primary files: [entropy-scanner.ts](../../../src/security/secret-detection/entropy-scanner.ts), [dxt-loader.ts](../../../src/plugin-isolation/dxt-loader.ts).

- `Session export / index integrity` — `L9 M4/M6` — export digests are still key-order dependent and session snapshot writes can still commit ahead of index metadata without compensation. Primary files: [import-export.ts](../../../src/session/import-export.ts), [store.ts](../../../src/session/store.ts).

- `Shadow ODB storage correctness` — `L9 M12/M13` — cross-process `registerHead` is still not serialized and cleanup still under-enforces size caps on error. Primary files: [default.ts](../../../src/storage/shadow-odb/default.ts), [cleanup.ts](../../../src/storage/shadow-odb/cleanup.ts).

- `Migration import-log stale lock recovery` — `L9 M14` — a crashed writer can still leave a permanent busy lock with no stale-lock reclaim path. Primary file: [persistence.ts](../../../src/migration/persistence.ts).

- `Skybridge honesty` — `L9 M17` — Lima skybridge still discards compiled policy while reporting `sandboxApplied: true`. Primary file: [lima-microvm.ts](../../../src/mcp/skybridge/lima-microvm.ts).

- `IPC bridge / transport hygiene` — `L9 M18` — command-state growth, stdio error/end blindness, and missing control-frame version validation are still present. Primary files: [bridge.ts](../../../src/ipc/session/bridge.ts), [stdio.ts](../../../src/ipc/transports/stdio.ts), [codec.ts](../../../src/ipc/session/codec.ts).

## Explicitly Not In The Final Solve Set

- All `03-false-positives.md` items.

- All audit items explicitly marked `적대적-미검증`, verifier-failed, or still relying only on the first finder pass. The biggest excluded pool remains L2 `M1-M21`.

- Latent-only issues that are real but not on a live path today, unless they sit directly on a surface already being repaired. Examples left out on purpose:
  - L1 `H4`, `M6`, `L4-L8`
  - L2 `H9` and most low-only subagent residue
  - L3 `C-15`, `C-16`, `C-19`, `C-21`
  - L6 `H6`, `H9`, `H10`, `M12-M14`
  - L8 `H2`, `L2`
  - L9 `M15`, `M16`, `H14`

- Low-severity observability-only or code-quality-only issues that do not change product semantics, safety, or durability today.

## Practical Order

1. Fix Tier 1 rows touching `loop.ts`, `streaming-dispatch.ts`, `context-binding.ts`, `scheduler/runtime.ts`, and permission/runtime boundaries first. They carry the highest current correctness and security risk.

2. Fix Tier 1 rows touching storage / connectors / MCP / remote runners next. Those are the biggest production-boundary and durability risks.

3. Take Tier 2 opportunistically only when the owning Tier 1 seam is already open. They are real and validated, but they should not block the first closure claim by themselves.
