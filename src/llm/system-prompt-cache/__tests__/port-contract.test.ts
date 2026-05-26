/**
 * ★ HELLGATE — ADR-0326 port surface (compile-time assertion).
 *
 * Pins the exact method signature of `SystemPromptCachePort` and the
 * exact variant set of `InvalidationReason`. Drift here means the
 * closed-port contract was widened without a new ADR — that's the
 * load-bearing invariant of the slice-fence.
 *
 * The test body runs at runtime as a sanity smoke (one assertion per
 * variant tag), but the real test is `tsc --noEmit`: every type
 * assertion below must remain `true` for the file to compile.
 */

import { describe, expect, test } from "bun:test"
import {
  asCacheKey,
  type CachedPrompt,
  type CacheStats,
  createInMemorySystemPromptCache,
  type InvalidationReason,
  makeStrictDriftCache,
  type SystemPromptCacheKey,
  type SystemPromptCachePort,
} from ".."

// --------------------------- type-level assertions ---------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type AssertTrue<T extends true> = T

// 1) InvalidationReason is exactly the 3 declared in ADR-0326. Adding a
//    4th requires a new ADR; the type guard fires at the compile step.
type _ReasonSet = AssertTrue<
  Equals<InvalidationReason, "session_end" | "manual_reset" | "config_change">
>

// 2) Port surface is exactly 5 methods with the documented signatures.
type _PortShape = AssertTrue<
  Equals<
    SystemPromptCachePort,
    {
      getOrBuild(key: SystemPromptCacheKey, factory: () => string): CachedPrompt
      peek(key: SystemPromptCacheKey): CachedPrompt | null
      invalidate(key: SystemPromptCacheKey, reason: InvalidationReason): void
      clearAll(reason: InvalidationReason): void
      stats(): CacheStats
    }
  >
>

// 3) Both factories return the port type (not a class — impl is intentionally
//    NOT part of the public surface).
type _InMemoryFactoryReturn = AssertTrue<
  Equals<ReturnType<typeof createInMemorySystemPromptCache>, SystemPromptCachePort>
>
type _StrictWrapperReturn = AssertTrue<
  Equals<ReturnType<typeof makeStrictDriftCache>, SystemPromptCachePort>
>

// 4) The brand prevents widening a plain `string` into a `SystemPromptCacheKey`
//    without `asCacheKey`. The line below would FAIL to compile if uncommented:
//      const _bad: SystemPromptCacheKey = "raw"  // ← Type 'string' is not assignable…
//    We pin the brand contract by asserting `asCacheKey`'s shape.
type _KeyMint = AssertTrue<Equals<ReturnType<typeof asCacheKey>, SystemPromptCacheKey>>

// 5) CachedPrompt shape pin — adding fields requires an ADR amendment.
type _CachedPromptShape = AssertTrue<
  Equals<
    CachedPrompt,
    {
      readonly key: SystemPromptCacheKey
      readonly text: string
      readonly builtAt: number
      readonly contentHash: string
    }
  >
>

// 6) CacheStats shape pin.
type _CacheStatsShape = AssertTrue<
  Equals<
    CacheStats,
    {
      readonly hits: number
      readonly misses: number
      readonly invalidations: number
      readonly size: number
    }
  >
>

// Discard markers so `noUnusedLocals` / biome don't flag them.
type _Markers = [
  _ReasonSet,
  _PortShape,
  _InMemoryFactoryReturn,
  _StrictWrapperReturn,
  _KeyMint,
  _CachedPromptShape,
  _CacheStatsShape,
]
const _markers: _Markers | undefined = undefined
void _markers

// ----------------------------- runtime smoke --------------------------------

describe("ADR-0326 port-contract", () => {
  test("factory returns an object satisfying the 5-method port", () => {
    const cache = createInMemorySystemPromptCache()
    expect(typeof cache.getOrBuild).toBe("function")
    expect(typeof cache.peek).toBe("function")
    expect(typeof cache.invalidate).toBe("function")
    expect(typeof cache.clearAll).toBe("function")
    expect(typeof cache.stats).toBe("function")
  })

  test("strict wrapper returns an object satisfying the same port", () => {
    const cache = makeStrictDriftCache(createInMemorySystemPromptCache())
    expect(typeof cache.getOrBuild).toBe("function")
    expect(typeof cache.peek).toBe("function")
    expect(typeof cache.invalidate).toBe("function")
    expect(typeof cache.clearAll).toBe("function")
    expect(typeof cache.stats).toBe("function")
  })

  test("every invalidation reason is constructible via the union", () => {
    // Exhaustiveness check: if any variant is dropped from the union
    // this switch loses its `never` arm and the test fails to compile.
    const reasons: InvalidationReason[] = ["session_end", "manual_reset", "config_change"]
    for (const r of reasons) {
      const _exhaustive: InvalidationReason = r
      switch (_exhaustive) {
        case "session_end":
        case "manual_reset":
        case "config_change":
          break
        default: {
          const _never: never = _exhaustive
          throw new Error(`unreachable: ${String(_never)}`)
        }
      }
    }
    expect(reasons.length).toBe(3)
  })

  test("asCacheKey is the only sanctioned widening from string", () => {
    const k = asCacheKey("session-X")
    // Brand is compile-time only — at runtime the value is the plain string.
    expect(k).toBe("session-X" as SystemPromptCacheKey)
  })
})
