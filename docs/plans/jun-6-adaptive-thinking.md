# RFC — Adaptive thinking (`thinking:{type:"adaptive"}`) for the Anthropic adapter

**Status: ✅ IMPLEMENTED (jun-06)**

> Status: PROPOSED (design only — no source changed by this RFC)
> Date: 2026-06-06

---

## As-built (jun-06)

Landed exactly per §4 (producer-side decision, dumb codec), default-OFF byte-identical:

- **Union (§4.1):** `StreamInput.thinking` widened to the closed `ThinkingConfig` union
  (`enabled | adaptive | disabled`) in `src/llm/types.ts`, exported through the `@/llm` barrel. The
  `enabled` arm is byte-identical, so every existing producer/test still typechecks.
- **Family gate (§4.2):** `ADAPTIVE_THINKING_FAMILIES` + `supportsAdaptiveThinking(model)` added to
  `src/llm/factory.ts` (next to the `CACHE_1H_ALLOWLIST` sibling), reusing `normalizeModelFamily`.
  Set = `{opus-4-8, opus-4-7, opus-4-6, sonnet-4-6}`. **Deliberately excludes `haiku-4-5`** (it IS on
  the 1h-cache set but has no adaptive support — the two sets are intentionally different). An
  absent / unknown slug is fail-safe NON-adaptive.
- **Producer (§4.2):** `applyEffortClassifierFloor` (`src/agent/loop/skill-gate.ts`) keeps the
  unchanged "should we think" signal (`budgetTokens > 0`); when ON **and** the resolved model is
  adaptive-capable it returns `{type:"adaptive"}`, else the manual `{type:"enabled",budget_tokens}`
  path. Per-model fallback is automatic (a turn that swaps to sonnet-4-5 on a knob-ON session still
  gets manual budget — no 400). The two `stream-consume.ts` call-sites pass `thinking` through
  opaquely (no change needed — confirmed).
- **Knob (§5.1):** `adaptiveThinking` (`QUANTA_ADAPTIVE_THINKING === "1"`, default false) added to
  `src/shared/runtime-config.ts` (additive).
- **Codec / SDK-cast decision (§4.3, §8.1):** chose option (b) — **no SDK bump.** The wire JSON is
  already correct for every arm; the single spread site in `anthropic-messages-codec.ts:189` casts
  `as Anthropic.ThinkingConfigParam` (NOT `MessageCreateParamsStreaming["thinking"]`, which includes
  `undefined` and trips `exactOptionalPropertyTypes`). Documented inline. Zero new deps. The
  `output_config.effort` / `display:"summarized"` follow-ups (§8.3/§8.4) are deferred.
- **Polarity (§5.2 / §8.2):** shipped **default-OFF opt-in** (NOT default-ON-for-capable-families).
  The Opus-4.8 budget-400 footgun is repaired *when the knob is on*; with the knob off the wire is
  byte-identical to today (including the latent 400 on a non-zero budget — unchanged, as the RFC's
  strict-absorption posture requires). Flagged here so the product call to flip default-ON-for-4.6+
  remains open.
- **Provider isolation (§3.4 / §6.2):** OpenAI / Responses never read `thinking` — verified: the
  Responses body with `{type:"adaptive"}` present is `.toEqual` a thinking-absent body, and H15
  reasoning-carryover still assembles (prior reasoning re-emitted + `include` set) on its disjoint path.

**Tests:** `tests/unit/adaptive-thinking-hellgate.test.ts` — 18 pass / 0 fail / 48 expects.
**fc:** `tools/feature-catalog/features/08-llm/adaptive-thinking.yaml` (L3 — wired+tested,
default-OFF; not L4 to avoid over-claiming the composition-root live-flip). validate/lint/gates green.
**Deviation from RFC:** none material. Helper landed in `factory.ts` (the RFC's primary §9 option),
not a new `adaptive-thinking.ts` leaf. SDK kept at 0.40.1 (cast path, §8.1 option b).
> Slice: TOUCH `src/llm/` (types + codec + adapter), `src/agent/loop/skill-gate.ts`, `src/shared/runtime-config.ts`, `src/llm/factory.ts` (reuse family-gate)
> Default posture: OFF (byte-identical manual `budget_tokens` wire when the knob is unset)
> Feature axis: LLM reasoning-mode (extends the existing manual-extended-thinking path ADR-0076 Gap-2 / ADR-0277 session-effort)

---

## 1. 요약

quanta sends extended thinking to Anthropic **manual-only**: the agent loop computes a token budget (`effortToTokenBudget` from the session/skill/classifier effort tier) and ships `thinking:{type:"enabled", budget_tokens:N}` on the Messages wire (`src/agent/loop/skill-gate.ts:87` → `StreamInput.thinking` (`src/llm/types.ts:285`) → `src/llm/anthropic-messages-codec.ts:189`). cc-cli 2.1.150 / the Anthropic API have since shipped **adaptive thinking** (`thinking:{type:"adaptive"}`): the model self-paces how much to think per request on Claude 4.6+ (Opus 4.6/4.7/4.8, Sonnet 4.6), and **manual `budget_tokens` is now DEPRECATED on 4.6 and a hard 400 on 4.7/4.8**. quanta's `DEFAULT_MODEL.anthropic` is `claude-opus-4-8` (`src/llm/factory.ts:217`), so the **current default request shape will 400 the instant a thinking budget is non-zero** on the default model — this is a latent live break, not just a missing nicety.

**Goal:** add an Anthropic-only `thinking:{type:"adaptive"}` path, gated by a knob (`QUANTA_ADAPTIVE_THINKING`), default-OFF byte-identical. When ON it sends `{type:"adaptive"}` for models on the 4.6+ adaptive-capable family allowlist (reusing the existing `normalizeModelFamily`/allowlist mechanism in `factory.ts`) and **falls back to the manual `budget_tokens` path for older models**. `effort` keeps acting as the depth/spend dial; OpenAI and every other provider are untouched (Anthropic-only param).

---

## 2. 경쟁사 레퍼런스 (verified evidence)

### 2.1 cc-cli 2.1.150 + Anthropic API — adaptive thinking (verified against the installed SDK + the claude-api skill reference)

The wire shape is **verified from the bundled `claude-api` skill reference** (Anthropic's own SDK doc) and the `model-migration.md` per-SDK syntax table, NOT guessed:

- **TypeScript wire (this repo's SDK language):** `thinking: { type: 'adaptive' }` replaces `thinking: { type: 'enabled', budget_tokens: N }`. (`shared/model-migration.md` → Per-SDK Syntax Reference → "`thinking` — `budget_tokens` → adaptive", TypeScript row.)
- **Optional `display` sub-field (Opus 4.7+):** `thinking: { type: 'adaptive', display: 'summarized' }`. Default is `"omitted"` — thinking blocks still stream but their text is empty unless `display:"summarized"` is set. (`SKILL.md` §"Opus 4.8 / 4.7 — thinking content omitted by default".)
- **Model support (verified):**
  - Opus 4.8 / 4.7: **adaptive-only.** `{type:"enabled", budget_tokens:N}` → **400**; `temperature`/`top_p`/`top_k` also 400. (`SKILL.md` §"Thinking & Effort"; `error-codes.md` §"Model-specific 400s on Opus 4.8 / 4.7".)
  - Opus 4.6 / Sonnet 4.6: adaptive recommended; `budget_tokens` **deprecated but still functional** (transitional escape hatch). (`SKILL.md`; `model-migration.md` → "Transitional escape hatch".)
  - Sonnet 4.5 / Haiku 4.5 / older: adaptive **not** available — use `{type:"enabled", budget_tokens:N}` (`budget_tokens` < `max_tokens`, min 1024). (`SKILL.md` §"Older models".)
- **Knob name:** the absorption audit reports cc-cli's `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` (i.e. adaptive is ON by default in cc-cli, knob to disable). quanta's posture is the inverse — default-OFF opt-in (`QUANTA_ADAPTIVE_THINKING=1`) to keep byte-identical (see §5.2 for the polarity rationale).
- **`effort` combines with adaptive:** `output_config:{effort:"low"|"medium"|"high"|"xhigh"|"max"}` controls depth/spend and is orthogonal to the adaptive on/off switch. (`SKILL.md` §"Effort parameter".) **NOTE:** `effort` is a *separate* top-level field quanta does not send today — see §8 open-question on whether to also wire `output_config.effort` (out of scope for this RFC; this RFC only swaps the `thinking` object).

### 2.2 Installed SDK reality (grep-verified — important caveat)

`node_modules/@anthropic-ai/sdk` is **0.40.1** (`package.json:62` pins `^0.40.0`). Its `messages.d.ts` defines only:

```
ThinkingConfigEnabled  { type:"enabled"; budget_tokens:number }
ThinkingConfigDisabled { type:"disabled" }
ThinkingConfigParam = ThinkingConfigEnabled | ThinkingConfigDisabled    // NO Adaptive arm
```

There is **no `ThinkingConfigAdaptive` type in the installed SDK.** This is the single biggest integration constraint and is called out honestly in §4.3 + §8. The migration guide's Go/Java/C# rows reference `ThinkingConfigAdaptive*` symbols that exist only in newer SDK releases. Two honest options, both covered below: (a) bump the SDK, or (b) construct the request as a typed-widened object literal (the adapter already narrows on a hand-rolled `RawEvent`/request shape and casts to `Anthropic.MessageCreateParamsStreaming`). **The wire JSON `{"type":"adaptive"}` is correct regardless of SDK version** — the only question is how to satisfy the TS type, not what bytes to send.

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 Manual-only confirmed — no adaptive anywhere

- `grep -rni "adaptive" src/ --include="*.ts"` → only `src/runner/batch/eval/adaptive-timeout.ts` (bench per-instance timeout) and `prompt-cache-1h-ttl.yaml` Phase-2 note. **Zero** matches in any thinking/reasoning path.
- `StreamInput.thinking` is typed `{ type: "enabled"; budget_tokens: number }` — a closed single-arm shape, no `"adaptive"`/`"disabled"` (`src/llm/types.ts:285`).
- `applyEffortClassifierFloor` is the sole producer: `budgetTokens > 0 ? { thinking: { type: "enabled", budget_tokens: budgetTokens } } : {}` (`src/agent/loop/skill-gate.ts:80-88`). budget is `max(session/skill budget, classifier floor)` via `effortToTokenBudget` (`src/agent/effort.ts:80`, tiers default→undefined, low 1024, medium 4096, high 16384, max 64000).
- The codec spreads it verbatim onto the wire: `...(input.thinking ? { thinking: input.thinking } : {})` (`src/llm/anthropic-messages-codec.ts:189`). No transform, no model check.
- Feature-catalog: `tools/feature-catalog/features/08-llm/277-session-effort-wire.yaml` + `06-tier1/04-seam.yaml` describe the manual budget seam; **no adaptive entry exists.**

**Verdict: manual-only. Adaptive thinking is NOT built.** This RFC proceeds.

### 3.2 Latent live break (be honest)

Because `DEFAULT_MODEL.anthropic = "claude-opus-4-8"` (`factory.ts:217`) and Opus 4.8 **400s on `{type:"enabled", budget_tokens:N}`**, any non-default-effort turn on the default model already fails. Today this is masked only when the effective budget is 0 (effort `"default"` ⇒ `effortToTokenBudget` returns `undefined` ⇒ no `thinking` field ⇒ no 400). The moment a user sets `/effort high` (or the classifier raises a floor) on Opus 4.8, the request 400s. So adaptive is not merely SOTA++ — it is the **correct repair** for the default model. (This RFC's fallback table makes the repair explicit and keeps older models working.)

### 3.3 Reusable model-family gate (already present)

`src/llm/factory.ts` already has exactly the mechanism this RFC needs:
- `normalizeModelFamily(model)` (line 229) — lowercases, strips cloud prefix (`anthropic.`), strips date/`@`/`:`/`-vN` suffixes → canonical family, transport-agnostic (Bedrock/Vertex slugs collapse to the public family).
- `CACHE_1H_ALLOWLIST` (line ~216) — a `Set` of `{claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, …}` used to gate the 1h prompt-cache TTL by family.
- `resolveCacheTtl(model, cfg)` (line 252) — the gating idiom: `knob ON && allowlist.has(normalizeModelFamily(model)) ? grant : fallback`.

The adaptive gate is **structurally identical** (a different allowlist + a different grant), so it reuses `normalizeModelFamily` and adds a sibling `ADAPTIVE_THINKING_FAMILIES` set.

### 3.4 Provider isolation confirmed

- OpenAI chat (`adapters/openai.ts`) and OpenAI Responses (`adapters/openai-responses.ts` + `responses-stream.ts`) never read `StreamInput.thinking` — they have their own `reasoning` handling. The H15 encrypted-reasoning carryover (`QUANTA_REASONING_CARRYOVER`, `responses-stream.ts` / `openai-responses-wire.ts`) is an **OpenAI-Responses-only** path keyed off `response.output_item.done` reasoning items with `encrypted_content`. It does NOT touch the Anthropic `thinking` object. **Adaptive cannot break reasoning-carryover because they are disjoint code paths and disjoint providers.**
- Anthropic's own thinking-signature carryover (`ThinkingBlock.signature` / `signature_delta`, ADR-0076 Gap-2, `adapters/anthropic.ts:90-92,279-283`) is on the **response→input** axis (re-sending a prior thinking block) and is independent of whether the *request* asked for adaptive vs enabled. Adaptive thinking auto-enables interleaved thinking (no beta header), and the streamed `thinking_delta`/`signature_delta` events are the same shape — so the existing assembly + carryover path is byte-compatible (§6 hellgate proves it).

---

## 4. 설계 (closed-port)

### 4.1 Widen the wire type (closed union, exhaustive)

`src/llm/types.ts` — widen `StreamInput.thinking` from a single struct to a **closed discriminated union**, mirroring the SDK's three-arm shape plus the adaptive arm:

```ts
export type ThinkingConfig =
  | { readonly type: "enabled"; readonly budget_tokens: number }
  | { readonly type: "adaptive"; readonly display?: "summarized" | "omitted" }
  | { readonly type: "disabled" }

export interface StreamInput {
  // …
  thinking?: ThinkingConfig   // was: { type:"enabled"; budget_tokens:number }
  // …
}
```

The `"enabled"` arm is byte-identical to today, so every existing producer/test that builds `{type:"enabled", budget_tokens}` still typechecks. `"disabled"` is added for completeness (explicit off; not produced by this RFC but lets callers force-off). The union is closed so the adapter's request-builder gets a compile error if a future arm is added without a mapping.

### 4.2 Adaptive resolution at the producer (`skill-gate.ts`), not the adapter

The model-family decision is made **where the budget is computed** (`applyEffortClassifierFloor`), because that is the only place that already holds both the resolved `LLMPort` (which carries `.model`) and the budget. The adapter stays a dumb wire-shaper.

New helper (lives in `factory.ts` next to its sibling, exported; or a tiny `src/llm/adaptive-thinking.ts` leaf — see §9):

```ts
// reuse normalizeModelFamily from factory.ts
export const ADAPTIVE_THINKING_FAMILIES: ReadonlySet<string> = new Set([
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
])
export const supportsAdaptiveThinking = (model: string): boolean =>
  ADAPTIVE_THINKING_FAMILIES.has(normalizeModelFamily(model))
```

`applyEffortClassifierFloor` becomes (default-OFF gate + per-model fallback):

```ts
const wantsThinking = budgetTokens > 0   // unchanged signal: effort/classifier asked to think
if (!wantsThinking) return { llm: resolved.llm }

if (runtimeConfig().adaptiveThinking && supportsAdaptiveThinking(resolved.llm.model)) {
  return { llm: resolved.llm, thinking: { type: "adaptive" } }   // 4.6+ family, knob ON
}
// knob OFF, OR model not adaptive-capable → manual budget (today's path, byte-identical)
return { llm: resolved.llm, thinking: { type: "enabled", budget_tokens: budgetTokens } }
```

Key properties:
- **The "should we think at all" signal is unchanged** — it is still `budgetTokens > 0`, derived from effort/classifier exactly as today. Adaptive only changes the *shape* sent, not *whether* thinking is requested. So `effort` still sets the floor/ceiling intent (effort `"default"`/0 ⇒ no thinking field ⇒ no adaptive either; effort `high` ⇒ adaptive-on for 4.6+, budget=16384 for older). This satisfies "effort still sets a ceiling/floor".
- **Per-model fallback is automatic:** a turn that swaps to `claude-sonnet-4-5` (sticky-model or skill override) on the SAME session with the knob ON still gets `{type:"enabled", budget_tokens}` because `supportsAdaptiveThinking("claude-sonnet-4-5")` is false. No 400 on the older model.
- **`return type` widens** from `{thinking?:{type:"enabled",…}}` to `{thinking?: ThinkingConfig}` — a one-line signature change; the two call-sites in `stream-consume.ts` (`turnLlm.thinking !== undefined ? {thinking: turnLlm.thinking} : {}`, lines 99/127) pass it through opaquely and need no change.

### 4.3 Codec / adapter — wire shaping (SDK-version-aware)

`anthropic-messages-codec.ts:189` already does `...(input.thinking ? { thinking: input.thinking } : {})`. With the widened union the spread is unchanged **at the value level** — the object is already the correct wire JSON. The only friction is the TS type:

- **If the SDK is bumped** to a version with `ThinkingConfigAdaptive`: `Anthropic.MessageCreateParamsStreaming.thinking` accepts the union directly; the spread typechecks as-is. **Preferred** — it also unblocks `output_config.effort` and `display`.
- **If the SDK stays 0.40.1** (no bump): the request is already assembled as a plain object and the function returns `Anthropic.MessageCreateParamsStreaming`. The adaptive arm is cast at the single spread site: `...(input.thinking ? { thinking: input.thinking as Anthropic.MessageCreateParamsStreaming["thinking"] } : {})` — narrow, local, documented cast (the adapter already casts the raw SSE stream `as unknown as AsyncIterable<RawEvent>` at `anthropic.ts:156`, so a scoped cast here is in-house style). **The wire bytes are correct; only the compile-time type is being satisfied.** This is the honest "can't fully type it on the pinned SDK" path and is marked an open question (§8).

No change to the stream-consume / assembly side: adaptive streams the same `thinking_delta` + `signature_delta` events (interleaved-thinking auto-on), which `mapRawEvent` + `assembleFromEvents` already handle. `display:"omitted"` (the API default) means thinking text may be empty — quanta already tolerates empty thinking blocks (they only feed the optional UI channel), so this is non-breaking; setting `display:"summarized"` is an §8 follow-up if quanta wants to keep rendering reasoning.

### 4.4 Disabled arm (force-off) — optional, included for closure

The `"disabled"` arm is not produced by §4.2 (we omit the field entirely for no-thinking, byte-identical to today). It exists only so a future caller can force thinking off on a model where it would otherwise default on. Costs nothing, keeps the union honest.

---

## 5. 통합 (knob + default-OFF)

### 5.1 Config knob

`src/shared/runtime-config.ts` — add `adaptiveThinking: boolean`, parsed `env["QUANTA_ADAPTIVE_THINKING"] === "1"` (strict `=== "1"`, mirroring `imageGen`/`artifactStore`). Default `false`.

### 5.2 Default-OFF posture + polarity (be honest)

- **Knob OFF (default):** `applyEffortClassifierFloor` takes the `{type:"enabled", budget_tokens}` branch for every model → **byte-identical** to today. Proven by the existing anthropic codec tests + a new "knob-off sends enabled" hellgate.
- **Polarity vs cc-cli:** cc-cli ships `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` (adaptive ON by default, knob disables). quanta inverts to opt-in (`QUANTA_ADAPTIVE_THINKING=1`) **because default-ON would change the wire for the default model and is therefore not byte-identical** — quanta's absorption discipline requires new LLM-wire behavior to land default-OFF. **However** — see §8: because the *current* default-on-Opus-4.8 path is already a latent 400 (§3.2), there is a strong argument to make adaptive **default-ON for adaptive-capable families only** (a "repair", not a "feature"). That is flagged as the key open question, not silently chosen.

### 5.3 Feature-catalog entry

Add `tools/feature-catalog/features/08-llm/adaptive-thinking.yaml` (schema per `277-session-effort-wire.yaml`): `section:8`, `subsystem: LLM reasoning-mode — adaptive thinking (Anthropic 4.6+)`, `maturity: L3` (wired), `labels:[surface:cli, category:llm, default-off]`, `depends_on:[277-session-effort-wire]`, `config_refs.env:[QUANTA_ADAPTIVE_THINKING]`, `config_refs.runtime:[adaptiveThinking]`, evidence.code listing `skill-gate.ts`, `types.ts`, `anthropic-messages-codec.ts`, the family helper, and the SDK note.

### 5.4 Provider-agnostic guarantee

The change is confined to (a) the Anthropic-only `StreamInput.thinking` field and (b) the Anthropic codec/adapter. OpenAI chat, OpenAI Responses, chatgpt-oauth, and the cloud Anthropic-family adapters that route through `anthropic-messages-codec` (Bedrock/Vertex) all consume the same `thinking` object — and `normalizeModelFamily` already collapses their slugs, so a Bedrock `anthropic.claude-opus-4-8-v1:0` is correctly recognized as adaptive-capable. Non-Anthropic providers never read the field → zero behavioral change.

---

## 6. 테스트 계획

### 6.1 Hellgate — `tests/unit/anthropic-adaptive-thinking-hellgate.test.ts`

- **knob-off byte-identical:** `QUANTA_ADAPTIVE_THINKING` unset, model `claude-opus-4-8`, effort `high` → `applyEffortClassifierFloor` returns `{type:"enabled", budget_tokens:16384}`; codec wire carries exactly that (manual path unchanged on the default model).
- **knob-on, 4.6+ family → adaptive:** knob `=1`, model `claude-opus-4-8` (and 4-7/4-6/sonnet-4-6), effort `high` → returns `{type:"adaptive"}`; codec wire is `thinking:{type:"adaptive"}` and carries **no `budget_tokens`** (assert key absent).
- **knob-on, older model → fallback to manual:** knob `=1`, model `claude-sonnet-4-5` (and `claude-haiku-4-5`, `claude-3-7-sonnet-*`), effort `high` → returns `{type:"enabled", budget_tokens:16384}` (NOT adaptive) — proves per-model fallback, no 400 on older models.
- **no-think still no field:** effort `"default"`/budget 0, knob on OR off, any model → no `thinking` field at all (adaptive does not force thinking on when effort didn't ask). Byte-identical no-thinking wire.
- **family-normalization:** cloud/date/`@`/`-vN` slugs (`anthropic.claude-opus-4-8-v1:0`, `claude-opus-4-6@20251101`) → recognized adaptive-capable (reuse `normalizeModelFamily`); a garbage/unknown slug → NOT adaptive → manual fallback (fail-safe).
- **no-leak / no-crash:** adaptive request builds a valid `MessageCreateParamsStreaming` (assert it round-trips the codec without throw); the streamed `thinking_delta`/`signature_delta` still assemble into a `ThinkingBlock` with signature carried (reuse the existing `assemble-thinking` fixtures) — adaptive does not break Anthropic thinking-signature carryover.

### 6.2 Provider-isolation hellgate (reuse / extend)

- OpenAI + OpenAI-Responses adapters: build a `StreamInput` with `thinking:{type:"adaptive"}` present → the OpenAI wire is **identical** to a `thinking`-absent request (the field is dropped, no crash). Proves adaptive is Anthropic-only and cannot leak into OpenAI / break H15 reasoning-carryover (which runs on a disjoint Responses path).

### 6.3 Drift / regression

- Full `bun test` on the `assemble-thinking*`, `anthropic*`, `working-loop`, `streaming-dispatch`, `loop-skill-override` suites — the union widening must not regress any manual-budget assertion.
- `effortToTokenBudget` exhaustiveness guard unchanged (effort tiers still map to budgets used by the older-model fallback).

---

## 7. ROI

- **Repairs a latent live 400.** The default model (Opus 4.8) 400s on any non-zero manual budget *today* (§3.2). Adaptive is the documented, correct request shape for 4.6+ — this is a correctness fix wearing a feature's clothes. **High ROI.**
- **Better cost/quality.** Anthropic states adaptive outperforms fixed budgets on internal evals and auto-enables interleaved thinking; the model self-paces instead of burning a fixed budget. Cost: one widened union + one family helper (reusing an existing one) + one knob.
- **Low blast radius.** Disjoint from OpenAI/Responses; default-OFF byte-identical; the producer-side decision means the adapter is a no-op shaper.
- **Cost:** SDK-type friction (§8) is the only real cost — either a dependency bump (clean, also unlocks `effort`/`display`) or a single scoped cast (zero-dep, slightly less type-safe).

---

## 8. Open questions (honest)

1. **SDK version / how to type `{type:"adaptive"}` — THE KEY UNRESOLVED ITEM.** Installed `@anthropic-ai/sdk@0.40.1` has **no `ThinkingConfigAdaptive`** (§2.2, grep-verified). The wire JSON `{"type":"adaptive"}` is certainly correct (verified against the claude-api skill + migration guide), but satisfying the TS type requires either (a) bump the SDK to a release that types the adaptive arm — preferred, also unblocks `output_config.effort` + `display` — or (b) a local cast at the codec spread site. This RFC does **not** pre-pick; the SDK-bump blast radius (the adapter narrows a hand-rolled `RawEvent` union precisely to survive SDK churn, per `adapters/anthropic.ts:37`) must be measured first. **I could not confirm the exact minimum SDK version that adds `ThinkingConfigAdaptiveParam` from inside this repo** — that needs an `npm view @anthropic-ai/sdk` check before committing to option (a).
2. **Default polarity — OFF (byte-identical) vs ON-for-capable-families (repair).** §5.2: strict absorption discipline says default-OFF. But §3.2 shows the current default-on-Opus-4.8 path is *already broken* for non-zero budgets, so default-ON-for-4.6+-only is defensible as a bug-fix rather than a behavior change. Needs a product call (likely AskUserQuestion at implementation time): ship default-OFF and document the Opus-4.8 budget-400 footgun, or ship default-ON-for-adaptive-families as a repair.
3. **Also wire `output_config.effort`?** quanta maps effort → `budget_tokens` today; the modern Anthropic surface is `output_config:{effort:…}` (a separate top-level field, GA, combines with adaptive). Sending the named effort tier *as `effort`* (instead of, or in addition to, translating it to a token budget) is a larger follow-up — it would let quanta's `EffortLevel` map 1:1 to Anthropic's `low/medium/high/xhigh/max`. **Out of scope here** (this RFC only swaps the `thinking` object); flagged because it is the natural next slice and shares the same family-gate.
4. **`display:"summarized"`?** The 4.7+ default is `"omitted"` (empty thinking text). quanta's live-token-counter / thinking UI may want `display:"summarized"` to keep rendering reasoning. Trivial to add (a field on the adaptive arm) but it changes streamed content volume/cost — defer to a UI-driven follow-up.

---

## 9. 코드 위치 요약

**Touch:**
- `src/llm/types.ts` — widen `StreamInput.thinking` to the closed `ThinkingConfig` union (`enabled`|`adaptive`|`disabled`).
- `src/agent/loop/skill-gate.ts` — `applyEffortClassifierFloor` returns `{type:"adaptive"}` for adaptive-capable families when the knob is on; manual `{type:"enabled",budget_tokens}` otherwise (per-model fallback). Widen its return type to `{thinking?: ThinkingConfig}`.
- `src/llm/anthropic-messages-codec.ts` — spread is value-unchanged; add the SDK-type cast/bump (§4.3) at line 189.
- `src/shared/runtime-config.ts` — add `adaptiveThinking` (`QUANTA_ADAPTIVE_THINKING==="1"`, default false).
- `src/llm/factory.ts` (or new `src/llm/adaptive-thinking.ts` leaf) — `ADAPTIVE_THINKING_FAMILIES` + `supportsAdaptiveThinking(model)` reusing `normalizeModelFamily`. (A new leaf keeps `@/agent`→helper import off `@/llm/factory`'s heavier surface; either works — `skill-gate.ts` already imports from `@/agent`, and the helper is pure.)
- `tools/feature-catalog/features/08-llm/adaptive-thinking.yaml` — new catalog entry.
- `tests/unit/anthropic-adaptive-thinking-hellgate.test.ts` (+ provider-isolation extension) — new.

**Do NOT touch:** any OpenAI adapter, `responses-stream.ts` / `openai-responses-wire.ts` (H15 carryover is disjoint), `stream-consume.ts` (passes `thinking` through opaquely), the Anthropic response-side `ThinkingBlock`/signature carryover (unchanged by request shape).
