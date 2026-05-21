# ADR-0032 — OTel canonical attribute vocabulary

- **Status**: Accepted
- **Date**: 2026-05-21
- **Phase**: SOTA++ Codex absorption — observability vocabulary layer
- **Related**: ADR-0010 (observability trajectory, schema-in-shared rationale),
  ADR-0028 (apply_patch V4A — patch.* keys), ADR-0029 (reviewer 3-tier —
  permission.* keys), ADR-0030 (turn.kind / turn.steered),
  Codex notes [[codex-otel-attribute-vocabulary]],
  [[codex-feature-catalog-2026-05-21]] §M Telemetry.

## Decision

Introduce an OpenTelemetry-compatible **canonical attribute vocabulary** as a
standalone module under `@/observability`:

- `src/observability/vocabulary.ts` — two nested `as const` maps
  (`QUANTA_ATTRS`, `GEN_AI_ATTRS`), a derived string-literal union
  (`AttrKey`), and the OTel-spec `AttrValue` type.
- `src/observability/attrs.ts` — type-safe builder `attrs()` and merge helper
  `mergeAttrs()`, plus named span-shape builders (`turnAttrs`, `toolAttrs`,
  `permissionAttrs`). Validation throws a named `InvalidAttrValueError`
  (no silent drop, no fallback).

The vocabulary covers twelve `quanta.*` sub-namespaces (`conversation`,
`thread`, `turn`, `tool`, `mcp`, `task`, `multi_agent`, `memory`,
`permission`, `patch`, `rules`, `sqlite`) and the provider-neutral
`gen_ai.*` set (`request`, `response`, `usage`, `tool`, `system`).

## Rationale

Telemetry attribute keys are inherently string-typed at the wire layer, so
without a vocabulary they scatter across the codebase as raw literals —
typos, drift, and dashboard breakage follow. Codex ships 70+ canonical keys
with namespace prefixes and span hierarchies; the corresponding move for
quanta-v3 is a vocabulary module with compile-time enforcement.

- **Compile-time**: `AttrsInput = Partial<Record<AttrKey, AttrValue>>`. A
  typo'd key fails `tsc` at the emit site, not at runtime on a dashboard.
- **Runtime safety net**: `attrs()` re-validates keys against the canonical
  set and rejects disallowed value shapes (null/undefined/NaN/Infinity,
  objects, functions, heterogeneous arrays) with `InvalidAttrValueError`
  carrying `key`/`value`/`reason`. This protects against `as any` casts.
- **Provider neutrality**: `gen_ai.*` keys come straight from the OTel GenAI
  semconv (`gen_ai.usage.input_tokens` etc.), so any future OTLP exporter
  adapter (out of scope for this slice — see ADR-0010 "후속") is wire-level
  compatible without translation.
- **Standalone module**: deliberately imports nothing else under
  `src/observability/`. Existing `metrics.ts` / `logger.ts` / `types.ts`
  remain unchanged; migration to the vocabulary is a follow-up.

## Trade-offs

- **Gain**: typo elimination at compile time; canonical, sorted, frozen key
  list (`ALL_ATTR_KEYS`) for documentation and test introspection; named
  builders for the most common span shapes; zero new npm dependencies; pure
  module (no globals, no side effects on import).
- **Cost**: adding a new attribute key now requires touching
  `vocabulary.ts`. This is intentional friction — every new key gets review
  before it lands in dashboards. The `InvalidAttrValueError` runtime checks
  are O(entries) per `attrs()` call; negligible vs. JSONL serialization.
- **Non-goals**: no OTLP exporter, no global tracer provider, no migration
  of existing emitters in this slice. The vocabulary module is the *port*;
  adapters (jsonl-recorder, future OTLP) will consume it in subsequent PRs.

## Integration seam

This slice ships the vocabulary module only. Migration happens in follow-up
PRs that switch raw string literals to vocabulary references. Targets:

- `src/agent/metrics.ts` — `METRIC` name table → migrate per-counter names
  to vocabulary references where the key matches an attribute (counter
  names and attribute keys overlap conceptually). Search seam:
  `grep -rn "agent\\.\\|memory\\." src/agent/metrics.ts`.
- `src/agent/memory-stats.ts` — persist/recall/consolidate metric names →
  align with `quanta.memory.*` keys. Search seam:
  `grep -rn "memory\\." src/agent/memory-stats.ts`.
- jsonl-recorder (`src/stream/jsonl-recorder.*` and adapters) — span
  attribute writers should import `attrs()` and build via
  `QUANTA_ATTRS.*` / `GEN_AI_ATTRS.*` instead of bare strings. Search
  seam: `grep -rn "gen_ai\\.\\|quanta\\." src/stream`.
- LLM provider usage emission (`src/llm/openai/*`, `src/llm/anthropic/*`)
  — output `gen_ai.usage.input_tokens` /
  `gen_ai.usage.cache_creation_input_tokens` etc. via vocabulary. Search
  seam: `grep -rn "input_tokens\\|cache_creation" src/llm`.
- Permission layer (`src/permission/**`) on emit of reviewer outcome →
  `permissionAttrs()` (ADR-0029).
- Patch layer (`src/tool/apply-patch.*`) → `QUANTA_ATTRS.patch.*`
  (ADR-0028).

Migration steps per file:
1. `import { attrs, ... } from "@/observability/attrs"` (or vocabulary
   directly for raw key references).
2. Replace string literals with `QUANTA_ATTRS.<ns>.<key>` /
   `GEN_AI_ATTRS.<ns>.<key>`.
3. Wrap attribute composition with `attrs({...})`; let the type checker
   surface drift.
4. Add a vocabulary key (and a test in `vocabulary.test.ts`) if a needed
   attribute is missing — never inline a raw literal.

## Verify

- `tsc --noEmit` 0 errors (the `ExtractValues` derivation resolves to the
  expected string-literal union).
- `biome check` exit 0 on
  `src/observability/vocabulary.ts`,
  `src/observability/attrs.ts`,
  `tests/unit/observability/**`.
- `bun test tests/unit/observability` — all assertions pass; ≥ 30 cases.
