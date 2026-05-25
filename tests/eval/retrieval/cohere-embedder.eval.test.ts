/**
 * Real-API smoke eval for Cohere embedder — ADR-0275.
 *
 * Drift detection (non-blocking, polite-skip when COHERE_API_KEY unset).
 * Model: embed-english-v3.0 (dim=1024) — same family as the spec "embed-v3";
 * we pin a single concrete model to keep dim assertion stable.
 *
 * Hellgate axes (~5 cases):
 *   1. dim matches model spec (1024 for embed-english-v3.0).
 *   2. L2-norm in (0.9, 1.1) — Cohere v3 returns unit-normalised vectors.
 *   3. batch input: 2 inputs in → 2 vectors out.
 *   4. error path: bogus model name → http-error arm.
 *   5. latency under SMOKE_LATENCY_CAP_MS (5s).
 */
import { expect, test } from "bun:test"
import { createCohereEmbedder } from "@/retrieval/engines"
import {
  assertCostCap,
  describeOnEnv,
  l2Norm,
  SMOKE_INPUTS,
  SMOKE_LATENCY_CAP_MS,
  SMOKE_TOKEN_CAP,
} from "./_helpers"

describeOnEnv("COHERE_API_KEY", "cohere-embedder real-API smoke", () => {
  const apiKey = process.env.COHERE_API_KEY ?? ""
  const MODEL = "embed-english-v3.0"
  const EXPECTED_DIM = 1024

  test("HELL-COE-01: dim matches model spec (embed-english-v3.0 = 1024)", async () => {
    assertCostCap("cohere-embedder", SMOKE_INPUTS, SMOKE_TOKEN_CAP)
    const e = createCohereEmbedder({ apiKey, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = r.value.vectors[0]
    expect(v).toBeDefined()
    expect(v?.length).toBe(EXPECTED_DIM)
    expect(r.value.modelTag).toBe(`cohere:${MODEL}`)
  })

  test("HELL-COE-02: L2-norm in (0.9, 1.1) — unit-normalised vectors", async () => {
    const e = createCohereEmbedder({ apiKey, model: MODEL })
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

  test("HELL-COE-03: batch input (2 in → 2 out)", async () => {
    assertCostCap("cohere-embedder-batch", SMOKE_INPUTS, SMOKE_TOKEN_CAP)
    const e = createCohereEmbedder({ apiKey, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.vectors.length).toBe(SMOKE_INPUTS.length)
    for (const v of r.value.vectors) expect(v.length).toBe(EXPECTED_DIM)
  })

  test("HELL-COE-04: bogus model → http-error (4xx)", async () => {
    const e = createCohereEmbedder({ apiKey, model: "definitely-not-a-real-model-xxxxx" })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(["http-error", "invalid-response"]).toContain(r.error.kind)
    if (r.error.kind === "http-error") {
      expect(r.error.status).toBeGreaterThanOrEqual(400)
      expect(r.error.status).toBeLessThan(500)
    }
  })

  test("HELL-COE-05: latency under 5s on tiny 2-input batch", async () => {
    const e = createCohereEmbedder({ apiKey, model: MODEL })
    const t0 = Date.now()
    const r = await e.embed(SMOKE_INPUTS)
    const ms = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(ms).toBeLessThan(SMOKE_LATENCY_CAP_MS)
  })
})
