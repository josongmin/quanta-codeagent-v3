# ADR-0179: Per-tool TTL config for `defaultToolCallCache` — staleness-tolerance by tool class

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0176 (tool-call dedup — parent; this ADR closes the §"Follow-up: Per-tool TTL config" item it left open)
- **참조**: `src/observability/metrics/instrument-tool-dedup.ts`, `tests/unit/observability-metrics-tool-dedup-ttl-hellgate.test.ts`, `tests/unit/observability-metrics-instrument-tool-dedup-hellgate.test.ts` (parent regression)

## 맥락

ADR-0176 shipped `defaultToolCallCache` with a single global `ttlMs` (default 30s) and explicitly deferred per-tool TTL: *"Per-tool TTL config — deferred until operator telemetry shows a tool-class needs a different value (e.g. `read` 5min vs `git_log` 30s)."* Real-world cache behavior across tool classes differs sharply enough that one global value is wrong for both ends:

| Tool class | Staleness tolerance | Reason |
|---|---|---|
| `read` (file) | up to 60s | content rarely changes within a turn if no `write` happened in the same session |
| `grep` / `glob` | up to 30s | matches can shift with any write — current global default |
| `git_status` / `git_diff` | ~5s | working tree mutates frequently |
| `git_log` | up to 60s | history is append-only (modulo rebase) |
| `bash` | 0 (never) | we don't know what the command did — clock, network, mutable state |
| `web_fetch` / `web_search` | 0 (never) | content lives outside our control |

A single TTL forces a choice: short enough to be safe for `bash` (defeats `read` benefit) or long enough for `read` (unsound for `bash`).

## Research grounding

**Cursor's 4-tier freshness model** (`docs/analysis/경쟁사리뷰/code-agent-loop/cursor-localization.md`, §1.2 + §5.1 + §5B + §5C, ≈ 30 lines verbatim audit):

1. **`recent_edits` overlay (0s freshness)** — composer-internal AI-edit ledger. The instant a write lands, the corresponding fingerprint becomes the ground truth; no debounce, no polling.
2. **Rust debounce, event-driven** — `merkleClient.onDidChange/Create/Delete` reacts on FS events; no polling for *change detection*, only for *upload batching*.
3. **60s server reconciliation** — `setInterval(doUpdate, max(indexingPeriodSeconds:600, 60)*1000)` — minimum 60s polling boundary for re-handshake even when nothing changed.
4. **Handshake ground truth** — `FastRepoInitHandshakeV2` against `rootHash + simhash` — the only source of "what's actually in the server's index".

**The insight** — staleness tolerance is **data-class specific**. Cursor doesn't use a single freshness window across all data; it picks four (0s / event-driven / 60s / handshake) because each class has a different rate of change and a different cost of being stale.

**The analog** — per-TOOL TTL is the call-level translation of the same insight: each tool reads a different *kind* of state, with a different rate of change.

(Memory `cursor-3.2-absorption.md` was checked — covers agent runtime, hooks, rules, AI tracking; no per-class TTL pattern beyond what `cursor-localization.md` documents above.)

## 결정

Three additions to `instrument-tool-dedup.ts`. All default-OFF.

### Part 1 — `DefaultCacheOpts.perToolTtlMs` + threading `toolName` through `set`

```ts
export interface ToolCallCache {
  set(key: string, result: ToolResult, toolName?: string): void  // toolName added
  // get / computeKey / clear unchanged
}

export interface DefaultCacheOpts {
  readonly maxEntries?: number
  readonly ttlMs?: number
  /** Per-tool TTL override. Falls through to `ttlMs` for unlisted tools.
   *  `0` ⇒ never cache (every `get` is a miss; `set` stores nothing). */
  readonly perToolTtlMs?: Readonly<Record<string, number>>
  readonly now?: () => number
}
```

`toolName` is optional on `set` for back-compat (legacy callers stay byte-identical). `instrumentToolWithDedup` always forwards `tool.name`.

### Part 2 — TTL resolved at SET time (so the cheap `get` path stays tool-agnostic)

The cache entry stores `expiresAt = now() + resolveTtl(toolName)`. `resolveTtl` looks up `perToolTtlMs[toolName] ?? ttlMs`. A TTL of `0` short-circuits: nothing is stored (and any stale prior entry for the same key is dropped to keep semantics monotone). The boundary semantic is preserved from ADR-0176 (`now() > expiresAt` ⇒ expired; equality ⇒ still alive).

### Part 3 — `RECOMMENDED_PER_TOOL_TTL_MS` preset

```ts
export const RECOMMENDED_PER_TOOL_TTL_MS = Object.freeze({
  read: 60_000, grep: 30_000, glob: 30_000,
  git_status: 5_000, git_diff: 5_000, git_log: 60_000,
  web_fetch: 0, web_search: 0, bash: 0,
})
```

Conservative starting point matching the staleness table above. Frozen (consumers can't accidentally mutate the shared preset). Callers can override or build their own map.

## Hellgate (10-case summary)

`tests/unit/observability-metrics-tool-dedup-ttl-hellgate.test.ts`:

- HELL-TTL-1: per-tool override beats global — `ttlMs:30000, perToolTtlMs:{read:60000}` → "read" entry survives 50s.
- HELL-TTL-2: tool not in `perToolTtlMs` → falls through to global `ttlMs`.
- HELL-TTL-3: `perToolTtlMs:{read:0}` → "read" never caches (same-tick get is miss; re-set still miss).
- HELL-TTL-4: different tool names → independent TTL (read 60s, grep 30s, both set at t=0; grep expires at 30s, read at 60s).
- HELL-TTL-5: RECOMMENDED preset has `bash:0`, `web_fetch:0`, `web_search:0`.
- HELL-TTL-6: RECOMMENDED preset has `read:60_000`; preset is frozen.
- HELL-TTL-7: tool name routing — wrap calls `set()` with `tool.name` (asserted via `perToolTtlMs:{fake:0}` defeating the cache through the wrap).
- HELL-TTL-8: determinism — two caches with identical opts + clocks produce identical eviction order.
- HELL-TTL-9: legacy `set()` without `toolName` falls through to global `ttlMs` (back-compat with parent ADR-0176 callers).
- HELL-TTL-10: opts absent → byte-identical to ADR-0176 (global `ttlMs` only).

Parent regression `observability-metrics-instrument-tool-dedup-hellgate.test.ts` (20 cases) re-run untouched: 0 fail.

## Default-OFF

`perToolTtlMs` is absent on the default cache opts. Construction site `defaultToolCallCache()` with no args is byte-identical to ADR-0176: a single global `ttlMs` of 30s, no per-tool resolution path executed (the `resolveTtl` short-circuit returns `ttlMs` immediately when `perToolTtlMs === undefined`). HELL-TTL-10 pins this.

## Alternatives rejected

1. **Per-input TTL** (e.g. `read("README.md") → 60s` vs `read("logs/...") → 0s`) — cardinality problem. The cache key already includes input hash; a per-input TTL map would have unbounded keys and no closed shape to advertise. Rejected: too granular without a typed channel for the operator to express intent.
2. **Auto-detect "is read-only" → long TTL** — `Tool.isReadOnly` is already in the predicate (HELL-WRAP-5 of parent). But `isReadOnly` says nothing about staleness: `bash` is "read-only" if the command is `cat`, but the cache doesn't know that. The staleness signal is the tool *class*, not the read/write polarity. Rejected: wrong axis.
3. **Time-of-day-aware TTL** (e.g. shorter during workday, longer overnight) — overkill. The cache is process-scoped and a session rarely spans a clock-time discontinuity. Rejected: no workload demands this.
4. **Tier-0 default-ON with the RECOMMENDED preset** — premature without operator telemetry on real workloads, and `bash:0` would silently change semantics for anyone who had a `bash`-cached run. Rejected: same caution as ADR-0176 §Alternatives #7. The preset is opt-in by importing the constant.
5. **Drop `set(key, result)` legacy signature in favor of mandatory `toolName`** — would force every parent-ADR caller (custom `ToolCallCache` impls in the wild) to migrate. Optional `toolName?` is the cheap back-compat seam. Rejected: needless break.
6. **Per-tool LRU cap (in addition to TTL)** — would solve the "one chatty tool evicts everyone else" failure mode. Different concern; tracked as a separate follow-up below. Rejected for this slice (single-axis change).

## SOTA matrix

| Agent | Cache TTL strategy | Per-class? |
|---|---|---|
| Cursor 3.2 | 4-tier freshness model (recent_edits 0s / debounce / 60s / handshake) | ✅ per data class |
| Claude Code 2.1 | Prompt prefix `cache_control:{type:"ephemeral"}` ×4 breakpoints — TTL is server-managed (default 5min) | ❌ uniform |
| Codex 0.130 | Schema cache on disk, no TTL (until disk eviction) | ❌ uniform |
| v0.dev | (no tool-call cache observed) | n/a |
| **quanta** (이 ADR) | **`defaultToolCallCache` with `perToolTtlMs` map + `0`=never-cache sentinel + RECOMMENDED preset** | **✅ per tool name** |

= "per-tool TTL을 closed-port + 0-sentinel + 검증된 preset으로 typed 한 slice. Cursor의 data-class freshness 패턴을 call-class staleness로 변환."

## Follow-up (이 ADR이 닫지 않는 것)

- **TTL by pattern** (regex / glob over tool name) — e.g. `git_*: 5s` instead of enumerating each git tool. Defer until the RECOMMENDED preset shows it's needed (>10 tool entries before the constant becomes hard to read).
- **Cache-hit-ratio metric per tool** — orthogonal observability work. Today we only emit `dedup_collapse.total{tool}`; the hit/total ratio is computable but a histogram per tool would expose distribution. Defer until at least one production session campaign shows the rate matters per-tool.
- **Per-tool LRU cap** — see Alternative #6. Independent failure mode; needs its own ADR if observed.
- **Tier-0 default-ON with the RECOMMENDED preset** — separate ADR after operator telemetry confirms the `bash:0` semantic shift is acceptable.
