/**
 * HELLGATE — semantic-search headless embedder proofs (ADR-0254).
 *
 * The dead text-in `SemanticIndex` port + in-memory cosine adapter were
 * removed as a proven duplicate of the live vector-in `SemanticIndex` in
 * `@/retrieval/pipeline` (the real search wire's port). What survives in
 * this slice is the deterministic headless `Embedder` — which IS live:
 * `src/runner/assemble/pipeline.ts` imports `createHeadlessEmbedder` from
 * `@/retrieval/semantic`. These cases pin that surviving surface.
 *
 *   01 deterministic — same text ⇒ byte-identical vector
 *   02 different text ⇒ different vector
 *   03 requested dim honoured; output is L2-normalised
 *   04 empty text ⇒ err("empty-text")
 *   05 dim() reports the configured dimension
 *   06 invalid dim ⇒ constructor throws
 *   07 default-OFF: importing barrel exposes only the documented surface
 */

import { describe, expect, test } from "bun:test"
import { createHeadlessEmbedder, type Embedder } from "@/retrieval/semantic"

/** L2 norm of a vector — used to prove the embedder normalises its output. */
const l2 = (v: readonly number[]): number => Math.sqrt(v.reduce((a, x) => a + x * x, 0))

describe("semantic-search headless-embedder hellgate", () => {
  // HELL-SS-15 (was): determinism
  test("deterministic — same text ⇒ byte-identical vector", async () => {
    const e: Embedder = createHeadlessEmbedder({ dim: 16 })
    const r1 = await e.embed("hello world")
    const r2 = await e.embed("hello world")
    expect(r1.ok && r2.ok).toBe(true)
    if (!(r1.ok && r2.ok)) return
    expect(r1.value).toEqual(r2.value)
    expect(r1.value).toHaveLength(16)
  })

  test("different text ⇒ different vector (high probability)", async () => {
    const e = createHeadlessEmbedder({ dim: 16 })
    const r1 = await e.embed("hello world")
    const r3 = await e.embed("goodbye world")
    expect(r1.ok && r3.ok).toBe(true)
    if (!(r1.ok && r3.ok)) return
    expect(r3.value).not.toEqual(r1.value)
  })

  test("output is the requested dim and L2-normalised", async () => {
    const e = createHeadlessEmbedder({ dim: 32 })
    const r = await e.embed("some indexable chunk of text")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(32)
    // Normalised ⇒ ||v|| ≈ 1 (keeps cosine in [-1, 1] regardless of dim).
    expect(l2(r.value)).toBeCloseTo(1, 9)
  })

  test("empty text ⇒ err(empty-text)", async () => {
    const e = createHeadlessEmbedder({ dim: 8 })
    const r = await e.embed("")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("empty-text")
  })

  test("dim() reports the configured dimension", () => {
    expect(createHeadlessEmbedder({ dim: 64 }).dim()).toBe(64)
    // Default dim when unspecified.
    expect(createHeadlessEmbedder().dim()).toBe(64)
  })

  test("invalid dim ⇒ constructor throws TypeError", () => {
    expect(() => createHeadlessEmbedder({ dim: 0 })).toThrow(TypeError)
    expect(() => createHeadlessEmbedder({ dim: -4 })).toThrow(TypeError)
    expect(() => createHeadlessEmbedder({ dim: 2.5 })).toThrow(TypeError)
  })

  // Default-OFF byte-identical: importing the barrel exposes only the
  // documented factory (no singleton, no removed index factory).
  test("default-OFF: barrel exposes only the surviving surface", async () => {
    const mod = await import("@/retrieval/semantic")
    expect(typeof mod.createHeadlessEmbedder).toBe("function")
    // The dead in-memory index factory is gone.
    expect("createInMemoryIndex" in mod).toBe(false)
    // No singleton index lives on the module.
    expect("defaultIndex" in mod).toBe(false)
  })
})
