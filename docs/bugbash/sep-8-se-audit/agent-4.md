# Sep-08 SE audit — agent-4 (Lane E)

> **Fact-check snapshot:** `f5f4875799141068af73e604129c8b9a09f76007`
> **Scope:** `src/llm`, `src/retrieval`, `src/runner`, `src/skill`, `src/rules`
> **Disposition:** unresolved, reachable defects only. Product code is not fixed here.

## Retained findings

| ID | Pri | Owner | Required result |
|---|---:|---|---|
| E-PROV-01 | P2 | `src/llm/factory.ts`, boot/status projection | Report the transport that actually builds the LLM. |
| E-SEARCH-01 | P2 | `src/runner/assemble/search-index-backend.ts` | Explicit store initialization failure must be observable and consumed. |
| E-EMBED-01 | P2 | `src/runner/assemble/search-index-backend.ts` | Never mix a 64-dimensional hash vector into a provider-dimensional index. |
| E-KNOB-01 | P3 | `src/runner/knobs/knobs/{read-outline,test-runner}.ts` | Bench telemetry must use the runtime's canonical boolean vocabulary. |

### E-PROV-01 — status provider differs from the live transport (P2)

- **Trigger:** select a cloud transport with `CLAUDE_CODE_USE_BEDROCK=1` (or the
  sibling Vertex/Foundry/Mantle selectors) while the legacy provider resolver
  selects Anthropic/OpenAI/ChatGPT OAuth.
- **Two current authorities:** `pickProvider` only resolves the legacy credential
  provider (`src/llm/factory.ts:424-445`). The production main-LLM wire separately
  calls `selectLlmTransport` (`src/apps/cli/internal.ts:192-205,437-457`), whose
  canonical cloud ladder is `src/runner/assemble/llm.ts:446-480`.
- **Reachable consumers:** `/status` and doctor still call `pickProvider`
  (`src/apps/cli/status-cmd.ts:57-83`,
  `src/apps/cli/doctor/default-probes.ts:32-44`) while the session can build the
  Bedrock/Vertex/etc. adapter.
- **Measured result at the snapshot:** with `QUANTA_PROVIDER=anthropic` and
  `CLAUDE_CODE_USE_BEDROCK=1`, status resolution is `anthropic` and live transport
  resolution is `bedrock`.
- **Impact:** operator diagnostics can report the wrong provider/auth posture and
  claim an Anthropic key is missing while the active session uses cloud credentials.
- **Smallest correction:** expose one boot selection DTO containing both legacy
  provider and resolved transport, and have status/doctor render the effective
  transport. Keep transport selection owned by the existing registry; do not copy
  its env ladder into status.
- **Regression rail:** for every cloud selector, assert the booted adapter and
  status/doctor effective provider are identical; keep a no-cloud legacy control.

### E-SEARCH-01 — explicit store failure stays `ready` and becomes empty search (P2)

- **Trigger:** set a valid explicit store (`sqlite`, `lance`, or `qdrant`) and let
  store construction, capability negotiation, or remote operations fail.
- **Owner evidence:** `buildVectorStoreRuntime` returns `null` on unavailable store
  or negotiation failure (`src/runner/assemble/search-index-backend.ts:604-640`).
  The returned backend nevertheless has static `state:"ready"` and converts a null
  explicit runtime into `[]`/no-op operations (`:800-857`).
- **Reachable consumers:** `src/runner/assemble/search-pipeline.ts:222-247` and
  `src/host/runtime/internal/mention-symbol-deps.ts:140-153` consume only the port.
  There is no production read of `SemanticBackend.state` or `stateReason`; the only
  readers are tests.
- **Existing rail gap:** T06 covers an invalid spelling and asserts `state:"failed"`
  (`tests/unit/runner/t06-search-backend-failclosed-hellgate.test.ts:35-85`). B7
  proves a valid explicit Lance capability mismatch returns zero hits but does not
  require a failed state
  (`tests/unit/runner/search-index-backend.test.ts:414-432`).
- **Impact:** an explicitly requested index can accept the production wire as
  `ready` while silently dropping upserts and returning no matches. Logs are not a
  machine-consumed health contract.
- **Smallest correction:** make async initialization failure reach a typed failing
  port/readiness result and require both production consumers to refuse or surface
  it. Do not fall back to a different store for an explicit selection.
- **Regression rail:** valid explicit selection + injected create/capability failure
  must be distinguishable at the consumer and must not report ready; include a
  successful explicit-store control.

### E-EMBED-01 — long-input fallback changes vector dimension (P2)

- **Trigger:** a recognized provider embed call fails for a chunk larger than 32
  KiB. The default line-window chunker limits lines, not bytes, so a generated or
  minified line reaches this path (`src/retrieval/indexer/chunker.ts:32-67`).
- **Owner evidence:** `fallbackHeadless` preserves provider dimension but constructs
  a stub with the default 32-KiB input cap
  (`src/runner/assemble/search-index-backend.ts:239-255` and
  `src/retrieval/engines/embedder/headless-stub.ts:13-16,52-74`). When that fallback
  returns `input-too-large`, `resolveIndexEmbedder` returns 64-dimensional
  `hashEmbed` (`search-index-backend.ts:294-325`). In-memory cosine explicitly
  truncates mismatched dimensions with `Math.min` (`:349-354`).
- **Measured result at the snapshot:** an injected 1536-dimensional provider that
  returns an error for a 32,769-byte string yields a vector of length 64.
- **Impact:** in-memory ranking compares incompatible vectors and can silently
  reorder results; fixed-dimension stores reject/drop the upsert.
- **Smallest correction:** the fallback must either return the negotiated provider
  dimension for every admitted chunk or fail the operation explicitly. Do not use
  `hashEmbed` after a provider-dimensional index has been selected.
- **Regression rail:** inject a 1536-dimensional failing provider and input just over
  32 KiB; require a 1536-dimensional fallback or a typed failure, never length 64.

### E-KNOB-01 — `yes` is active at runtime but inactive in bench reports (P3)

- **Trigger:** run bench with `QUANTA_READ_OUTLINE=yes` or
  `QUANTA_TEST_RUNNER=yes`.
- **Owner evidence:** both knob parsers accept only `1|on|true`
  (`src/runner/knobs/knobs/read-outline.ts:17-23`,
  `test-runner.ts:17-23`). Runtime uses the canonical truthy set that also includes
  `yes` (`src/shared/env-flag.ts:24-40,60-74`). `resolveBenchKnobs` classifies a
  rejected unit-less flag as inactive (`src/runner/batch/eval/knobs-bench.ts:83-135`)
  and that list is persisted into report metadata.
- **Measured result at the snapshot:** both runtime flags are `true`, while bench
  resolves neither knob and lists both ids in `inactive`.
- **Impact:** the feature remains enabled, but benchmark provenance says it was not
  active, invalidating configuration comparisons.
- **Smallest correction:** parse both knob values with `isTruthyToken` (the existing
  shared vocabulary) and remove the local `ENABLING` sets.
- **Regression rail:** table-test all canonical true/false/unrecognized tokens across
  `runtimeConfigFromEnv` and `resolveBenchKnobs`; require identical activation and
  report classification.

## Verification

- `git rev-parse HEAD` → `f5f4875799141068af73e604129c8b9a09f76007`
- `bun test tests/unit/runner/search-index-backend.test.ts tests/unit/runner/t06-search-backend-failclosed-hellgate.test.ts tests/unit/llm-providers/claude-use-quartet-wiring-hellgate.test.ts` → pass
- Direct knob probe → runtime `{readOutline:true,testRunner:true}` but bench
  `resolved:[]`, `inactive:["read-outline","test-runner"]`
- Direct provider probe → status `anthropic`, live transport `bedrock`
- Direct long-input embed probe → negotiated provider dimension 1536, returned
  fallback dimension 64
