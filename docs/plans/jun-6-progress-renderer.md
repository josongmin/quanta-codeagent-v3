# RFC: C2 last-mile — ProgressSink host wiring (the missing bridge)

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADR: 0481 (progress-sink-wire) — completes C2 (the tool + event + renderers are ADR-tracked under jun-4-communicate-update).
> Predecessor: `docs/plans/jun-4-communicate-update.md` (the C2 tool + sink TYPE + event + adapter renderers) — **LANDED**.

---

## 1. 요약 (Summary)

C2 (`communicate_update`) absorbed Cursor's structured mid-turn progress channel. The
predecessor RFC's P0 is **fully landed**: the tool (`src/tool/communicate-update.ts:87`), the
duck-typed `ProgressSink` / `ProgressUpdateMirror` type on `ToolContext`
(`src/tool/types.ts:319,341`), the `progress_update` `AgentEvent` variant
(`src/stream/types.ts:359-365`), and — crucially — **both surface renderers already exist**:
`stdout.ts` has a `case "progress_update"` that paints a dim step line + a `✓` subtitle
(`src/stream/adapters/stdout.ts:206-214,347-351`), and `jsonl-recorder.ts` records the full
triple. The `AgentConfig.progressSink` slot (`src/agent/types.ts:1162`) and the dispatch seam
that surfaces it onto `ctx.progressSink` (`src/agent/dispatch.ts:690`) are also done. The
knob exists (`runtimeConfig().progressUpdate` ← `QUANTA_PROGRESS_UPDATE`,
`src/shared/runtime-config.ts:334,657`) and the gated tool registers
(`src/host/runtime/agent-arg-builder.ts:616`).

**The GAP (last-mile):** *nobody constructs a `ProgressSink` and assigns it to
`AgentConfig.progressSink`.* `grep -rn "progressSink:" src --include="*.ts"` outside the
dispatch-seam read shows **zero host writes**. So the chain is severed exactly one link from
the end: the model calls `communicate_update` → the tool reads `ctx.progressSink` → **it is
always `undefined`** → `emitProgress` returns early (`communicate-update.ts:123`) → no
`progress_update` event is ever emitted → the (already-present) `stdout.ts` renderer never
receives anything. The renderer is dead code waiting for a producer.

This RFC designs the **one missing bridge**: a `createProgressStreamSink(stream)` adapter
that maps a `ProgressUpdateMirror` (snake_case tool payload) onto a `progress_update`
`AgentEvent` (camelCase) on `cfg.stream`, plus a `maybeWireProgressSink(cfg, env)` that
assigns it to `cfg.progressSink` when the knob is on. This is a **byte-for-byte clone of the
already-landed `maybeWireVcsEventSink` / `createPassiveVcsStreamSink` pattern**
(`agent-config-assembler.ts:358,473-503`) — the exact same "duck-typed mirror → host adapter →
existing AgentEvent stream" shape the predecessor RFC §4.2 specified. Default-OFF: absent
knob ⇒ `cfg.progressSink` stays unset ⇒ the tool's emit is a no-op ⇒ byte-identical.

---

## 2. 경쟁사 레퍼런스 (Competitor reference — verified)

Already extracted in the predecessor RFC (`docs/plans/jun-4-communicate-update.md` §2 — the
Cursor `agent.v1.CommunicateUpdateArgs` proto + zod describe-strings). The load-bearing cue
for THIS RFC is the surfacing, not the tool:

> Cursor surfaces `current_step` as a **live, repeatedly-updated status line** (anchored at
> `message_index`), `completed_subtitle` as the **agent subtitle in the UI**, and
> `final_summary` as the **executive-summary message** — a read-only, no-side-effect channel
> whose only effect is appending a structured message + updating turn state.
> (predecessor RFC §2.4)

quanta's stdout renderer already does the CLI analogue (dim step line + `✓` subtitle); the
`final_summary` lives in the jsonl trajectory (stdout is a monitor, not a log —
`stdout.ts:211-213`). So the rendering decisions are made and shipped. What is missing is
purely the **producer wiring** that lets any event reach those renderers.

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 LANDED — the tool, the sink TYPE, the event, AND the renderers

- Tool — `createCommunicateUpdateTool` (`src/tool/communicate-update.ts:87`); read-only,
  concurrency-safe, `pre-approval-ok` HITL tier (`:100-109`); `emitProgress(ctx.progressSink,
  input)` (`:112,122-139`) — early-returns when the sink is `undefined` (`:123`).
- Sink TYPE — `ProgressSink { emit(u: ProgressUpdateMirror): void }`
  (`src/tool/types.ts:341`); `progressSink?: ProgressSink` on `ToolContext` (`:319`);
  `ProgressUpdateMirror { current_step; final_summary?; completed_subtitle? }`
  (the snake_case mirror).
- Event — `progress_update` variant (`src/stream/types.ts:359-365`): `{ type, currentStep,
  finalSummary?, completedSubtitle?, turn? }` (camelCase, RENDER-ONLY, `:347-353`).
- **CLI renderer — ALREADY PRESENT.** `stdout.ts:206-214` `case "progress_update"` →
  `renderProgressUpdate(event)` (`:347-351`): dim `— step: {currentStep} —` line, and when
  `completedSubtitle` is non-empty a `${GREEN}✓ {completedSubtitle}` line. All model text
  routes through `redactStr` + `oneLine` (defence-in-depth, `:348-350`). The `never`
  exhaustiveness pin (`stdout.ts:225-230`) already compiles WITH this case.
- jsonl-recorder — records the full triple (predecessor RFC §4.4; `assertNever` satisfied).
- `AgentConfig.progressSink?` slot (`src/agent/types.ts:1146-1162`) + dispatch surfacing
  (`src/agent/dispatch.ts:683-690`: `...(config.progressSink !== undefined ? { progressSink:
  config.progressSink } : {})`).
- Knob + gated registration — `runtimeConfig().progressUpdate` (`runtime-config.ts:334,657`);
  `...(cfg.progressUpdate ? { progressUpdate: true } : {})` (`agent-arg-builder.ts:616`).

### 3.2 The GAP — **no host constructs / assigns a `ProgressSink`**

- `grep -rn "progressSink:" src --include="*.ts"` → only `dispatch.ts:690` (a READ of
  `config.progressSink`) and `agent/types.ts:1162` (the slot decl). **No WRITE anywhere.**
- `grep -rn "createProgressStreamSink\|maybeWireProgressSink\|new.*ProgressSink\|progressSink =" src`
  → **0 hits.** Nothing builds a sink or sets `cfg.progressSink`.
- Therefore: in EVERY run, `ctx.progressSink === undefined`, `emitProgress` returns at
  `communicate-update.ts:123`, no `progress_update` event is emitted, and `stdout.ts:214`'s
  `renderProgressUpdate` is **never reached**. The renderer is correct but starved.
- `runtime-config.ts:331` comment even FLAGS the missing step: *"…wires
  `AgentConfig.progressSink`"* — describing wiring that does not yet exist.

### 3.3 The precedent that makes this a 1-function clone — `vcsEventSink`

The IDENTICAL pattern is already shipped for H6 passive-VCS:
- `createPassiveVcsStreamSink(stream)` (`agent-config-assembler.ts:473-487`): a
  `PassiveVcsEventSink` whose `emit(VcsEvent)` maps onto an `AgentEvent` and calls
  `stream.emit(ev)` inside a try/catch (NO-THROW boundary, `:480-485`).
- `maybeWireVcsEventSink(cfg, env)` (`:499-503`): `if (env.QUANTA_PASSIVE_VCS !== "1") return;
  if (cfg.vcsEventSink !== undefined) return; cfg.vcsEventSink =
  createPassiveVcsStreamSink(cfg.stream)`.
- Registered in `wireOptionalCapabilitySlots` (`:348-360`, line 358).

`progressSink` needs the structurally-identical `createProgressStreamSink` +
`maybeWireProgressSink` + one line in `wireOptionalCapabilitySlots`.

### 3.4 Verdict — **NOT superseded; the renderer EXISTS.** Honest correction to the brief.

The task framed this as "no CLI renderer draws them." Grep shows the CLI renderer
(`renderProgressUpdate`, `stdout.ts:347`) **is already implemented and wired into the stdout
adapter's switch**. The TRUE missing piece is the upstream **producer**: the host
`ProgressSink` that emits the event in the first place. Without it the renderer is reachable
only if some other path emits `progress_update` — and none does. So this RFC's deliverable is
the sink-wire, not a renderer. (If a richer renderer is wanted later — e.g. a coalescing live
status pill vs the current one-shot line — that is an additive P2, not the gap.)

---

## 4. 설계 (Design)

### 4.1 The bridge — `createProgressStreamSink(stream)`

A `ProgressSink` whose `emit` maps the snake_case mirror to the camelCase `progress_update`
AgentEvent and forwards it onto the existing stream — the exact mirror of
`createPassiveVcsStreamSink`:

```ts
export const createProgressStreamSink = (stream: StreamPort): ProgressSink => ({
  emit(u: ProgressUpdateMirror): void {
    const ev: AgentEvent = {
      type: "progress_update",
      currentStep: u.current_step,                                   // snake → camel
      ...(u.final_summary !== undefined ? { finalSummary: u.final_summary } : {}),
      ...(u.completed_subtitle !== undefined ? { completedSubtitle: u.completed_subtitle } : {}),
      // `turn?` is OMITTED here (the assembler has no turn index); a future
      // turn-aware caller can set it for UI coalescing (predecessor RFC §4.3).
    }
    try {
      stream.emit(ev)
    } catch {
      // NO-THROW boundary (identical to createPassiveVcsStreamSink:480-485):
      // a dead stream must never poison the turn that called communicate_update.
    }
  },
})
```

- **Snake→camel at the boundary** is exactly the proto↔zod split the predecessor RFC §4.3
  documented (the tool's `current_step` is the model-facing contract; `currentStep` is the
  wire-internal AgentEvent). This adapter IS that boundary.
- **`exactOptionalPropertyTypes`-safe** conditional spread so the emitted event carries no
  `undefined` keys (matches the tool's own `emitProgress` discipline,
  `communicate-update.ts:131-134`).
- **NO-THROW** by contract (the tool additionally try/catches at `communicate-update.ts:128`,
  so even a throwing sink cannot reject the tool's async iterator — defence in depth).

### 4.2 The wire — `maybeWireProgressSink(cfg, env)`

```ts
const maybeWireProgressSink = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (env.QUANTA_PROGRESS_UPDATE !== "1") return   // default-OFF, same gate as the tool
  if (cfg.progressSink !== undefined) return        // caller-override-safe (ADR-0332)
  cfg.progressSink = createProgressStreamSink(cfg.stream)
}
```

Added to `wireOptionalCapabilitySlots` (`agent-config-assembler.ts:348-360`) next to
`maybeWireVcsEventSink`. The sink emits onto `cfg.stream` — the **SAME** stream the loop's
other AgentEvents ride, so it reaches `StdoutStream` (`stdout.ts:39`), `jsonl-recorder`,
`sse`, and `tee` with no per-adapter change (the renderers already handle the variant; sse/tee
forward generically — predecessor RFC §4.4).

### 4.3 Gate alignment — tool ON ⇒ sink ON (one knob)

The tool is gated by `QUANTA_PROGRESS_UPDATE` (`agent-arg-builder.ts:616`); the sink uses the
SAME env in `maybeWireProgressSink`. So enabling the knob both (a) registers the tool and (b)
wires the sink — the chain is complete in one flip. With the knob OFF: tool absent + sink
unset ⇒ byte-identical (two independent default-OFF guards reinforce).

> Decision: keep the tool GATED (the predecessor RFC §5.1 floated BASE-vs-gated; the landed
> code chose gated via `QUANTA_PROGRESS_UPDATE`). This RFC does NOT change that — it only
> completes the producer side of whatever gate is in force. If the tool is later promoted to
> BASE, `maybeWireProgressSink` should drop its env check and wire unconditionally (the sink
> is harmless: absent renderers ignore the variant, `NullStream` swallows it).

### 4.4 Closed-port DI / no globals

`createProgressStreamSink` takes the `stream` as an argument (no global), touches no
`Date.now` / `Math.random` / `process.env` (the assembler reads env via the injected
`AssemblerEnv`, `agent-config-assembler.ts` `env:` param — same as every other `maybeWire*`).
The `@/tool` slice stays a leaf: the sink ADAPTER lives in the host
(`agent-config-assembler.ts`), and `@/tool` only declares the structural `ProgressSink`
mirror — identical fence to `vcsEventSink` (predecessor RFC §8.5).

### 4.5 (Optional, P2) richer CLI renderer — coalescing live pill

The current `renderProgressUpdate` (`stdout.ts:347`) prints a fresh dim line per event. Cursor
coalesces repeated `current_step` updates at a stable `message_index` (predecessor RFC §2.4).
If a less-noisy CLI UX is wanted, a P2 can replace the per-event line with an **in-place live
status line** (carriage-return overwrite, like the spinner/token-counter at `stdout.ts:146-150`)
keyed by `turn?`, repainting on each `current_step` and committing a terminal `✓ subtitle`
line at turn end. This is purely a `stdout.ts` rendering change behind the same event — NOT
required for the gap, and out of scope for P0.

---

## 5. 통합 (Integration)

### 5.1 Knob — reuse `QUANTA_PROGRESS_UPDATE` (no new env)

No new knob. `maybeWireProgressSink` reads the SAME `QUANTA_PROGRESS_UPDATE` the tool gate
uses. Default-OFF on every surface (bench/eval + web-daemon share this assembler — a default-ON
would change their event stream + SWE-bench reproducibility, the exact reasoning
`maybeWireVcsEventSink` cites at `agent-config-assembler.ts:492-494`).

### 5.2 No new tool / no new event / no manifest change

The tool, the `progress_update` variant, and the two renderers all exist. No
`BASE_TOOL_NAMES` / `GATED_TOOLS` edit, no new AgentEvent variant, no exhaustiveness pin
churn (the `never` at `stdout.ts:225` + the recorder `assertNever` already pass). **Zero
drift-guard impact** — this RFC adds only a host adapter + a wire helper.

### 5.3 fc

Update the existing `communicate-update` fc node: flip its `maturity`/`status` from "seam"
(tool present, sink unwired) to "wired", and add the assembler sink-wire to `evidence.code`.
This is the `partial-wiring` ledger correction — C2 was a "hard part done, last-mile unwired"
slice, exactly the cheap-win class.

### 5.4 Slice / fence

- Touch `src/host/runtime/agent-config-assembler.ts` only: add `createProgressStreamSink`
  (export, for the hellgate to assert the mapping directly, mirroring
  `createPassiveVcsStreamSink`'s export at `:473`) + `maybeWireProgressSink` + one call in
  `wireOptionalCapabilitySlots`.
- Import `ProgressSink` / `ProgressUpdateMirror` from `@/tool` and `AgentEvent` /
  `progress_update` from `@/stream` (the assembler already imports both, e.g.
  `agent-config-assembler.ts:75` for VcsEvent + the `AgentEvent` used in
  `createPassiveVcsStreamSink:475`).

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (`tests/.../progress-sink-wire.hellgate.test.ts`)

- **mapping correctness:** `createProgressStreamSink(capturingStream).emit({ current_step:"x"
  })` → the captured AgentEvent is `{ type:"progress_update", currentStep:"x" }` with NO
  `finalSummary`/`completedSubtitle` keys (exactOptional). With all three fields → all three
  camelCase keys present, snake→camel exact.
- **NO-THROW:** a stream whose `emit` throws → `createProgressStreamSink(...).emit(...)` does
  NOT throw (the try/catch boundary, §4.1).
- **wire gate:** `maybeWireProgressSink(cfg, { QUANTA_PROGRESS_UPDATE:"1" })` sets
  `cfg.progressSink`; with the env unset it leaves `cfg.progressSink` undefined (default-OFF).
- **caller-override-safe:** a pre-set `cfg.progressSink` is preserved (ADR-0332), not clobbered.
- **default-OFF byte-identity:** with the knob off, the full dispatch path is unchanged — the
  tool's `emitProgress` early-returns and the stream sees no `progress_update`.

### 6.2 e2e — tool → sink → stream → renderer (end-to-end, the gap closed)

- Wire `cfg.progressSink = createProgressStreamSink(capturingStream)`; drive a scripted model
  that calls `communicate_update` with `{current_step}` then `{current_step, final_summary,
  completed_subtitle}`; assert the capturing stream observed **two** `progress_update`
  AgentEvents in order with the right camelCase fields (this is the link that is currently
  DEAD — the e2e proves the producer→renderer chain is whole).
- Render assertion: feed those two events through the REAL `StdoutStream` (over a fake
  writer) and assert `renderProgressUpdate` output appears (`— step: …` + `✓ …`) — proving the
  already-present renderer is now actually reached.
- jsonl assertion: the recorder writes both `progress_update` rows (durable intent) and NO
  `output_progress` (the orthogonality the predecessor RFC §4.5 specified).

---

## 7. 단계 (Phasing)

- **P0 — the bridge (the gap).** `createProgressStreamSink` + `maybeWireProgressSink` + the
  `wireOptionalCapabilitySlots` line. Hellgate (§6.1) + e2e (§6.2). fc maturity "seam"→"wired".
  This single helper closes C2 end-to-end.
- **P1 — prompt guidance (if not already landed).** Confirm the model-facing "when to call
  communicate_update" guidance exists (predecessor RFC §7 P2); add it if missing so the now-live
  channel is actually exercised.
- **P2 (optional) — coalescing live CLI pill** (§4.5) + the future Tauri status-pill/subtitle
  surface (predecessor RFC §4.4) — additive rendering, same event.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **Spam flooding the stream/trajectory.** A model calling `communicate_update` excessively
  emits many `progress_update` events. Mitigation: the tool's per-field byte caps
  (`communicate-update.ts:37-39`) bound each event; coalescing is a SURFACE concern (the P2
  live-pill merges repeated `current_step`), and a future per-turn drop-identical guard can
  live in `createProgressStreamSink` (compare against the last emitted `current_step`) without
  touching the tool or event — out of scope for P0.
- **Double-reporting (prose + tool).** Unchanged from the predecessor RFC §8.4 — additive, the
  describe-strings guide WHEN to use each. This RFC does not alter that.
- **Slice-fence regression.** The adapter lives in the host, `@/tool` keeps only the structural
  `ProgressSink` mirror — identical to `vcsEventSink`. No `@/tool` → `@/stream` import.
- **Alternative — emit `progress_update` directly from the tool.** Rejected (predecessor RFC
  §8.5): it would force `@/tool` to import `@/stream`, breaking the biome-enforced fence. The
  host sink is the only sanctioned path.
- **Alternative — leave C2 as a seam (no wire).** Rejected: the tool, event, AND renderers are
  all built; leaving the one-function producer unwired means the entire C2 slice is inert (the
  model can call the tool but nothing ever surfaces) — the worst ROI shape (all cost, no
  effect). The cheap last-mile wire is the whole point.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (this RFC, when implemented) — all in ONE host file**
- `src/host/runtime/agent-config-assembler.ts` — `createProgressStreamSink(stream)` (exported,
  mirror of `createPassiveVcsStreamSink:473`) + `maybeWireProgressSink(cfg, env)` (mirror of
  `maybeWireVcsEventSink:499`) + one call in `wireOptionalCapabilitySlots` (`:348-360`).
- `tests/.../progress-sink-wire.hellgate.test.ts` + the tool→sink→stream→renderer e2e.
- `docs/decisions/0481-progress-sink-wire.md`.

**Touched**
- fc `communicate-update` node — maturity "seam"→"wired" + sink-wire evidence.

**Audited ground truth (cited, NOT modified)**
- `src/tool/communicate-update.ts:87,112,122-139` — the tool + `emitProgress` (early-returns
  on absent sink, `:123`).
- `src/tool/types.ts:319,341` — `ToolContext.progressSink` + `ProgressSink` / mirror.
- `src/stream/types.ts:347-365` — the `progress_update` AgentEvent variant.
- `src/stream/adapters/stdout.ts:206-214,225-230,347-351` — **the already-present CLI
  renderer** (`renderProgressUpdate`) + the satisfied `never` pin.
- `src/agent/types.ts:1146-1162` + `src/agent/dispatch.ts:683-690` — the slot + dispatch surfacing.
- `src/shared/runtime-config.ts:331-334,657` — the `progressUpdate` knob (comment already
  names the missing "wires AgentConfig.progressSink" step).
- `src/host/runtime/agent-arg-builder.ts:612-616` — the gated tool registration.
- `src/host/runtime/agent-config-assembler.ts:348-360,473-503` — **the `vcsEventSink` precedent
  this RFC clones.**
