/**
 * Real-API smoke eval for OpenAI embedder — ADR-0275.
 *
 * Drift detection (non-blocking, polite-skip when OPENAI_API_KEY unset).
 * Model: text-embedding-3-small (dim=1536).
 *
 * Hellgate axes (~5 cases):
 *   1. dim matches model spec (1536 for text-embedding-3-small).
 *   2. L2-norm in (0.9, 1.1) — OpenAI returns unit-normalised vectors.
 *   3. batch input: 2 inputs in → 2 vectors out, both right shape.
 *   4. error path: bogus model name → http-error arm (4xx).
 *   5. latency under SMOKE_LATENCY_CAP_MS (5s) for a 2-input batch.
 */
import { expect, test } from "bun:test"
import { createOpenAIEmbedder } from "@/retrieval/engines"
import {
  assertCostCap,
  describeOnEnv,
  l2Norm,
  SMOKE_INPUTS,
  SMOKE_LATENCY_CAP_MS,
  SMOKE_TOKEN_CAP,
} from "./_helpers"

describeOnEnv("OPENAI_API_KEY", "openai-embedder real-API smoke", () => {
  const apiKey = process.env.OPENAI_API_KEY ?? ""
  const MODEL = "text-embedding-3-small"
  const EXPECTED_DIM = 1536

  test("HELL-OAI-01: dim matches model spec (text-embedding-3-small = 1536)", async () => {
    assertCostCap("openai-embedder", SMOKE_INPUTS, SMOKE_TOKEN_CAP)
    const e = createOpenAIEmbedder({ apiKey, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = r.value.vectors[0]
    expect(v).toBeDefined()
    expect(v?.length).toBe(EXPECTED_DIM)
    expect(r.value.modelTag).toBe(`openai:${MODEL}`)
  })

  test("HELL-OAI-02: L2-norm in (0.9, 1.1) — unit-normalised vectors", async () => {
    const e = createOpenAIEmbedder({ apiKey, model: MODEL })
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

  test("HELL-OAI-03: batch input (2 in → 2 out)", async () => {
    assertCostCap("openai-embedder-batch", SMOKE_INPUTS, SMOKE_TOKEN_CAP)
    const e = createOpenAIEmbedder({ apiKey, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.vectors.length).toBe(SMOKE_INPUTS.length)
    for (const v of r.value.vectors) expect(v.length).toBe(EXPECTED_DIM)
  })

  test("HELL-OAI-04: bogus model → http-error (4xx)", async () => {
    const e = createOpenAIEmbedder({ apiKey, model: "definitely-not-a-real-model-xxxxx" })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    expect(r.ok).toBe(false)
    if (r.ok) return
    // Either http-error (typed 4xx) or invalid-response — both are valid
    // drift signals (OpenAI may move the validator location).
    expect(["http-error", "invalid-response"]).toContain(r.error.kind)
    if (r.error.kind === "http-error") {
      expect(r.error.status).toBeGreaterThanOrEqual(400)
      expect(r.error.status).toBeLessThan(500)
    }
  })

  test("HELL-OAI-05: latency under 5s on tiny 2-input batch", async () => {
    const e = createOpenAIEmbedder({ apiKey, model: MODEL })
    const t0 = Date.now()
    const r = await e.embed(SMOKE_INPUTS)
    const ms = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(ms).toBeLessThan(SMOKE_LATENCY_CAP_MS)
  })
})
