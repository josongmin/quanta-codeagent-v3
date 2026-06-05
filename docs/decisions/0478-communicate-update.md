# ADR-0478: `communicate_update` — structured mid-turn progress channel (Cursor `agent.v1.CommunicateUpdateArgs` absorption)

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0010 (observability trajectory — the `AgentEvent` → `TrajectoryEvent` jsonl mapping this ADR extends with one new variant)
  - ADR-0048 (`response.in_progress` heartbeat — the sibling RENDER-ONLY event; same NullStream-swallow / default-OFF posture, but provider-sourced rather than tool-sourced)
  - ADR-0075 (pre-compact + `context_compacted` — the `recovery`-family jsonl mapping pattern this event reuses verbatim, avoiding a new `TrajectoryKind`)
  - ADR-0097 (`request_user_input` port — the BLOCKING tool this one is deliberately the inverse of: non-blocking, no decision channel)
  - ADR-0269 (decision-emit phase 3 — the `redactStr` defence-in-depth render pattern + `reason`-discriminated recovery line this event mirrors)
  - ADR-0464 (gated `DefaultToolPorts` slot — the same composition-root knob→port→tool-registration discipline)
- **참조**:
  - `src/tool/communicate-update.ts` — `createCommunicateUpdateTool()` factory + `communicateUpdateInputSchema` (zod) + `CommunicateUpdateInput`; the per-field DoS caps `MAX_CURRENT_STEP=200` / `MAX_FINAL_SUMMARY=4_000` / `MAX_COMPLETED_SUBTITLE=80`; `isReadOnly` / `isConcurrencySafe` / `hitlTier` overrides; the NO-THROW `emitProgress` boundary.
  - `src/tool/types.ts` — `ProgressUpdateMirror` (snake_case slice-leaf shape) + `ProgressSink` (duck-typed NO-THROW sink) + `ToolContext.progressSink?`.
  - `src/tool/index.ts` — `DefaultToolPorts.progressUpdate?: boolean` + the `ports.progressUpdate === true` registration arm in `buildDefaultTools`; barrel re-export of `ProgressSink` / `ProgressUpdateMirror`.
  - `src/stream/types.ts` — the new `progress_update` `AgentEvent` union member `{ currentStep; finalSummary?; completedSubtitle?; turn? }` (camelCase wire-internal).
  - `src/stream/adapters/stdout.ts` — `case "progress_update"` + `renderProgressUpdate(event)` (dim step line + `✓` subtitle, both `redactStr`-scrubbed).
  - `src/stream/adapters/jsonl-recorder.ts` — `KIND_MAP.progress_update = "recovery"` + the `case "progress_update"` arm in `dataOf` (`reason:"progress_update"`); `RecordedEventType` exhaustiveness; the `assertNever(e, "AgentEvent")` default pin.
  - `src/agent/types.ts` — `AgentConfig.progressSink?` (config-side mirror).
  - `src/agent/dispatch.ts` — the dispatch seam that surfaces `config.progressSink` onto `ToolContext.progressSink` (conditional spread).
  - `src/host/runtime/agent-arg-builder.ts` — `buildGatedToolPorts` `…(cfg.progressUpdate ? { progressUpdate: true } : {})` (composition-root gate).
  - `src/shared/runtime-config.ts` — `progressUpdate: env["QUANTA_PROGRESS_UPDATE"] === "1"` knob projection.
  - Tests: `tests/unit/communicate-update-hellgate.test.ts` (tool contract + DoS caps + render-only + default-OFF), `tests/unit/communicate-update-e2e-hellgate.test.ts` (host adapter → stream → jsonl), `tests/unit/composition-root-gated-port-activation-r3-hellgate.test.ts` (real `buildBaseFromArgs` gated activation).
  - Feature catalog: `tools/feature-catalog/features/02-tool-system/c2-communicate-update.yaml`.

## 맥락

The agent already had three textual progress channels, but each is the WRONG shape for "what high-level step am I on, and what is the one-line headline of what I just finished":

- `assistant_text` — free-form narration prose. Unstructured; a surface cannot extract a status pill or an agent subtitle from it without re-parsing.
- `output_progress` (the live `· N tokens` counter) — a transient, high-frequency token tick the recorder deliberately SKIPS (`jsonl-recorder.ts` early-returns on it). It carries throughput, not intent, and is never durable.
- `tool_progress` — free text KEYED by a tool-call `id`. It is tied to one tool invocation; it cannot express a turn-level "current step" that spans many tools, nor a set-once terminal summary.

Cursor 3.5.33 ships `agent.v1.CommunicateUpdateArgs`: a typed triple the model emits MID-TURN — `current_step` (the live step line), and once at turn-end `final_summary` + `completed_subtitle` (the agent's UI subtitle). It is RENDER-ONLY: it never ends the turn and carries no loop-control authority. quanta had no equivalent: the model could not surface a typed, surface-renderable, durable progress signal distinct from prose narration.

The hard constraint is slice isolation (RFC §3.1 / §8.5): `@/tool` is a leaf and must never import `@/stream` or `@/agent`. So a tool cannot emit an `AgentEvent` directly — it would have to reach into the stream slice. The existing `vcsEventSink` / `toolDiff` precedent shows the discipline: a duck-typed mirror on `ToolContext` that the composition root adapts onto the real stream.

## 결정

A read-only, zero-blast-radius tool whose ONLY effect is forwarding one typed mirror to a host-wired sink, plus a new RENDER-ONLY `AgentEvent` variant the composition root adapts onto.

### The tool (`createCommunicateUpdateTool`)

Built via a factory so it composes with the registry like the other gated tools. The zod `schema` is the model-facing contract (snake_case): required `current_step` (`min(1).max(200)`), optional `final_summary` (`max(4_000)`) and `completed_subtitle` (`max(80)`). The caps mirror `update-working-state.ts`'s DoS discipline — `current_step` rides every UI status tick, so a single call must not balloon the event stream / jsonl recorder. The cap message embeds the field name so a rejection is greppable.

Three explicit capability overrides, each load-bearing:

- `isReadOnly: () => true` — no FS / shell / git / session-state mutation, so it is unconditionally allowed in plan posture and never routes through the mutating-tool dispatch guard.
- `isConcurrencySafe: () => true` — fire-and-continue; it blocks on no host decision (the inverse of `request_user_input`, ADR-0097), so overlapping calls are safe.
- `hitlTier: () => "pre-approval-ok"` — WHY it must be EXPLICIT: without it the fail-closed `inferToolTier` fallback could classify a non-mutating call as `always-confirm`, firing `onConfirm` on EVERY progress report — a deadlock in HITL-enabled sessions (same reasoning as `update_working_state`'s explicit tier).

`execute` calls `emitProgress(ctx.progressSink, input)` and yields exactly ONE `{ type: "result", result: { ok: true, output: "progress reported" } }` — no control / loop events. `emitProgress` is a NO-THROW boundary: absent sink ⇒ early `return` (no-op); a present sink is wrapped in `try/catch` so a misbehaving host adapter that throws can never reject the tool's async iterator — best-effort observability degrades to a silent `ok:true`, never a hung turn. The optional terminal fields are CONDITIONALLY spread so the emitted mirror is byte-exact under `exactOptionalPropertyTypes` (no `undefined` keys).

### The slice fence (RFC §8.5)

`ProgressUpdateMirror` (snake_case) + `ProgressSink` (NO-THROW `emit`) live in `@/tool/types.ts` and are surfaced on `ToolContext.progressSink?`. `@/tool` imports nothing from `@/stream` / `@/agent` — identical discipline to `VcsEventSink` / `ToolDiffSink`. The config-side `AgentConfig.progressSink?` (`@/agent/types.ts`) is the SAME structural `@/tool` mirror; the dispatch seam (`dispatch.ts`) conditionally spreads `config.progressSink` onto `ctx.progressSink` so absent ⇒ omitted ⇒ byte-identical.

### The `AgentEvent` union extension + exhaustiveness

A new closed-union member in `@/stream/types.ts`:

```
| { type: "progress_update"; currentStep: string; finalSummary?: string;
    completedSubtitle?: string; turn?: number }
```

camelCase matches the wire-internal `AgentEvent` convention (`fromSha`, `outputTokens`); the snake_case tool input is transformed at the adapter boundary — the exact proto↔zod split Cursor uses. Because `AgentEvent` is a discriminated closed union, adding a member forces BOTH adapter exhaustiveness pins to handle it or fail to compile:

- `stdout.ts` — `case "progress_update": this.write(renderProgressUpdate(event))`. The renderer paints a dim `— step: … —` line and, when `completedSubtitle` is present, a terminal `✓ …` subtitle. Both route through `redactStr` (defence-in-depth, same as the `decision` case, ADR-0269). The executive `finalSummary` is NOT painted to stdout (a monitor, not a log) — it lives in the trajectory. The `default: const _exhaustive: never = event` guard would have broken without this case.
- `jsonl-recorder.ts` — `KIND_MAP.progress_update = "recovery"` (reuses the existing `recovery` TrajectoryKind family, ADR-0075 pattern — no new kind rippling through redaction / probe consumers) and a `dataOf` arm tagging `reason:"progress_update"` with conditionally-spread optionals. The `dataOf` `default` is `assertNever(e, "AgentEvent")`, a runtime+compile pin. UNLIKE `output_progress` (the transient token tick the recorder early-returns on), `progress_update` IS recorded — it is durable agent intent. `RecordedEventType = Exclude<AgentEvent["type"], "output_progress">` keeps that distinction honest in the type.

The `sse` / `tee` adapters are generic forwarders — unchanged.

### Default-OFF composition-root gate

The knob `QUANTA_PROGRESS_UPDATE` projects to `runtimeConfig().progressUpdate` (`runtime-config.ts`). `buildGatedToolPorts` (`agent-arg-builder.ts`) spreads `{ progressUpdate: true }` only when the knob is set; `buildDefaultTools` registers `communicate_update` only when `ports.progressUpdate === true`. Knob unset ⇒ the tool is ABSENT from the menu ⇒ the assembled tool-name set is byte-identical to the bare default. Even with the tool registered, an unwired `progressSink` makes the emit a no-op + `ok:true` — a TWO-layer default-OFF (tool-registration gate AND sink-presence gate), so neither the model-facing menu nor the event stream changes until BOTH the knob is on and the host mints an adapter.

## 결과

- The agent now has a fourth, ORTHOGONAL progress channel: a typed `{currentStep, finalSummary?, completedSubtitle?}` triple a surface can render as a status pill / agent subtitle / summary panel, distinct from prose (`assistant_text`), token throughput (`output_progress`), and tool-keyed text (`tool_progress`).
- The event is durable (recorded under the `recovery` family with a greppable `reason:"progress_update"`) yet RENDER-ONLY — the loop never inspects it, so it cannot perturb control flow.
- Default-OFF byte-identity is provable end-to-end through the REAL composition root (`buildBaseFromArgs`), not just the seam — closing the round-3 "gated port never wired" finding for `progressUpdate`.
- The model-facing prompt-body WHEN-to-call guidance currently rides the tool/field `describe` strings (set-once-per-turn guidance); a dedicated prompt section + Tauri surface affordances (status pill / subtitle / summary panel) remain additive follow-ups.

## Trade-offs / Negative invariants

Each pinned by a hellgate case (the test file is named per assertion family):

- **Single-emit, only-`current_step` when terminals omitted** (`communicate-update-hellgate`): the mirror must contain exactly `{ current_step }` with `final_summary` / `completed_subtitle` ABSENT (not `undefined`) — `exactOptionalPropertyTypes` byte-exactness; a leaked `undefined` key would corrupt the jsonl line.
- **Full-triple fidelity**: all three fields round-trip unchanged to the sink and on to the stream/jsonl in order.
- **DoS caps are hard**: empty `current_step`, over-cap `current_step` (10k), over-cap `final_summary` (10k), over-cap `completed_subtitle` (500), and missing-required `current_step` ALL reject at the registry parse boundary (no-throw via the registry's typed rejection) — a single call can never balloon the stream.
- **Render-only / no control authority**: `execute` yields ONLY `["result"]` — never a loop/control event. The loop cannot be steered by a progress report.
- **No FS/shell/git**: a bogus `cwd` (`/nonexistent/\0`) succeeds identically — the tool ignores `cwd` entirely.
- **Non-blocking**: a context that would DEADLOCK a blocking tool (no input/decision port) resolves fine — no host promise is awaited.
- **NO-THROW sink boundary**: a host adapter that throws is swallowed; the model still gets `ok:true`.
- **Default-OFF byte-identical menu** (`hellgate` + `composition-root-gated-port-activation-r3`): `buildDefaultTools()` (no port) and `buildBaseFromArgs` (`QUANTA_PROGRESS_UPDATE` unset) both EXCLUDE `communicate_update`, and the assembled tool-name set equals the bare baseline with NO cross-bleed (only `communicate_update` is added when ON).
- **Gated activation through the REAL root** (`composition-root-gated-port-activation-r3`): knob ON ⇒ `buildBaseFromArgs(...).registry` contains the tool AND a dispatch emits exactly once onto the wired `progressSink` — proving the composition-root wire, not just the direct seam.
- **Absent-sink no-op**: with the tool registered but no `progressSink`, the emit is a no-op and the run is byte-identical (`ok:true`, nothing emitted).
- **`progress_update` recorded, `output_progress` skipped** (`e2e-hellgate`): the jsonl recorder writes `reason:"progress_update"` lines under `kind:"recovery"` (durable intent) but NEVER records `output_progress` (transient token tick) — the two progress signals have deliberately opposite durability.
- **Adapter exhaustiveness pin**: the stdout `never` default and the jsonl `assertNever(e, "AgentEvent")` guarantee a future `AgentEvent` variant cannot silently bypass either adapter — adding the union member without handling it fails to compile.
