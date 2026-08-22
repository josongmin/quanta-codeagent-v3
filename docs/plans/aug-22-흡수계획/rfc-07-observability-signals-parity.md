# RFC-07 — Structured Bash/lifecycle observability signals + failure taxonomy (parity)

**Status:** **R6 ARCHITECTURE FROZEN — G1 grammar BUILD-ready; G2–G4 inline facts staged;
report binding and lifecycle work PARKED.** Most substrate is already built. No correctness-bug or
taxonomy-wiring completion claim is made.

**Absorbs:** Claude Code 2.1.238 `BashOutput.gitOperation` / `backgroundEndsWithFinalResponse` /
`REPLOutput.asyncDispatched` + `SendFeedback.failure_mode`/`task_category` enums; plus a LOW Codex-UI parity bundle.
Detail: `.extracted_source/_deep-claude-2.1.238.md` §3–§7, `.extracted_source/_deep-codex-ui-med.md` §4–§8.

---

## Final audit incorporation — current-HEAD authority (R5, normative)

This section supersedes the historical R1→R4 audit and any conflicting FINAL, 1:1 PR-verb,
or taxonomy BUILD claim below.

### Final disposition

| Scope | Disposition | Reason / prerequisite |
|---|---|---|
| Passive VCS core | **ALREADY / DROP** | Producer→sink is wired |
| `commit.branch` | **BUILD** | Literal bracket field with ambiguity omission |
| `pr.action` | **BUILD after exact grammar** | Flags split one verb into distinct actions |
| `branch.ref` | **DROP** | Not authoritative in observed output |
| Existing model-failure taxonomy | **DECIDE/PARK** | Offline report lacks `ObservationBundle` authority |
| Count-based failure labels | **MEASURE/PARK** | Event recording and task-complexity/calibration absent |
| Raw spawn/question counts | **MEASURE candidate** | May ship only if recorded JSONL presence is proven |
| Owner-scoped bg reap/signal | **PARK** | Child session identity/ownership prerequisite |
| LOW UI bundle | **PARK / split ticket** | Different product owner and no observability consumer |

### `pr.action` command grammar

Classification operates on the already-tokenized executable command segment, not regex over
the entire shell string. A PR action is emitted only when either the command contains an
explicit PR number validated by the parser or successful output yields the authoritative PR
identity already used by `VcsPr`.

| Parsed argv | `pr.action` |
|---|---|
| `gh pr create ...` | `created` |
| `gh pr edit ...` | `edited` |
| `gh pr merge ...` without auto flags | `merged` |
| `gh pr comment ...` | `commented` |
| `gh pr close ...` | `closed` |
| `gh pr reopen ...` | `reopened` |
| `gh pr ready ...` without `--undo` | `ready` |
| `gh pr ready --undo ...` | `draft` |
| `gh pr merge --auto ...` | `auto-merge-enabled` |
| `gh pr merge --disable-auto ...` | `auto-merge-disabled` |

Unknown/mutually conflicting flags, nonzero exit, missing PR identity, aliases not parsed by
the grammar, heredoc/string/comment occurrences, and read-only verbs omit `action`. The
closed union and parser table are one owner; no consumer remaps verbs.

### Failure-taxonomy architecture decision

Do not reconstruct bundle-dependent semantics from loose trajectory events. Before 5.2a can
be BUILD, choose and version one of:

1. **Inline facts:** compute a compact `FailureTaxonomyFacts` where `ObservationBundle` and
   `MetricInputs` are live, persist it in the per-attempt result, and let report aggregation
   project labels; or
2. **Versioned sidecar:** persist the full required bundle/facts atomically beside the
   trajectory and require matching run/attempt/schema identity at report time.

Missing or mismatched facts yield `unavailable`, never a partial label set. This decision is
serialized with the current owner of dirty `src/runner/batch/report.ts`; no competing edit is
authorized by this plan.

Count labels require more than event counts: `SUBAGENT_OVERSPAWN` needs an authoritative task
complexity class and calibrated threshold; `EXCESSIVE_QUESTIONS` needs a policy/benchmark
expectation and calibration. Until those exist, expose only raw counts (if the recorder is
proven) and do not call them failures.

## Architecture integration — R6 (normative)

R6 chooses the R5 inline-facts option and separates three concerns: exact passive-VCS parsing,
bundle-live fact extraction, and offline pure classification. It does not attempt to reconstruct an
`ObservationBundle` from loose trajectory events and does not authorize edits to the currently
dirty report owner. Shared topology is in
[`00-architecture-blueprint.md`](./00-architecture-blueprint.md).

### Existing owner map

| Concern | Current owner | R6 decision |
|---|---|---|
| Passive VCS classification | `src/git/passive-classify/**` | Extend exact parser in place; core remains ALREADY |
| Bundle-live metrics | `src/agent/observation/metrics/failure-taxonomy.ts` and observation callback path | Extract compact versioned facts where inputs coexist |
| Bundle producer seam | `src/runner/batch/eval/driver/localize-prep.ts` `onObservationBundle` | Bind fact extractor here/adjacent runner adapter |
| Offline report | `src/runner/batch/report.ts` and current dirty report overlay | Consumer later; serialized with current owner |
| Background shell registry | `src/runtime/bash-bg-registry.ts` | No reap change until child owner identity exists |

### Target write set

```text
src/git/passive-classify/
  pr-action.ts                     # exact token grammar
  classifier.ts                    # consumes grammar, emits existing VCS structure
src/observability/failure-taxonomy/
  types.ts                         # FailureTaxonomyFactsV1 + labels/result
  classify.ts                      # pure facts -> labels/unavailable
  index.ts
src/agent/observation/metrics/
  failure-facts.ts                 # live events + bundle + inputs -> FactsV1
  failure-taxonomy.ts              # deleted after atomic classifier extraction
src/runner/batch/
  failure-facts.ts                 # inline attempt persistence/reader adapter
src/protocol/observability/
  failure-facts.ts                 # strict DTO version decoder when crossing protocol boundary
tests/unit/git/passive-classify-pr-action.test.ts
tests/unit/observability/failure-taxonomy.test.ts
tests/integration/batch-failure-facts-roundtrip.test.ts
```

`src/runner/batch/report.ts`, report envelope files and dashboards are explicitly outside the first
packet while their worktree owner is dirty. No sidecar, offline bundle reconstructor, lifecycle
reaper, UI parity folder or new telemetry bus is added.

### Passive VCS grammar

`pr-action.ts` consumes the already-tokenized executable command segment and returns a closed
action or omission. It does not regex the shell source, output prose, comments, heredocs, aliases or
strings. Flag combinations are parsed before the verb mapping:

- `gh pr ready --undo` -> `draft`;
- `gh pr merge --auto` -> `auto-merge-enabled`;
- `gh pr merge --disable-auto` -> `auto-merge-disabled`;
- plain admitted create/edit/merge/comment/close/reopen/ready map exactly as R5;
- conflicts, read-only verbs, nonzero exits and missing authoritative PR identity omit action.

The action union and grammar table share one owner. Consumers store the value verbatim and never
remap it. `commit.branch` remains literal bracket-derived data with ambiguity omission;
`branch.ref` remains DROP.

### Inline fact contract

```ts
interface FailureTaxonomyFactsV1 {
  schemaVersion: 1
  runId: string
  attemptId: string
  sourceDigest: string
  evidence: FailureEvidenceFacts
  rawCounts: { subagentsSpawned?: number; questionsAsked?: number }
}
```

The exact fact fields are the minimum complete inputs for admitted detectors and are documented per
detector. Facts are derived once where `MetricEvent[]`, `ObservationBundle` and `MetricInputs`
coexist. They contain normalized bounded primitives/closed enums, not the full bundle or free-form
model text. Missing required evidence yields an explicit unavailable reason.

Facts are persisted inline with the canonical per-attempt result under matching
`{runId,attemptId,sourceDigest,schemaVersion}`. Atomic attempt persistence means result and facts
commit together; partial/mismatched facts are rejected. This avoids sidecar join/orphan races and
keeps SavedSession/trajectory stores from becoming a second metrics authority.

`@/observability/failure-taxonomy` is pure and imports only shared values. `@/agent` legally adapts
the observation bundle into facts. Runner persists them and, after the report owner is released,
passes decoded facts to the pure classifier. Protocol decoding is strict: unknown versions become
`unavailable`, never best-effort partial labels.

### Labels, counts and ownership scope

Only detectors whose full authoritative facts exist may emit labels. Raw spawn/question counts may
be stored as facts, but `SUBAGENT_OVERSPAWN` and `EXCESSIVE_QUESTIONS` remain disabled until task
complexity/policy expectations and calibrated thresholds exist. A count is not a failure label.

Background reap remains PARKED. The prerequisite is an explicit child session/owner id threaded
through child config and every background-shell adoption path. PID, TTL, parent process, task name
or timing cannot infer ownership. When admitted later it extends the existing registry with narrow
`listOwned/killOwned`; it never creates another process registry.

### Atomic landing plan

1. **G1 — VCS grammar:** pure table parser and existing sink/front-door receipt. Independent of
   taxonomy work.
2. **G2 — facts schema/classifier:** atomically extract pure classification from the old agent file,
   delete the duplicate classifier, add versioned contracts, detector completeness table and
   unavailable semantics.
3. **G3 — live extractor:** compute FactsV1 at the existing bundle-live seam; no report edit.
4. **G4 — inline persistence:** extend canonical attempt result atomically and roundtrip.
5. **G5 — report integration later:** only after dirty report ownership is released; consume facts
   without reconstruction or heuristic fallback.
6. **G6 — calibration/ownership later:** label thresholds and owner-scoped reap remain separate
   measured/prerequisite tickets.

### Executable work packets

Use [`01-execution-board.md`](./01-execution-board.md). G1 is independent. G2–G4 may proceed without
touching report files. G5 has no authorized branch until the current dirty report owner releases a
clean SHA and explicit write-set.

#### G1 — exact passive-VCS fields (`codex/aug22-g1-vcs-grammar`)

- **Prerequisite/owner:** none; owns `git/passive-classify/pr-action.ts`, the narrow classifier
  integration and `tests/unit/git/passive-classify-pr-action.test.ts`.
- **RED first:** argv table for every admitted action plus conflicting flags, aliases, heredoc/string
  occurrences, read-only verbs, failure exit and missing PR identity. Pin current core output first.
- **Implement:** exact token grammar, closed action union, literal commit branch extension with
  ambiguity omission and one exhaustive classifier mapping.
- **Verify:** new table test, existing passive-classify/sink tests, git boundary and typecheck.
- **Receipt:** positive commands reach the existing sink; all adversarial inputs omit action; gate
  OFF/core fields are byte-identical. **Stop** if classification needs full-command regex or prose.

#### G2 — versioned facts and pure classifier (`codex/aug22-g2-failure-facts-domain`)

- **Prerequisite/owner:** none after rebase; owns `observability/failure-taxonomy/**`, atomic removal
  of classification from `agent/observation/metrics/failure-taxonomy.ts`, and unit tests.
- **RED first:** detector-completeness table shows which current labels require bundle/input fields;
  missing one currently cannot produce explicit unavailable. Add unknown-version and partial-facts
  cases.
- **Implement:** minimal `FailureTaxonomyFactsV1`, strict decoder, per-detector required-field map,
  pure facts->labels/unavailable classifier; delete duplicate agent classifier.
- **Verify:** classifier/decoder/exhaustiveness tests, observability/agent boundaries, typecheck and
  old-symbol/import-zero scan.
- **Receipt:** complete fixture labels deterministically; each removed required field disables only
  its detector with a stable unavailable reason. **Stop** if facts require free-form bundle replay.

#### G3 — bundle-live fact extraction (`codex/aug22-g3-failure-facts-extractor`)

- **Prerequisite/owner:** G2; owns `agent/observation/metrics/failure-facts.ts`, the existing
  bundle-live callback adapter near `runner/batch/eval/driver/localize-prep.ts`, and extractor tests.
- **RED first:** a real observation callback has events/bundle/inputs but emits no versioned facts;
  source/run/attempt mismatch cannot be represented.
- **Implement:** derive bounded normalized primitives at the live seam, bind exact identities/source
  digest and return explicit unavailable when an admitted fact is absent. Do not persist yet.
- **Verify:** live callback integration with one complete and one unavailable observation, agent/
  observability/runner boundaries and typecheck.
- **Receipt:** deleting the real extractor call makes the integration test RED; bare import is
  insufficient. **Stop** if extraction must read offline trajectory or reconstruct bundle fields.

#### G4 — atomic inline attempt persistence (`codex/aug22-g4-failure-facts-persist`)

- **Prerequisite/owner:** G3; owns `runner/batch/failure-facts.ts`, canonical per-attempt result DTO/
  writer, optional `protocol/observability/failure-facts.ts`, and roundtrip tests. It explicitly
  excludes `runner/batch/report*`.
- **RED first:** result persists while facts fail/mismatch, creating partial evidence; unknown schema
  can be consumed best-effort. Inject writer failure and identity mismatch.
- **Implement:** inline optional versioned field committed with attempt result, strict matching on
  run/attempt/source/schema and legacy absence -> unavailable. No sidecar.
- **Verify:** atomic failure, close/reopen roundtrip, corrupt/mismatch/legacy decoder tests,
  runner/protocol/observability boundaries and typecheck.
- **Receipt:** injected failure publishes neither result nor facts; matching complete record survives
  restart. **Stop** if canonical envelope ownership is dirty/contested—rebase or defer instead.

#### G5 — report consumption (BLOCKED, no branch)

- **Prerequisite:** current owners of `src/runner/batch/report.ts`, `report-envelope.ts`, related
  dashboard/projectors publish a clean result SHA and assign an exact non-overlapping write-set.
- **First RED when admitted:** report built from persisted FactsV1 lacks expected label/unavailable;
  deleting classifier call must flip it RED while a bare import remains insufficient.
- **Allowed implementation:** strict decode -> pure classifier -> existing report field. No bundle
  reconstruction, trajectory heuristic, sidecar join or duplicate label mapping.
- **Required receipt:** real attempt persistence close/reopen -> report label/unavailable at same
  identities, plus gate-OFF/legacy report compatibility.

#### G6 — semantic counts and owner reap (PARKED, no branch)

Store raw spawn/question counts only when G3/G4 already has an authoritative producer. Do not label
them until calibrated task complexity/policy exists. Reap work requires explicit child session id
on config and every background adoption; then and only then extend the existing BashBgRegistry with
`listOwned/killOwned`. PID/TTL/cwd/task-name inference or a second process registry invalidates it.

### Architectural completion gates

- PR grammar table has positive and adversarial argv fixtures for every action, conflicting flags,
  aliases, heredoc/string appearances, read-only verbs, failure exit and absent identity.
- Fact extractor completeness test enumerates every detector-required field; deleting one live
  extraction call makes its detector unavailable and the test RED.
- Anti-vacuum integration asserts at least one complete labeled attempt, one explicitly unavailable
  attempt and one mismatched-version rejection through real attempt persistence.
- Inline atomicity test injects a persistence failure and proves neither result nor facts publish.
- Report integration must use the decoded inline field; a no-reconstruction scanner requires the
  live classifier call and rejects bare-symbol/import-only matches.
- Passive VCS gate-OFF output is byte-identical, and G1 has an actual sink/front-door receipt.

**R6 status:** G1 is BUILD-ready. G2–G4 have a frozen architecture but remain separate work;
G5 waits on the dirty report owner. Count labels and owner-scoped reap remain PARKED.

---

## Historical review incorporation (R4, superseded by R5)

`_review-07.md` (READ-ONLY grounding review, snapshot HEAD `9d5369d31`) verdict = **REVISE**. What the review CONFIRMED
and what it FALSIFIED, folded into this final version:

**CONFIRMED (unchanged):**
- gitOperation CORE = ALREADY-BUILT, correctly DROPPED (classifier.ts:253 pure; sink.ts:28 noop sentinel;
  bash-hook.ts:42 knob+sink gate; wired bash/index.ts:822 → host `createPassiveVcsStreamSink`
  agent-config-assembler.ts:696 / maybeWireVcsEventSink:722).
- The residual gitOperation fields (`commit.branch` + `pr.action`) are **real and authoritative**; `branch.ref` correctly
  DROPPED (MERGE_LINE classifier.ts:90 captures no target ref → deriving it = heuristic).
- The failure taxonomy is a **genuine dead seam** — `classifyFailure`/`FailureLabel` (failure-taxonomy.ts:148 /
  metrics/index.ts:20) has NO `src/` production importer (tests-only). Wiring it into the report is the right lever.

**FALSIFIED → this RFC's §5.3 "P0 correctness bug" claim is WITHDRAWN (PARK):**
- The child `AgentConfig` from `buildChildConfig` (`src/agent/subagent-runner-child-config.ts:261`, via `buildChildBase`
  :134 + `buildChildInheritedConfig` :206) carries **NEITHER `bgShellRegistry` NOR `sessionId`** (grep-confirmed: both
  tokens are absent from the entire file).
  - ⇒ (a) Subagent teardown `session-lifecycle.ts:145 await args.cfg.bgShellRegistry?.killAll()` **short-circuits on
    undefined** — the parent-shell over-reap **does NOT reproduce**. **Open-Q 11.1 resolves NO.** The RFC's proposed
    red-on-injection rail ("spawn sync subagent, end it, assert parent shell survives") would pass **trivially / vacuously
    green** and prove nothing.
  - ⇒ (b) Subagent bg shells adopt into the singleton with `ownerId` **OMITTED** (no child `sessionId` → `ctx.ownerId`
    guard drops it), so the proposed `killOwned(subagentOwnerId)` fix has **no ownership to scope to**.
- The **REAL defect is the inverse**: a mild **UNDER-reap leak** — a subagent's own bg shells are never reaped at subagent
  teardown and linger unowned in the singleton until ROOT teardown `killAll()` sweeps everything. A correct fix requires
  **threading child-session identity into the child config FIRST** (an unnamed prerequisite the RFC skipped), then a
  widened reap port (`{listOwned,killOwned}`, not just `{killAll}`). This is larger than a "swap killAll for killOwned".
- **Action:** §5.3 is re-scoped to **PARK** pending child-session identity. It is **NOT** a P0 correctness bug and must
  not be presented as one. (The top-level README's "🔴 실 correctness 버그 발견" claim for RFC-07 is therefore WRONG and
  needs correcting — RFC-07 found a *mischaracterized under-reap leak that is PARKED*, not a real over-reap bug.)

**COST/GATING CORRECTION — §5.2 wiring understated:**
- `classifyFailure` signature (failure-taxonomy.ts:148) is `(events: MetricEvent[], bundle: ObservationBundle,
  inputs: MetricInputs, options)`. The **offline report producer has none of these** — `failure-classifier.ts`
  (readTrajectory:73, `TrajectoryEvent`:57) reads a different, looser shape and has **no `ObservationBundle`**. Several
  detectors (`detectWrongOwner`, `detectHintOvertrust`) DEPEND on the bundle (the S1–S3 observation-kernel output), which
  is **not currently persisted offline** at report time. So wiring is real **M-to-L glue** (reconstruct offline vs compute
  inline where the bundle is live), not the RFC's "M-lite / the report wiring is the bulk".
- Only the **two count-labels** (`SUBAGENT_OVERSPAWN` / `EXCESSIVE_QUESTIONS`) are the cheap honest part (pure trajectory
  COUNTS, no bundle). They are **GATED on confirming `subagent_spawn` actually lands in the recorded per-attempt JSONL**
  (`failure-classifier.ts:11 <patch>.jsonl`) — it is emitted on the AgentEvent STREAM (stdout adapter); its presence in the
  recorded JSONL is UNCONFIRMED (Open-Q 11.2). Degrade-to-unavailable, never invent.

**Revised landing order (supersedes §10):** 5.1 (gitOperation fields — pure/leaf/conflict-free) FIRST → **5.2a** (wire
`classifyFailure`→report, once the bundle-availability decision is made; **NOTE: `report.ts` is DIRTY in a concurrent
session — merge, do not race**) → **5.2b** (count-labels, gated on JSONL event presence) → **§5.3 PARK** (child-session
identity prerequisite) → **5.4 separate UX ticket**.

---

## 1. Motivation

Claude 2.1.238 hardens *agent-state observability* (the USER north star): git activity rendered from a struct
(no stdout scraping), a lifecycle-ownership flag so a backgrounded child dies with its synchronous-subagent
owner, an async-dispatch receipt so resume never double-fires, and a curated **model-behavior failure vocabulary**
(16 failure modes × 8 task categories) that turns free-text bug reports into gradeable telemetry.

quanta already owns most of the *substrate* here. The honest job of this RFC is to (a) confirm what exists,
(b) extend the gitOperation classifier's two missing fields (`commit.branch` + `pr.action`), and
(c) **wire an already-built-but-dead** model-behavior taxonomy into the bench report — where the real leverage is.
(The subagent-scoped reap that an earlier draft listed here is **PARKED** — the review falsified its premise; see
"리뷰 반영" and §5.3.)

## 2. Non-goals

- Not reimplementing `SendFeedback` (a model→Anthropic telemetry faucet). We steal only the **enum vocabulary**
  as an *eval-grading* rail, per the mandate.
- Not building an on-disk event-log resume engine (jul-16: quanta resume is InMemory-only). The `asyncDispatched`
  replay-skip signal presupposes such an engine — see §4 item 4 for the DROP.
- Not duplicating RFC-05's `requestUserInput` posture surface (the tool already exists; cross-ref, don't rebuild).
- No heuristics / magic thresholds beyond those the existing classifiers already justify (measure-first).

---

## 3. Current state (file:line, per-item verdict)

### Item 1 — `gitOperation` structured git/gh classification — **ALREADY-BUILT (core); PARTIAL (fields)**
- `src/git/passive-classify/classifier.ts:253` `classifyPassiveVcs()` — PURE `{command,stdout,exitCode} → VcsEvent|null`.
- `src/git/passive-classify/types.ts:71` `VcsEvent = { commit?{kind,sha}, push?{localRef,remoteRef}, branch?{action}, pr?{number,url} }`.
- `src/git/passive-classify/sink.ts:28` `noopVcsEventSink` (default-OFF sentinel) + `src/git/passive-classify/bash-hook.ts:42` `maybeEmitPassiveVcs()` (knob + sink boundary).
- Knob `QUANTA_PASSIVE_VCS`: `src/shared/runtime-config.ts:201`, `src/shared/runtime-config-knobs/knobs-b.ts:83`, `src/shared/runtime-config/types.ts:134`.
- WIRED end-to-end: bash tool call site `src/tool/bash/index.ts:822`; host observer-sink `src/host/runtime/agent-config-assembler.ts:696` `createPassiveVcsStreamSink` → `AgentEvent` stream (no second bus), gated by `maybeWireVcsEventSink` (`:722`).
- **Delta vs 2.1.238** = three OPTIONAL field additions Claude shipped that quanta lacks:
  - `commit.branch` (which branch the commit landed on) — **trivially present** in the already-matched `[<branch> <sha>]` bracket (`COMMIT_BRACKET`, `classifier.ts:114`, captures only the sha today).
  - `pr.action` union (`created|edited|merged|commented|closed|reopened|ready|draft|auto-merge-*`) — quanta's `VcsPr` has NO action, so `gh pr create` and `gh pr reopen` are indistinguishable.
  - `branch.ref` (Claude `{ref,action}`; quanta `{action}` only).
  - (Note: quanta's `push{localRef,remoteRef}` is RICHER than Claude's `push{branch}` — no gap there.)
- **Verdict:** core DROP (already shipped, wired, gated). Keep only a small field-extension (see §5.1).

### Item 2 — `failure_mode` (16) + `task_category` (8) as a grading taxonomy — **PARTIAL (vocab exists, model-behavior classifier is a DEAD SEAM)**
quanta has **three** classification axes today:
- **Infra/termination** — `src/runner/batch/corpus/failure-classifier.ts:26` `TerminationType` (12-value covering partition: `passed|admission_blocked|budget_exhausted|generation_error|throttled|grader_invalid|harness_error|hung_stream|max_turns_exhausted|completed_unresolved|timeout|unknown`) + `FailureSignal` (5-value: `empty_patch|dirty_cache_leak|verify_loop_stuck|search_thrashing|multi_file_drift`). **Wired** into `bench-report.json` (`src/runner/batch/report.ts:364,499`) and analysis (`src/apps/bench/analyze/verdicts.ts`).
- **Model-behavior** — `src/agent/observation/metrics/failure-taxonomy.ts:16` `FailureLabel` (7-value: `LOCALIZATION_WRONG_OWNER|HINT_OVERTRUST|PATCH_TOO_NARROW|PATCH_TOO_WIDE|UNRELATED_DIFF|STOP_TOO_EARLY|STOP_TOO_LATE`), `classifyFailure()` at `:148`.
- **Verdict buckets** — `verdicts.ts:24` `RunVerdicts` (resolved/unresolved/errored/emptyPatch/reRunnable/…).
- 🔴 **Grounding kill:** `classifyFailure`/`FailureLabel` has **NO non-test consumer** — exported from `src/agent/observation/metrics/index.ts:20` but the whole S4 metrics barrel (`stratumTag`, `criticSavedEditRate`, `classifyFailure`) is imported nowhere in `src/` production. It was built jul-6 (Stream S4) and never wired into the report. So the model-behavior taxonomy is a **dead analysis primitive**.
- **Verdict:** the real gap is NOT vocabulary size (7 vs 16) — it is **wiring** `classifyFailure → report`. `task_category` (8) has no quanta equivalent but is **churn** for a single-category (SWE code-edit) corpus (see R1/R2 audit).

### Item 3 — `backgroundEndsWithFinalResponse` (subagent-owned reap) — **PARTIAL (reap exists, is GLOBAL not owner-scoped; no signal flag)**
- `src/runtime/bash-bg-registry.ts` — ADR-0296 background-shell registry. `register`/`adopt` stamp an `ownerId` (`:82`, RFC02-0 stable session identity), `killOwned(id, ownerId)` (`:636`, owner-scoped, typed refusal union), `killAll()` (`:665`, clears ALL entries **regardless of owner**).
- Reap wiring: `src/agent/loop/session-lifecycle.ts:145` `await args.cfg.bgShellRegistry?.killAll()` on session teardown ("M1 leak fix jun-7"). The loop consumes only a narrow `{ killAll() }` port (`src/agent/types/wire-slots-core.ts:440`).
- Registry is a **module singleton** (`getBashBgRegistry`, `bash-bg-registry.ts:710`); `agent-config-assembler.ts:913` binds the same singleton to every session's `cfg.bgShellRegistry`.
- **Delta (as originally framed):** (a) there is NO per-tool-output `backgroundEndsWithFinalResponse` flag telling the model "this dies when you answer"; (b) reap was claimed to be a **session-end-GLOBAL over-reap** — a synchronous subagent whose teardown fires `killAll()` on the shared singleton reaping the **parent's** shells.
- 🔴 **Review FALSIFICATION (`_review-07.md` §E):** the over-reap does **NOT reproduce**. The child `AgentConfig`
  (`buildChildConfig`, `subagent-runner-child-config.ts:261`) sets **neither `bgShellRegistry` nor `sessionId`**
  (grep-confirmed). So (a) subagent teardown `session-lifecycle.ts:145 args.cfg.bgShellRegistry?.killAll()`
  short-circuits on `undefined` (no reap at all at subagent end), and (b) subagent bg shells adopt **unowned** (no child
  `sessionId` ⇒ `ctx.ownerId` omitted), leaving `killOwned` nothing to target. The real defect is the **inverse**: an
  under-reap leak (subagent shells linger unowned until ROOT `killAll()`).
- **Verdict:** **PARK.** The signal flag inherits the same missing subagent-session signal. Any reap fix requires
  child-session-identity threading FIRST (prerequisite, not in scope here). See re-scoped §5.3.

### Item 4 — `REPLOutput.asyncDispatched` (resume-replay skip) — **GAP but NO CONSUMER → DROP**
- `src/tool/async-helper.ts` — ADR-0287 `defineToolAsync`: an async tool registers with a `DeferredResultRegistry` (ADR-0286), yields a terminal `result` carrying a `deferred{id,hint}` handle, and the LLM calls `poll_deferred`. **Pull-based, not replay-based.**
- `src/agent/subagent-resume/replay.ts:153` `skipReplayPolicy` exists but it is **conversation-seed** replay (re-fork a resumed child with `initialMessages`), NOT tool-block re-execution.
- There is **no on-disk event-log resume that re-runs tool blocks** (jul-16: InMemory only). So "resume replay must skip an async-dispatched block" has nothing to skip — the deferred-handle-then-poll design already makes double-execution structurally impossible (the tool returns immediately; the result arrives via `poll_deferred`, never via re-run).
- **Verdict:** DROP. Note as a forward-seam IF an on-disk replay engine ever lands.

### LOW parity bundle — current state
- `/archive` · `/rename` · `/star`: quanta slash registry (`src/apps/cli/slash/registry-surface.ts`) has `/resume`, `/branches`, `/state`, `/agents`, … but **no** archive/rename/star on saved conversations → **GAP** (small).
- `requestUserInput`: **ALREADY-BUILT** — `src/tool/request-user-input.ts` (`request_user_input`, ADR-0097, closed 2-arm `UserInputOutcome`). Its posture/toggle surface is RFC-05's job (`rfc-05-permission-posture-surface.md` §"mid-task-question knob"). **DROP** here; cross-ref only.
- MCP capability quick-links ("Open in MCP Settings"/"Open in Plugins" + auth "Starting…"): `src/host/mcp-composition.ts` composes MCP but there is no UI quick-link/auth-state affordance → **GAP** (small UI).
- plain-text composer toggle: no composer-format toggle surface → **GAP** (trivial UI).
- trace keep-local: quanta traces are already local (cassettes/trajectories on-disk) → **ALREADY; DROP**.

---

## 4. Post-grounding scope (what survives)

| Item | Verdict | Action |
|---|---|---|
| gitOperation core | ALREADY-BUILT | DROP |
| gitOperation fields (`commit.branch`, `pr.action`) | PARTIAL | Extend with R5 exact argv grammar (§5.1) |
| gitOperation `branch.ref` | PARTIAL | DROP — not reliably parseable from stdout (R2) |
| failure_mode vocabulary | PARTIAL (dead seam) | **DECIDE/PARK** bundle/facts persistence; raw counts only after recorder proof |
| task_category (8) | GAP | DEFER — churn on single-category corpus (R1) |
| backgroundEndsWithFinalResponse / owner-scoped reap | **PARK** (premise FALSIFIED) | **NOT a P0 bug** — over-reap does not reproduce (child cfg carries no `bgShellRegistry`/`sessionId`); real defect is an under-reap leak; needs child-session identity FIRST (§5.3) |
| asyncDispatched replay-skip | GAP, no consumer | DROP |
| /archive /rename /star | GAP | **PARK** — separate UX ticket (§5.4) |
| requestUserInput | ALREADY-BUILT | DROP — cross-ref RFC-05 |
| MCP quick-links | GAP | **PARK** — separate UX ticket (§5.4) |
| plain-text composer | GAP | **PARK** — separate UX ticket (§5.4) |
| trace keep-local | ALREADY | DROP |

---

## 5. Design (gaps only)

### 5.1 gitOperation field-extension (`commit.branch` + exact `pr.action` grammar)
Extend the EXISTING pure classifier; no new module, no new bus, no new knob (rides `QUANTA_PASSIVE_VCS` + the wired stream sink).

- **`commit.branch?: string`** on `VcsCommit`. The `[<branch> <sha>] subject` bracket already carries the branch name.
  Change `COMMIT_BRACKET` to also capture the leading branch token. **Guards** (no heuristic): the bracket may read
  `[detached HEAD abc1234]` or `[main (root-commit) abc1234]` — treat `detached HEAD` as *no branch* (omit the field), and
  strip a `(root-commit)` / `(<n> commits)` parenthetical so only the ref name survives. Absent/ambiguous ⇒ omit (optional field, never a guess).
- **`pr.action?: VcsPrAction`** uses the closed R5 union and argv table. The verb alone
  is insufficient: `ready --undo`, `merge --auto`, and `merge --disable-auto` are distinct
  actions. Parse the executable command segment into argv, reject conflicting/unknown flag
  combinations, require exit 0 plus authoritative PR identity, and omit on ambiguity.
- **`branch.ref` — DROPPED** (R2): a `Fast-forward`/`Merge made by` stdout does not reliably print the target branch ref; inferring it would be a heuristic. Out of scope.
- Consumers: the host stream-sink (`createPassiveVcsStreamSink`) already forwards the whole `VcsEvent`; new optional fields flow through with zero call-site change. Client render ("Committed <sha> on <branch>", "PR #N reopened") is a UI concern, not required for this RFC's substrate.

### 5.2 Failure taxonomy — **DECIDE/PARK before wiring**

The vocabulary exists but `classifyFailure` is dead. It must not be wired to a report with
synthetic or partial inputs. Select the R5 inline-facts or versioned-sidecar authority first,
then freeze a schema and a report-time `unavailable` contract.

> ⚠️ **Wiring cost (review §D):** `classifyFailure` (failure-taxonomy.ts:148) signature is
> `(events: MetricEvent[], bundle: ObservationBundle, inputs: MetricInputs, options)`. The offline report producer
> (`failure-classifier.ts` readTrajectory:73, `TrajectoryEvent`:57) reads a **different loose shape and has no
> `ObservationBundle`** — and detectors `detectWrongOwner`/`detectHintOvertrust` DEPEND on that S1–S3 bundle, which is
> **not persisted offline** at report time. So 5.2a is **M-to-L glue** (reconstruct `MetricEvent[]+ObservationBundle+
> MetricInputs` offline vs compute inline where the bundle is live — Open-Q 11.3), NOT a one-liner. **Resolve the
> bundle-availability decision BEFORE coding.**

**5.2a (PARK until the authority decision is accepted):**
1. **Wire** `classifyFailure()` output into the per-instance report as `failure.modes: readonly FailureLabel[]`
   alongside the existing `failure.{termination,signals}` (`report.ts:159–160,364`). This makes the jul-6 S4 classifier
   observable for the first time — and every test on it non-vacuous (it asserts a real report field).
   **NOTE: `report.ts` is DIRTY in a concurrent session — re-read + merge before editing; do not race it.**
2. **Map** Claude's 16 `failure_mode` values onto quanta's axes (documented table, so future readers don't re-litigate):

   | Claude failure_mode | quanta home |
   |---|---|
   | `stopping_short` | `STOP_TOO_EARLY` (FailureLabel) |
   | `overeager` / `over_correction` | `STOP_TOO_LATE` / `PATCH_TOO_WIDE` |
   | `unwanted_scope` | `UNRELATED_DIFF` / `PATCH_TOO_WIDE` |
   | `instruction_following` | `HINT_OVERTRUST` (partial) |
   | `repetition_and_looping` | `FailureSignal.verify_loop_stuck` / `search_thrashing` |
   | `destructive_actions` | `FailureSignal.dirty_cache_leak` (partial) |
   | `context_and_memory` / `overconfidence_and_hallucination` / `code_quality` / `model_regression` / `tone_or_preachiness` / `dispute_or_decline` | **no measurable trajectory signal** — NOT stolen (would be an LLM-judge call, out of scope; see R3) |
   | `subagent_overspawn` | **NEW, measurable** — spawn count from trajectory `subagent_spawn` events |
   | `excessive_questions` | **NEW, measurable** — `request_user_input` call count from trajectory |
   | `other` | n/a (catch-all, no classifier value) |

**5.2b (MEASURE/PARK; raw counts first):**

3. First prove `subagent_spawn` and `request_user_input` are durably recorded for every
   attempt and expose versioned raw counts. Do not emit `SUBAGENT_OVERSPAWN` until task
   complexity and a calibrated threshold exist. Do not emit `EXCESSIVE_QUESTIONS` until a
   benchmark/policy expectation and calibrated threshold exist. Counts alone are not
   failure semantics.
4. **`task_category` — DEFER.** For the current SWE-bench corpus every instance is `code_edit`; a per-run constant tag is vocabulary churn (R1). Revisit only when a multi-category corpus exists (then it becomes a run-level tag, not a per-instance classifier).

### 5.3 Subagent-owned background reap + signal flag — **PARK (premise FALSIFIED)**

🔴 **This slice is PARKED. The "P0 over-reap correctness bug" it was built on is FALSIFIED (`_review-07.md` §E).** Do NOT
implement owner-scoped reap as written; do NOT ship the red-on-injection rail (it is a vacuous green today).

**Why the over-reap does not reproduce (grep-confirmed):**
- The child `AgentConfig` from `buildChildConfig` (`subagent-runner-child-config.ts:261` → `buildChildBase` :134 +
  `buildChildInheritedConfig` :206) sets **neither `bgShellRegistry` nor `sessionId`** — both tokens are absent from the
  whole file. `bgShellRegistry` is bound to the singleton only on the HOST/ROOT path
  (`agent-config-assembler.ts:913`, `context-binding/base.ts:55` wireRuntimePorts), which subagents do NOT traverse
  (they fork `runAgent` directly with the raw child config).
- ⇒ For a subagent, `cfg.bgShellRegistry === undefined`, so teardown `session-lifecycle.ts:145
  await args.cfg.bgShellRegistry?.killAll()` **short-circuits** — no reap, hence no over-reap. **Open-Q 11.1 = NO.**
- ⇒ Subagent bg shells adopt into the singleton (`bash/index.ts:494 getBashBgRegistry().adopt`) with `ownerId` **OMITTED**
  (no child `sessionId` ⇒ `ctx.ownerId` guard drops it). So `killOwned(subagentOwnerId)`/`listOwned(subagentOwnerId)`
  would match **nothing** — there is no ownership to scope to.
- The **red-on-injection rail as written** ("spawn sync subagent while parent holds a bg shell; end subagent; assert
  parent shell survives") passes **trivially/vacuously** today (the subagent never calls `killAll`) — it is NOT a
  regression catch. Ship it and it is a false green.

**What the real defect is (inverted direction — an UNDER-reap leak):** a subagent's own bg shells are never reaped at
subagent teardown (registry undefined) and linger **unowned** in the singleton until ROOT teardown `killAll()` sweeps
everything. Because they are unowned they cannot even be individually enumerated.

**Prerequisite before any fix (the RFC previously skipped this):** thread **child-session identity** into the child
config so child shells register **owned**, THEN widen the reap port to `{listOwned,killOwned}` (not just `{killAll}`) and
reap owner-scoped at child teardown. This is materially larger than "swap `killAll` for `killOwned`".

**Signal flag** (`backgroundEndsWithFinalResponse?: true` on `buildBackgroundPlaceholderResult`,
`src/tool/bash/index.ts:414`): its trigger condition ("owning session is a *synchronous* subagent") **inherits the same
identity gap** — the child config exposes no subagent-session signal — so it cannot proceed independently until that
signal exists either. PARKED with the reap fix.

**Action:** open a separate ticket "child-session identity threading for subagent bg-shell ownership" as the real
prerequisite. Only once that lands does the owner-scoped reap (and this signal flag) become a coherent, testable slice.

### 5.4 LOW parity bundle — **PARK as a separate UX ticket**
These are LOW UI slices with no substrate risk and no measurement consumer. They do **not** belong in an
observability-correctness RFC and must not pad this RFC's scope — split into their own UX ticket (`_review-07.md` §H).
Slice list retained for that ticket:
- **`/archive` · `/rename` · `/star`** — conversation-management verbs on the saved-conversation store, siblings of the
  existing `/resume` and `/branches` (`registry-surface.ts`). Each mutates a thread-metadata field (archived flag / display
  name / starred flag) and is a leaf slash-command handler + a store field. Small.
- **`requestUserInput`** — **DROP.** Tool built (`src/tool/request-user-input.ts`, ADR-0097); its posture/toggle surface is
  RFC-05 (`rfc-05-permission-posture-surface.md`). Cross-ref, do not duplicate.
- **MCP capability quick-links** — "Open in MCP Settings" / "Open in Plugins" deep-links + an auth "Starting…" transient
  state next to `src/host/mcp-composition.ts` server rows. Small UI affordance; no protocol change.
- **plain-text composer toggle** — a per-thread composer-format flag; trivial UI + a persisted preference.
- **trace keep-local** — DROP (already local).

---

## 6. Default-OFF / byte-identical gate

- **5.1** rides the existing `QUANTA_PASSIVE_VCS` knob + `noopVcsEventSink` sentinel. New fields are OPTIONAL on `VcsEvent`; when the knob is OFF or no sink is wired, `maybeEmitPassiveVcs` returns before classification (`bash-hook.ts:49`) — byte-identical.
- **5.2** is EVAL-ONLY (report-side, offline). New `failure.modes` field is additive on the report JSON; a run that does not compute it omits the field. No runtime/prompt path touches it (same fence as `closure-diagnostics.ts`).
- **5.3 — PARKED.** No default-OFF receipt is possible today: owner-isolation cannot be received (there is no owned subagent shell to isolate — §5.3 falsification), and the reap fix has **no validated red to gate behind** (the rail is vacuous). Blocked on child-session-identity; not landing in this RFC.
- **5.4 — PARKED (separate ticket).** Each surface is a new command/affordance behind its own registration; unregistered ⇒ byte-identical.

## 7. TDD + hellgate

- **5.1:** exercise every R5 argv-table row plus paired negatives: `ready --undo`,
  `merge --auto`, `merge --disable-auto`, conflicting flags, nonzero exit, missing PR
  identity, quoted/heredoc/comment text, and read-only verbs. A capturing sink proves the
  fields reach the stream. Deleting one flag branch must make its exact row RED.
- **5.2a (future):** the first rail persists inline facts/sidecar, destroys runtime state,
  reconstructs the report, and proves matching identity/version. Missing, stale, or
  mismatched facts must produce `unavailable`, not fewer labels.
- **5.2b (measure):** recorder integration proves raw spawn/question counts from real
  per-attempt JSONL. No failure-label test is admitted before calibration authority exists.
- **5.3 — PARKED.** ⚠️ The originally-proposed "red-on-injection" rail (spawn sync subagent, end it, assert parent shell survives) is a **VACUOUS GREEN today** — the subagent never calls `killAll` (`cfg.bgShellRegistry` undefined), so it passes trivially and proves nothing. Do NOT ship it. The *honest* failing rail (subagent registers a bg shell, ends → assert the subagent's own shell is reaped) fails today and needs child-session-identity + a widened `{listOwned,killOwned}` port + a defined child `ownerId` to green — out of scope until the prerequisite ticket lands.
- **5.4 — PARKED (separate ticket).** leaf handler units for each slash command (store field flips + readback); MCP quick-link render test.
- Hellgate: default-OFF byte-identical assertions on every new field/flag; observer-sink discipline (no second bus).

## 8. Effort

- 5.1 gitOperation fields: **S** (extend one pure classifier + matrix rows). Pure, leaf, conflict-free — land first.
- 5.2a taxonomy authority: **unestimated / PARKED** until inline-facts versus sidecar is
  decided and the dirty `report.ts` owner is clear.
- 5.2b raw-count measurement: **S after recorder proof**; semantic labels remain PARKED.
- 5.3 owner-scoped reap + flag: **PARKED** — premise falsified; real prerequisite = child-session-identity threading
  (a larger, separate ticket), not the "swap killAll for killOwned" this RFC estimated.
- 5.4 LOW bundle: **PARKED** — separate UX ticket, **S** each (mostly UI/handler slices).
- Total landable-now: **5.1 (S)**. Raw-count measurement is conditional; all semantic
  taxonomy and lifecycle/UI work is deferred.

## 9. Risks + traps

- 🔴 **Over-reap (5.3) — FALSIFIED / PARKED.** The claimed shared-singleton `killAll()` parent-shell kill does **NOT reproduce**: the child config carries no `bgShellRegistry` (teardown short-circuits) and subagent shells are unowned (no child `sessionId`). The real risk is the inverse — an under-reap leak — and it cannot be fixed without first threading child-session identity. The originally-proposed red-on-injection test is a **vacuous green** and must not be shipped as proof. Open-Q 11.1 now resolves **NO**.
- **Vocabulary churn (5.2)** — adding labels to a dead classifier is pure churn; the RFC's discipline is *wire first, then extend*. Only labels with a mechanical trajectory signal are stolen; judgement-only Claude modes (`code_quality`, `tone_or_preachiness`, …) are explicitly NOT taken (would require an LLM judge — out of scope, measure-first).
- **pr.action false-positive (5.1)** — a `gh pr create` inside a heredoc/string must not classify; reuse the existing command-shape gating (`invokesGitOrGh` segment scan), never a stdout scrape.
- **commit.branch on odd brackets (5.1)** — detached-HEAD / root-commit / rebase-todo brackets; enumerated guards above, omit on ambiguity.
- **asyncDispatched temptation** — do NOT build the replay-skip signal speculatively; it has no engine to consume it and the deferred-poll design already prevents double-fire. Revisit only with an on-disk replay engine.

## 10. Sequencing

1. **5.1** gitOperation fields (isolated, pure, leaf-crate `@/git`, conflict-free — NOT in the dirty set) — land first.
2. **5.2 decision only:** choose inline facts or a versioned sidecar and coordinate with the
   owner of dirty `report.ts`. No report implementation before acceptance.
3. **5.2 measurement:** prove recorder coverage and expose raw counts if useful. Calibrate
   before adding semantic labels.
4. **5.3 — PARK / RE-SCOPE.** Do not implement owner-scoped reap as written (premise falsified). First settle whether
   subagent bg shells should carry a session-owner identity at all; that identity-threading is the real prerequisite
   ticket, the reap swap is downstream. The signal flag inherits the same gap.
5. **5.4 — PARK as a separate UX ticket.** Does not belong in an observability-correctness RFC.
Only 5.1 is an immediate landing item. Every later slice needs its own accepted authority
and receipt.

## 11. Open questions

- ~~Does a **synchronous subagent** run the `session-lifecycle.ts:145` `killAll()` teardown against the shared singleton?~~ **RESOLVED = NO (`_review-07.md` §E).** The child config from `buildChildConfig` carries no `bgShellRegistry`, so `args.cfg.bgShellRegistry?.killAll()` short-circuits on undefined — the over-reap does NOT reproduce and 5.3's red-on-injection would be a vacuous green. The open successor question is instead: **should subagent bg shells carry a session-owner identity at all?** (the child config sets neither `bgShellRegistry` nor `sessionId`) — that is the real §5.3 prerequisite.
- Is `subagent_spawn` reliably present in the trajectory JSONL the failure-classifier reads (`failure-classifier.ts` opportunistic trajectory)? If spawn events aren't recorded there, `SUBAGENT_OVERSPAWN` degrades to unavailable (never invented) — acceptable but worth confirming the event is emitted.
- Should `failure.modes` be computed inline in the report or as an offline sidecar (like `closure-diagnostics`)? Sidecar keeps the runtime fence cleanest.

---

## 12. Audit log R1 → R3

### R1 — "is it already built? is the delta vacuous?"
- **gitOperation → core DROPPED.** Grounding found `src/git/passive-classify/` fully wired (classifier + sink + bash-hook + host `createPassiveVcsStreamSink` + `QUANTA_PASSIVE_VCS` knob). The RFC-02 memory hint ("maybeEmitPassiveVcs is a gitOperation-equivalent") is CONFIRMED. Only 2.1.238's optional field additions survive → shrank the item from "build gitOperation" to "add 2 fields".
- **failure taxonomy → real gap re-located.** The obvious read ("quanta has 7 labels, Claude has 16, add 9") is WRONG. `classifyFailure`/`FailureLabel` has **no production consumer** (dead since jul-6 S4). Adding labels to a dead classifier is churn. The lever is *wiring*, not vocabulary. Reframed 5.2 from "expand enum" to "wire + add only measurable labels".
- **task_category → DEFERRED as churn.** Every SWE-bench instance is `code_edit`; a constant per-run tag measures nothing. Killed from scope until a multi-category corpus exists.
- **asyncDispatched → DROPPED.** No on-disk replay engine (jul-16 InMemory-only); deferred-registry is pull-based (`poll_deferred`), so double-fire is already structurally impossible. Nothing to skip.
- **requestUserInput → DROPPED.** `src/tool/request-user-input.ts` exists (ADR-0097); RFC-05 owns the surface. Cross-ref set.

### R2 — "does the surviving delta hold up under correctness pressure?"
- **`branch.ref` DROPPED (new this round).** Initially kept for parity, but `Fast-forward`/`Merge made by` stdout does not reliably print the target branch ref — deriving it would be a heuristic (violates no-heuristics). Cut it; kept `commit.branch` (literally in the `[branch sha]` bracket) and `pr.action` (command-verb shape).
- **`commit.branch` edge cases surfaced.** `[detached HEAD sha]`, `[main (root-commit) sha]`, rebase brackets would mis-capture. Added explicit omit-on-`detached HEAD` + strip-parenthetical guards; omit-on-ambiguity (optional field, never a guess).
- **Over-reap escalated from "signal" to "correctness bug".** Traced the registry: `killAll()` (`:665`) clears ALL entries regardless of owner, on a **shared module singleton** bound to every session. A synchronous subagent's teardown (`session-lifecycle.ts:145`) would reap the parent's shells. This flipped 5.3's priority: the owner-scoped `killOwned` reap is the real fix; the `backgroundEndsWithFinalResponse` flag is secondary. Mandated **red-on-injection first** (prove the over-reap before touching teardown). Added Open-Q 11.1 to confirm subagents hit that teardown path.
- **pr.action false-positive** re-checked against the existing `invokesGitOrGh` segment scan — reused, so `echo "gh pr create"` cannot classify. No new gate needed.

### R3 — "vacuous tests? observer-sink? byte-identical? measure-first honesty?"
- **Vacuous-test trap on 5.2 closed.** Testing `classifyFailure` in isolation while nothing consumes it would be vacuous (assert a label no surface reads). Made the report-integration assertion (`failure.modes` in `bench-report.json`) the gate — the test now observes a real, consumed field; this is WHY the wiring must precede the label additions.
- **Judgement-only failure modes explicitly NOT stolen.** `code_quality`, `overconfidence_and_hallucination`, `tone_or_preachiness`, `context_and_memory`, `model_regression`, `dispute_or_decline` have no mechanical trajectory signal — importing them would force an LLM-judge classifier (heuristic-adjacent, unmeasured). Cut to only the countable pair (`SUBAGENT_OVERSPAWN`, `EXCESSIVE_QUESTIONS`), each behind a named threshold in `TaxonomyOptions` (no magic number). Measure-first respected.
- **Observer-sink / byte-identical re-verified per slice.** 5.1 new fields ride the existing sink (no second bus); OFF path returns before classify. 5.2 is offline eval-only (report fence, like `closure-diagnostics`). 5.3 flag is optional + knob-gated; the reap fix stays behind a gate until the red-on-injection validates it. Added a wiring-proof (capturing-sink) requirement for 5.1 so the field-flow is asserted, not just the pure return.
- **Residual honesty:** Open-Q 11 records the two unconfirmed grounding assumptions (subagent teardown path; `subagent_spawn` trajectory presence) rather than asserting them — degrade-to-unavailable, never invent.

### R4 — review incorporation (`_review-07.md`, verdict REVISE)
- **§5.3 P0 "over-reap correctness bug" FALSIFIED → PARK.** The reviewer traced the child-config path end-to-end:
  `buildChildConfig` (`subagent-runner-child-config.ts:261`) sets **neither `bgShellRegistry` nor `sessionId`**
  (independently grep-confirmed here — both tokens absent from the file). ⇒ (a) subagent teardown
  `session-lifecycle.ts:145 args.cfg.bgShellRegistry?.killAll()` short-circuits on undefined, so the parent-shell
  over-reap **does not reproduce** (Open-Q 11.1 = NO); (b) subagent shells adopt **unowned**, so `killOwned` has nothing
  to scope to — the red-on-injection rail as written is a **vacuous green**. The real defect is the inverse under-reap
  leak, whose fix needs **child-session-identity threading first** (unnamed prerequisite). R2's escalation of this to a
  "correctness bug" is **retracted**. This RFC did NOT find a real correctness bug — the README claim must be corrected.
- **§5.2 wiring cost UNDERSTATED → split + cost-corrected.** `classifyFailure` needs `MetricEvent[]` +
  `ObservationBundle` + `MetricInputs`; the offline report producer (`failure-classifier.ts`) has none and
  bundle-dependent detectors can't run without the S1–S3 bundle persisted. Split into **5.2a** (the real M/L glue, gated
  on a bundle-availability decision, dirty-`report.ts` merge) and **5.2b** (the two cheap count-labels, gated on
  confirming `subagent_spawn` presence in the recorded JSONL). "The report wiring is the bulk" reframed to name the hard
  bundle-availability part.
- **§5.4 LOW bundle → PARK as a separate UX ticket.** No substrate risk, no measurement consumer; does not belong in an
  observability-correctness RFC and must not pad scope.
- **CONFIRMED unchanged:** gitOperation CORE ALREADY-BUILT (DROP), residual fields `commit.branch`+`pr.action`
  authoritative, `branch.ref` DROP, failure taxonomy genuine dead seam — all upheld by the review.
