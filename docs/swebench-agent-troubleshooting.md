# SWE-bench agent troubleshooting — record → replay, and offline repro-oracle rescore

Debugging *why* a bench instance fails normally means re-running the whole
expensive pipeline (LLM patch-gen + repro-gen + an EC2 box) on every code tweak.
You don't have to. The bench has two complementary cheap-iteration paths:

1. **Trajectory cassette (record → replay)** — record the agent's *entire* LLM
   stream once, then replay it deterministically for **zero tokens** while you
   change deterministic code (oracle, build-env, selection, closure).
2. **`evaluate-repro` (offline repro-oracle rescore)** — re-run already-generated
   repro scripts (or a synthetic build-env import probe) against a fresh base
   checkout, with **zero LLM**, to watch the repro oracle flip
   `exec_failed → reproduced`.

Both exist because the EXPENSIVE part of a run is the stochastic LLM rollout; the
DETERMINISTIC part (repro execution, build-env, grading, selection) can be
re-driven for free once the rollout is captured.

---

## What to read first — the failure taxonomy

A bench run drops these artifacts (full-remote fetches them to
`~/Library/quanta-codeagent-v3/bench/full-remote/`):

| file | what it tells you |
|---|---|
| `report-<suffix>.json` | per-instance verdicts + `reproTest` + `selectionTelemetry` |
| `closure-<suffix>.json` | closure diagnostics (oracle/localization health metrics) |
| `runlog-<suffix>.log` | terminal/operational summary |
| `preds-<suffix>.jsonl` | the submitted patch per instance |
| `trajectory-<suffix>.jsonl` | the LLM cassette (only if recording was on) |

**The single most important signal — is the repro ORACLE established?**
In `closure-<suffix>.json` → `metrics`:
- `synth_repro_base_red_rate` — fraction of instances whose repro script went
  RED on the broken base. **0 ⇒ the oracle never established ⇒ verify-select has
  no signal to confirm a candidate.** This, not localization, is usually the gap
  (`owner_recall@1` is typically high).
- `primary_rail_present_rate`, `required_verification_coverage` — verification
  rail coverage.

**Why each instance's oracle failed** — `report-<suffix>.json` →
`perInstance[].reproTest`:
- `reason: "execution_failed"`, `sampleOutcomes: [exec_failed, …]` + a
  `sampleStderrTail` like `No module named 'extension_helpers'` ⇒ **build-env**:
  the repro can't even build/import the project. Fix is dependency/build-env, not
  the script. (See `src/runner/batch/corpus/project-env.ts` per-repo overrides.)
- `reason: "no_reproduced_candidate"`, outcomes `[other, …]`/`[resolved, …]` ⇒
  **repro-gen quality**: scripts run but never print `Issue reproduced` (they
  self-immolate to "Other issues", or report the bug already "resolved" on base).
- `reproducedCount > 0` ⇒ oracle established; look at `selectionTelemetry` next.

---

## Path 1 — trajectory cassette (record → replay)

Records EVERY bench LLM consumer (localize, candidate-gen, repro-gen,
verify-guard …) through one chokepoint (`maybeRecordTrajectory`,
`src/apps/bench/index.ts`), so a replay reproduces the run bit-for-bit.

**Record** (default-OFF; byte-identical when unset):
```bash
QUANTA_BENCH_RECORD_TRAJECTORY=1 quanta-bench run …          # local → ./bench-trajectory.jsonl
QUANTA_BENCH_RECORD_TRAJECTORY=1 quanta-bench grade --mode full … # full-remote → fetched as trajectory-<suffix>.jsonl
```

**Replay** (zero tokens) — note the env var is `QUANTA_BENCH_REPLAY_TRAJECTORY`,
**not** the generic `QUANTA_LLM_REPLAY`:
```bash
QUANTA_BENCH_REPLAY_TRAJECTORY=/path/to/trajectory.jsonl quanta-bench run …
```
- STRICT by default: `QUANTA_BENCH_REPLAY_ON_MISS=throw` — a stale/short cassette
  fails LOUDLY instead of silently drifting onto live model output.
- To replay up to a point then diverge live: `QUANTA_BENCH_REPLAY_ON_MISS=record-and-passthrough`.

**Use it for:** iterating any DETERMINISTIC change (oracle/build-env/selection/
closure) — the same LLM outputs replay for free and your new deterministic code
runs against them. **Cannot** be used to test repro-gen *prompt* changes (those
need a fresh, paid rollout) — for those, record a new cassette.

(Bench cassettes are NOT `fork_session` — that is CLI-REPL only and cannot reach
a bench run. The cassette is the bench-native replay.)

---

## Path 2 — `evaluate-repro` (offline repro-oracle rescore, zero LLM)

Re-runs repro scripts against a fresh base checkout under the CURRENT build-env /
exec code. Lighter and more targeted than a full cassette replay: it exercises
ONLY the repro oracle (no driver replay).

```bash
# build-env class (exec_failed): a synthetic `import <pkg>` probe is enough —
# the repro script content is irrelevant when the repo can't even build.
quanta-bench evaluate-repro --corpus <corpus-dir> --probe --instance astropy__astropy-13033

# repro-gen class (no_reproduced): replay the EXACT recorded scripts (needs a
# persisted repro-scripts sidecar; script content matters here).
quanta-bench evaluate-repro --corpus <corpus-dir> --repro-scripts <sidecar.jsonl>
```
Flags: `--instance a,b` (subset), `--exec-timeout-ms` (default 60000, matches the
live `DEFAULT_EXEC_TIMEOUT_MS` so a slow repro doesn't pass here yet die live).

Output per instance: `outcomes=[…] reproduced=N parity=match|drift (was […])`.
`parity=drift` from `exec_failed` → `reproduced` is the **win signal** that a
build-env fix worked. The summary exits non-zero if every instance errored or any
were skipped (so `drift=0` can never silently read as "no regressions").

Implementation: `src/runner/batch/eval/repro-rescore.ts` (pure core, reuses the
live `executeReproTests` so it round-trips byte-identically) +
`repro-rescore-run.ts` (sidecar parse / import probe / summary). It takes NO
`llm` port — the rescore cannot cost a model call.

**Probe import-name caveat:** the probe imports `<repo-slug-tail>` by default; for
repos whose module name differs (scikit-learn→`sklearn`, Pillow→`PIL`, …) it uses
a known-alias map (`IMPORT_NAME_BY_REPO`). For an unmapped divergent repo use
`--repro-scripts` (a real recorded script) to avoid a false `exec_failed`.

---

## The loop in practice

1. Run once with `QUANTA_BENCH_RECORD_TRAJECTORY=1` (the only paid step).
2. Read `closure-*.json` → `synth_repro_base_red_rate`; if 0, read each
   `reproTest.reason`/`sampleStderrTail` to classify build-env vs repro-gen.
3. **build-env (exec_failed):** edit `project-env.ts`; verify free with
   `evaluate-repro --probe`.
4. **repro-gen (no_reproduced):** replay the cassette (or `evaluate-repro
   --repro-scripts`) against the fixed oracle/repro-gen code.
5. Re-measure the readout (`synth_repro_base_red_rate` rising from 0). Only pay
   for a fresh rollout once the deterministic fix is confirmed.

> Honest scope: a working oracle is *necessary* but not *sufficient* — it lets
> verify-select PICK a correct candidate only if one exists among the N. If the
> oracle is fixed and instances still miss, the bottleneck has moved to
> generation ("right place, wrong answer"), which a fresh rollout must address.
