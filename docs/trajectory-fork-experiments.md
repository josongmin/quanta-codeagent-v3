# Trajectory Fork-Experiments — counterfactual debugging for SWE-bench

> **Reader:** this guide is written to be driven by an LLM/coding-agent (with a
> human skimming). Every command is copy-pasteable. Every claim is grounded in
> the code; flags that are not documented here do not exist.
>
> **Architecture / rationale:** RFC at
> [`docs/plans/jun-23-trajectory-fork-experiment/README.md`](plans/jun-23-trajectory-fork-experiment/README.md).
> Per-branch replay isolation is RFC §4.1; the remote non-goal is RFC §8.

---

## 1. What it is / when to use

Replay a **recorded** LLM trajectory deterministically up to turn N, change
**exactly what the LLM sees at turn N** (one pure rewrite of the assembled
prompt), then continue **live** from N onward — and run **K such branches** over
the same bench instance to compare outcomes side by side. The replayed prefix
(turns `1..N-1`) costs ~0 tokens; only the diverged tail hits the real model.

It answers one question: **"what information at turn N changes the outcome?"**
(e.g. *"if the model had the correct localization at turn 5, would it resolve?"*,
*"is the misleading issue-suggested-fix note at turn 3 the anchor that kills it?"*).

**Use it when** a bench instance fails and you want to test a fix-hypothesis
*cheaply* instead of paying a full live re-run for every guess. It is a
**troubleshooting** tool — you form a hypothesis and measure it. It is **not** a
benchmark number and **not** a substitute for a final live measurement (see §8).

The mechanism is two existing, default-OFF primitives composed:

- **Record/replay cassette** — `src/apps/bench/trajectory.ts`
  (`QUANTA_BENCH_RECORD_TRAJECTORY` / `QUANTA_BENCH_REPLAY_TRAJECTORY`).
- **Per-turn prompt mutation seam** — `AgentConfig.turnContextMutator`
  (`src/agent/types.ts`), driven by the named-experiment registry
  `src/apps/bench/eval/fork-experiments.ts`.

**DEFAULT-OFF:** with `QUANTA_FORK_EXPERIMENT` and the trajectory envs all unset,
a bench run is **byte-identical** to a normal run.

---

## 2. The 3-step workflow

The fork experiment fires during **patch generation** — i.e. the bench `run`
path (`quanta-bench run`, or the legacy no-subcommand flat-flag form). Pick a
single instance with `--instance <substr>` so you iterate on exactly one failure.

### (a) RECORD a cassette once (a real, live run)

Set `QUANTA_BENCH_RECORD_TRAJECTORY=1` on a normal run. Every bench LLM call is
recorded (single chokepoint — driver, localize, repro, verify-guard all share the
port). `=1`/`on` writes to `<cwd>/bench-trajectory.jsonl`; any other value is
treated as the output path.

```bash
QUANTA_BENCH_RECORD_TRAJECTORY=./trajectory-django-11099.jsonl \
  bun run src/apps/bench/cli.ts run \
  --swebench ./datasets/swe-verified.jsonl \
  --instance django__django-11099
```

After it completes, note the cassette file (here
`./trajectory-django-11099.jsonl`). You record **once** per instance; all
branches below replay this same file.

### (b) REPLAY + experiment

Point `QUANTA_BENCH_REPLAY_TRAJECTORY` at the cassette and pick experiment(s)
with `QUANTA_FORK_EXPERIMENT`. Replay is strict by default
(`QUANTA_BENCH_REPLAY_ON_MISS=throw`), but a fork **needs** to go live at the
divergence point, so you must set `QUANTA_BENCH_REPLAY_ON_MISS=passthrough` (or
`record-and-passthrough`) — otherwise the run throws at the mutated turn instead
of continuing live. See §3 and §6.

**Single-experiment run** (one mutator wired onto the config — no fan-out):

```bash
QUANTA_BENCH_REPLAY_TRAJECTORY=./trajectory-django-11099.jsonl \
QUANTA_BENCH_REPLAY_ON_MISS=passthrough \
QUANTA_FORK_EXPERIMENT=inject \
QUANTA_FORK_INJECT_TURN=5 \
QUANTA_FORK_INJECT_TEXT='Consider whether the bug is in the form-field rendering path, not the validator.' \
  bun run src/apps/bench/cli.ts run \
  --swebench ./datasets/swe-verified.jsonl \
  --instance django__django-11099
```

**Two-branch run** (`baseline,inject` ⇒ fan-out, one branch per name, compared):

```bash
QUANTA_BENCH_REPLAY_TRAJECTORY=./trajectory-django-11099.jsonl \
QUANTA_BENCH_REPLAY_ON_MISS=passthrough \
QUANTA_FORK_EXPERIMENT=baseline,inject \
QUANTA_FORK_INJECT_TURN=5 \
QUANTA_FORK_INJECT_TEXT='Consider whether the bug is in the form-field rendering path, not the validator.' \
  bun run src/apps/bench/cli.ts run \
  --swebench ./datasets/swe-verified.jsonl \
  --instance django__django-11099
```

`≥2` names ⇒ branch fan-out (one `InstanceResult` per arm, table printed).
Exactly `1` name ⇒ a single run with that mutator wired on. `0` names (unset) ⇒
DEFAULT-OFF, no mutator.

### (c) READ the branch table

The fan-out prints a comparison table to the log (see §5). With `baseline` vs
`inject`, a `— DIVERGED` summary means your turn-N change flipped the outcome —
that is the signal you were looking for.

### (d) Fork WITHOUT a mutator — re-sample the tail from step N

Sometimes you don't want to *change* the prompt at turn N — you want to see what
the model does if it simply runs **live again from step N** (variance / "was this
just a bad sample?"). Set `QUANTA_BENCH_REPLAY_LIMIT=N`: the run replays the first
`N` recorded interactions, then diverges **live** at interaction `N+1` with the
prompt unchanged. No `QUANTA_FORK_EXPERIMENT` needed.

```bash
QUANTA_BENCH_REPLAY_TRAJECTORY=./trajectory-django-11099.jsonl \
QUANTA_BENCH_REPLAY_ON_MISS=passthrough \
QUANTA_BENCH_REPLAY_LIMIT=4 \
QUANTA_BENCH_PRESET=baseline \
  bun run src/apps/bench/cli.ts run \
  --swebench ./datasets/swe-verified.jsonl --instance django__django-11099
```

If you'd rather produce a smaller **cassette file** trimmed to a prefix (e.g. to
share or archive), the pure helper `truncateCassette(src, keep, dest)` in
`src/apps/bench/trajectory.ts` writes the first `keep` interactions to `dest`
without touching the source — replaying `dest` under `passthrough` diverges live
past its end, same as the env cap but as an on-disk artifact.

---

## 3. Env reference table

All envs are DEFAULT-OFF: with every one unset, a bench run is byte-identical to
the pre-feature path.

| Env var | Meaning | Example | Required? |
|---|---|---|---|
| `QUANTA_BENCH_RECORD_TRAJECTORY` | Record every bench LLM call to a cassette. `1`/`on` ⇒ `<cwd>/bench-trajectory.jsonl`; any other non-empty/non-`0` value ⇒ that path. Cannot be combined with replay. | `./traj.jsonl` | Optional (record step only) |
| `QUANTA_BENCH_REPLAY_TRAJECTORY` | Replay from this cassette path. Unset/`""`/`0` ⇒ off. Cannot be combined with record. **Local-only** (remote/pool throws — see §8). | `./traj.jsonl` | Optional (replay step) |
| `QUANTA_BENCH_REPLAY_ON_MISS` | Policy when a request hash is not in the cassette. `throw` (default) fails loud on any miss; `passthrough` falls through to the live LLM; `record-and-passthrough` also writes the live tail back. For a fork you want a live tail ⇒ use `passthrough`. | `passthrough` | Optional; **set to `passthrough` for forks** |
| `QUANTA_BENCH_REPLAY_LIMIT` | Cap replay to the **first N recorded interactions** — the run replays the prefix and then **diverges LIVE at interaction N+1, with NO mutator**. The "re-sample / temperature-vary the tail from step N" lever (a fork-at-N that changes *nothing* about the prompt). Invalid (non-integer/negative) ⇒ throws. | `4` | Optional |
| `QUANTA_FORK_EXPERIMENT` | Comma-list of experiment names. Unset/`""`/`0` ⇒ no experiments. `1` name ⇒ single mutated run; `≥2` ⇒ branch fan-out. Unknown/misconfigured name ⇒ **throws with the catalog** (never a silent no-op). | `baseline,inject` | Optional (enables the feature) |
| `QUANTA_FORK_INJECT_TURN` | (used by the `inject` experiment) 1-based turn index to inject at. Must parse as an integer `≥1`. | `5` | Required **for `inject`** |
| `QUANTA_FORK_INJECT_TEXT` | (used by the `inject` experiment) text appended as a trailing user message at the chosen turn. Must be non-empty and must pass the answer-key fence (§7). | `'try the rendering path'` | Required **for `inject`** |

Notes grounded in `resolveBenchTrajectoryMode` (`src/apps/bench/trajectory.ts`):

- Setting **both** `QUANTA_BENCH_RECORD_TRAJECTORY` and
  `QUANTA_BENCH_REPLAY_TRAJECTORY` throws (`cannot combine …`).
- An invalid `QUANTA_BENCH_REPLAY_ON_MISS` value throws (`expected throw |
  passthrough | record-and-passthrough`).
- `QUANTA_BENCH_REPLAY_ON_MISS=passthrough`/`record-and-passthrough` requires a
  live fallback LLM port — the bench wiring supplies it automatically.

---

## 4. Experiment catalog

Two experiments are registered in `FORK_EXPERIMENTS`
(`src/apps/bench/eval/fork-experiments.ts`). The registry is deliberately minimal
and contains **no instance-specific or answer-key-derived steering** (that would
be leaderboard gaming — see §7).

### `baseline` — A/B control (identity)

No params. Returns the input unchanged (same reference) — provably a no-op,
byte-identical to wiring no mutator. Run it as the comparison arm against any
other branch so the table has a control row.

### `inject` — append a hint at one chosen turn

Appends arbitrary text as a trailing **user** message at exactly one turn; all
other turns pass through unchanged. The general-purpose *"give the LLM this hint
at step N"* lever.

| Param | Required | Meaning |
|---|---|---|
| `QUANTA_FORK_INJECT_TURN` | yes | 1-based turn index to inject at (e.g. `5`). |
| `QUANTA_FORK_INJECT_TEXT` | yes | Text added as a trailing user message that turn. |

The `inject` factory **fails loud** (never a silent no-op): empty text throws
asking for `QUANTA_FORK_INJECT_TEXT`; text containing a SWE dataset marker is
rejected by the answer-key fence; a missing/`<1`/non-integer turn throws asking
for a valid 1-based `QUANTA_FORK_INJECT_TURN`.

### Runtime self-describing catalog

The catalog is also produced at runtime by `describeForkExperiments()` and is
**printed in the error** when you pass an unknown name to `QUANTA_FORK_EXPERIMENT`
(via `resolveForkExperiments`). So if you forget the exact name/params, trigger
the error and read the catalog back. Sample of that error + catalog:

```text
unknown fork experiment "injct" (QUANTA_FORK_EXPERIMENT); valid names: baseline, inject.
Trajectory fork experiments — set QUANTA_FORK_EXPERIMENT=<name>[,<name>...] (comma-list ⇒ one branch per name, compared side by side):
  baseline — A/B CONTROL arm — identity (never touches the input). Run this alongside another arm as the comparison branch; it is byte-identical to wiring no mutator.
    (no params)
  inject — Append arbitrary text as a user message at ONE chosen turn (turn-scoped). The general-purpose 'give the LLM this hint at step N' lever. Other turns pass through unchanged.
    QUANTA_FORK_INJECT_TURN (required) — 1-based turn index to inject at (e.g. 5)
    QUANTA_FORK_INJECT_TEXT (required) — the text to add as a trailing user message that turn
```

(The catalog is deterministic and sorted by name.)

---

## 5. Reading the output

The fan-out path prints a monospace table via `formatForkBranchReport`
(`src/apps/bench/eval/fork-branch-report.ts`), one row per branch **in input
order**, followed by a summary line.

Columns:

| Column | Meaning |
|---|---|
| `BRANCH` | Experiment name (e.g. `baseline`, `inject`). |
| `RESOLVED` | `yes`/`no` — did this branch resolve the instance. |
| `PATCH(bytes)` | Byte size of the generated patch (`0` = empty/no patch). |
| `TURNS` | Agent turns used (`-` if unknown). |
| `REASON` | Short failure/verdict reason (optional; truncated past 60 chars with `…`). |

Summary line: `{p}/{n} branches resolved`, with **`— DIVERGED`** appended **iff
the branches did not all agree** (some resolved, some did not, i.e. `p` is
neither `0` nor `n`). DIVERGED is the headline signal: **your turn-N change
mattered.** If all branches agree (all `yes` or all `no`), the change made no
observable difference on this instance.

Sample table (DIVERGED — `inject` flipped the outcome):

```text
django__django-11099
BRANCH    RESOLVED  PATCH(bytes)  TURNS
baseline  no        0             14
inject    yes       512           9
1/2 branches resolved — DIVERGED
```

Sample table (no divergence — all branches agree, hint had no effect):

```text
django__django-11099
BRANCH    RESOLVED  PATCH(bytes)  TURNS
baseline  no        0             14
inject    no        128           12
0/2 branches resolved
```

(When there are no branches, the formatter prints `(no branches)`.)

---

## 6. How fork-at-N works (mental model)

The mutator drives the fork; the existing replay machinery handles the divergence
with **no new replay code**:

```text
cassette (recorded trajectory)         turnContextMutator(turn, input)
        │                                        │
   turn 1..N-1: prompt == recording  ──►  replay HIT  (≈0 tokens)
   turn N:      mutator rewrites input ──► request-hash MISS ──► LIVE
   turn N+1..:  prompt now diverged    ──► MISS ──► LIVE (continues live)
```

Replay matches by **request hash**. The `inject` mutator rewrites the turn-N
prompt, so the cassette **misses at exactly turn N**; with
`QUANTA_BENCH_REPLAY_ON_MISS=passthrough` the miss falls through to the real LLM,
and every subsequent turn (now diverged) also goes live. That is **fork-at-N +
live tail** — no cassette truncation required.

**Per-branch replay isolation (RFC §4.1).** The replay store is stateful: each
matched cassette entry is marked `used`. If K branches shared one port, branch 1
would consume the prefix and branch 2+ would miss from turn 1. The fan-out driver
avoids this by giving **each branch a FRESH replay port** (`freshLlm()` per arm
in `runForkBranches`), so every branch re-replays the full prefix over the same
cassette file independently. Cross-link:
[RFC §4.1](plans/jun-23-trajectory-fork-experiment/README.md#41-per-branch-replay-isolation-correction--reviewer-jun-23).

**Caveat (RFC §4):** this assumes the only LLM calls in the turn window are the
per-turn agent calls. Memory distillation runs post-session and language
detection is pure, so neither shifts cassette alignment. A custom mid-turn
callback that itself calls the LLM would consume cassette entries and offset the
fork point — out of scope for the standard bench path.

---

## 7. Adding a new experiment

Add one `ForkExperimentSpec` to `FORK_EXPERIMENTS` in
`src/apps/bench/eval/fork-experiments.ts`. Minimal pattern:

```ts
export const FORK_EXPERIMENTS: Record<string, ForkExperimentSpec> = {
  // ...existing baseline / inject...

  myhypothesis: {
    description: "One-line, LLM-readable summary of what this arm tests.",
    params: [
      { env: "QUANTA_FORK_MY_TURN", required: true, desc: "1-based turn to act at" },
    ],
    build: (env) => {
      const turn = Number.parseInt(env.QUANTA_FORK_MY_TURN ?? "", 10)
      if (Number.isNaN(turn) || turn < 1) {
        // Fail LOUD — never a silent no-op.
        throw new Error('myhypothesis requires QUANTA_FORK_MY_TURN as a 1-based integer.')
      }
      // PURE: return a NEW input; do not mutate `input` or its nested members.
      return (t, input) =>
        t === turn
          ? { ...input, baseMessages: [...input.baseMessages, /* extra message */] }
          : input
    },
  },
}
```

Rules (the seam does not enforce these — honour them; see `src/agent/types.ts`):

- **PURE mutator.** Return a new object; never mutate `input` or its nested
  members. `baseMessages` is a shallow copy of working memory — mutating a shared
  `message.content[*]` corrupts the session transcript. Use the spread form.
- **Turn is 1-based.** Turn `1` is the first turn.
- **May fire more than once per turn.** Refusal/nudge re-prompts re-enter the
  assembly within one logical turn, so the mutator must be idempotent for a given
  `(turn, input)`. If you need fire-once, key off your own counter.
- **Vary message content only.** Do **not** change `system` / `cwd` — they pin
  the cached system-prompt prefix and rewriting them breaks cache reuse.
- **NO answer-key content.** Mutators inject *hypotheses / evidence framing*,
  never gold-patch / dataset markers / file-path / keyword matches. The `inject`
  arm screens its text with `assertEvidenceTextBlind` at factory-construction
  time, which **throws** on `FAIL_TO_PASS` / `PASS_TO_PASS` dataset markers.
  Smuggling the answer key is leaderboard gaming and is the worst failure mode —
  keep new experiments general and reviewable in this one auditable file.

---

## 8. Limits / gotchas

- **Predictions/report record the BASELINE branch only (fan-out mode).** The
  pipeline keeps one `InstanceResult` per instance — the baseline (first) branch.
  So `predictions.jsonl` / `report.json` reflect ONLY the baseline; the other
  branches live in the **printed table** (the real output). The driver logs a
  warning to make this impossible to miss:

  ```text
  [fork] django__django-11099: 2-branch experiment (baseline, inject) — predictions/report record the BASELINE branch only; see the table below.
  ```

  Never read a fan-out run as a benchmark number.

- **Replay is LOCAL-ONLY.** `buildForwardedBenchEnv`
  (`src/apps/bench/remote/box-session.ts`) **throws** when
  `QUANTA_BENCH_REPLAY_TRAJECTORY` is set — a local cassette path cannot be
  blindly forwarded to a remote box / pool. Run forks locally; remote replay
  needs explicit cassette-upload wiring that does not exist yet (RFC §8).

- **Branches run sequentially.** Replay prefixes are ~free and live tails must
  not fan out concurrently (throttle), so `runForkBranches` iterates arms one at
  a time.

- **Cassette tail past the fork point is dead weight.** Under `passthrough`,
  turns `> N` are diverged and go live, so the recorded entries beyond the fork
  point are never replayed. A 40-turn cassette forked at turn 5 does NOT mean
  "40 turns replayed".

- **This is a troubleshooting tool, not a final measurement.** It forms
  hypotheses cheaply; confirming a config still requires a full live run
  (RFC §8).
