/**
 * Real-API smoke eval for Voyage embedder — ADR-0275.
 *
 * Drift detection (non-blocking, polite-skip when VOYAGE_API_KEY unset).
 * Model: voyage-3 (dim=1024).
 *
 * Hellgate axes (~5 cases):
 *   1. dim matches model spec (1024 for voyage-3).
 *   2. L2-norm in (0.9, 1.1) — Voyage returns unit-normalised vectors.
 *   3. batch input: 2 inputs in → 2 vectors out.
 *   4. error path: bogus model name → http-error arm.
 *   5. latency under SMOKE_LATENCY_CAP_MS (5s).
 */
import { expect, test } from "bun:test"
import { createVoyageEmbedder } from "@/retrieval/engines"
import {
  assertCostCap,
  describeOnEnv,
  l2Norm,
  SMOKE_INPUTS,
  SMOKE_LATENCY_CAP_MS,
  SMOKE_TOKEN_CAP,
} from "./_helpers"

describeOnEnv("VOYAGE_API_KEY", "voyage-embedder real-API smoke", () => {
  const apiKey = process.env.VOYAGE_API_KEY ?? ""
  const MODEL = "voyage-3"
  const EXPECTED_DIM = 1024

  test("HELL-VOY-01: dim matches model spec (voyage-3 = 1024)", async () => {
    assertCostCap("voyage-embedder", SMOKE_INPUTS, SMOKE_TOKEN_CAP)
    const e = createVoyageEmbedder({ apiKey, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = r.value.vectors[0]
    expect(v).toBeDefined()
    expect(v?.length).toBe(EXPECTED_DIM)
    expect(r.value.modelTag).toBe(`voyage:${MODEL}`)
  })

  test("HELL-VOY-02: L2-norm in (0.9, 1.1) — unit-normalised vectors", async () => {
    const e = createVoyageEmbedder({ apiKey, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = r.value.vectors[0]
    expect(v).toBeDefined()
    if (v === undefined) return
    const norm = l2Norm(v)
    expect(norm).toBeGreaterThan(0.9)
    expect(norm).toBeLessThan(1.1)
  })

  test("HELL-VOY-03: batch input (2 in → 2 out)", async () => {
    assertCostCap("voyage-embedder-batch", SMOKE_INPUTS, SMOKE_TOKEN_CAP)
    const e = createVoyageEmbedder({ apiKey, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.vectors.length).toBe(SMOKE_INPUTS.length)
    for (const v of r.value.vectors) expect(v.length).toBe(EXPECTED_DIM)
  })

  test("HELL-VOY-04: bogus model → http-error (4xx)", async () => {
    const e = createVoyageEmbedder({ apiKey, model: "definitely-not-a-real-model-xxxxx" })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(["http-error", "invalid-response"]).toContain(r.error.kind)
    if (r.error.kind === "http-error") {
      expect(r.error.status).toBeGreaterThanOrEqual(400)
      expect(r.error.status).toBeLessThan(500)
    }
  })

  test("HELL-VOY-05: latency under 5s on tiny 2-input batch", async () => {
    const e = createVoyageEmbedder({ apiKey, model: MODEL })
    const t0 = Date.now()
    const r = await e.embed(SMOKE_INPUTS)
    const ms = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(ms).toBeLessThan(SMOKE_LATENCY_CAP_MS)
  })
})
