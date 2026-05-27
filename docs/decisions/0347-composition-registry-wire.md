# ADR-0347 — Composition-root session-keyed registry wire

## Status
Accepted. Slice landed: process-level singleton + `assemble.ts` 1-line swap + hellgate.

## Context

ADR-0345 shipped `createInMemorySessionResourceRegistry({maxEntries?, idleTtlMs?})` and a closed-port `SessionResourceRegistry` but stopped at the slice boundary — composition roots were not updated. The four ADR-0334 composition roots therefore still mint a FRESH `{store, cache}` pair on every `installCodexR2Wires` call:

```ts
// src/apps/agent/assemble.ts (before ADR-0347)
installCodexR2Wires(cfg, {
  sessionId,
  systemPromptCache: createInMemorySystemPromptCache(),  // ← fresh
  store: createInMemoryTypedHistoryEventStore(),         // ← fresh
  …
})
```

Same-`sessionId` re-assemble (session restart, control-op resume, repeated `assembleAgentConfig` within one process) therefore observes:

- **Zero prior typed-history events** — every `context_update / mode_change / repo_rules_change / skill_activation / reasoning_echo / compaction_event` accumulated on the prior assemble call is unreachable.
- **Zero system-prompt cache hits** — the new `SystemPromptCachePort` starts empty even though the same `sessionId` was just warm.

Both regressions are silent: the loop runs, the model gets a system prompt, the observability surface just shows misses where there should be hits.

This ADR is the production wire that closes the gap.

## Decision

Introduce a **process-level lazy-init singleton** for `SessionResourceRegistry` in a new file `src/agent/session-resource-registry/global.ts`, then swap the fresh-each-call factories in `src/apps/agent/assemble.ts` for one `registry.getOrCreate(sessionId)` lookup.

### Why Option A (process-level singleton) over Option B (caller-side) or C (AgentConfig slot)?

- **Option B (each composition root owns its own instance)** defeats the whole point of ADR-0345 — same `sessionId` across CLI repl restarts or web-daemon-vs-CLI co-tenancy would NOT reuse anything because the instances would be distinct.
- **Option C (AgentConfig opt-in slot)** pushes ownership to the caller. Reasonable in theory but every caller would either (a) wire the singleton themselves or (b) skip the option — yielding no reuse. Same effect with more boilerplate.
- **Option A (process-level singleton)** is the minimal viable contract: one registry per node process, every composition root reads from it. This is what `single-process, multi-assemble` actually means.

### Why lazy-init?

Test isolation. With an eager `export const registry = …()` the registry would be constructed at module-import time and every test file importing this module would see the same Map. Lazy-init + `resetGlobalSessionResourceRegistry()` gives tests a clean reset knob while production code still pays the construction cost exactly once.

### Why only `assemble.ts`?

The four ADR-0334 composition roots have different deps policies:

| Root | Deps policy (ADR-0334) | ADR-0347 action |
|---|---|---|
| `src/apps/agent/assemble.ts` | **rich** (cache pair + store + context-events) | **swap fresh factories → registry lookup** |
| `src/apps/agent/run.ts` | belt-and-suspenders (idempotent under pre-filled) | no change (caller-override precedence) |
| `src/apps/agent/mode-presets/interactive.ts` | documentary install (slots intact) | no change |
| `src/apps/bench/eval/driver.ts` | EMPTY deps (byte-identical bench cfg) | **no change** (replay determinism) |

The lifecycle (`run.ts`) and mode preset (`interactive.ts`) are idempotent under the slots that `assemble.ts` has already filled (ADR-0332). They do not need to query the registry themselves. The bench driver INTENTIONALLY stays empty-deps so replay determinism is preserved — registry-backed state is by definition non-deterministic across runs.

### sessionId guard

`assemble.ts` consults the registry **only when `cfg.sessionId !== undefined`**. The fallback path keeps the prior fresh-factory behaviour, preserving ADR-0334 §A2 ("absent sessionId ⇒ cache pair NOT wired, store-side slots STILL wired").

## Implementation

`src/agent/session-resource-registry/global.ts` exports:

```ts
export const getGlobalSessionResourceRegistry = (): SessionResourceRegistry
export const resetGlobalSessionResourceRegistry = (): void
```

The barrel `src/agent/session-resource-registry/index.ts` re-exports both. The default `createInMemorySessionResourceRegistry()` is used with no config (unbounded, no TTL) — production knobs are a follow-up.

`src/apps/agent/assemble.ts` change (atomic):

```diff
+ import { getGlobalSessionResourceRegistry } from "@/agent/session-resource-registry"
…
+ const sessionResources =
+   cfg.sessionId !== undefined ? getGlobalSessionResourceRegistry().getOrCreate(cfg.sessionId) : null
  installCodexR2Wires(cfg, {
    …(cfg.sessionId !== undefined ? { sessionId: cfg.sessionId } : {}),
-   systemPromptCache: createInMemorySystemPromptCache(),
-   store: createInMemoryTypedHistoryEventStore(),
+   systemPromptCache: sessionResources?.cache ?? createInMemorySystemPromptCache(),
+   store: sessionResources?.store ?? createInMemoryTypedHistoryEventStore(),
    …
  })
```

## Invariants

1. **Same `sessionId` reuse** — two `assembleAgentConfig({base: {…sessionId: "X"}})` calls in one process return cfgs whose `systemPromptCache` is the SAME reference and whose `store` (hidden inside install closures) is also reused. The registry's `peek("X")` returns the same `SessionResources` reference.
2. **Distinct `sessionId` isolation** — different ids yield distinct resources; registry size == number of distinct ids.
3. **Absent `sessionId`** — registry not consulted, fresh fallback factories used, ADR-0334 §A2 preserved.
4. **Caller-override precedence** — caller-supplied `systemPromptCache` on `req.base` always wins (ADR-0332 install helper preserves pre-filled slots).
5. **Bench replay determinism** — `apps/bench/eval/driver.ts` still calls `installCodexR2Wires(config, {})` with empty deps; the registry is never touched on the bench path.
6. **Lazy-init + reset** — first `getGlobalSessionResourceRegistry()` constructs; tests call `resetGlobalSessionResourceRegistry()` between cases.

## Non-goals

- **`run.ts` / `interactive.ts` mutation** — caller-override precedence makes them inert; touching them would not improve reuse and would invade the ADR-0334 belt-and-suspenders contract.
- **Bench wiring** — replay determinism trumps cache economics on the bench path.
- **Config knobs on the singleton** — `maxEntries` / `idleTtlMs` stay at their default (absent). A follow-up ADR can expose env-var or settings-file knobs without changing the call-site shape.
- **Disk persistence** — separate ADR (sqlite/jsonl, Codex `logs_2.sqlite` reference pattern).
- **Cross-process / distributed sharing** — out of scope (Redis-class). Process-local only.
- **`prompt.ts` / `loop.ts` mutation** — user in-flight; this ADR does not touch them.

## Tests

`tests/unit/composition-registry-wire-hellgate.test.ts` — 9 cases across §A–§G covering singleton identity, reset semantics, same-`sessionId` reuse, distinct-id isolation, absent-`sessionId` fallback, caller-override precedence, and bench empty-deps invariant. The slice's own port contract (LRU / TTL / peek-readonly) stays covered by `src/agent/session-resource-registry/__tests__/registry.hellgate.test.ts`.

## Follow-ups

- Expose `maxEntries` / `idleTtlMs` via settings or env var if a real production workload requires bounded reuse.
- Disk-backed registry adapter (sibling factory, separate ADR).
- Observability hook on the registry (counter for hit/miss) folded into the existing system-prompt cache audit (ADR-0326).
