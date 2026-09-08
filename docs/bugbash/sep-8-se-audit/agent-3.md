# Sep-08 SE audit — agent-3 (Lane H)

> **Fact-check snapshot:** `f5f4875799141068af73e604129c8b9a09f76007`
> **Scope:** `src/media`, `src/voice`, `src/browser`, `src/git`, `src/patch`,
> `src/subagent`, `src/side-agent`
> **Disposition:** unresolved, reachable defects only. Product code is not fixed here.

## Retained findings

| ID | Pri | Owner | Required result |
|---|---:|---|---|
| H-SA-02 | P1 | `src/side-agent/process-registry.ts`, `worker-entry.mjs` | Process backer must honor the daemon port's cadence and lifetime bounds. |
| H-PATCH-01 | P1 | `src/patch/unified-to-v4a.ts` | A git rename must become a move, not an update of the old path. |
| H-SA-01 | P2 | `src/side-agent/worker-entry.mjs` | LLM failure or no-finding must not be emitted as a finding. |
| H-PATCH-02 | P2 | `src/patch/applier.ts` | A failed rollback must be surfaced; callers must not be told the disk was restored. |

### H-SA-02 — process backer violates the persistent-daemon contract (P1)

- **Trigger:** enable `QUANTA_SIDE_AGENT` and `QUANTA_SIDE_AGENT_PROCESS`, then call
  `side_agent_spawn` with an interval/event trigger, `max_wakes`, or `idle_reap_ms`.
- **Reachable wire:** `src/host/runtime/agent-config-assembler.ts:458-488` selects
  `createProcessSideAgentDaemonRegistry`; the tool promises a persistent daemon that
  wakes on an interval/event at `src/tool/side-agent/index.ts:85-95,141-149`.
- **Owner evidence:** `src/side-agent/types.ts:26-35,150-168` defines cadence,
  `maxWakes`, and idle reap as part of the shared port. The in-process owner validates
  and enforces them at `src/side-agent/registry.ts:52-65,195-205,217-261`.
  The process registry's `spawn` path (`src/side-agent/process-registry.ts:227-272`)
  never validates or arms `spec.trigger`, never reads `maxWakes`/`idleReapMs`, and
  `src/side-agent/process.ts:218-221` sends exactly one charter on child readiness.
  `worker-entry.mjs:148-162` has only an IPC listener; it has no wake loop.
- **Additional drift:** `process-registry.ts:123-175` increments `wakesDone` per
  finding rather than per completed pass, so one pass emitting multiple findings can
  consume multiple apparent wakes without enforcing the ceiling.
- **Impact:** the model receives a daemon id and a `running` snapshot, but the daemon
  runs once and remains resident. Requested recurrence, runaway bounds, and idle reap
  do not execute.
- **Smallest correction:** make the process registry own trigger scheduling and
  lifecycle bounds, sending one charter per admitted wake. Share or mirror
  `validateSpec` without weakening the in-process contract.
- **Regression rail:** extend
  `tests/unit/side-agent-process-registry-hellgate.test.ts` with interval re-wake,
  event wake, `maxWakes` auto-stop, `idleReapMs`, one-pass/one-wake accounting, and
  invalid-spec cases. Existing tests only prove spawn, IPC forwarding, status, stop,
  and concurrency cap.

### H-PATCH-01 — unified git rename updates the old path (P1)

- **Trigger:** submit a unified diff containing `rename from old.py`,
  `rename to new.py`, and an edit hunk through `apply_patch`.
- **Owner evidence:** `src/patch/unified-to-v4a.ts:101-118` discards both rename
  headers. For any non-add/delete pair, `emitFileSection` uses `fromPath` and emits
  `Update File` (`:201-226`).
- **Reachable consumer:** `src/tool/apply-patch.ts:406-417` auto-converts unified
  input and passes the resulting operation to the canonical parser/applier.
- **Measured result at the snapshot:** the parsed operation is `update`; applying
  the rename diff leaves only `old.py` with the edited bytes. `new.py` is not created.
  The current test explicitly locks the wrong behavior at
  `tests/unit/patch/unified-to-v4a-scenarios.test.ts:267-286`.
- **Impact:** a successful tool result mutates the wrong path and loses the requested
  rename semantics.
- **Smallest correction:** retain rename metadata while scanning and emit V4A
  `Update File: old.py` plus `Move to: new.py` for rename+edit. Reject inconsistent
  rename metadata instead of degrading to update.
- **Regression rail:** reverse S-OP-5 to require a `move` operation and add an
  apply-level assertion that the old path is absent and the new path contains the
  edited content.

### H-SA-01 — no-finding is converted into a finding (P2)

- **Trigger:** the process child has a viable LLM source, but dynamic import,
  provider assembly, the LLM pass, or an empty final answer returns `null`.
- **Owner evidence:** `src/side-agent/worker-entry.mjs:68-80` collapses import/pass
  failure to `null`; `:133-145` then emits `runCharterPass(...,
  "pass returned no finding")` as `{kind:"finding"}`. The typed contract says a
  `null` pass means nothing to report (`src/side-agent/types.ts:39-45,72-82`). The
  in-process registry only publishes non-null results
  (`src/side-agent/registry.ts:229-247`).
- **Consumer:** `src/side-agent/process.ts:199-215` accepts the IPC frame as a real
  finding, and `process-registry.ts:156-175` records it for `side_agent_findings`.
- **Impact:** an LLM failure or genuine no-finding is presented as a finding and also
  advances process-side wake accounting. This is false-positive output, not a
  degraded health event.
- **Smallest correction:** preserve `null` as no finding. If degradation must be
  visible, add a typed status/error channel rather than reusing `kind:"finding"`.
- **Regression rail:** an OS-child or worker seam with `llmPassViable=true` and a
  null/throwing LLM pass must emit no finding and must expose the failure only through
  the chosen typed status path.

### H-PATCH-02 — rollback failure is hidden behind a success claim (P2)

- **Trigger:** a later filesystem mutation fails after earlier operations landed,
  and at least one inverse journal operation also fails.
- **Owner evidence:** `src/patch/applier.ts:122-128` always throws
  `"was rolled back"` after `rollback`; `rollback` swallows every inverse failure at
  `:226-238`. `src/patch/message-for-model.ts:70-79` strengthens the claim to
  `"the file is unchanged"`.
- **Measured result at the snapshot:** with an injected port whose second update
  mutates then throws and whose subsequent undo writes throw, both files remain
  edited while the exception says `Patch commit failed and was rolled back`.
- **Impact:** callers may continue under a false clean-disk assumption after a
  partial write.
- **Smallest correction:** collect inverse failures and throw a distinct typed
  rollback-incomplete error carrying the original commit error plus failed paths.
- **Regression rail:** inject commit failure followed by undo failure; assert partial
  state is observable in the typed error and neither `was rolled back` nor
  `file is unchanged` is emitted.

## Verification

- `git rev-parse HEAD` → `f5f4875799141068af73e604129c8b9a09f76007`
- `bun test tests/unit/side-agent-process-registry-hellgate.test.ts tests/unit/patch/unified-to-v4a-scenarios.test.ts` → pass
- Direct unified-rename apply probe → `kind:"update"`, only `old.py` remains
- Direct rollback-failure injection → message says rolled back while `A.txt` and
  `B.txt` retain edited bytes
