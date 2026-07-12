# ADR-0539 — Bench tracing/observability architecture: layers, SSOT, correlation tuple

Status: Accepted (2026-07-12)
Supersedes the folklore "RFC-0002" reference cited in `src/shared/trajectory.ts` (no such file exists; this ADR is the governing document).

## Context

An adversarial + objective audit (2026-07) of the bench tracing stack found FOUR
parallel trace layers with no single owner, no shared correlation key, and
several consequential actions traced nowhere. Symptoms: the run verdict buried at
the bottom of the viewer; OTEL spans un-joinable to the trajectory; the repo
file-tree build (which can silently drop the gold file via truncation) emitting
no trace; the agent-stream tail lost on box crash.

## The four layers (as-built)

| Layer | Captures | Model | File | Default |
|---|---|---|---|---|
| **TRAJECTORY cassette** | one `RecordedInteraction {id,request,events,metadata}` per LLM `stream()` call — for deterministic REPLAY / fork-from-failure | `RecordedInteraction` (own) | `src/llm/replay/recording-llm.ts`, `src/apps/bench/trajectory.ts` | ON |
| **OBSERVE stream** | the normalized agent-event stream + the scaffold's own evidence (`sandbox / localize / patch_generated / verify / tool_* / recovery / error / session_* / turn_start / llm_*`) | `TrajectoryEvent` via `makeEvent` | `src/runner/batch/observe.ts` (+ `JsonlRecorder`), `src/shared/trajectory.ts` | ON |
| **DEBUG-sink** | keyed slices enriched into `metadata.debug` (only `toolExec` wired) | free `Record` in cassette metadata | `src/apps/bench/trajectory-debug-sink.ts` | OFF (`RECORD=debug`) |
| **OTEL spans** | a 4-span tree (session/turn/sampling/tool) | OTLP span (own) | `src/observability/*`, `src/apps/bench/otel-trace-sink.ts` | OFF (`QUANTA_OTEL_ENDPOINT`) |

## Decision

1. **SSOT = the OBSERVE stream.** It is the only layer that already shares one
   event model (`TrajectoryEvent`/`makeEvent`/`RunContext`) across its two
   producers (`JsonlRecorder` + `BenchObserver`) and applies `redactValue`
   consistently. All NEW scaffold-action tracing MUST be an OBSERVE `kind` with a
   declared `data` contract in `src/shared/trajectory.ts` (`TrajectoryKind` +
   `TRAJECTORY_KINDS` + a `*Data` interface). The trajectory cassette and OTEL
   are DERIVED/adjunct layers, not competing sources of truth.

2. **Correlation tuple (mandatory on every layer): `{runId, instanceId, attempt, turn}`** plus a span id where spans exist.
   - OBSERVE stamps it via `RunContext` (already).
   - TRAJECTORY carries `runId/instanceId/attempt/lane` in `metadata` (already).
   - OTEL now stamps `quanta.run.id` (resource) + `quanta.instance.id` (session span). `quanta.attempt` is supported end-to-end but not yet threaded by the driver (residual gap — same-instance discriminator only).
   - The join key across all layers is therefore `{runId, instanceId}` → the file `<runId>/<instanceId>.<attempt>.jsonl`.

3. **Redaction contract.** OBSERVE + metrics/summary are redacted via the shared
   `redactValue`. The TRAJECTORY cassette is deliberately NOT redacted — its
   match key is the request-hash and redaction would break cross-box replay
   determinism (fork-from-failure). Treat the cassette as a SECRET artifact:
   never share it outside the operator boundary. (Audit F5: this is an accepted
   trade-off, not a bug — do not "fix" it by scrubbing the cassette.)

## Audit fixes landed under this ADR

- **F1** (CRIT) — file-tree build + truncation now emit an OBSERVE `localize`
  event `{treeFileCount, truncated, truncatedChars?, rankedCandidateCount}`
  (`agentless-localize.ts` → `localize-prep.ts` `onLocalize` → `emitLocalize`),
  wired at the driver via `wiring.observer`.
- **F2** (CRIT) — the OBSERVE agent-stream recorder (`jsonl-recorder`) now flushes
  at TURN BOUNDARIES (`turn_start`/`done`/`error`) and on `SIGTERM`/`SIGINT`, so a
  box crash (OOM/exit137/spot-reclaim) no longer loses the last completed turns.
- **F3** (HIGH) — OTEL session span now carries `quanta.instance.id` (join key);
  `quanta.run.id` already on the resource.
- **F7** (MED) — a successful-turn commit failure in the cassette recorder now
  `logger.warn`s + writes a degraded sentinel instead of silently vanishing.
- **Surfacing** — the viewer pins a RUN SUMMARY (verify verdict / patch / sandbox
  / errors) at the top, out of ts order.
- **Honesty** — debug-sink docstring corrected (only `toolExec` wired); the stale
  "observe default-OFF" comment fixed (observe is default-ON).

## Residual gaps (tracked, not yet fixed)

- `quanta.attempt` not threaded onto spans (needs a multi-hop driver param).
- Dead trajectory kinds `patch_applied` / `patch_rejected` are declared but never
  emitted — RESERVED for a future patch-apply tracer; keep or emit, don't leave
  as silent no-ops without this note.
- `onSelection` per-round acceptance observer is declared but bound nowhere —
  wire at the driver or delete.
- Phase-gate blocks (`consultLocalizePhase`) return a synthetic tool_result but
  emit no `decision` event despite the kind being wired — should emit a
  `decision {kind:"gate", ruleId, outcome:"deny"}`.
- DEBUG-sink promised contributors (grader/edit/phase-gate) remain unwired; only
  `toolExec` is live.

## Rule for new observability features

Add to the SSOT (OBSERVE) as a typed `kind`, stamp the correlation tuple, and —
if the data is a low-frequency HIGH-VALUE decision (verdict, gate, knob posture) —
also surface it in the viewer's pinned summary, not just the ts-sorted stream.
Do NOT bolt a new event onto whichever layer is convenient.
