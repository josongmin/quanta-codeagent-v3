# RFC 0003 — Eval Architecture (Tier 0..4 Verification Harness)

- Status: Phase A landed 2026-05-21 · Phase B landed 2026-05-21
- Owner: codeagent core
- Companion doc: `docs/analysis/may-21-coding-agent-query-usecase.md`
- Slice impact: ZERO new slices. Adds `src/apps/eval/` only.

## 0. Phase B delta (this revision)

Phase B drops the firstUserText heuristic and lands the four items §11 had
deferred. Concrete changes vs Phase A:

- `trajectory/source.ts` — REMOVED the "first 500 chars of assistant_text"
  proxy. Sessions now carry an authoritative `EvalMeta` sidecar
  (`<jsonl>.meta.json`); absence ⇒ `meta:null`, treated as unclassifiable.
- `trajectory/meta.ts` — new sidecar reader/writer.
- `trajectory/diff.ts` — new structural projection + LCS diff.
- `trajectory/replay.ts` — fully implemented. Re-executes a fixture against
  the current agent, persists a sibling `.replay.jsonl`, diffs streams
  structurally, emits `TrajectoryPayload.replay`.
- `trajectory/freeze.ts` — promote a real session into the fixtures dir,
  refusing inputs without sidecar AND no inline `--prompt`.
- `synthetic/runner.ts` — wires a real `JsonlRecorder` (strict) + meta
  sidecar via `recordTo` so Tier 1 produces replayable fixtures.
- `synthetic/index.ts` — `recordTrajectories` opt (default ON) writes to
  `<storeDir>/<runId>/<scenarioId>.jsonl`.
- `synthetic/generator.ts` — new LLM-driven scenario generator with strict
  schema + size validation; rejects malformed batches without writing.
- `compare/adapter.ts` — new `AgentAdapter` interface.
- `compare/adapters/{cli-base,claude-code,cursor,aider,quanta}.ts` — four
  competitor adapters. CLI adapters spawn one-shot, capture stdout, refuse
  to throw (return `exitOk:false` instead).
- `compare/pairwise-judge.ts` — bias-swap pairwise judge (`forward + swapped
  → winner` resolver).
- `compare/index.ts` — real `runCompare` running adapters in parallel + N
  pairwise matchups + persists `ComparePayload` per pair.
- CLI — three new trajectory subcommands (`classify`/`replay`/`freeze`),
  `generate` for synthetic, real `compare` with default `--agents
  quanta,claude-code`.

## 1. Motivation

We rely on per-feature unit tests and one external benchmark (SWE-bench). We
have no answer to "does quanta cover the *real* developer query distribution?"
because we never enumerated the distribution. The companion analysis doc
classifies the distribution into 12 majors / ~120 leaves with empirical anchors
(Hao 2026, Hao 2024, Liu 2026, Wang 2026, Zhong 2025). This RFC turns that
classification into runnable verification.

## 2. Non-goals

- A new agent framework. `runAgent` from `@/agent` stays the single executor.
- Replacing `src/apps/bench/`. The SWE-bench harness is wrapped, not forked.
- Inventing new telemetry shapes. `JsonlRecorder` output is the trajectory
  source of record; eval reads it, does not produce a parallel format.
- A judge "rubric DSL". Plain JSON scenario files; if it grows, revisit.

## 3. Constraints

- RFC §4 (apps vs slices): only one new dir under `src/apps/`. No `src/eval/`.
- Strict TS, exactOptionalPropertyTypes, noUncheckedIndexedAccess hold here too.
- Provider key absence ⇒ exit 0 with guidance (mirrors `src/apps/bench/index.ts`).
- Sandbox-only mutation. Eval may write to a tmp dir; never to the user's repo.
- Single result schema. All tiers append to `evals/runs/<runId>.jsonl` under one
  envelope (`storage/schema.ts`).

## 4. Architecture

```
src/apps/eval/
  taxonomy/      ← SSOT for 12 majors / ~120 leaves (usecases.ts)
  storage/       ← shared JSONL envelope + result store
  audit/         ← Tier 0: static grep matrix
  synthetic/     ← Tier 1: scenario → runAgent → LLM judge
  trajectory/    ← Tier 3: real-session JSONL → classify (replay TBD)
  public/        ← Tier 2: adapters around external benches (swebench-verified)
  compare/       ← Tier 4: A/B vs other agents (stub, see §7)
  report/        ← cross-tier aggregation + markdown render
  index.ts       ← CLI dispatch
```

Data flow:

```
taxonomy ─┬──> audit ───┐
          ├──> synthetic ┤
          ├──> public ───┤──> storage ──> report
          ├──> trajectory┤
          └──> compare ──┘
```

## 5. Tier-by-tier semantics

### Tier 0 — audit (`src/apps/eval/audit/`)
- Walks every taxonomy leaf, runs `auditOne` against `RULES` (hand-curated
  token map), classifies as `ok | partial | no | tbd`.
- Pure static analysis — no LLM, no agent invocation.
- Persists `AuditPayload` per leaf. Default config greps `src/`, `tests/`,
  `docs/runbooks/`.
- Adding a new leaf without a rule degrades to `tbd` and surfaces as a gap.

### Tier 1 — synthetic (`src/apps/eval/synthetic/`)
- Scenario files at `synthetic/scenarios/<usecase-id>/*.json` (schema v1).
- Each scenario = `{ prompt, files?, setupCmd?, rubric[], forbidden? }`.
- `runScenario` materialises files into a fresh `mkdtemp` sandbox, calls
  `runAgent` with `permission.mode = "bypass"` and `defaultTools`.
- `judge` rates per-rubric; weighted score ∈ [0,1].
- Verdict aggregation: `forbiddenHit ⇒ fail`; `stopReason ∈ {aborted,error} ⇒
  error`; rubric all-pass ⇒ `pass`; some-pass ⇒ `partial`; none ⇒ `fail`.
- The judge model is independent of the agent (`QUANTA_JUDGE_MODEL`).

### Tier 2 — public (`src/apps/eval/public/`)
- `mapping.ts` declares `bench → primary UseCaseId (+ secondary[])`.
- Current adapter: `swebench-verified` reads `bench-report.json` produced by
  `bun run bench`, translates each instance into a `PublicPayload`.
- Future adapters (`livecodebench`, `terminalbench`, `multi-swebench`) are
  additional files in `public/adapters/`; mapping entries already declared so
  reports surface gaps.
- Deliberately does NOT spawn `src/apps/bench/runner.ts` directly in this
  iteration — keeps the bench CLI as the single entry while we shake the
  contract out. Direct spawn is the documented next step.

### Tier 3 — trajectory (`src/apps/eval/trajectory/`)
- `source.ts` reads `JsonlRecorder` output (read-only, never imports the
  recorder — symmetric format only).
- `classifier.ts` classifies a session by its `firstUserText` (proxy: the
  first `assistant_text.delta`'s 500-char head; producers may emit explicit
  `user_message` lines, which take precedence).
- Persists `TrajectoryPayload` per session; unknown id ⇒ `usecase:"unclassified"`.
- **Replay (`replay.ts`) is intentionally deferred** — design captured in §6.
  The "label real traffic, compute coverage" half is the higher-ROI half.

### Tier 4 — compare (`src/apps/eval/compare/`)
- Stub. Emits a single `skipped` `ComparePayload` so the tier is visible.
- Full design in §7.

## 6. Trajectory replay design (IMPLEMENTED — Phase B)

Implemented as `trajectory/replay.ts`:

1. Read fixture JSONL + `<jsonl>.meta.json` sidecar. **No sidecar ⇒ refuse**
   with `verdict:"skipped"` and a `no_meta_sidecar` reason — there is NO
   heuristic prompt reconstruction (Phase A's `firstUserText` was removed).
2. Re-execute via `runAgent` with `messages = [{role:"user", text: meta.userPrompt}]`,
   `permission.mode = "bypass"`, `cwd` = a fresh sandbox, default tools.
3. Tee the replay stream to a sibling `<fixture>.replay.jsonl`; reload it to
   normalise into `TrajectoryEvent` (same shape as the original).
4. Diff via `diff.ts`: PROJECT each event to a key
   `(kind, tool-name + input-shape, ok)`, drop noisy kinds (`assistant_text`,
   `llm_request`/`llm_usage`, `sandbox`/`verify`), then LCS over the
   projected key sequences. Result: `{matched, divergedEvents,
   firstDivergences[5]}`.
5. Verdict: `matched ⇒ pass`; `divergedEvents ≤ 2 ⇒ partial`; else `fail`.
   Persists `TrajectoryPayload.replay` (no extra schema bump).

**Tool result content** is NOT compared (provider non-determinism, exec
non-determinism). Only `(name, ok)` shape — that has held up against real
provider drift in early fixtures.

### Producer requirement

Tier 1 (`synthetic/runner.ts`) writes a meta sidecar whenever `recordTo` is
set. For real CLI sessions, the recorder slice does NOT currently emit a
`user_message` event (would require a `TrajectoryKind` bump, RFC-0002 §5.2).
Until that lands, real sessions become replayable only via
`eval trajectory freeze --source X --prompt "..."`.

## 7. Compare runner design (IMPLEMENTED — Phase B)

Surface:

- `compare/adapter.ts` — `AgentAdapter { name; available(); runOne(scenario) }`.
- `compare/adapters/quanta.ts` — in-process, calls `synthetic/runner.runScenario`.
- `compare/adapters/cli-base.ts` — shared spawn/sandbox/timeout machinery.
- `compare/adapters/claude-code.ts` — `claude -p <prompt> --permission-mode bypassPermissions`.
- `compare/adapters/cursor.ts` — `cursor-agent -p <prompt>`.
- `compare/adapters/aider.ts` — `aider --message <prompt> --yes-always --no-auto-commits`.
- `compare/pairwise-judge.ts` — pairwise judge with bias swap (`resolveWinner`).
- `compare/index.ts` — `runCompare`: build adapters → probe `available()` →
  run all in parallel → pairwise judge every (a, b) → persist
  `ComparePayload` per matchup.

Behaviour contracts:

- Adapter `runOne` MUST NOT throw; returns `exitOk:false` + `failureReason`
  on infra failure. The orchestrator never wraps with `try/catch`.
- Unknown adapter name in `--agents` is REFUSED at build time (no silent
  skip); CLI absence is reported as `agentsSkipped[]` so report surfaces it.
- Default `--agents quanta,claude-code` — the most useful baseline pair.
- Position-bias mitigation: judge runs twice, A/B swapped; an
  agreed winner is recorded, otherwise `tie` (-1).

NOT implemented (deliberately): multi-turn driving of competitor CLIs. We
hand the prompt once and read the final stdout — vendor-specific interactive
protocols explode the surface area without buying replicability.

## 8. Storage & schema versioning

- Records: `evals/runs/<runId>.jsonl`, append-only.
- Envelope versioned by `SCHEMA_VERSION`. Reader skips lines whose schema
  doesn't match — bumps require a migration plan.
- `runId`: `YYYYMMDD-HHMMSS-<tier>-<rand>` for deterministic sort.
- Each run ends with a `kind:"run_summary"` record consumed by `report/trend`
  (future) for historical comparisons.

## 9. CLI surface

```
bun run eval audit
bun run eval synthetic [--usecase ID]
bun run eval public swebench-verified [--report PATH]
bun run eval trajectory classify --input <dir>
bun run eval compare --scenario ID --usecase ID --agents quanta,claude-code
bun run eval report
bun run eval classify "<query text>"
```

Provider/model resolution mirrors `bun run bench`: `QUANTA_PROVIDER`,
`QUANTA_MODEL`, plus `QUANTA_JUDGE_MODEL` and `QUANTA_CLASSIFIER_MODEL`
for the two LLM roles unique to eval.

## 10. Test posture

- Unit (`tests/unit/eval-*.test.ts`):
  - `eval-taxonomy.test.ts` — SSOT invariants (id uniqueness, shape).
  - `eval-audit-matrix.test.ts` — aggregation correctness.
  - `eval-classifier-parse.test.ts` — JSON extraction tolerance.
  - `eval-storage-roundtrip.test.ts` — append/read/render path.
- Integration: synthetic roundtrip against `ScriptedLLM` (TBD; non-trivial
  because `runAgent` requires a more complete LLM mock than the classifier).
- Out of scope here: live integration tests requiring API keys. CI skips when
  keys are absent (the CLI exits 0).

## 11. What this RFC explicitly chooses NOT to do (still deferred after Phase B)

- LiveCodeBench / TerminalBench / Multi-SWE-bench adapters — each needs a
  language-specific test harness (Python sandbox, container scaffolding) we
  don't want to build inside `src/apps/eval/`. Tier 2 keeps the SWE-bench
  Verified bridge and the mapping table — add adapters when there's a
  concrete need.
- Multi-turn driving of competitor CLIs — see §7.
- Trajectory recorder bump to emit `user_message` for real CLI sessions —
  RFC-0002 §5.2 contract change; freeze + manual `--prompt` is the workaround.
- Cost tracking on eval LLM calls — `JsonlRecorder.cost = null` policy still
  holds; report uses `bench-report.json` cost figures for Tier 2 only.
- Trend / historical reports — Phase C.

## 12. Migration / rollout

- Phase A (landed 2026-05-21): taxonomy + audit + storage + synthetic PoC +
  trajectory classify + public/swebench + report + CLI + unit tests.
- Phase B (landed 2026-05-21): meta sidecar + trajectory replay/diff/freeze +
  real compare with pairwise judge + synthetic LLM generator.
- Phase C (planned): trend/historical reports; CI gating thresholds per
  major; SWE-bench direct spawn from eval (drop the bench-report dependency).
- Phase D (planned): additional public adapters (livecodebench, terminalbench);
  recorder `user_message` event for native trajectory classification.

## 13. Backwards compatibility

- New scripts in `package.json` only — no existing script modified.
- No slice imports added or removed. `src/apps/bench/`, `src/agent/`, and
  `src/stream/adapters/jsonl-recorder.ts` unchanged.
