# RFC — C2 · CommunicateUpdate (structured progress-report tool)

**Status:** Draft (design only — NOT an implementation)
**Date:** 2026-06-04
**Feature id:** C2
**Author:** absorption sprint (jun-4)
**Scope:** one new read-only tool + one new typed `AgentEvent` variant + the two surface renders. No behavioral change to any existing path; default-OFF wiring.

---

## 1. 요약 (Summary)

The agent today narrates progress to the user only as **free text** (`assistant_text` deltas) or as a transient **token counter** (`output_progress`). There is no *structured, typed, surfaceable* progress channel — nothing the model can call mid-turn to say "I am on step X" / "here is my executive summary" / "here is my 4-6-word completed subtitle" that a surface can render as a distinct UI affordance (status pill, agent subtitle) rather than inline prose.

This RFC proposes **`communicate_update`** — a read-only, no-side-effect tool the model calls mid-turn. It validates a small typed payload `{ current_step, final_summary?, completed_subtitle? }`, emits exactly one typed **`progress_update` `AgentEvent`** onto `config.stream` via a duck-typed host sink (the established `vcsEventSink` / `toolDiff` precedent — `@/tool` stays a slice leaf), and returns an `ok:true` acknowledgement. The CLI stdout monitor renders a one-line status; a future Tauri surface renders a status pill + agent subtitle. It is orthogonal to and does not replace `output_progress` (token counter) or prose narration.

**Key decision (see §8):** add a **new `AgentEvent` variant** (`progress_update`) rather than overloading the existing `tool_progress` or `in_progress` events. `tool_progress` is a free-text-only reminder keyed by tool-call id; `in_progress` is a provider "thinking…" heartbeat. Neither carries the typed `{current_step, final_summary?, completed_subtitle?}` triple, and overloading them would force every existing consumer to disambiguate by inspecting message strings — exactly the anti-pattern the closed-union discipline exists to prevent. The cost of a new variant is two exhaustiveness-pin edits (`stdout.ts`, `jsonl-recorder.ts`); the sse/tee adapters are generic forwarders and need no change.

---

## 2. 경쟁사 레퍼런스 (Cursor 3.5.33 — verified field shape)

Source: `.extracted_source/cursor/extensions/cursor-agent-exec/dist/main.js` (12.7 MB minified bundle). All field names and describe-strings below are extracted verbatim from the bundle.

### 2.1 Proto wire shape (`agent.v1.CommunicateUpdateArgs`)

From the connect-proto `newFieldList` (offset ~4,678,405) — all three fields are **optional scalars** (`T:9` = string, `opt:!0`):

```
agent.v1.CommunicateUpdateArgs
  no:1  current_step         scalar string  optional
  no:3  final_summary        scalar string  optional
  no:4  completed_subtitle   scalar string  optional
```

(Field number 2 is reserved/removed — the proto skips from 1→3, evidence the schema evolved.)

### 2.2 Result / Error / TurnState / HistoryEntry shapes

```
agent.v1.CommunicateUpdateSuccess { current_step: string;  message_index: uint32 }
agent.v1.CommunicateUpdateError   { error: string }
agent.v1.CommunicateUpdateHistoryEntry { step: "CODE";  message_index: "SAFE" }
agent.v1.CommunicateUpdateTurnState    { final_summary: "CODE";  completed_subtitle: "CODE" }
```

Salient inferences:
- **`message_index`** on `Success` — the update is *anchored into the message stream at an index* (it surfaces as a positioned message, not an out-of-band toast). The agent gets the index back.
- **`current_step`** lives in a per-message `HistoryEntry` (`step`) → it is the *live, mutable* "what am I doing now" line, updated repeatedly through the turn.
- **`final_summary` + `completed_subtitle`** live in a per-turn `TurnState` → they are *set-once-per-turn*, terminal fields.
- The `"CODE"` / `"SAFE"` / `"PATH"` tags are Cursor's redaction/classification annotations (`current_step`, `final_summary`, `completed_subtitle`, `error`, `step` = `"CODE"` ⇒ may contain code-derived text and is scrubbed; `message_index` = `"SAFE"`).

### 2.3 Zod input contract + describe-strings (gold — offset ~213,405)

The runtime input schema (`AT.Ik({...})`) carries the model-facing guidance verbatim:

- **`current_step`** — *"Major step or phase you are on. Update when the subtask changes. Keep the text concise, high-level, and user-friendly."*
- **`final_summary`** — *"Concise, well-formatted executive summary of your work. Typically 1-3 sentences (can be more if user requests more detail). Include the most relevant takeaways for the user, as implied by the user's original request. No unnecessary details. … Examples of what to include: full answer(s) to user's question(s), high-level root cause while debugging, status update of completed (or in-progress) work, test results …, blocking questions …, links to newly created PRs. Examples of what NOT to include (unless requested): tool calls / results, code / log / shell command excerpts, long file paths, line numbers, low-level implementation details. Set this field just ONCE per turn, as the last thing you do before your final response, at the same time that you set the `completed_subtitle` field."*
- **`completed_subtitle`** — *"4-6 word, past-tense, final summary of the work you have completed. Will be used as your agent subtitle in the UI. Keep the text concise, high-level, and user-friendly. Set this field ONCE per turn, as the last thing you do before your final response, at the same time that you set the `final_summary` field."*

There is also a sibling `agent.v1.SendFinalSummaryArgs { final_summary }` with describe *"Brief final summary of the work you have performed. When helpful, include illustrative examples of completed work."* — a narrower variant. We fold both ideas into a single tool (see §4).

### 2.4 How Cursor surfaces it (summary)

- `current_step` → a **live, repeatedly-updated** "current step" line in the message stream (anchored at `message_index`); the model updates it whenever the subtask changes.
- `completed_subtitle` → the **agent subtitle in the UI** — a 4-6-word past-tense headline shown once the turn completes.
- `final_summary` → the **executive summary** message, set once at turn end (paired with `completed_subtitle`).
- It is a **read-only, no-side-effect** progress channel: the only "effect" is appending a structured message + updating turn state. It never touches the FS / shell / git.

---

## 3. 현재 quanta 상태 (free-text only — grep-verified)

**GAP CONFIRMED.** `grep -rln "progress_update|communicate_update|CommunicateUpdate|current_step|completed_subtitle" src/` returns **zero hits**. quanta has no structured progress tool or event.

What exists today (the three adjacent, non-overlapping channels):

1. **Free-text narration** — `assistant_text` deltas (`src/stream/types.ts:119`). The model narrates inline; surfaces print it as prose. There is also *prose guidance* in the system prompt (`src/agent/prompt-body.ts`) — e.g. the git-status / in-progress-work directives at lines 104, 115-117, 337. **This is prose, not a tool.** The H1 "narrate your progress" style directive is system-prompt text the model is asked to follow, with no typed channel behind it.

2. **`output_progress`** (the live token counter — Claude-Code "· N tokens" parity) — `src/stream/types.ts:179`, synthesized by the `LiveUsageLLM` decorator (`src/llm/live-usage/index.ts:131,158`) from normalized text/thinking deltas. It is a **transient UI signal**: the loop forwards it WITHOUT accounting (`src/llm/adapters/anthropic.ts:216-222`), the jsonl-recorder **SKIPS** it (`src/stream/adapters/jsonl-recorder.ts:87-92,256`), and the CLI stdout monitor **ignores** it (`src/stream/adapters/stdout.ts:146-150` — the spinner renders it in-place, not as a line). It is about *token volume*, not *what the agent is doing*.

3. **`tool_progress`** — `src/stream/types.ts:130` `{ id, name, message }`. A **free-text** progress reminder keyed by a tool-call id. Tools yield `ToolEvent {type:"progress"; message}` (`src/tool/types.ts:881-882`), which the dispatch/stream-callbacks seam maps to a `tool_progress` AgentEvent (`src/agent/dispatch.ts:528`, `src/agent/stream-callbacks.ts:191`). Also free-text; tied to a specific tool call; no typed `{current_step, final_summary, completed_subtitle}` shape.

4. **`in_progress`** — `src/stream/types.ts:128` `{ timestamp, message?, progress? }`. A provider "thinking…" heartbeat decoded from a Responses-API `response.in_progress` event (`src/stream/adapters/stdout.ts:140-144`). Provider-driven, not agent-driven; not structured progress.

**Reuse inventory (the design rides these):**
- The `AgentEvent` discriminated union — `src/stream/types.ts:74-337`. A surface that doesn't implement a branch falls through the **exhaustive `never` default** (compile-time hellgate).
- `config.stream.emit({...AgentEvent})` — the established emit seam (e.g. `src/agent/dispatch.ts:527`).
- **Duck-typed host sinks on `ToolContext`** — `vcsEventSink` (`src/tool/types.ts:296-308,338-341`) and `toolDiff` (`src/tool/types.ts:289,352`). These are the *exact* precedent: a tool emits a structural-mirror payload to a host-wired sink, and the **host adapts it onto the EXISTING AgentEvent stream** (`@/tool` never imports `@/stream` / `@/agent` — slice-fence, biome-enforced). `ToolContext` exposes **no direct `config.stream`** (grep-verified: `stream:` is absent from `src/tool/types.ts`).
- The tool authoring pattern — `defineTool` / a `Tool<Input>` factory (`src/tool/request-user-input.ts`, `src/tool/update-working-state.ts`).
- Tier-1 block builders — `src/agent/tier1/user-input.ts` (`buildUserInputBlock`: returns the tool only when its config slot is wired).
- The tool-surface SSOT manifest — `src/tool/surface/manifest.ts` (`BASE_TOOL_NAMES` line 105; `GATED_TOOLS` line 135).
- Surface renders — `src/stream/adapters/stdout.ts` (CLI monitor switch, exhaustive `never` at line 215-219); `src/stream/adapters/jsonl-recorder.ts` (trajectory mapper, `assertNever` at line 439-443); `sse.ts` / `tee.ts` are **generic forwarders** (JSON.stringify+redact / blind `port.emit`) — no per-variant code.

---

## 4. 설계 (Design)

### 4.1 The tool — `communicate_update`

A new tool file `src/tool/communicate-update.ts` (factory pattern, mirroring `request-user-input.ts`).

```ts
// shape — NOT final code, illustrative
const schema = z.object({
  current_step: z.string().min(1).max(200)
    .describe("Major step or phase you are on. Update when the subtask changes. " +
              "Keep it concise, high-level, and user-friendly."),
  final_summary: z.string().min(1).max(4000).optional()
    .describe("Concise executive summary of your work (1-3 sentences). Include the " +
              "takeaways the user asked for; omit tool calls, code excerpts, file " +
              "paths, line numbers. Set ONCE per turn, just before your final reply."),
  completed_subtitle: z.string().min(1).max(80).optional()
    .describe("4-6 word, past-tense final summary used as the agent subtitle in the " +
              "UI. Set ONCE per turn, alongside final_summary."),
})
```

Tool properties (grounded in the existing read-only / no-confirm contract):
- `name: "communicate_update"`
- `isReadOnly: () => true` — no FS, no shell, no git, no session-state mutation. The only effect is emitting an observability event.
- `isConcurrencySafe: () => true` — unlike `request_user_input` it does NOT block; it is a fire-and-continue report. Safe to overlap (it touches nothing). This is what makes it **non-blocking** — the model calls it mid-turn and execution continues immediately.
- `hitlTier: () => "pre-approval-ok"` — read-only + zero blast radius; must never trigger a confirm prompt (same reasoning as `update_working_state`'s explicit tier — without it the fail-closed `inferToolTier` fallback could classify it `always-confirm` and deadlock every turn).

Caps mirror `update-working-state.ts`'s DoS discipline: bounded `max()` on every string so a single call cannot balloon the event stream / recorder.

`execute` (illustrative):
```ts
async *execute(input, ctx): AsyncIterable<ToolEvent> {
  // Emit the typed progress event via the host-wired sink (duck-typed,
  // @/tool stays a leaf). Absent sink ⇒ no-op, byte-identical default-OFF.
  ctx.progressSink?.emit({
    current_step: input.current_step,
    ...(input.final_summary !== undefined && { final_summary: input.final_summary }),
    ...(input.completed_subtitle !== undefined && { completed_subtitle: input.completed_subtitle }),
  })
  yield { type: "result", result: { ok: true, output: "progress reported" } }
}
```

> We fold Cursor's `current_step` (live) + `final_summary`/`completed_subtitle` (set-once) into **one** tool, matching `CommunicateUpdateArgs`. We do NOT model the separate `SendFinalSummary` tool — a single tool with optional terminal fields is the smaller surface and the describe-strings carry the "set once at the end" guidance.

### 4.2 The sink — `ProgressSink` (duck-typed mirror)

Add to `ToolContext` (in `src/tool/types.ts`) an OPTIONAL duck-typed sink, structurally identical to `vcsEventSink`:

```ts
/** Read-only structured-progress payload mirror. Carried to the host, which
 *  adapts it onto the EXISTING AgentEvent stream as `progress_update`. @/tool
 *  stays a slice leaf (no import of @/stream / @/agent). ABSENT ⇒ no-op,
 *  byte-identical default-OFF (same discipline as vcsEventSink / toolDiff). */
export interface ProgressUpdateMirror {
  readonly current_step: string
  readonly final_summary?: string
  readonly completed_subtitle?: string
}
export interface ProgressSink { emit(u: ProgressUpdateMirror): void /* NO-THROW by contract */ }
// on ToolContext:  progressSink?: ProgressSink
```

The dispatch seam surfaces `ctx.progressSink` from a new `AgentConfig.progressSink` (host-wired); absent ⇒ omitted ⇒ tool's `?.emit` is a no-op. The host adapter (composition root) translates `ProgressUpdateMirror` → `config.stream.emit({ type: "progress_update", ... })`.

### 4.3 The event — new `AgentEvent` variant `progress_update`

Add to the union in `src/stream/types.ts`:

```ts
| {
    type: "progress_update"
    /** Live "what step am I on" line — updated whenever the subtask changes. */
    currentStep: string
    /** Set-once-per-turn executive summary (optional until the turn ends). */
    finalSummary?: string
    /** Set-once 4-6-word past-tense agent subtitle (optional). */
    completedSubtitle?: string
    /** Turn index for ordering / UI anchoring (mirrors Cursor's message_index
     *  intent — lets a surface anchor / coalesce updates within a turn). */
    turn?: number
  }
```

(camelCase on the wire-internal AgentEvent matches the existing variants — `fromSha`, `outputTokens`, `toolCallId`; the tool's snake_case input is the *model-facing* contract, transformed at the adapter boundary, exactly like the proto↔zod split in Cursor.)

### 4.4 Surface rendering

- **CLI (`src/stream/adapters/stdout.ts`)** — add a `case "progress_update":` rendering a single dim status line, e.g. `— step: {currentStep} —`, and when `completedSubtitle` is present a terminal subtitle line `✓ {completedSubtitle}`. Route any model-text through `redactStr` (defence-in-depth, same as the `decision` case). **This edit is mandatory** — the `never` exhaustiveness pin at line 215-219 will not compile without it.
- **jsonl-recorder (`src/stream/adapters/jsonl-recorder.ts`)** — add a `case "progress_update":` returning its trajectory `data` payload (e.g. `{ currentStep, finalSummary?, completedSubtitle?, turn? }`). **Mandatory** — `assertNever` at line 439-443 fails otherwise. Unlike `output_progress`, this event **IS** recorded (it is durable agent intent, not a transient token tick).
- **sse / tee** — **no change**. `sse.ts:52` does `JSON.stringify(redactValue(event))` generically; `tee.ts:47` blind-forwards. Both pick up the new variant for free.
- **Future Tauri surface** — renders `currentStep` as a live status pill (coalescing repeated updates within a turn), `completedSubtitle` as the agent subtitle, `finalSummary` as the executive-summary panel. No code in this RFC — the typed event is the contract the Tauri layer consumes.

### 4.5 Relation to `output_progress`

Strictly orthogonal. `output_progress` = *how many tokens are streaming* (transient, un-recorded, spinner-only). `progress_update` = *what the agent is doing / what it concluded* (durable, recorded, status-pill + subtitle). They render in different UI regions and never compete. A surface may show both simultaneously (token counter in the spinner, current-step in the status line).

---

## 5. 통합 (Integration)

### 5.1 Always-available read-only, NOT default-OFF-gated at the tool level

Unlike most absorbed slices, `communicate_update` is read-only and zero-blast-radius, so the **tool itself should be BASE (always registered)** — it belongs alongside `read` / `grep` in `BASE_TOOL_NAMES` (`src/tool/surface/manifest.ts:105`). The model always having a structured progress channel is the point.

However, the **event-emission side is default-OFF-by-omission**: if the host does not wire `AgentConfig.progressSink`, the tool's `ctx.progressSink?.emit` is a no-op and the run is byte-identical (the model still gets `ok:true`, and `NullStream` would swallow the event anyway). This is the same "tool present, effect gated by a wired port" shape as `request_user_input` — except here "no port" degrades to *silent success* (progress is best-effort observability) rather than a hard `ok:false`. The CLI surface wires the sink; bench/web opt in.

> Manifest placement decision: add `communicate_update` to `BASE_TOOL_NAMES`. (Alternative — a `GATED_TOOLS` entry with `gate: { kind: "config-slot", slot: "progressSink" }` and `default: { cli: "on" }`, `risk: "meta"` — is viable if we want the tool absent when no surface consumes it. **Recommendation: BASE**, because a structured progress channel is universally useful and harmless, and absence-on-no-sink adds a registration branch for no safety gain.)

### 5.2 Feature-catalog (fc)

Add `tools/feature-catalog/features/02-tool-system/<id>-communicate-update.yaml` (the fc YAML shape — `id/title/section/subsystem/order/maturity/status/ui_surfaces/modes/labels/depends_on/purpose/evidence{code,adrs,tests}/knobs/notes`). `labels: ["surface:core", "tier:0", "absorbed:cursor"]`; `depends_on` the AgentEvent union + the `assert-never-exhaustiveness` feature; evidence cites the new tool file, the `stdout.ts` / `jsonl-recorder.ts` cases, and the hellgate test.

### 5.3 Tool-surface manifest + seed

- `BASE_TOOL_NAMES += "communicate_update"`.
- The bidirectional drift guards (the 11 manifest tests, `tests/unit/tool-surface-manifest-hellgate.test.ts`) require the manifest entry and the registered tool to agree — adding to `BASE_TOOL_NAMES` plus registering in `buildDefaultTools` keeps the SSOT consistent. `apply_patch_structured`-style fc-orphan detection should pass once the fc entry lands.

### 5.4 CLI rendering

`src/stream/adapters/stdout.ts` gets the `progress_update` case (§4.4). No new CLI flag — the sink is wired by the CLI runtime-context the same way `userInputPort` is (`src/tool/surface/manifest.ts:374-380`).

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (`tests/unit/communicate-update-hellgate.test.ts` + integration)

- **Field validation:** empty `current_step` rejected; over-cap strings rejected (DoS cap, mirroring `update-working-state` tests); `final_summary` / `completed_subtitle` optional — omitting them is valid; a call with ONLY `current_step` is valid.
- **Event emitted:** with a wired `progressSink`, one `progress_update` mirror is emitted carrying exactly the provided fields (optional fields absent when omitted under `exactOptionalPropertyTypes`).
- **No-side-effect:** assert FS / shell / git are never touched (no writes); `isReadOnly()===true`, `hitlTier()==="pre-approval-ok"` (never triggers `onConfirm`).
- **No-block:** `isConcurrencySafe()===true`; the tool resolves immediately and does NOT await any host decision (contrast `request_user_input`). A fake clock proves the execute returns without yielding to an external promise.
- **Default-OFF:** with `progressSink` absent, the tool still returns `ok:true`, emits nothing, and the run is byte-identical.
- **Adapter exhaustiveness:** a compile-level test (or the existing `assert-never` battery) proves stdout + jsonl-recorder handle the variant; sse/tee forward it without code.

### 6.2 e2e through dispatch → stream

- A loop test: register `communicate_update`, wire `AgentConfig.progressSink` → host adapter → a `CapturingStream`; drive a scripted model that calls the tool with `{current_step}` then later `{current_step, final_summary, completed_subtitle}`; assert the capturing stream observed two `progress_update` AgentEvents in order with the right fields, and the jsonl trajectory recorded both (and did NOT record any `output_progress`).
- Smoke (`tests/smoke/`): a tikitaka fixture where the agent reports a step mid-turn and a subtitle at the end; `expect.json` asserts the `progress_update` events surface.

---

## 7. 단계 (Phases)

1. **P0 — types + tool (no wiring).** Add `ProgressUpdateMirror` / `ProgressSink` to `ToolContext`; add `progress_update` to the `AgentEvent` union; add the two mandatory adapter cases (`stdout`, `jsonl-recorder`); create `src/tool/communicate-update.ts`; register in `buildDefaultTools` + `BASE_TOOL_NAMES`. Hellgate (§6.1). **No host wiring yet — sink unset everywhere ⇒ byte-identical.**
2. **P1 — host wiring (CLI).** `AgentConfig.progressSink` slot; dispatch seam surfaces `ctx.progressSink`; CLI runtime-context wires the adapter (`ProgressUpdateMirror` → `config.stream.emit`). e2e (§6.2). fc entry + manifest drift-guard green.
3. **P2 — prompt guidance.** Add the (prose) describe-string guidance so the model knows WHEN to call it (mid-turn on subtask change; set-once terminal fields before the final reply). This is the typed-channel replacement for the H1 narration prose.
4. **P3 (future, out of scope) — Tauri surface render** (status pill + agent subtitle + summary panel).

---

## 8. 리스크 / 대안 (Risks / Alternatives)

### 8.1 New AgentEvent variant vs reuse — **decision: NEW variant**

- **vs reuse `tool_progress`:** `tool_progress` is `{id, name, message}` — free-text keyed by a tool call. Encoding `{current_step, final_summary, completed_subtitle}` into its `message` string forces every consumer to parse text → defeats the typed channel. **Rejected.**
- **vs reuse `in_progress`:** provider-driven heartbeat (`{timestamp, message?, progress?}`); semantically "model is thinking", not "agent reports a step". **Rejected.**
- **vs reuse `assistant_text`:** that IS the prose channel we're trying to give a typed alternative to. **Rejected.**
- **Cost of the new variant:** exactly **two** exhaustiveness-pin edits — `stdout.ts:215` (`never`) and `jsonl-recorder.ts:439` (`assertNever`). The sse/tee adapters are generic forwarders (verified) and need no change. This is the documented, low-cost path every prior AgentEvent absorption (`turn_diff_updated`, `decision`, `knobs_applied`) took.

### 8.2 AgentEvent exhaustiveness-guard consideration

Adding a stream variant is a **compile-time hellgate**: the build WILL FAIL until both `stdout.ts` and `jsonl-recorder.ts` declare the new case (this is a feature — it prevents a silently-dropped event). The RFC's mandatory P0 edits satisfy both pins. No runtime fallthrough exists; there is no heuristic default that could swallow the variant.

### 8.3 Spam / rate concerns

The model could call `communicate_update` excessively, flooding the event stream and the jsonl trajectory.
- **Cap, not block:** keep per-field byte caps (§4.1) so a single call is bounded.
- **Coalescing is a SURFACE concern, not an event concern:** the CLI/Tauri renderer coalesces repeated `current_step` updates within a turn (Cursor anchors at a stable `message_index`; we carry `turn?` for the same purpose). The recorder keeps every event (durable intent) but each is small.
- A future per-turn rate guard (drop / merge identical consecutive `current_step` values) can live in the host adapter without touching the tool or event — out of scope for this RFC.

### 8.4 vs prose narration (the thing it replaces)

Prose narration (`assistant_text` + system-prompt H1 directive) stays — `communicate_update` is *additive*. The risk is the model double-reports (prose + tool). Mitigation is the describe-string guidance (P2): prose for conversational reasoning, `communicate_update` for the structured status pill / subtitle. We do NOT remove the prose directive in this RFC (behavior-preserving).

### 8.5 Slice-fence risk

The naïve implementation gives the tool a direct `config.stream` reference → would make `@/tool` import `@/stream` / `@/agent`, breaking the slice fence (biome-enforced). **Mitigation is structural, not optional:** the duck-typed `ProgressSink` mirror on `ToolContext` (§4.2) is the only sanctioned path — identical to `vcsEventSink` / `toolDiff`. `ToolContext` exposes no `config.stream` today (verified) and this RFC keeps it that way.

---

## 9. 코드 위치 요약 (Code-location summary)

**New files**
- `src/tool/communicate-update.ts` — the tool factory (mirror `src/tool/request-user-input.ts`).
- `tools/feature-catalog/features/02-tool-system/<id>-communicate-update.yaml` — fc entry.
- `tests/unit/communicate-update-hellgate.test.ts` (+ an e2e/integration case).

**Edited files**
- `src/tool/types.ts` — add `ProgressUpdateMirror` / `ProgressSink`; add `progressSink?` to `ToolContext` (alongside `vcsEventSink` at line 296-308).
- `src/stream/types.ts` — add `progress_update` to the `AgentEvent` union (line 74-337 region).
- `src/stream/adapters/stdout.ts` — add `case "progress_update"` (before the `never` default at line 215). **Mandatory.**
- `src/stream/adapters/jsonl-recorder.ts` — add `case "progress_update"` returning its trajectory `data` (before `assertNever` at line 439). **Mandatory.**
- `src/tool/surface/manifest.ts` — add `"communicate_update"` to `BASE_TOOL_NAMES` (line 105).
- `src/tool/registry.ts` / `buildDefaultTools` — register the tool.
- `src/agent/types.ts` — add `AgentConfig.progressSink` slot (P1).
- `src/agent/dispatch.ts` — surface `ctx.progressSink` from `config.progressSink` (P1).
- CLI runtime-context — wire the `ProgressUpdateMirror → config.stream.emit({type:"progress_update"})` adapter (P1).
- `src/agent/prompt-body.ts` — add the model-facing usage guidance (P2).

**Unchanged (forward the variant for free)**
- `src/stream/adapters/sse.ts` (generic `JSON.stringify`+redact), `src/stream/adapters/tee.ts` (blind forward).

**Competitor evidence**
- `.extracted_source/cursor/extensions/cursor-agent-exec/dist/main.js` — `CommunicateUpdateArgs` proto (offset ~4,678,405), zod schema + describe-strings (offset ~213,405), Success/Error/TurnState/HistoryEntry (offset ~5,077,099).
