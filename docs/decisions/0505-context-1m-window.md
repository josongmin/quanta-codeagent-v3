# ADR-0505: 1M-context window opt-in (Anthropic `context-1m` beta)

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/llm/context-1m.ts` (`resolveContext1M`, `CONTEXT_1M_BETA`)
  - `src/llm/factory.ts` (anthropic arm wiring)
  - Tests: `tests/unit/context-1m-hellgate.test.ts`, `tests/unit/context-1m-factory-e2e-hellgate.test.ts`
  - Absorbs: Claude long-context beta (gap-other-agent GAP 3)

## Context

Anthropic gates a 1M-token context window behind the `context-1m-2025-08-07` beta header on
eligible models (sonnet-4-5/4-6). quanta always offered the 200k default and had no opt-in
seam to request the larger window.

## Decision

`resolveContext1M(rawModel, env)` returns `{ model, active, betaHeader?, windowKey }`. A 1M
request is expressed either by a `[1m]` model-id suffix OR `QUANTA_CONTEXT_1M`; eligibility is
DERIVED (not hardcoded) by checking `${model}-1m ∈ MODEL_CONTEXT_WINDOWS`. The factory strips
`[1m]` from the API model id, de-dups the beta header against caller-supplied betas, and only
attaches it when active+eligible. Default-OFF: no suffix, no knob ⇒ no beta header, the API
model id is unchanged (byte-identical). The compaction-window-metadata bump (so the loop
compacts at 1M rather than 200k) is the documented separate plumbing follow-up.

## Consequences

The server grants 1M when the header is present; the conservative 200k compaction threshold
remains until the metadata bump lands (never incorrect, only under-utilizes the grant).
