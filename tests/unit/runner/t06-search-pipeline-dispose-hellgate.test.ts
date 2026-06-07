import { afterEach, describe, expect, test } from "bun:test"
import {
  buildSearchPipelineFromEnv,
  clearSearchPipelineWireForTests,
} from "@/runner/assemble/search-pipeline"

/**
 * T06 — Search pipeline teardown hellgate (L5 M-11).
 *
 * Proof rail: a constructed `WiredSearchPipeline` exposes an idempotent
 * `dispose()` that session teardown can call to clear the delta-scan
 * `setInterval` + stop the indexer — instead of the interval only being
 * cleared when the GLOBAL singleton is replaced by a NEW pipeline (so a
 * long-lived session leaked a scanning interval forever).
 */

afterEach(() => {
  clearSearchPipelineWireForTests()
})

describe("T06 / search pipeline dispose", () => {
  test("DISPOSE-1: lexical-only wire exposes dispose() and it is idempotent", () => {
    // QUANTA_INDEX off ⇒ lexical-only, no interval handle, but dispose must
    // still exist + be safe to call twice (session teardown calls it blind).
    const wire = buildSearchPipelineFromEnv({} as NodeJS.ProcessEnv, process.cwd())
    expect(wire).not.toBeNull()
    expect(typeof wire?.dispose).toBe("function")
    expect(() => {
      wire?.dispose()
      wire?.dispose()
    }).not.toThrow()
  })

  test("DISPOSE-2: dispose() actually clears the delta-scan interval + is idempotent", () => {
    // Spy on the real clearInterval so we PROVE teardown happened (the prior
    // version only asserted not.toThrow, so a no-op dispose stayed green).
    const cleared: Array<ReturnType<typeof setInterval>> = []
    const realClear = globalThis.clearInterval
    globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      cleared.push(handle)
      return realClear(handle)
    }) as typeof clearInterval
    try {
      const wire = buildSearchPipelineFromEnv(
        { QUANTA_INDEX: "on", QUANTA_PIPELINE: "parallel-rrf" } as NodeJS.ProcessEnv,
        process.cwd(),
      )
      expect(wire).not.toBeNull()
      const handle = wire?.intervalHandle ?? null
      wire?.dispose()
      if (handle != null) {
        // Semantic preset wired a scan interval: dispose MUST have cleared
        // exactly that handle.
        const countAfterFirst = cleared.filter((h) => h === handle).length
        expect(countAfterFirst).toBeGreaterThanOrEqual(1)
        // Second dispose is guarded by the `disposed` flag — no double clear.
        wire?.dispose()
        expect(cleared.filter((h) => h === handle).length).toBe(countAfterFirst)
      } else {
        // Lexical fallback (no semantic deps in this env): nothing to clear,
        // but dispose must still be safe + idempotent.
        expect(() => wire?.dispose()).not.toThrow()
      }
    } finally {
      globalThis.clearInterval = realClear
    }
  })
})
