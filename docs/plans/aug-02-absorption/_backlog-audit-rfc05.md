# RFC-05 backlog audit vs CURRENT code (2026-08-10)

**Basis:** `/Users/songmin/quanta-codeagent-v3` main. Read-only. The RFC-05 plan doc says
"NOT started" (README status STALE). **That is wrong now** — a concurrent session landed the
full RFC05-0/1/2/3 stack (D1 + D2). Files timestamped Aug 5. This report grounds each sub-item
in the CURRENT tree.

The Round-1 mandate greps re-run confirm the STALE assumption is dead:
- `grep -rn "model_providers\|customProvider\|wire_api" src/` → 0. But that only means the
  *Codex TOML token spelling* is absent; the CONCEPT ships under quanta-native names
  (`openaiEndpoints`, `wireApi` camelCase, `EndpointWireApi`). The hit-0 was a spelling artifact.
- `grep -rni "ollama\|lmstudio" src/ | grep -i chat` → **HIT** `src/llm/endpoint-transport.ts:44`
  (`LocalPresetKind = "ollama" | "lmstudio"`, chat presets). No longer embed-only.

---

## D1 — declarative custom provider config (base_url + wire_api + headers, no code adapter)

**Verdict: ALREADY-BUILT (end-to-end wired, tested, green).**

Evidence (control plane → data plane → composition → surface):
- Schema: `src/config/types.ts:100` `EndpointWireApi="chat"|"responses"`, `:106`
  `EndpointNetworkPolicy="public_https"|"loopback_local"`, `:114` `ENDPOINT_SECRET_REFS=["endpoint_api_key"]`,
  `:123` `OpenAIEndpointOptions{baseUrl,wireApi,model,networkPolicy,authRef?,headerRefs?,query?}`,
  `:155` `openaiEndpoints?` on the security band, `:193` resolved `openaiEndpoints` on `ResolvedSettings`.
- Parse/fail-closed: `src/config/loader.ts:188` `parseOneEndpoint` (any bad field ⇒ DROP whole endpoint),
  `:142` `parseHeaderRefs` rejects any non-allowlisted ref, `:225` null-prototype accumulator (`__proto__` safe).
- Merge + trust gate: `src/config/merge.ts:178-184` — `openaiEndpoints` is treated as LOOSENING;
  **dropped for an untrusted repo layer** (`dropLoosening`), id-keyed deterministic replace. This is the
  anti-hostile-repo gate the plan's S1 demanded, and it is real (not merged-then-flagged).
- Network admission (SSRF): `src/shared/net/ssrf.ts:215` `NetworkPolicy`, `:279` `admitEndpointUrl`
  (`public_https` ⇒ https+public-resolved only; `loopback_local` ⇒ http/https+loopback only; arbitrary
  private LAN refused for BOTH), redirect-hop re-check + DNS-rebinding resolver (`:318` `HostResolver`).
- Shared data plane: `src/llm/endpoint-transport.ts:102` `buildEndpointFetch` — ONE guarded fetch both
  wires share (via `fetchWithSsrfGuard`), `:144` `redactEndpointForDiagnostics` (only id/wire/model/
  policy/host/header-COUNT into logs; secret values never serialized).
- Selection/composition: `src/runner/assemble/llm.ts:574` `resolveConfiguredEndpoint` (materializes
  symbolic refs → concrete header VALUES, fail-closed on unresolved ref), `:630`
  `composeEndpointCreateLLMOptions` (spreads `baseURL`+explicit `surface`+guarded `fetchImpl`;
  **undefined ⇒ byte-identical `{model}`** legacy shape).
- Factory seam: `src/llm/factory.ts:79` `fetchImpl?` on `CreateLLMOptions`, `:151` plumbed into BOTH
  OpenAI wires (Chat `OpenAIAdapter` + Responses); absent ⇒ SDK default global fetch (byte-identical).
- CLI surface: `src/apps/cli/configured-endpoint-wire.ts:43` `resolveEndpointSecrets` (ONLY place a
  `QUANTA_ENDPOINT_API_KEY` becomes a value), selection via `QUANTA_LLM_ENDPOINT` knob
  (`src/config/knob-inventory/extra.ts:796-803`). `src/apps/cli/internal.ts:505` routes it directly.
- Tests green (ran locally, 77 pass / 0 fail): `central-config-openai-endpoints-hellgate`,
  `ssrf-classifier-hellgate`, `endpoint-transport-parity-hellgate`, `assemble-llm-endpoint-selection-hellgate`.

**Minimal delta / improvement:** essentially none for the core. Two honest gaps vs the Codex feature
surface, both DELIBERATELY scoped OUT by the plan (not accidental):
- `request_max_retries` per-endpoint: NOT built (plan excluded it until a common transport-retry owner
  exists — retry stays SDK `maxRetries:2` / RecoveryRouter). Low ROI; leave as-is.
- `env_http_headers` maps to a FIXED allowlist (`endpoint_api_key` only), NOT arbitrary env names. This
  is the anti-exfil design, correct. A hostile endpoint cannot reference `ANTHROPIC_API_KEY`. Do NOT
  loosen to arbitrary env names — that would reintroduce the A1 credential-exfil hole.

**ROI:** N/A (done). Any further work here is subtraction of safety, not addition. **DROP from backlog.**

---

## D2 — local OSS chat providers (ollama / lmstudio as CHAT, not embed)

**Verdict: ALREADY-BUILT — and D1 subsumes it exactly as the plan predicted.**

Evidence:
- `src/llm/endpoint-transport.ts:53` `LocalPresetKind="ollama"|"lmstudio"`, `:58` loopback base URLs
  (ollama `127.0.0.1:11434/v1`, lmstudio `127.0.0.1:1234/v1`), `:71` `localEndpointPreset(kind,model,baseUrl?)`
  → a named `OpenAIEndpointOptions` pinned to `wireApi:"chat"`, `networkPolicy:"loopback_local"`, NO auth.
  Pure config sugar over D1 — no new adapter, no local chat grammar, no provider registry. This is chat,
  distinct from the embed-only `src/retrieval/engines/embedder/ollama-embedder.ts` (still Embedder port, not LLMPort).
- No-auth contract: `composeEndpointCreateLLMOptions` (llm.ts) feeds the SDK ctor a fixed non-secret
  `ENDPOINT_NO_AUTH_SENTINEL` when the loopback endpoint has no token (local server ignores it).
- **Live smoke is REAL and PASSED on this machine**: `tests/unit/llm/local-preset-smoke-hellgate.test.ts`
  Part 2 drives the REAL `OpenAIAdapter` against a running Ollama; run output:
  `live smoke PASS — events=5 kinds=tool_use_start,tool_use_delta,tool_use_end,usage,message_stop toolCall=true`.
  Honest reachability: SKIP (never faked) when no server answers. The tool-call parity risk (plan A5,
  the one genuinely non-trivial part of D2) is proven against the actual server, not a cassette guess.
- Red-on-injection present: a non-loopback base-URL override under the preset is refused with
  `SsrfGuardError` (test line ~40) — the preset cannot smuggle traffic to a remote host.

**Minimal delta / improvement:** none required. Optional nicety (LOW ROI): a user-facing CLI preset
shortcut (e.g. `--provider ollama:llama3.1`) instead of hand-setting `QUANTA_LLM_ENDPOINT`+config — pure
ergonomics, no correctness gap. No server model-listing/health grammar (deliberately excluded — correct).

**ROI:** N/A (done, live-proven). **DROP from backlog.**

---

## A6 — Responses-over-WebSocket turn transport (measure-first, separate track)

**Verdict: GAP for the turn transport (as designed — LAST, separate, measure-first). Partial substrate exists.**

Evidence:
- A WS *event decoder* exists: `src/llm/streaming-events.ts:264` `decodeWsEvent(raw)` (single WS text
  message → `DecodedProviderEvent`), exported at `src/llm/index.ts:142`. But it is a DECODER only —
  `grep` shows NO caller drives an LLM turn through it (only the barrel re-export).
- NO turn transport: `grep -rn "WS_TRANSPORT" src/ tests/` → 0. `QUANTA_LLM_WS_TRANSPORT` knob does
  not exist. No `new WebSocket` in any LLM turn path. No connection-generation / prior-response-chain /
  reconnect-replay framing in `src/llm/`.
- The `src/realtime/` module (`types.ts:13` `RealtimeStatus` 4-state, `headless-stub.ts`) is a
  SEPARATE Codex-parity realtime/audio slice (SDP/RTCPeerConnection, ADR-0230) — NOT the Responses-turn
  transport A6 describes. Do not conflate.

**Minimal delta / improvement (if ever pursued):** the decoder substrate (`decodeWsEvent` + the SSE
decoder sharing `liftKind`) is a real head-start — a stateful `LlmProvider` speaking the public
Responses-WS framing could reuse it. But A6 remains: (1) pin the public protocol version, (2) build the
`{connectionGeneration,turnId,priorResponseId,inFlightState}` session with typed reconnect semantics
routed to the existing RecoveryRouter (no WS-internal SSE fallback), (3) A/B on our SWE-bench f2p before
any default-ON. Effort L.

**ROI:** LOW / speculative. No efficacy evidence for WS latency/cost on our workload. The plan's own
stop-rule holds: do not start until D1/D2 demand is shown AND a measurement harness exists. **KEEP in
backlog as separate measured track; do NOT start.**

---

## What Round 2 (adversarial) changed vs Round 1

Round 1's naive re-run of the mandate's hit-0 greps (`model_providers`/`wire_api` = 0) would have
FALSELY reported D1 as a GAP. Round 2 refuted that by searching for the concept under a different name:
quanta uses `openaiEndpoints`/`wireApi`/`EndpointWireApi`, not Codex's snake_case TOML tokens. That
flipped D1 and D2 from apparent-GAP to ALREADY-BUILT. Round 2 also confirmed D2 is genuinely subsumed by
D1 (ollama/lmstudio = loopback presets, live-proven, not a separate adapter), and verified the SSRF /
trust-gate / secret-allowlist safety the original plan flagged (A1 exfil, A2 SSRF, S1 vacuous-gate) are
all actually implemented and load-bearing — not theater. The only surviving real GAP is A6, and it is a
GAP by design (separate measured track), with a decoder substrate already present but unwired.
