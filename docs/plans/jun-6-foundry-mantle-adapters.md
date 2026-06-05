# RFC — Mantle real adapter (Foundry already shipped) — provider-port `stream()` graduation

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-06
- Axis: `@/llm/providers` transport adapters (ADR-0139 provider port)
- **CORRECTION to the backlog premise**: the task framed BOTH `foundry` and `mantle`
  as Phase-1 stubs. **Foundry is NOT a stub — it shipped a real stream (ADR-0172,
  grep-verified §3.1).** Only `mantle` remains a throw-only stub. This RFC is therefore
  scoped to **Mantle alone**, and explains why Foundry is already done.
- Default-OFF, byte-identical when the `mantle` transport is not selected.
- ROI: **LOW** — Mantle has no public SDK/wire spec; this is a "ready-to-graduate seam",
  not a today-shippable wire.

---

## 1. 요약 (Summary)

The ADR-0139 provider port carves *transport* (Bedrock / Vertex / Foundry / Mantle) away
from *vendor grammar* (Anthropic Messages), and the registry + multicloud factory already
dispatch to all five (`registry.ts:45-55`, `createMulticloudLLM` `factory.ts:467-505`).
The backlog said Foundry and Mantle were both Phase-1 stubs that throw `provider-unsupported`
at stream time. **That is now stale for Foundry**: `foundry-adapter.ts` is a full ADR-0172
implementation — lazy `@anthropic-ai/foundry-sdk` import, `clientFactory` DI, real
`client.messages.create({stream:true})`, `mapRawEvent` decode, typed auth/misconfig errors
(`foundry-adapter.ts:205-358`). The registry factory even constructs `FoundryProviderAdapter`
directly (`registry.ts:49`).

**Mantle is the only remaining stub** (`mantle-adapter.ts:34-64`): it constructs cleanly,
exposes `providerId:"mantle"` for telemetry, and `stream()` immediately throws
`ProviderError("provider-unsupported", …)`. It cannot graduate today because Anthropic
Mantle has **no public SDK or wire spec** (the adapter header documents this,
`mantle-adapter.ts:1-28`). This RFC designs the **graduation seam**: the exact `stream()`
implementation, the `ProviderAuth` extension (`mantleToken?` / `mantleEndpoint?`), and the
lazy-SDK + `clientFactory` DI shape — all mirroring the shipped Foundry/Vertex/Bedrock
adapters — so the day the Mantle surface lands, the change is "drop in `openRawStream`,
extend `ProviderAuth` by two fields", with zero registry/factory/routing churn.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

### 2.1 Anthropic enterprise transports — the verified pattern this slice follows

근거: 백로그 기술 + grep-verified sibling adapters. Anthropic publishes per-transport SDKs
that re-export the public `Anthropic` client with transport-specific URL + auth:
- `@anthropic-ai/vertex-sdk` → `AnthropicVertex` (shipped, `vertex-adapter.ts:140-148`),
- `@anthropic-ai/foundry-sdk` → `AnthropicFoundry` (shipped, `foundry-adapter.ts:115-139`,
  validated against `KNOWN_PUBLISHED_VERSION = "0.2.3"`, `:63`),
- Bedrock SDK → `AnthropicBedrock` sibling.
Each keeps the SAME Anthropic Messages wire grammar; only transport + auth differ
(`provider-port.ts:1-19`). **Mantle is the one enterprise fork with no published SDK** as of
2026-05-24 — the name surfaces only via the Claude-CLI env switch `CLAUDE_CODE_USE_MANTLE`
and internal docs (`mantle-adapter.ts:5-8`). So the competitor reference here is the
*shape* of the three shipped siblings, which Mantle's graduation copies 1:1.

### 2.2 Why a separate Mantle adapter (not Foundry reuse) — verified rationale

The Mantle stub header documents the decision: telemetry parity. The router emits
`providerId:"mantle"` so dashboards distinguish Mantle traffic (different billing units,
residency boundaries) from Foundry; Mantle and Foundry graduate on different release
schedules, so a shared throw-only base would couple them (`mantle-adapter.ts:21-28`).

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 Foundry — REAL, not a stub (backlog premise is stale)

`FoundryProviderAdapter` (`foundry-adapter.ts:211-358`) is a complete ADR-0172 stream:
- lazy SDK resolver `tryImportFoundrySdk()` collapsing all failures to `null`
  (`:115-129`), `isFoundryAdapterReady()` predicate (`:135-139`);
- `clientFactory` DI seam for tests (`:100-106, 242-258`), identical to Vertex/Bedrock;
- `validateConfig` — `resource` xor `baseURL`, `azureApiKey` or `azureADTokenProvider`
  required, typed `provider-misconfigured` (`:144-172`);
- real `client.messages.create(buildAnthropicMessagesRequest(...), {signal})` with Azure
  auth-error mapping (`:292-323`);
- `stream()` decoding via `withStreamTimeout` + `mapRawEvent` (`:325-357`).
`registry.ts:49` wires `foundry: (config) => new FoundryProviderAdapter(config)`, and the
`ProviderAuth` Azure fields are documented as live (`provider-port.ts:56-68`). **Foundry
needs nothing from this RFC.** (Honest verdict: the Foundry half of the backlog item is
SUPERSEDED — already implemented.)

### 3.2 Mantle — the actual stub

`MantleProviderAdapter` (`mantle-adapter.ts:34-64`):
- constructor accepts `config`, checks `providerId==="mantle"`, sets `this.model` (`:42-51`);
- `stream()` is `// biome-ignore lint/correctness/useYield` + immediate
  `throw new ProviderError("provider-unsupported", "Mantle adapter is Phase 2 — …no public
  SDK as of 2026-05-24", { providerId:"mantle" })` (`:56-63`).
No lazy SDK, no `clientFactory`, no auth. The header explicitly states Phase 2 extends
`ProviderAuth` with `mantleToken?` / `mantleEndpoint?` when the spec is public (`:13-18`).

### 3.3 Routing already dispatches to Mantle (the seam is wired, the impl is empty)

- `ProviderId` closed union includes `"mantle"` (`provider-port.ts:34`).
- `FACTORIES.mantle = (config) => new MantleProviderAdapter(config)` (`registry.ts:54`),
  with the OCP comment "Phase 2 swaps the adapter implementation with zero registry churn"
  (`:50-53`).
- `MULTICLOUD_DEFAULT_MODEL.mantle = "claude-sonnet-4-6"` (`factory.ts:351-357`).
- `createMulticloudLLM` routes `default/foundry/mantle` through `resolved.factory(config)`
  verbatim (`factory.ts:500-504`) — so a `providerId:"mantle"` today builds the stub and
  throws on first `stream()`. The classifier treats `not_implemented`/`provider-unsupported`
  as FATAL-but-fallback-eligible (`src/agent/retry.ts:145-158`, `FALLBACK_KINDS`), so a
  Mantle selection cleanly advances a fallback chain rather than crashing — the stub's
  design intent.

### 3.4 `ProviderAuth` has NO Mantle fields yet

`ProviderAuth` (`provider-port.ts:70-83`) carries `apiKey`, AWS×4, GCP×3, Azure×4 — **no
`mantleToken` / `mantleEndpoint`**. That extension is the prerequisite the stub header
names (`mantle-adapter.ts:13-18`) and §4.2 designs.

---

## 4. 설계 (Design)

### 4.1 The `stream()` graduation — mirror the shipped siblings exactly

`MantleProviderAdapter` graduates to the SAME four-part shape Foundry/Vertex/Bedrock use:

```ts
export class MantleProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "mantle"
  readonly provider = "anthropic"
  readonly surfaceId = "anthropic-messages"
  readonly transportId = "mantle"
  readonly authMode = "Anthropic Mantle"
  readonly model: string
  private readonly clientOptions: MantleClientOptions
  private readonly maxTokens: number
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }
  private readonly clientFactory: MantleClientFactory | undefined

  constructor(config: ProviderConfig, options: MantleAdapterOptions = {}) {
    validateConfig(config)                          // providerId + auth presence (§4.3)
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
    this.streamTimeoutMs = resolveAdapterStreamTimeouts({ … })  // shared/, as siblings
    this.clientOptions = buildClientOptions(config)
    if (options.clientFactory !== undefined) this.clientFactory = options.clientFactory
  }

  private async resolveClient(): Promise<MantleClientLike> { /* lazy import OR DI factory */ }
  private async openRawStream(c, input): Promise<AsyncIterable<RawEvent>> { /* messages.create */ }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (input.signal?.aborted) throw new LLMError("Mantle stream aborted before stream open", { kind: "aborted" })
    const client = await this.resolveClient()
    const raw = await this.openRawStream(client, input)
    const guarded = withStreamTimeout(raw, { firstChunkMs, idleMs, provider: "anthropic",
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onChunk ? { onChunk: input.onChunk } : {}) })
    const open: OpenSlots = new Map()
    for await (const ev of guarded) yield* mapRawEvent(ev, open, { model: this.model })
  }
}
```

This is a structural copy of `foundry-adapter.ts:211-357` with `Mantle`/`mantle`
substituted — the request builder (`buildAnthropicMessagesRequest`), the decoder
(`mapRawEvent`), the timeout wrapper, and the abort short-circuit are all shared,
because **the wire grammar is identical Anthropic Messages** (`provider-port.ts:1-19`).

### 4.2 `ProviderAuth` extension (the one shared-type change)

Add two OPTIONAL fields, exactly as the stub header prescribes
(`mantle-adapter.ts:13-18`):

```ts
export interface ProviderAuth {
  …existing…
  /** mantle transport — bearer minted/issued by the Mantle gateway. */
  readonly mantleToken?: string
  /** mantle transport — full base URL of the Mantle endpoint (gateway-specific). */
  readonly mantleEndpoint?: string
}
```

Optional ⇒ every other transport ignores them ⇒ byte-identical (the port already keeps ONE
auth struct so a multi-transport fallback chain hands down ONE bundle, `:36-40`). The
multicloud env-key map (`factory.ts:363-373`) gains two rows
(`mantleToken:"ANTHROPIC_MANTLE_TOKEN"`, `mantleEndpoint:"ANTHROPIC_MANTLE_BASE_URL"`) and
`resolveMulticloudAuth` (`:410-443`) gains two `pick(...)` lines — same pattern as the Azure
rows.

### 4.3 Lazy-SDK + `clientFactory` DI (no dep added today)

`resolveClient()` mirrors `foundry-adapter.ts:241-287`:
- if `clientFactory` set ⇒ use it (test path; wrap in the same try/catch so a DI-thrown
  auth error lands in the same typed bucket as a live ctor failure);
- else `await import("@anthropic-ai/mantle-sdk")` (or whatever the real package is named —
  pinned to a `MANTLE_SDK_PACKAGE` const like `FOUNDRY_SDK_PACKAGE`, `foundry-adapter.ts:56`),
  collapsing import failure to a typed `provider-missing-dependency` (NOT a crash), exactly
  as Foundry does (`foundry-adapter.ts:259-267`).
**No dependency is added by this RFC** — the package does not exist publicly yet. The lazy
import means the slice compiles and the stub-replacement is inert until the SDK is installed,
preserving the default-OFF posture (selecting `mantle` without the SDK throws a typed
`provider-missing-dependency` that the fallback chain handles — strictly better than today's
`provider-unsupported`, and the same UX Foundry already gives, `foundry-adapter.ts:259-266`).

### 4.4 `validateConfig` (typed, before the wire)

```ts
const validateConfig = (config: ProviderConfig): void => {
  if (config.providerId !== "mantle") throw new ProviderError("provider-misconfigured", …)
  const hasToken = config.auth.mantleToken !== undefined && config.auth.mantleToken.length > 0
  if (!hasToken) throw new ProviderError("provider-misconfigured",
    "mantle transport requires auth.mantleToken (auth-failed)", { providerId: "mantle" })
}
```

Mirrors Vertex's "missing required field ⇒ typed misconfig at construction"
(`vertex-adapter.ts:99-118`) so the failure surfaces at factory-wiring time, not first wire.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF, byte-identical)

Selection is the EXISTING transport ladder — no new knob to graduate Mantle:
- explicit `providerId:"mantle"` via `QUANTA_LLM_TRANSPORT`/CLI, OR an env signal. Add a
  `mantle` row to the resolver precedence ladder (`registry.ts:113-163`) keyed on
  `ANTHROPIC_MANTLE_BASE_URL` (+ the `CLAUDE_CODE_USE_MANTLE` Claude-CLI mirror via
  `isTruthyEnv`, exactly as Foundry added `QUANTA_USE_FOUNDRY`/`CLAUDE_CODE_USE_FOUNDRY`,
  `registry.ts:74-81, 148-159`).
- **Unset ⇒ resolver never returns `mantle` ⇒ the stub/real adapter is never constructed ⇒
  byte-identical.** The legacy `createLLM` vendor path is wholly untouched
  (`factory.ts:316-334` documents the legacy axis stays byte-identical).

### 5.2 Feature catalog (fc)

The multicloud-providers fc node already lists the five transports. Flip the Mantle row's
`status` from `stub`/`planned` to `seam-ready` (and on graduation, `live`); add
`depends_on: [@anthropic-ai/mantle-sdk]`. No tool-surface manifest change (transports are
not model-facing tools).

### 5.3 Slice / fence (where it lives)

- `src/llm/providers/mantle-adapter.ts` — replace the throw-only body with §4.1 (imports
  only `../adapters/anthropic` re-exports, `../adapters/shared`, `../stream-timeout`,
  `../types`, and the port — identical import set to `foundry-adapter.ts:41-52`; **no
  `@/agent`**, plane-clean).
- `src/llm/providers/provider-port.ts` — the two-field `ProviderAuth` add (§4.2).
- `src/llm/factory.ts` — two env-key rows + two `pick(...)` lines (§4.2).
- `src/llm/providers/registry.ts` — one Mantle precedence row (§5.1); the
  `FACTORIES.mantle` entry already exists (`:54`).

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, fake client injected via `clientFactory`)

Reuse the Foundry hellgate battery shape (it already exercises this exact DI seam):
- **scripted stream round-trips:** a `clientFactory` yielding a canned `RawEvent[]`
  (message_start → text_delta → message_delta(stop) ) ⇒ `stream()` emits the matching
  `StreamEvent`s + terminal `usage`/`message_stop` (parity with the Anthropic decode).
- **auth-fail (DI):** factory throws `Error("AccessDenied")` ⇒ typed
  `provider-misconfigured` (not a raw leak), symmetric with `foundry-adapter.ts:248-257`.
- **missing-dependency:** no `clientFactory` AND the lazy import fails ⇒ typed
  `provider-missing-dependency` (NOT a crash) — the fallback chain advances.
- **misconfig:** `mantleToken` absent ⇒ typed `provider-misconfigured` at construction.
- **pre-aborted signal ⇒ `aborted`** (not `provider-unsupported`) — mirrors the Foundry
  abort short-circuit decision (`foundry-adapter.ts:331-336`).
- **default-OFF byte-identical:** with no Mantle env signal the resolver returns
  `default`/`foundry`/etc., never `mantle`; assert the adapter is never constructed.
- **transport badge:** `providerId==="mantle"` on the constructed adapter (telemetry parity,
  the whole reason for a separate adapter, `mantle-adapter.ts:21-28`).

### 6.2 Differential parity

A 50-case fuzz feeding the SAME `RawEvent` sequences through the Foundry fake and the Mantle
fake asserts byte-identical `StreamEvent` output — proving the only difference is transport,
not grammar (the ADR-0139 invariant).

---

## 7. 단계 (Phasing)

- **Phase 0 — Foundry: DONE** (ADR-0172, §3.1). No work.
- **Phase 1 — Mantle seam (this RFC, SDK-absent).** `ProviderAuth` +2 fields, `validateConfig`,
  lazy-import skeleton, `clientFactory` DI, registry precedence row, fc `seam-ready`. Selecting
  `mantle` without the SDK throws typed `provider-missing-dependency` (better UX than today's
  `provider-unsupported`). Default-OFF. **This is the shippable unit** — it is graduation-ready,
  not live.
- **Phase 2 — Mantle live (when the SDK/spec publishes).** Pin `MANTLE_SDK_PACKAGE` +
  `KNOWN_PUBLISHED_VERSION`, add a `mantle-watch.ts` drift probe (mirror `foundry-watch.ts`),
  fill `openRawStream` with the real `messages.create`, flip fc to `live`. Zero
  registry/factory/routing churn (the OCP promise, `registry.ts:50-53`).

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **No public Mantle SDK/spec (the dominant constraint).** This is why Phase 1 is a *seam*,
  not a live wire. Faking the grammar now would risk locking in a wire shape that shifts
  before GA — exactly the reasoning the stub header gives (`mantle-adapter.ts:5-12`). The
  lazy-import design means the seam compiles and stays inert until the dep exists.
- **Backlog premise was stale (Foundry).** Documented honestly: Foundry already shipped
  (ADR-0172). Implementing it would be a no-op double-build; the RFC scopes to Mantle only.
- **Telemetry coupling.** Keeping a separate `MantleProviderAdapter` (vs. a shared
  throw-stub base) costs a little duplication but preserves the `providerId:"mantle"` badge
  and lets Mantle/Foundry graduate independently — the documented trade-off
  (`mantle-adapter.ts:21-28`). Accepted.
- **`ProviderAuth` widening.** Two optional fields on the shared struct; exactOptional honest
  (absent ⇒ ignored by every other transport). Same widening Foundry's Azure fields already
  did (`provider-port.ts:79-82`) — low-risk, byte-identical for non-Mantle paths.
- **ROI is low.** Mantle is a niche enterprise residency fork with no public surface today.
  Cost is also low — the entire impl is a 1:1 copy of the shipped Foundry adapter plus two
  auth fields. Documented as low-ROI / low-cost / high-readiness.
- **Alternative — delete the Mantle stub until the SDK lands.** Rejected: the registry's
  closed `ProviderId` union and the multicloud default-model map already reference `mantle`
  (`provider-port.ts:34`, `factory.ts:357`); deleting the adapter would break the OCP
  closed-union contract and force a registry edit on graduation. The throw-stub → seam-ready
  → live progression is cheaper and keeps the union honest.

---

## 9. 코드 위치 요약 (Code-location summary)

**Touch (Mantle graduation):**
- `src/llm/providers/mantle-adapter.ts` — replace throw-only `stream()` with the
  Foundry-shaped real adapter (§4.1, §4.3, §4.4).
- `src/llm/providers/provider-port.ts:70-83` — `mantleToken?` / `mantleEndpoint?` on
  `ProviderAuth`.
- `src/llm/factory.ts:363-373, 410-443` — two `MULTICLOUD_AUTH_ENV_KEYS` rows + two
  `resolveMulticloudAuth` `pick(...)` lines.
- `src/llm/providers/registry.ts:113-163` — one Mantle precedence row (+ `CLAUDE_CODE_USE_MANTLE`
  mirror).
- `src/llm/providers/mantle-watch.ts` — Phase 2 drift probe (mirror `foundry-watch.ts`).
- `tools/feature-catalog/…/multicloud-providers.yaml` — Mantle row `seam-ready`→`live`.
- `…/__tests__/mantle-adapter.hellgate.test.ts` (§6).

**Read-only (referenced — the patterns copied, NOT re-modified):**
- `src/llm/providers/foundry-adapter.ts:56-358` — the SHIPPED template (ADR-0172).
- `src/llm/providers/vertex-adapter.ts:78-213` — sibling (auth-required-field misconfig).
- `src/llm/providers/registry.ts:45-55` — `FACTORIES.mantle` already wired.
- `src/agent/retry.ts:145-158` — `FATAL_KINDS`/fallback handling of `not_implemented`.
