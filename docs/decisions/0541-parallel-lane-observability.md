# ADR-0541 — Parallel candidate-lane observability: ambient lane id + recording-lane LLMPort decorator + progress bus

Status: Accepted (2026-07-16)
Slice: `src/shared/lane-context.ts` (NEW) · `src/llm/with-recording-lane.ts` (NEW) · `src/runner/batch/eval/lane-progress.ts` (NEW) · `src/apps/bench/lane-progress-renderer.ts` (NEW)
Feature: `parallel-lane-observability` (feature-catalog §8-observability)
Landed: `e69c86ed3` (2026-07-08, ambient lane id + per-lane debug-sink buffers) · `2cc5c7400` (2026-07-08, recording-lane on the trajectory tape) · `8393fe450` (2026-07-08, live CLI view of parallel candidate lanes)
Related: ADR-0539 (bench tracing/observability architecture — the TRAJECTORY cassette + OBSERVE stream this primitive attributes) · ADR-0084 (speculative branch search — one of the concurrent-lane producers)

## Context

The bench runs **N candidate lanes CONCURRENTLY** — repair-breadth candidates, verify-select candidates, location fanout, branch-search proposals. These lanes share process-global observability sinks:

- **one recording port / one cassette tape** (the TRAJECTORY layer of ADR-0539): every candidate's `stream()` calls append `RecordedInteraction`s to the same store, so on the flat tape the interleaved turns of `repair-breadth#0` and `repair-breadth#1` are indistinguishable.
- **the per-turn debug-sink** (`trajectory-debug-sink.ts`): subsystems deep in the agent run — the tool executor, the recorder's per-turn debug drain — `contribute`/`append` into a buffer and later `drain` it. Under parallelism, without a lane key, one lane's `drain` would sweep up another lane's contributions (misattribution).
- **the human watching the run**: a single interleaved stderr log gives no sense of which of the N in-flight candidates is on which turn / tool.

The naive fix — thread a `lane` parameter from each fork site down through the agent loop, the tool executor, the recorder, and every renderer — would touch dozens of call sites on the hot path and couple the fork sites to a concrete renderer. We wanted lane attribution to be **ambient** (no parameter threading) and the display to be **decoupled** (fork sites emit; a surface subscribes), while staying **byte-identical when off** (a serial run, or a non-interactive/library host, must produce identical bytes and an identical cassette).

## Decision

Three orthogonal primitives, each SOLID-composed at the fork sites, each inert when unused.

### 1. Ambient lane id via `AsyncLocalStorage` — `src/shared/lane-context.ts`

`laneContext = new AsyncLocalStorage<string>()`. A fork site establishes the lane once with `laneContext.run(lane, fn)`; everything transitively invoked by `fn` — across `await` points — reads it via `currentLane()` (`laneContext.getStore()`), returning `undefined` on a serial path with no established lane.

- **Fork site**: `src/runner/batch/eval/repair-breadth.ts:303` wraps the candidate run in `laneContext.run(lane, () => …)`.
- **Consumer**: `src/apps/bench/trajectory-debug-sink.ts:113` derives its buffer key as `currentLane() ?? ""`, so each lane's `contribute`/`append` and its `drain` see the **same** lane string, and serial runs share one default `""` bucket. This is the mechanism that made per-lane debug buffering correct under parallelism (commit `e69c86ed3`: "per-lane debug-sink buffers — parallel toolExec no longer misattributed").

Why `AsyncLocalStorage`: it propagates through async continuations without a parameter, so the deep subsystems learn their lane without any change to their signatures.

### 2. Recording-lane `LLMPort` decorator — `src/llm/with-recording-lane.ts`

`laneLabeledPort(inner: LLMPort, lane: string): LLMPort` wraps any port so each `stream()` call carries a per-lane RECORDING LANE label, letting a debugger group the one interleaved tape by lane.

- **Transparent delegation**: the decorator copies the inner port's descriptive surface **verbatim** — `model`, `contextWindowKey`, `provider`, `surfaceId`, `transportId`, `authMode` are re-exported only when the inner port defines them (`inner.x !== undefined ? {x} : {}`), so the wrapper is observationally identical to the inner port except for the injected field. It depends only on the `LLMPort` interface (DIP), so it composes over any adapter or further decorator (temperature, recorder) without knowing the concrete type.
- **Single injected field, stripped before hashing**: `stream()` sets `input.recordingLane = lane` on the outgoing `StreamInput` (`src/llm/types.ts:434`). The recorder (`src/llm/replay/recording-llm.ts`) treats `recordingLane` as an **ephemeral correlation label, not request content**: `stripEphemeralRequest` (`recording-llm.ts:205`) destructures it out of the *stored* request (alongside `signal`/`onChunk`/…), so it is **REPLAY-NEUTRAL — never hashed, never on the persisted-request wire**, and instead lifts it into `metadata.lane` (`recording-llm.ts:195,290`). Absent ⇒ byte-identical: no `recordingLane` on the wire, no `lane` in metadata.
- **Caller override is respected**: `input.recordingLane !== undefined ? input : {…input, recordingLane: lane}` — an already-set (outer, finer) lane wins over an inner wrap, so nested composition does not clobber the more specific label.
- **Wired at every concurrent producer**: `repair-breadth.ts:298` (`laneLabeledPort(deps.resolveLaneLlm(index), lane)`), `driver/config-build.ts:563` (`"repair"`), `driver/attempt-context.ts:87` (`"localize"`), `agent/branch-search/propose.ts:107` (`branch-search#${i}`). Landed in commit `2cc5c7400` ("record parallel candidate lanes on the trajectory tape").

### 3. Progress bus + CLI renderer (D-lite) — `src/runner/batch/eval/lane-progress.ts` + `src/apps/bench/lane-progress-renderer.ts`

A surface-agnostic event bus decouples "what a lane is doing right now" (emitted at the fork sites) from "how it is shown".

- **Bus** (`lane-progress.ts`): a process-scoped `LaneProgressBus` singleton (`laneProgress`) with `subscribe()`/`emit()`. `LaneProgressEvent = {kind: "start"|"turn"|"tool"|"done", lane, turn?, tool?, ok?, patchBytes?}` — the `lane` is the **same string** as the recording lane, so display and tape correlate. **`emit()` is a NO-OP with zero subscribers** (`if (this.listeners.size === 0) return`), so the fork-site emit calls stay byte-identical for non-interactive / library hosts. A throwing listener is caught so a renderer bug never sinks a candidate. Placed in `runner/` (not `apps/`) so the fork sites emit without importing an app.
- **`laneProgressPort`** (`lane-progress.ts:75`): a second SOLID decorator that emits a `turn` per `stream()` and a `tool` per `tool_use_start`, passing stream events through **unchanged** (LIVE display only). It composes over `laneLabeledPort` at the fork site (`repair-breadth.ts:298`: `laneProgressPort(laneLabeledPort(…), lane)`); the recording lane and the progress lane are the same string. Inert when the bus has no subscriber.
- **Renderer** (`lane-progress-renderer.ts`): the CLI subscriber, gated by `QUANTA_BENCH_LANE_PROGRESS` (**ON by default in a bench TTY**; `0`/`off`/`false` ⇒ never subscribes, bus stays inert, byte-identical). Two modes chosen by the terminal: a **TTY** bottom-anchored, live-redrawing multi-line panel (one line per active lane) coordinated with all other stderr through the `TerminalIo` seam (each foreign log line erases the panel, writes, then redraws below — the ink/ora bottom-block pattern); a **non-TTY** (CI, nohup, supervised EC2) mode emitting plain, greppable, ANSI-free prefixed log lines that survive redirection. Display-only: stderr, never stdout, never the report. `stop()` unsubscribes, erases the panel, and restores the original terminal ports. Wired at the bench TTY entry `src/apps/bench/run-main.ts:472`. Landed in commit `8393fe450` ("live CLI view of parallel candidate lanes").

## Consequences

- **No parameter threading**: lane attribution reaches deep subsystems (debug-sink, recorder) ambiently via `AsyncLocalStorage` and via a single stripped request field — the agent loop, tool executor, and renderers keep their signatures.
- **Replay determinism preserved**: `recordingLane` is stripped before the request is hashed/stored, so labeling a lane cannot change replay behavior or the request hash; it only enriches `metadata.lane`. Verified by the recorder's strip path (`recording-llm.ts:205–217`).
- **Byte-identical when off**: serial runs (no `laneContext.run`) get an `undefined` lane / `""` bucket; unsubscribed hosts get no-op `emit`; the gate off ⇒ the renderer never subscribes. No fork-site call changes bytes when the feature is dormant.
- **Fault isolation**: a throwing progress listener is swallowed; a renderer bug cannot break a candidate or its siblings.
- **Surface-agnostic seam**: the progress bus is a subscribe point a future web/trajectory-viewer surface can consume without touching the fork sites (`web: na` today — no browser affordance, by design).
- **Two decorators, one lane string**: `laneLabeledPort` (recording, replay-neutral) and `laneProgressPort` (live display) are independent — one can ship without the other — but they share the lane correlation id, so tape and panel line up.

## Evidence

- Code: `src/shared/lane-context.ts`, `src/llm/with-recording-lane.ts`, `src/runner/batch/eval/lane-progress.ts`, `src/apps/bench/lane-progress-renderer.ts`; strip path `src/llm/replay/recording-llm.ts` (`stripEphemeralRequest`, `metadata.lane`); wiring `src/runner/batch/eval/repair-breadth.ts`, `src/runner/batch/eval/driver/{config-build,attempt-context}.ts`, `src/agent/branch-search/propose.ts`, `src/apps/bench/run-main.ts`, `src/apps/bench/trajectory-debug-sink.ts`.
- Tests: `tests/unit/lane-progress-hellgate.test.ts` — pins the bus (no-op-without-subscriber / subscribe / throwing-listener-isolation), the port (turn-per-`stream()`, tool-per-`tool_use_start`, pass-through red-on-injection, turn counter), and the renderer (gate-off inert, non-TTY log lines, TTY coordinated panel, `stop()` port restore).
