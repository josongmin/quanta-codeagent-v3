# ADR-0172: Tool-call collapse / dedup — closed-port `ToolCallCache` with `[from_cache]` model-transparency marker

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0144 (metrics registry primitive), ADR-0160 (tool instrument wrap — sibling), ADR-0161 (monitoring full coverage), ADR-0167 (PlanQueue collapse counter — sibling "expose dedup as observable signal" pattern)
- **참조**: `src/observability/metrics/instrument-tool-dedup.ts`, `src/observability/metrics/instrument-tool.ts` (sibling), `src/observability/metrics/port.ts` (MetricsRegistry), `tests/unit/observability-metrics-instrument-tool-dedup-hellgate.test.ts`

## 맥락

The loop frequently re-issues identical read-only tool calls within a single turn (model second-guesses a `read`/`grep`/`glob` it already saw) or across consecutive turns when the conversation churns the same observation. No SOTA agent solves tool-CALL dedup as a first-class primitive — every "cache" we audited operates at a different layer:

| Agent | Cache they DO have | Tool-call dedup? |
|---|---|---|
| Cursor | `Idempotent{,SSE,Poll}` RPC variants (`docs/analysis/경쟁사리뷰/code-agent-loop/cursor.md` §1) | ❌ — REQUEST-level retry safety (resending same RPC), not tool-CALL within a turn |
| Cursor | Merkle subtree reconciliation (`cursor-localization.md` §5/§17) | ❌ — FILE dedup (path-hash keying), not call dedup |
| Claude Code | `cache_read_tokens` + `cache_control:{type:"ephemeral"}` ×4 breakpoints (`claude.md` §3) | ❌ — PROMPT-prefix cache; tool calls always re-execute |
| Codex | `cache/codex_apps_tools/{hash}.json` (`codex.md` §V) | ❌ — offline tool-SCHEMA cache; no runtime call cache |

Result: every wasted re-call burns latency + tokens + (sometimes) external rate-limit budget; the operator has no observable signal showing how much.

## 결정

A closed-port `ToolCallCache` + a sibling instrument wrap `instrumentToolWithDedup` that, on a cache hit within TTL, SKIPS the wrapped `Tool.execute` and yields the cached `ToolResult` — with the model-facing `output` PREFIXED by a `[from_cache] ` marker.

### Part 1 — `ToolCallCache` port

```ts
export interface ToolCallCache {
  computeKey(toolName: string, input: unknown, ctx: ToolContext): string
  get(key: string): ToolResult | null   // null = miss (incl. stale)
  set(key: string, result: ToolResult): void
  clear(): void
}
```

Pure / typed / total. Implementations decide their own TTL/eviction policy; callers swap the impl freely.

### Part 2 — Default in-memory LRU + TTL impl

```ts
defaultToolCallCache({ maxEntries = 200, ttlMs = 30_000, now = Date.now })
```

- Key composition: `sha256("toolName|stableStringify(input)|ctx.cwd")`. `stableStringify` sorts object keys at every level for deterministic output (key order in the input MUST NOT change the cache key); a small `WeakSet`-based walker handles cycles + `bigint` defensively (key generation MUST be total).
- LRU via Map insertion order (`get` re-inserts to move to tail; `set` evicts from head on overflow).
- TTL is lazy: `get` checks `now() - storedAt > ttlMs` and drops inline (no separate sweeper — no timers in this module).

### Part 3 — `instrumentToolWithDedup` wrap

- **Cache MISS**: forwards every event from the wrapped tool verbatim (byte-identical to `instrumentTool()`'s forwarding) AND, after the terminal `result`, populates the cache.
- **Cache HIT**: wrapped tool's `execute` is NOT called; yields a SINGLE `{type:"result", result}` event whose `output` is `[from_cache] ` + the cached output; increments `tool.call.dedup_collapse.total{tool}` by 1.
- Default cacheability predicate: `tool.isReadOnly() && tool.isConcurrencySafe(input) && tool.hitlTier?.(input) !== "always-confirm"`. Caller overrides for narrower/wider scopes.
- Metric emission wrapped in `safe(…)` — throwing `MetricsRegistry` MUST NOT poison the result path (mirrors `instrument-tool.ts`).

### Part 4 — Model-transparency invariant (the load-bearing decision)

On a cache HIT we YIELD the cached result rather than silently skipping, AND we prefix `output` with `[from_cache] `. This is the single decision that distinguishes this primitive from a "transparent" cache (which would be incorrect for an LLM consumer):

1. **Silent skip would break the model's call-order assumption.** From the model's POV it called the tool again expecting a fresh observation. Yielding identical bytes makes the assistant think the world didn't move when it might have — TTL is a heuristic; FS/process state CAN change inside the window. Marking the output as `[from_cache]` makes the cache an OBSERVABLE FACT that the model can reason about (it can invalidate by varying input or asking again later).
2. **The marker also breaks a common LLM failure loop.** Without it, the model often gets stuck in "I just called this — let me call again to verify" cycles. With it, two consecutive identical `tool_result` blocks are no longer suspicious — the second is tagged and the model learns to stop re-asking.
3. **No SOTA agent ships this insight typed.** Cursor's Idempotent RPC has the same shape (return the prior response on repeat) but at the transport layer where the model never sees it. The transparency invariant only matters when the consumer is an LLM that reasons about call sequences — that consumer is exactly the loop.

### Part 5 — Counter

```
tool.call.dedup_collapse.total{tool}      counter
```

Single label (`tool`) keeps cardinality bounded. Per-tool dedup rate is `dedup_collapse.total{tool} / tool.call.total{tool, ok}`.

### Part 6 — Plane-clean & default-OFF

- `instrument-tool-dedup.ts` imports ONLY `./port`, `@/tool`, `node:crypto`. NO `@/agent`, `@/permission`, `@/llm`, `@/lsp`, `@/observability/index` cyclic. NO new npm deps.
- `buildDefaultTools()` is NOT changed — composition roots opt in by explicitly wrapping a tool with `instrumentToolWithDedup`. Every existing path is byte-identical until opt-in.

## Hellgate (13-case summary)

`tests/unit/observability-metrics-instrument-tool-dedup-hellgate.test.ts`:

**A. defaultToolCallCache (7)**
- HELL-CACHE-1: set → get returns stored result.
- HELL-CACHE-2: miss returns null.
- HELL-CACHE-3: TTL boundary — alive at `now - storedAt === ttl`, expired one tick later; expired entry dropped on lookup.
- HELL-CACHE-4: LRU — set N+1 entries, oldest evicted at cap.
- HELL-CACHE-5: clear() empties.
- HELL-CACHE-6: get touches LRU — recently-read entry survives subsequent eviction.
- HELL-CACHE-7: stableStringify pinned — `{a,b}` and `{b,a}` produce same key.

**B. instrumentToolWithDedup (13 — re-numbered HELL-WRAP-1..13)**
- HELL-WRAP-1: first call executes; cache populated; counter NOT emitted.
- HELL-WRAP-2: second identical call cache HIT; counter = 1; `[from_cache] ` marker present; `execute` NOT called second time (spy via callLog counter).
- HELL-WRAP-3: different input → no hit; counter stays 0.
- HELL-WRAP-4: `shouldCache=()=>false` predicate → no caching, no counter.
- HELL-WRAP-5: default predicate gates on `isReadOnly:false` (mutating tools never cache).
- HELL-WRAP-6: default predicate gates on `hitlTier === "always-confirm"`.
- HELL-WRAP-7: `ok:false` result IS cached; second call yields `[from_cache] <failure>` (decision rationale: it's still "this exact input produced this exact result"; caller-supplied predicate is the opt-out for tools where re-call may transiently succeed).
- HELL-WRAP-8: `ctx.cwd` diff → different cache keys (workspace-scoped).
- HELL-WRAP-9: throwing metrics swallowed; cached result still flows with marker.
- HELL-WRAP-10: cache MISS forwards `progress` events verbatim.
- HELL-WRAP-11: cache HIT yields EXACTLY one `result` event (no progress replay — the original progress was a side-effect of execution that is NOT being repeated).
- HELL-WRAP-12: `toolLabel` opt overrides counter label (decoupled from `tool.name`).
- HELL-WRAP-13: custom `ToolCallCache` port honored (proves the port is closed and the wrap doesn't assume `defaultToolCallCache` internals).

## Alternatives rejected

1. **Silent skip (no marker)** — would break the LLM's call-order assumption (insight from research: every SOTA cache hides the cache layer because the consumer is a UI/RPC client, not an LLM). For an LLM consumer the cache must be an OBSERVABLE fact. Rejected: this is the load-bearing invariant of the whole slice.
2. **Snapshot-delta computation (Cursor's Merkle pattern)** — Cursor reconciles FILE state; what we need is CALL state. The shape doesn't translate — Merkle gives "this subtree didn't change, skip upload", we need "this exact `(tool, input)` triple was just answered". Rejected: wrong layer.
3. **Cache key includes `signal` / `AbortController`** — non-serializable + per-call new instance, so every call would miss. Rejected: makes the cache useless.
4. **Per-tool TTL in the default impl (e.g. `read=300s, grep=60s`)** — premature. We ship a single TTL first and let operator telemetry tell us if a heuristic is warranted (per `no-heuristics-only-validated` user memory: "n=1로 루프 변경 정당화 금지"). Deferred to a follow-up.
5. **Always-emit counter `dedup_collapse.total{tool, hit:"true"|"false"}`** — would double cardinality on a hot counter; the `false` series is already `tool.call.total - dedup_collapse.total`. Rejected: redundant series violates 24-metric recipe minimalism (ADR-0158).
6. **Built into `instrumentTool()` directly** — would force every existing caller to either accept caching or pay the predicate check. A sibling wrap (this ADR) keeps the original instrument wrap byte-identical and lets composition roots layer dedup atop instrumentation. Rejected for additive risk.
7. **Tier 0 default-ON for built-in `read`/`grep`/`glob`** — too aggressive without operator feedback on real workloads. Default-OFF + ADR-documented opt-in pattern; flip to default-ON only after telemetry from at least one production session run shows the dedup ratio justifies the model-transparency-debt cost (the marker DOES change model behavior; we want at least one campaign of observation first).
8. **Cache key includes `ctx.depth` / `ctx.turnId`** — would scope cache to a single turn; defeats the cross-turn dedup goal. Within-turn dedup is already covered by `ctx.cwd` discrimination + `shouldCache` predicate. Rejected.

## SOTA matrix

| Agent | Tool-call dedup as a primitive | Model-transparency marker | Observable counter |
|---|---|---|---|
| Cursor 3.2 | ❌ (RPC-level Idempotent only) | n/a | ❌ |
| Codex 0.130 | ❌ (schema cache only) | n/a | ❌ |
| Claude Code 2.1 | ❌ (prompt prefix cache only) | n/a | ❌ |
| v0.dev | ❌ | n/a | ❌ |
| **quanta** (이 ADR) | **typed `ToolCallCache` port + default LRU/TTL impl + instrument wrap** | **`[from_cache] ` marker preserves call-order assumption** | **`tool.call.dedup_collapse.total{tool}`** |

= "tool-call dedup을 closed-port + LLM-transparency invariant로 처음 typed 한 slice. 무음 skip 거부가 load-bearing — 모델은 cache hit을 관찰 가능한 fact으로 본다."

## Follow-up (이 ADR이 닫지 않는 것)

- **Per-tool TTL config** — `defaultToolCallCache` takes a single `ttlMs` today. Deferred until operator telemetry shows a tool-class needs a different value (e.g. `read` 5min vs `git_log` 30s).
- **Cache-warm export / persist across restart** — today the cache is process-local. A future enhancement could persist `(key, result, storedAt)` to `~/.quanta/` for cross-session warm-start. Out of scope here.
- **Cache-hit-ratio histogram** — would expose distribution beyond the rate (e.g. p95 turn-level hit ratio). Defer until `dedup_collapse.total / tool.call.total` rate proves load-bearing in a dashboard.
- **Composition-root opt-in for built-in read-only tools (`read`/`grep`/`glob`/`file_tree_summary`)** — separate ADR after at least one production session campaign with manual opt-in shows the model-transparency cost is acceptable.
- **`ToolCallCache` adapter that delegates to Codex's `cache/codex_apps_tools/` style on-disk blob** — possible Tier-2 absorption if the cross-session use case is validated; the port is ready.
