# RFC — 1-hour prompt-cache TTL (`cache_control: { ttl: "1h" }`)

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-06
- Axis: `@/llm` Anthropic Messages codec — cache-control retention
- Pair: composes with the **cache-control audit slice** (ADR-0319,
  `src/llm/cache-control-audit/`, grep-verified §3.3) which already proves prefix-byte
  stability — the prerequisite for ANY TTL to pay off.
- Default-OFF, byte-identical when the knob is unset (every `cache_control` stays
  `{ type: "ephemeral" }` with no `ttl`, i.e. the current 5-minute default).
- ROI: **HIGH** — long agentic sessions with gaps > 5 min currently re-pay full prompt
  cost on the next turn; a 1h TTL keeps the cached prefix warm across those gaps.

---

## 1. 요약 (Summary)

quanta marks its Anthropic prompt cache breakpoints with `cache_control: { type:
"ephemeral" }` and NOTHING else (`anthropic-messages-codec.ts:79-113`), which Anthropic
treats as the **default 5-minute TTL**. On a long interactive or agentic session, any gap
longer than 5 minutes (user thinking, a long tool exec, a paused turn) lets the cached
system+tools+history prefix expire, so the next turn re-processes the entire prefix at full
input price instead of the ~0.1× cache-read price. For a session with a large system prompt
+ many tools + a long transcript, that is the single largest avoidable token cost.

Anthropic's `cache_control` supports an explicit `ttl: "1h"` that holds the entry alive for
one hour. The write cost is higher (2× base for 1h vs 1.25× for 5-min), so it pays off only
when reads outnumber the extra write premium (break-even ≈ 3 requests against the prefix
within the hour vs ≈ 2 for 5-min). This RFC adds an opt-in `cacheTtl` knob that stamps
`ttl:"1h"` on the codec's existing breakpoints, gated by a **per-model allowlist** (the 1h
TTL and the cacheable-prefix minimum are model-dependent), with the default-OFF preserving
today's byte-identical 5-minute behavior. **No new `cache_control` breakpoint is added** —
the knob only changes the `ttl` field on the breakpoints the codec already places, so the
4-breakpoint cap and prefix layout are untouched.

---

## 2. 경쟁사 레퍼런스 (Anthropic — verified)

### 2.1 The `ttl` field + economics (verified via claude-api skill)

The Anthropic prompt-caching contract (verified against the bundled `claude-api` skill,
`shared/prompt-caching.md` § API reference):

```json
"cache_control": { "type": "ephemeral" }              // 5-minute TTL (default)
"cache_control": { "type": "ephemeral", "ttl": "1h" } // 1-hour TTL
```

- **Max 4 `cache_control` breakpoints per request** — unchanged; this RFC mutates the `ttl`
  on existing breakpoints, it does not add any.
- **Write cost: 1.25× for 5-min, 2× for 1-hour. Read cost ~0.1×.** Break-even: 5-min TTL
  pays off at 2 requests (1.25 + 0.1 vs 2× uncached); 1-hour needs ≥ 3 (2 + 0.2 vs 3×).
  So 1h is the right tool ONLY for bursty/gappy traffic where the prefix would otherwise
  expire between reads.
- **Minimum cacheable prefix is model-dependent**: Opus 4.8/4.7/4.6/4.5 + Haiku 4.5 = 4096
  tokens; Sonnet 4.6 = 2048; Sonnet 4.5 = 1024. A prefix below the minimum silently does NOT
  cache (`cache_creation_input_tokens: 0`) — so the allowlist (§4.3) is also where a
  too-short-prefix guard could live, but the TTL change itself is model-orthogonal.

**No special beta header is required for the 1h TTL on current models** — it is set directly
via `cache_control.ttl`. (The codec already wires `anthropic-beta` channels through
`betaHeaders` if a future model ever gates it, `adapters/anthropic.ts:112-121`.)

### 2.2 Verify-with-usage

The response `usage` reports `cache_read_input_tokens` / `cache_creation_input_tokens`;
quanta ALREADY parses both (`adapters/anthropic.ts:46-50, 197-204`), so the 1h-TTL payoff
is directly observable (a turn after a 10-min gap should show `cache_read_input_tokens > 0`
with `ttl:"1h"`, and `0` without). This is the e2e signal (§6).

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 Only the 5-minute ephemeral cache exists — no `ttl` anywhere

Two codec functions emit `cache_control`, both `{ type: "ephemeral" }` with no `ttl`:
- `toAnthropicSystem` (`anthropic-messages-codec.ts:79-88`): for a `SystemBlock` with
  `cache:true`, emits `cache_control: { type: "ephemeral" as const }` (`:86`).
- `cacheConversationPrefix` (`:90-113`): finds the last text block of the last message and
  stamps `cache_control: { type: "ephemeral" }` (`:106-109`).
`grep -rn "ttl\|1h\|cache_control" src/llm` (excluding `.js`) confirms: every
`cache_control` in the codec is the bare 5-minute form; **no `ttl` field is emitted
anywhere.** The request builder threads both through `buildAnthropicMessagesRequest`
(`:150-171`).

### 3.2 `SystemBlock.cache` is the only cache signal today

`SystemBlock = { type:"text"; text:string; cache?:boolean }` (`types.ts:144-148`):
`cache:true` marks "everything up to here is byte-stable, cache here" — a boolean, no TTL
dimension. There is no place in the wire types to express "cache here FOR 1 hour."

### 3.3 The cache-control AUDIT slice already exists (the prerequisite)

`src/llm/cache-control-audit/analyzer.ts` (ADR-0319) reports whether the bytes up to each
`cache_control` breakpoint are byte-stable across turns — "ANY drift is reported"
(`analyzer.ts:1-35`). This is the precondition for a 1h TTL to be worth paying for: a
drifting prefix invalidates the cache regardless of TTL, so the audit slice and this RFC
compose (audit proves stability; 1h TTL extends the payoff window). This RFC does NOT
duplicate the audit — it consumes its guarantee.

### 3.4 `promptCacheRetention` exists — but it is OpenAI-only and a DIFFERENT axis

`StreamInput.promptCacheRetention?: PromptCacheRetention` where `PromptCacheRetention =
"in-memory" | "24h"` (`types.ts:293-296`, `llm-route-types.ts:23`). The doc says "extended
prompt-cache retention knob for compatible **OpenAI** surfaces" (`types.ts:293-294`). This
is the OpenAI Responses `prompt_cache` retention, NOT Anthropic `cache_control.ttl` — a
different vendor, different field, different value set ("24h" vs "1h"). The Anthropic codec
(`anthropic-messages-codec.ts`) does NOT read `promptCacheRetention`. So Anthropic 1h TTL is
genuinely absent; the existing field is a distinct OpenAI seam (honest: do not conflate).

---

## 4. 설계 (Design)

### 4.1 A `cacheTtl` adapter knob (`"5m" | "1h"`), default `"5m"`

The cleanest seam is at the codec, because the codec already owns every breakpoint. Add an
optional `cacheTtl` to the Anthropic codec call path:

```ts
export type CacheTtl = "5m" | "1h"                 // closed union (matches Anthropic's two)

const ttlControl = (ttl: CacheTtl): { type: "ephemeral"; ttl?: "1h" } =>
  ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }
```

`"5m"` produces the EXACT current object `{ type: "ephemeral" }` (no `ttl` key — verified
byte-identical to `:86, :108`). `"1h"` adds `ttl:"1h"`. Both `toAnthropicSystem` and
`cacheConversationPrefix` take `ttl: CacheTtl = "5m"` and call `ttlControl(ttl)` instead of
the inline literal. **Default `"5m"` ⇒ no `ttl` key ⇒ byte-identical wire payload** — this
is the sacred default-OFF guarantee, enforced at the literal-construction site.

### 4.2 Threading the knob (config flows DOWN, no `process.env` in the slice)

The adapter holds a `cacheTtl` set ONCE at construction (mirroring `betaHeaders` /
`streamTimeoutMs`, `adapters/anthropic.ts:98-106`):

```ts
interface AnthropicConfig { …; cacheTtl?: CacheTtl }   // absent ⇒ "5m"
```

`AnthropicAdapter` reads `config.cacheTtl ?? "5m"` and passes it into
`buildAnthropicMessagesRequest(model, maxTokens, input, cacheTtl)`, which forwards it to the
two codec functions. The composition root (`@/llm/factory`) resolves the knob from the env
and threads it as plain config — the codec/adapter slice NEVER reads `process.env` (the
`runtimeConfig()` SSOT invariant; the factory already resolves `serviceTier`/`reasoningEffort`
this way, `factory.ts:186-208`). The shared providers (`default-adapter.ts`,
`foundry`/`vertex`/`bedrock`, which all route through `buildAnthropicMessagesRequest`) get
the knob via `ProviderConfig.cacheTtl?` the same way.

### 4.3 Per-model allowlist (the load-bearing safety)

The factory gates the 1h request behind a model allowlist, because (a) the cacheable-prefix
minimum is model-dependent (§2.1) and (b) a future model might not honor `ttl:"1h"` (a
provider that ignores an unknown `cache_control` field would silently fall back to 5-min,
not error — but the allowlist makes the intent explicit and auditable):

```ts
// @/llm/factory — composition-root policy (NOT in the wire slice)
const CACHE_1H_ALLOWLIST: ReadonlySet<string> = new Set([
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "claude-sonnet-4-6", "claude-haiku-4-5",
])
const resolveCacheTtl = (model: string, env: EnvLike): CacheTtl =>
  env.QUANTA_PROMPT_CACHE_TTL === "1h" && CACHE_1H_ALLOWLIST.has(model) ? "1h" : "5m"
```

A model not on the list ⇒ `"5m"` even with the knob set (silently safe, byte-identical to
today for that model). The allowlist is a `prefix`-tolerant check in practice (a date-suffixed
or `anthropic.`-prefixed cloud slug normalizes to the family) — but the closed set is the SSOT
and adding a model is a one-line, OCP-friendly change.

### 4.4 No new breakpoint; the 4-cap and layout are untouched

Critically, this RFC mutates ONLY the `ttl` on the breakpoints the codec ALREADY places
(`:86`, `:108`). It does not add a breakpoint, does not change which block is cached, does
not touch the prefix layout. So the 4-breakpoint cap (§2.1), the cache-control-audit
stability guarantee (§3.3), and the 20-block lookback window are all preserved verbatim. The
1h TTL is purely a retention extension on the existing markers.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF, byte-identical)

- `QUANTA_PROMPT_CACHE_TTL` (`"5m"` | `"1h"`, default `"5m"`) in `runtime-config.ts` beside
  `mcpSampling`/`mcpRoots` (`runtime-config.ts:606-611`). Unset OR `"5m"` ⇒ `ttlControl`
  emits `{ type: "ephemeral" }` with NO `ttl` key ⇒ **byte-identical wire payload to today**.
- `"1h"` takes effect ONLY when the resolved model is on `CACHE_1H_ALLOWLIST` (§4.3).
- No tool, no manifest row (this is a wire-codec knob, not a model-facing tool).

### 5.2 Feature catalog (fc)

Add a `prompt-cache-1h-ttl.yaml` node under the LLM/caching subsystem:
`depends_on: [cache-control-audit (ADR-0319)]`, `labels: ["absorbed:anthropic",
"cost-optimization"]`, `status: planned`. (`fc` = feature axis.)

### 5.3 Slice / fence (where it lives)

- `src/llm/anthropic-messages-codec.ts` — `CacheTtl`, `ttlControl`, the `ttl` param on
  `toAnthropicSystem` / `cacheConversationPrefix` / `buildAnthropicMessagesRequest`. Imports
  unchanged (only `@anthropic-ai/sdk` + `@/shared/errors` + `./types`).
- `src/llm/types.ts` — `cacheTtl?: CacheTtl` on the Anthropic adapter config path (or reuse a
  shared `CacheTtl` export); `provider-port.ts` `ProviderConfig.cacheTtl?` for the cloud
  transports.
- `src/llm/adapters/anthropic.ts` — hold `cacheTtl` at construction, forward to the builder.
- `src/llm/factory.ts` — `CACHE_1H_ALLOWLIST` + `resolveCacheTtl(model, env)`, threaded into
  the adapter config (composition root owns the env read).
- No `@/agent` touch. The codec stays plane-clean.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, pure codec — no wire)

- **default byte-identical:** `cacheTtl` absent / `"5m"` ⇒ `buildAnthropicMessagesRequest`
  output is DEEP-EQUAL to the pre-feature output (assert the system block + last-message
  block carry exactly `{ type:"ephemeral" }` with NO `ttl` key — a structural snapshot, the
  sacred guarantee).
- **`"1h"` stamps both breakpoints:** `cacheTtl:"1h"` ⇒ the `cache:true` system block AND
  the conversation-prefix block both carry `{ type:"ephemeral", ttl:"1h" }`; NO OTHER block
  gains a `cache_control` (the 4-cap and layout are untouched — count breakpoints == count
  before).
- **allowlist gate:** `resolveCacheTtl("some-future-model", {QUANTA_PROMPT_CACHE_TTL:"1h"})`
  ⇒ `"5m"` (off-list ⇒ no `ttl`); on-list model ⇒ `"1h"`. Date-suffixed / `anthropic.`-prefixed
  slug of an allowed family normalizes to allowed.
- **no extra breakpoint under the cap:** a message with NO text block ⇒
  `cacheConversationPrefix` returns messages unchanged (the `textIdx === -1` path, `:105`)
  regardless of `cacheTtl` (1h must not invent a breakpoint where there was none).
- **empty / string-content edge:** `messages.length === 0` and string-content last message
  return unchanged with EITHER ttl (the early returns `:91, 96` must not regress).
- **idempotent:** a message already carrying `cache_control` is not double-stamped.

### 6.2 e2e (usage-observed, replay)

Drive a 2-turn replay where turn 2 follows a simulated >5-min gap. With `ttl:"1h"`, the
recorded turn-2 `usage` shows `cache_read_input_tokens > 0`; with `"5m"` (and the simulated
gap), it shows `cache_creation_input_tokens > 0, cache_read_input_tokens == 0` (cold
re-write). Uses the existing usage parse (`adapters/anthropic.ts:197-204`) — no new
accounting. (Replayed/deterministic, not a live billing test.)

---

## 7. 단계 (Phasing)

- **Phase 1 — codec `ttl` + allowlist (this RFC).** `CacheTtl`/`ttlControl`, the knob, the
  allowlist, hellgate + replay e2e. Default-OFF. Shippable unit; immediate cost win for
  long sessions on allow-listed models.
- **Phase 2 — adaptive TTL.** Auto-select `"1h"` only when the session has shown a gap
  pattern (e.g. the loop observed an inter-turn gap approaching 5 min) so quanta pays the 2×
  write premium ONLY when it would otherwise have missed — turning a static knob into a
  measured policy (consistent with the project's "no arbitrary heuristic; measure first"
  rule — gate on an OBSERVED gap, not a guess).
- **Phase 3 — pre-warm.** Tie a `max_tokens:0` pre-warm (the verified Anthropic pre-warm
  shape) to session start when `ttl:"1h"` is active, eliminating first-request cache-miss
  latency. Pure additive.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **The 2× write premium can LOSE money (primary risk).** 1h TTL is only a win when reads
  against the prefix outnumber the extra write cost (break-even ≈ 3 requests within the
  hour). On short, single-shot, or rapid-fire sessions (turns < 5 min apart) the 5-min TTL
  is already kept warm by traffic and 1h just pays more for writes. Mitigation: **default-OFF**
  (opt-in only), the Phase-2 adaptive policy (pay 1h only on an observed gap), and clear docs.
  Never the default.
- **Prefix drift defeats ANY TTL.** A drifting system prompt (date, session id) invalidates
  the cache regardless of TTL. Mitigation: this RFC composes with the cache-control-audit
  slice (§3.3), which already detects drift — the two ship as a pair, and the audit is the
  honest "is 1h even worth it" check.
- **Too-short prefix silently won't cache.** Below the model minimum (§2.1), neither TTL
  caches and the 2× write premium is wasted on nothing. The allowlist is model-keyed; a
  follow-up could add a measured-prefix-size guard, but the codec change is orthogonal and
  safe (a non-caching request with `ttl:"1h"` is identical cost to one with `"5m"` — the
  premium only applies on an actual write).
- **A future model that ignores `ttl:"1h"`** silently falls back to 5-min (no error). The
  allowlist makes the intent explicit and keeps unknown models on `"5m"` until vetted.
- **Conflation with the OpenAI `promptCacheRetention` field (§3.4).** Honest separation: the
  OpenAI `"24h"` retention is a different vendor/field. This RFC adds an Anthropic-only
  `cacheTtl`; it does NOT touch `promptCacheRetention`. Naming them distinctly avoids drift.
- **Alternative — a top-level auto-cache `ttl`.** Anthropic supports `cache_control` on
  `messages.create()` itself (auto-placement). quanta deliberately places breakpoints
  explicitly (`:86, :108`) so the cache-control-audit can reason about them; switching to
  auto-cache would forfeit that. Rejected — the codec-level `ttl` keeps explicit placement.

---

## 9. 코드 위치 요약 (Code-location summary)

**Touch:**
- `src/llm/anthropic-messages-codec.ts:79-113, 150-171` — `CacheTtl`, `ttlControl`, `ttl`
  param on `toAnthropicSystem` / `cacheConversationPrefix` / `buildAnthropicMessagesRequest`.
- `src/llm/adapters/anthropic.ts:11-30, 104-129` — `cacheTtl?` on `AnthropicConfig`, hold at
  construction, forward to the builder.
- `src/llm/types.ts` (+ `src/shared/llm-route-types.ts`) — export `CacheTtl`; the Anthropic
  config carries it. (Leave `PromptCacheRetention` / `promptCacheRetention` untouched —
  different axis, §3.4.)
- `src/llm/providers/provider-port.ts:97-110` — `ProviderConfig.cacheTtl?` for cloud
  transports that share the Anthropic codec.
- `src/llm/factory.ts:186-208` — `CACHE_1H_ALLOWLIST` + `resolveCacheTtl(model, env)`,
  threaded into adapter config.
- `src/shared/runtime-config.ts:606-611` — `QUANTA_PROMPT_CACHE_TTL` flag.
- `tools/feature-catalog/…/prompt-cache-1h-ttl.yaml`.
- `…/__tests__/prompt-cache-ttl.hellgate.test.ts` + replay e2e (§6).

**Read-only (referenced):**
- `src/llm/cache-control-audit/analyzer.ts:1-35` — the prefix-stability prerequisite.
- `src/llm/adapters/anthropic.ts:46-50, 197-204` — `cache_read`/`cache_creation` usage parse
  (the payoff signal).
