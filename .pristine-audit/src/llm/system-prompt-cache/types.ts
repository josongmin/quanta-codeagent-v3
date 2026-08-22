/**
 * ADR-0326 — System prompt session-level cache (types).
 *
 * # What this is
 *
 * Closed types for a session-scoped cache of `buildSystemPrompt()` output.
 * Quanta's static system prompt is byte-stable across every turn of a
 * session by construction (ADR-0322 verified that the four section
 * sources — `buildSystemPrompt`, `INTRO_LINES`, persona, identity — carry
 * no clock / random / per-turn input). Codex enforces the same invariant
 * with code: `let base_instructions = sess.get_base_instructions().await`
 * (codex-rs/core/src/turn.rs:923) is called once per sampling request
 * but reads from a session-level cache populated when the session opens
 * (codex-rs/core/src/session.rs ~555). The text is NEVER rebuilt mid-
 * session.
 *
 * Quanta's `buildSystemPrompt` is cheap and pure, so the rebuild itself
 * is not the cost; the cost is each turn re-running the assembly and
 * letting any future drift sneak in unnoticed. This slice provides a
 * port + adapter that future wire-up can route through to enforce
 * byte-stability AT THE CODE LEVEL — not just by audit (ADR-0322).
 *
 * # Default-OFF
 *
 * Nothing in `src/agent/prompt.ts` or `src/agent/loop.ts` is touched
 * by this slice. A follow-up ADR will inject the cache port into
 * `buildTurnContext`'s static-prompt assembly. Until then, production
 * latency / behaviour is byte-identical.
 *
 * # Plane-clean
 *
 * This file imports NOTHING. Pure type declarations. The implementation
 * sibling (`in-memory-cache.ts`) imports only `node:crypto` via the
 * `hash.ts` helper — no `@/agent`, no `@/llm` cross-slice imports.
 */

/**
 * Opaque session key — typically `thread_id` or session id. Stable across
 * iterations within one session.
 *
 * The brand prevents accidental use of plain strings (a footgun: a caller
 * could pass `"foo"` literal and silently never get a hit because the next
 * caller passed `"bar"`). Callers must mint a key via {@link asCacheKey}
 * which is the only sanctioned way to widen a `string` into the branded
 * type.
 */
export type SystemPromptCacheKey = string & { readonly __brand: "SystemPromptCacheKey" }

/** Mint a {@link SystemPromptCacheKey} from a raw string. The check is
 *  compile-time only; this helper is just a typed cast. The runtime cost
 *  is zero. */
export const asCacheKey = (s: string): SystemPromptCacheKey => s as SystemPromptCacheKey

/**
 * One cached prompt entry. Returned from {@link SystemPromptCachePort.getOrBuild}
 * and {@link SystemPromptCachePort.peek}.
 *
 * `builtAt` is the wall-clock ms at which the factory ran (useful for
 * observability — e.g. "cache hot for N seconds"). `contentHash` is the
 * SHA-256 hex of `text`, used by the strict drift detector to assert that
 * a re-invocation of the factory would produce the SAME text. Same digest
 * shape as ADR-0322 (`src/llm/cache-control-audit/hash.ts`) so audits can
 * cross-check.
 */
export interface CachedPrompt {
  readonly key: SystemPromptCacheKey
  readonly text: string
  /** Epoch ms at which the factory ran (NOT the time of the latest hit). */
  readonly builtAt: number
  /** SHA-256 hex of `text`. Cheap drift detector — see `drift-detector.ts`. */
  readonly contentHash: string
}

/**
 * Reason surfaced when an entry is invalidated. The variants are CLOSED
 * (exhaustive switch in the test) so callers can route on intent without
 * stringly-typed branching.
 *
 *   - `session_end`     — the session that minted this key is over; the
 *                          orchestrator clears every key it owns.
 *   - `manual_reset`    — a `/reset` / test-suite reset; not a normal
 *                          production path.
 *   - `config_change`   — the static config that feeds `buildSystemPrompt`
 *                          changed mid-session (e.g. persona toggled); the
 *                          cached text is no longer fresh.
 */
export type InvalidationReason = "session_end" | "manual_reset" | "config_change"

/**
 * Observable counters surfaced by {@link SystemPromptCachePort.stats}.
 *
 * `hits` increments on {@link SystemPromptCachePort.getOrBuild} when the
 * factory is NOT called. `misses` increments when the factory IS called.
 * `invalidations` counts every `invalidate(...)` + every per-entry drop
 * from `clearAll(...)`. `size` is the current entry count. The shape is
 * intentionally minimal — richer telemetry is a future wire-up concern.
 */
export interface CacheStats {
  readonly hits: number
  readonly misses: number
  readonly invalidations: number
  readonly size: number
}

/**
 * Error thrown by the strict drift detector wrapper when a `getOrBuild`
 * hit's cached `contentHash` does NOT match a re-run of the factory.
 *
 * The error carries both hashes (prev = cached, current = freshly
 * built) so an audit trail can pin which turn the drift started in
 * without re-running the factory.
 *
 * This is a CONSTRUCTIVE detection of the failure mode ADR-0322 audited
 * for: a future caller folding per-turn data into the cached prompt
 * without realising the cache invariant is gone. The detector is opt-in
 * (production wrappers do NOT use it) — see `drift-detector.ts`.
 */
export class DriftDetectedError extends Error {
  public readonly key: SystemPromptCacheKey
  public readonly prevHash: string
  public readonly currentHash: string
  public constructor(key: SystemPromptCacheKey, prevHash: string, currentHash: string) {
    super(
      `system-prompt-cache: drift detected for key=${String(key)} ` +
        `(prev=${prevHash.slice(0, 12)}…, current=${currentHash.slice(0, 12)}…)`,
    )
    this.name = "DriftDetectedError"
    this.key = key
    this.prevHash = prevHash
    this.currentHash = currentHash
  }
}
