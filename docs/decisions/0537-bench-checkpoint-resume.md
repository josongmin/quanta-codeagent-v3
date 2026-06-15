# ADR-0537 — Bench turn-boundary checkpoints + resume (sender-deterministic, not provider-deterministic)

- Status: **Proposed** (2026-06-15)
- Related:
  - ADR-0010 (trajectory / observe)
  - ADR-0108 / ADR-0118 / ADR-0119 / ADR-0121 (shadow ODB + rewind)
  - ADR-0124 (conversation checkpoint store)
  - ADR-0166 (conversation-seed replay)
  - ADR-0536 (unified `quanta-bench` CLI + remote grading)

## Problem

Late SWE-bench failures are expensive in the wrong place. A single instance can
consume 20-30 internal agent turns, fail near the end, and the next experiment
starts again from turn 1. This is wasteful for:

1. prompt/RCA iteration on one hard instance,
2. preset A/Bs where the first 20 turns are mostly identical,
3. infra-adjacent failures that happen after useful work was already done.

The current bench path has no resumable state:

- `runInstanceOnce` creates a fresh sandbox, copies the repo, runs the agent,
  then deletes the sandbox on exit.
- `observe/` writes a trajectory JSONL and final patch/report artifacts, but
  that log is an audit trail, not a restore surface.
- existing checkpoint primitives are not enough for bench:
  - `conversationCheckpoint` is caller-side only and currently in-memory,
  - `shadowOdb` / `shadow_rewind` are optional tool surfaces, not a bench-owned
    persistent resume format,
  - subagent replay re-seeds message history but does not restore a bench
    sandbox or attempt metadata.

The user request is Temporal-like replay from a specific point. The important
split is:

- **resume**: restore a recorded state and continue with a LIVE next model call.
- **replay**: re-emit recorded model/tool outputs without calling the provider.

The cost problem needs **resume** first. Exact replay is a separate, stricter
mode.

## Determinism boundary

This ADR defines **sender-deterministic resume**, not full deterministic replay.

If we preserve:

- sandbox file state,
- the exact model-visible transcript that would be sent on the next request,
- preset / knobs / model / timeout / issue-hint / repro-test state,
- attempt-local metadata,

then the resumed run is deterministic from the caller's side: we know exactly
what state we restore and what bytes we send next.

That does **not** make the future execution fully deterministic:

- hosted LLM backends are not guaranteed byte-stable across calls,
- provider rollouts can change,
- tool outputs after the checkpoint can differ if they read live time/network,
- model-side hidden state is not restorable unless the provider itself exposes
  a deterministic continuation primitive we own.

Therefore:

- **resume** is a production cost-control feature,
- **replay** is a future debug/analysis feature.

## Decision

### 1. Ship bench resume first, not full replay

The first shipped surface is **checkpointed resume** for bench instances.

It restores:

- the sandbox contents,
- the exact model-visible conversation/transcript for the next request,
- the bench attempt metadata,

and then continues with the **next live model call**.

It does **not** attempt to:

- re-run prior model turns deterministically,
- replay prior tool calls from the trajectory,
- resume mid-tool or mid-stream,
- guarantee identical post-checkpoint outputs.

### 2. Checkpoint only at turn boundaries

The checkpoint boundary is:

- after a completed internal agent turn,
- after all tool effects from that turn are durable in the sandbox,
- before the next model request is assembled.

We do **not** checkpoint:

- mid-stream,
- mid-tool-call,
- between tool output emission and filesystem durability,
- at arbitrary wall-clock intervals.

Reason: bench resume must restore one coherent state. Mid-turn checkpoints would
need partially-applied tool state, partial tool outputs, and provider stream
continuations. That is a different class of system.

### 3. Persist a bench-owned checkpoint artifact

Bench gets a new run-scoped checkpoint artifact layout under the run directory.

```text
<bench-run-root>/
  checkpoints/
    <instance-id>.<attempt>/
      turn-00001/
        manifest.json
        transcript.json
        sandbox.tgz
      turn-00002/
        manifest.json
        transcript.json
        sandbox.tgz
```

`manifest.json` is the restore authority. It records:

- schema version,
- run id / instance id / attempt,
- internal turn number,
- model id / provider,
- preset name and resolved knobs,
- timeout / retry posture,
- issue-hint / repro-test installation state,
- swebench identity (`repo`, `baseCommit`, `instanceId`) when present,
- checksums of `transcript.json` and `sandbox.tgz`,
- `resumedFrom` when the current run itself is a resumed run.

`transcript.json` is the **exact model-visible history** that the next request
would consume. This is the critical artifact; the observe JSONL is not
authoritative for restore.

`sandbox.tgz` is the full disposable sandbox, including `.git`, restored into a
fresh temp directory on resume. V1 chooses the full sandbox snapshot over a
cleverer partial restore because correctness matters more than dedup in the
first shipping surface.

### 4. Add an explicit checkpoint sink to the agent loop

Bench cannot build checkpoints after the fact from `observe/`; it needs the loop
to hand it the exact restore state at the right moment.

Add a new optional loop seam:

- `AgentConfig.turnCheckpoint?`

The sink receives a pure snapshot payload at the boundary above:

- turn number,
- exact transcript/messages for the next request,
- cwd / sandbox root,
- optional provider-owned resume metadata when available,
- structured attempt metadata needed by the caller.

Default-OFF:

- absent sink => byte-identical loop behavior.

Bench wires this sink only when checkpointing is enabled.

### 5. New bench surfaces

Add two surfaces to `quanta-bench`:

```text
quanta-bench run --checkpoint-dir <dir> ...
quanta-bench resume --checkpoint <path-to-turn-dir>
```

Semantics:

- `run --checkpoint-dir` enables periodic turn-boundary checkpoint writes.
- `resume --checkpoint` restores the checkpoint into a fresh temp sandbox and
  continues the same instance from the next live model call.

`resume` must hard-refuse on manifest drift:

- different model/provider,
- different preset / resolved knobs,
- different instance id / corpus identity,
- missing or checksum-mismatched artifacts,
- incompatible schema version.

This is fail-closed. Silent best-effort resume is not acceptable for benchmark
measurement.

### 6. Checkpoint write failure is an explicit infra failure

If checkpointing is enabled and a checkpoint cannot be written atomically, the
attempt fails as infrastructure/runtime failure. We do not continue the run and
pretend resumability exists.

This keeps the promise clear:

- checkpointing OFF => no cost, no guarantees,
- checkpointing ON => resumability is part of the contract.

### 7. Replay is a deferred P2 surface

Full replay is still useful, but it is a different product:

- provider output cassette,
- tool-result cassette,
- no live model/tool calls for replayed segments,
- exact prompt/tool RCA and debugger workflows.

That belongs behind a separate surface, likely a replay LLM/tool adapter over
the existing trajectory.

This ADR does not ship that.

## Implementation shape

### Owner surfaces

- `src/agent/types.ts`
  - add the optional `turnCheckpoint` slot.
- `src/agent/loop.ts`
  - emit boundary snapshots at the defined turn boundary.
- `src/runner/batch/checkpoint/*` (new)
  - bench-owned persistent checkpoint writer/reader/validator.
- `src/apps/bench/eval/driver.ts`
  - wire the sink and restore from `resume`.
- `src/runner/batch/eval/driver.ts`
  - same wiring for the shared path.
- `src/apps/bench/cli.ts`
  - `run --checkpoint-dir` and `resume --checkpoint`.

### Phasing

- **P0**: single-instance local bench resume (`run` + `resume`, one instance,
  one checkpoint directory, full sandbox snapshot).
- **P1**: batch integration (`report.json` / lineage / resumed-attempt metadata).
- **P2**: replay mode (cassette-backed provider/tool adapters).
- **P3**: snapshot dedup / shadow-ODB-backed workspace storage if disk pressure
  warrants it.

## Consequences

- Late-failure iteration cost drops sharply for hard instances: the next run can
  start from turn N+1 rather than turn 1.
- Measurement semantics improve: resumed runs become explicit, lineage-tracked,
  and fail-closed on drift.
- Disk use increases materially because V1 stores full sandbox snapshots.
- Resume is **not** proof of future-output determinism. It is a restore-and-
  continue surface, not a replay engine.
- Checkpoint artifacts contain code and model-visible history; they must live
  under the existing bench run root and obey the same retention / redaction
  posture as observe artifacts.

## Alternatives considered

### 1. Use `observe/*.jsonl` as the resume source

Rejected.

`observe` is a trajectory/audit rail. It is not the canonical next-request
state, and reconstructing the exact model-visible transcript from it is fragile.
Bench resume needs a first-class restore artifact.

### 2. Build full Temporal-style replay now

Rejected for V1.

To get true deterministic replay we would need to record and re-inject:

- model outputs,
- tool results,
- provider continuation state where relevant,
- side-effect ordering,

and run a replay adapter instead of the live provider/tool surfaces. That is
valuable, but it is a debugger product, not the minimum fix for benchmark cost.

### 3. Reuse the current conversation checkpoint + shadow rewind surfaces as-is

Rejected.

Those surfaces are individually useful, but they do not currently give bench
one atomic, persistent, run-scoped restore unit. Bench needs one owner that can
validate and restore:

- transcript,
- sandbox,
- attempt metadata,

together, under one manifest.
