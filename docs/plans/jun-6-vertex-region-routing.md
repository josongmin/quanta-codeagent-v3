# RFC — per-model Vertex region routing (`VERTEX_REGION_<model>` map + fallback)

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-06
- Axis: `@/llm/providers` — `vertex` transport region resolution
- Default-OFF, byte-identical when no per-model region map is configured (single region,
  exactly as today).
- ROI: **LOW** — only matters to operators whose GCP project serves different Claude model
  slugs from different Vertex locations (a real but narrow data-residency / capacity case).

---

## 1. 요약 (Summary)

The Vertex adapter synthesizes its endpoint from ONE region: `gcpLocation`
(`vertex-adapter.ts:103-127`). Both `gcpProjectId` and `gcpLocation` are required, and
`gcpLocation` is a single string sourced from `CLOUD_ML_REGION`
(`factory.ts:368-369, 429-430`). But Vertex AI does NOT serve every Anthropic model slug in
every region — a given model is available in a SUBSET of locations, and capacity/quota
differ per region. An operator who runs (say) Opus from `us-east5` but Sonnet from
`europe-west1` cannot express that today: one `CLOUD_ML_REGION` forces all models through
one location, so a model not served there 404s.

This RFC adds an optional **per-model → region map** consulted before the single
`gcpLocation` fallback. The map is an env-derived `Record<modelSlug, region>` resolved at
the composition root and threaded into the adapter as plain config; absent ⇒ the single
region is used exactly as today (byte-identical). It is a small, closed change: one optional
config field, one resolution function, one constructor branch — no new SDK, no routing
churn.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

근거: 백로그 기술 + grep-verified GCP shape. Vertex AI is region-scoped: the endpoint path
is `projects/{id}/locations/{loc}/...` (`vertex-adapter.ts:6-13`), and Anthropic-on-Vertex
model availability is published per-location — not every model in every region. Cloud SDKs
(and the Claude CLI's Vertex path) let the location vary; the per-model granularity is the
gap. (No competitor's exact env-map shape is verified — marked as backlog-derived.)

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 Single region, hard requirement, no per-model map

`VertexProviderAdapter` constructor (`vertex-adapter.ts:91-132`):
- reads `config.auth.gcpProjectId` and `config.auth.gcpLocation` (`:103-104`);
- `location === undefined || length === 0` ⇒ typed `provider-misconfigured` "requires
  auth.gcpLocation" (`:112-118`);
- `this.clientOptions = { projectId, region: location }` (`:127`) — ONE region for ALL
  models; `region` is passed straight to `new AnthropicVertex({ region })` (`:140-157`).

`grep -rn "region\|gcpLocation\|VERTEX_REGION" src/llm` (excluding `.js`) confirms: `region`
is a single string everywhere; there is **no per-model map, no `VERTEX_REGION_*` env read.**

### 3.2 The env source — single `CLOUD_ML_REGION`

`MULTICLOUD_AUTH_ENV_KEYS.gcpLocation = "CLOUD_ML_REGION"` (`factory.ts:368`), and
`resolveMulticloudAuth` does one `pick(a.gcpLocation, "CLOUD_ML_REGION")`
(`factory.ts:429-430`) → the single `auth.gcpLocation`. There is one region knob, full stop.

### 3.3 Model is already known at construction

`config.model` is set on the adapter (`vertex-adapter.ts:119`) and the multicloud default
model is `vertex: "claude-sonnet-4-6@20250101"` (`factory.ts:354`). Since the adapter
already holds `model`, a per-model region lookup has everything it needs at construction —
no plumbing of the model into a new place.

---

## 4. 설계 (Design)

### 4.1 An optional per-model region map on the auth/config path

The region the adapter uses becomes: **`regionForModel[model] ?? gcpLocation`** (the map
wins per-model; the single location is the fallback). The map is an optional field threaded
in as plain config:

```ts
// provider-port.ts — ProviderConfig (the cloud-transport config struct)
readonly vertexRegionByModel?: Readonly<Record<string, string>>   // modelSlug → region
```

```ts
// vertex-adapter.ts — constructor, replacing the single `region: location` line
const region = config.vertexRegionByModel?.[config.model] ?? location
const opts: VertexClientOptions = { projectId, region }
```

- The existing `gcpLocation`-required guard STAYS (`:112-118`): the single region remains
  the mandatory fallback, so a model NOT in the map still resolves to a valid region (no
  silent "no region" hole). Absent map ⇒ `region === location` ⇒ **byte-identical to today**.
- The map is `Readonly<Record>` and consulted by exact `model` key (the same slug the wire
  sends), so there is no normalization ambiguity at the adapter — the composition root owns
  any normalization (§4.2).

### 4.2 Composition-root resolution (`VERTEX_REGION_<MODEL>` env → map)

The factory builds the map from env, the same way it builds the rest of `ProviderAuth`
(`factory.ts:410-443`), so the adapter slice never reads `process.env`:

```ts
// @/llm/factory — composition root
const VERTEX_REGION_PREFIX = "VERTEX_REGION_"      // e.g. VERTEX_REGION_CLAUDE_OPUS_4_8=us-east5
const resolveVertexRegionMap = (env: EnvLike): Record<string, string> | undefined => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(VERTEX_REGION_PREFIX) || v === undefined || v.length === 0) continue
    const slug = k.slice(VERTEX_REGION_PREFIX.length).toLowerCase().replaceAll("_", "-")
    out[slug] = v                                  // CLAUDE_OPUS_4_8 → claude-opus-4-8
  }
  return Object.keys(out).length > 0 ? out : undefined   // empty ⇒ undefined ⇒ no map
}
```

- `Object.entries(env)` over the injected `EnvLike` — **no `process.env`** (the SSOT
  invariant; `factory.ts:173-179`). The env is passed in by the composition root.
- Empty ⇒ `undefined` ⇒ the adapter sees no map ⇒ single-region path ⇒ byte-identical.
- The slug normalization (`CLAUDE_OPUS_4_8` → `claude-opus-4-8`) is done HERE so the adapter
  does an exact `[model]` lookup against the real model slug. (An explicit
  `opts.vertexRegionByModel` from a programmatic caller wins over the env-derived map, same
  precedence discipline as `resolveMulticloudAuth`.)

### 4.3 No SDK change, no routing change

`createMulticloudLLM` already constructs the Vertex adapter directly so it can inject
`credentialSource`/`clientFactory` (`factory.ts:519-524`, `buildVertex`). The region map is
just one more field on the `ProviderConfig` it builds — no new injection seam, no registry
change, no new transport.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF, byte-identical)

- `VERTEX_REGION_<MODEL_SLUG>` env vars (e.g. `VERTEX_REGION_CLAUDE_OPUS_4_8=us-east5`),
  surfaced in `--help` next to `CLOUD_ML_REGION`. **No var set ⇒ map is `undefined` ⇒
  `region === gcpLocation` ⇒ byte-identical to today.**
- Documented in `MULTICLOUD_AUTH_ENV_KEYS` adjacency (the canonical-names surface,
  `factory.ts:363-373`).
- No tool, no manifest row (transport config, not a model-facing tool).

### 5.2 Feature catalog (fc)

Extend the multicloud-providers / vertex fc node with a `per-model-region` bullet (or a small
`vertex-region-routing.yaml`): `depends_on: [vertex-adapter (ADR-0139)]`,
`labels: ["data-residency"]`, `status: planned`.

### 5.3 Slice / fence

- `src/llm/providers/vertex-adapter.ts` — one constructor line (the `??` lookup); imports
  unchanged.
- `src/llm/providers/provider-port.ts` — `vertexRegionByModel?` on `ProviderConfig`.
- `src/llm/factory.ts` — `resolveVertexRegionMap(env)`, set on the config in `buildVertex`'s
  upstream config assembly (composition root owns the env read). Plane-clean; no `@/agent`.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, `clientFactory`-injected — no GCP)

Inject a `clientFactory` that records the `region` it was constructed with:
- **map wins per-model:** `vertexRegionByModel: { "claude-opus-4-8": "us-east5" }`,
  `gcpLocation: "us-central1"`, `model: "claude-opus-4-8"` ⇒ client built with
  `region:"us-east5"`; same config with `model:"claude-sonnet-4-6"` (not in map) ⇒
  `region:"us-central1"` (fallback).
- **absent map ⇒ byte-identical:** no `vertexRegionByModel` ⇒ `region === gcpLocation`
  (assert the constructed region equals the single location, exactly today's behavior).
- **fallback still required:** `gcpLocation` absent + a map present but model NOT in it ⇒
  still typed `provider-misconfigured` "requires auth.gcpLocation" (the guard, `:112-118`,
  must not be weakened — a map is NOT a substitute for the mandatory fallback).
- **env-map parse:** `resolveVertexRegionMap({ VERTEX_REGION_CLAUDE_OPUS_4_8: "us-east5",
  CLOUD_ML_REGION: "us-central1" })` ⇒ `{ "claude-opus-4-8": "us-east5" }`; empty env ⇒
  `undefined`; a `VERTEX_REGION_*` with empty value ⇒ skipped (no garbage key).
- **explicit opts win over env map** (precedence parity with `resolveMulticloudAuth`).

### 6.2 e2e

Build a Vertex adapter via `createMulticloudLLM({ providerId:"vertex", model:"claude-opus-4-8",
vertexClientFactory: spy }, { VERTEX_REGION_CLAUDE_OPUS_4_8:"us-east5", CLOUD_ML_REGION:"us-central1",
ANTHROPIC_VERTEX_PROJECT_ID:"p" })` ⇒ assert the spy saw `region:"us-east5"`.

---

## 7. 단계 (Phasing)

- **Phase 1 — per-model env map (this RFC).** The `??` lookup, `resolveVertexRegionMap`, the
  retained fallback guard, hellgate. Default-OFF. Shippable unit.
- **Phase 2 — region fallback CHAIN.** Extend the value to an ordered list
  (`VERTEX_REGION_<MODEL>=us-east5,us-central1`) so a 404/quota error on the first region
  retries the next — composing with the existing same-turn retry classifier
  (`src/agent/retry.ts`). Only worth it if a per-region capacity failure is observed
  (measure-first, per the no-arbitrary-heuristic rule).

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **A wrong region 404s the model (primary failure mode it FIXES, and could re-introduce).**
  A misconfigured map entry pointing a model at a region that does not serve it 404s — but
  that is a config error surfaced as the existing typed wire error, no worse than today's
  single-region 404. The retained mandatory `gcpLocation` fallback (§4.1) guarantees there
  is always SOME valid region.
- **Slug-key drift.** The env-var-name→slug normalization (`CLAUDE_OPUS_4_8` →
  `claude-opus-4-8`) must match the real model slug. Mitigation: normalization lives in ONE
  place (§4.2), hellgate pins it, and a non-matching key simply falls through to the
  fallback region (safe).
- **ROI is low.** Per-model region routing matters only to multi-region GCP operators. Cost
  is also low — one constructor line + one env parser. Documented as low-ROI / low-cost.
- **Alternative — a single richer "model@region" slug** (Vertex already uses `model@version`,
  `factory.ts:354`). Rejected: overloading the model slug with region couples two
  orthogonal axes and breaks the `MULTICLOUD_DEFAULT_MODEL` map; an explicit region map is
  clearer and keeps the model slug meaning one thing.

---

## 9. 코드 위치 요약 (Code-location summary)

**Touch:**
- `src/llm/providers/vertex-adapter.ts:119-129` — `region = config.vertexRegionByModel?.[model]
  ?? location` (one line); keep the `:112-118` fallback guard.
- `src/llm/providers/provider-port.ts:97-110` — `vertexRegionByModel?` on `ProviderConfig`.
- `src/llm/factory.ts:363-373, 410-443, 519-524` — `resolveVertexRegionMap(env)` + thread
  into the Vertex `ProviderConfig`; `--help` adjacency in `MULTICLOUD_AUTH_ENV_KEYS`.
- `tools/feature-catalog/…/vertex-region-routing.yaml`.
- `…/__tests__/vertex-region-routing.hellgate.test.ts` (§6).

**Read-only (referenced):**
- `src/llm/providers/vertex-adapter.ts:91-157` — the single-region construction today.
- `src/llm/factory.ts:354, 368-369` — `vertex` default model + `CLOUD_ML_REGION` source.
