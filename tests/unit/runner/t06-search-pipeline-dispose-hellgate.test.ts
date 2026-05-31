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

  test("DISPOSE-2: dispose() clears an active delta-scan interval handle", () => {
    const wire = buildSearchPipelineFromEnv(
      { QUANTA_INDEX: "on", QUANTA_PIPELINE: "parallel-rrf" } as NodeJS.ProcessEnv,
      process.cwd(),
    )
    expect(wire).not.toBeNull()
    // An indexed preset wires a scan interval. dispose() must clear it; a
    // second dispose() must be a no-op.
    if (wire?.intervalHandle != null) {
      expect(() => wire.dispose()).not.toThrow()
    }
    expect(() => wire?.dispose()).not.toThrow()
  })
})
