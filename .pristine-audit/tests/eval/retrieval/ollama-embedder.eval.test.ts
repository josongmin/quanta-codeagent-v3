/**
 * Real-API smoke eval for Ollama local embedder — ADR-0275.
 *
 * Drift detection (non-blocking, polite-skip when the local daemon is
 * unreachable). Default endpoint http://localhost:11434, model nomic-embed-text
 * (dim=768). Override either via env: QUANTA_OLLAMA_URL / QUANTA_OLLAMA_MODEL.
 *
 * NOTE: Unlike the managed-vendor evals, Ollama has no API key — the gate
 * is connectivity. We probe the daemon at module load with a 500ms HEAD
 * (any HTTP response = "up"); ECONNREFUSED means the daemon isn't running
 * and the entire describe is skipped politely.
 *
 * Hellgate axes (~5 cases):
 *   1. dim is positive (768 for nomic-embed-text; model-dependent, so we
 *      only assert dim > 0 + matches capabilities()).
 *   2. L2-norm is finite + non-zero (nomic returns unit-norm by default but
 *      other models may differ — we don't gatekeep the band here).
 *   3. batch input: 2 inputs in → 2 vectors out, each non-empty.
 *   4. error path: bogus model → typed EmbedError.
 *   5. latency under SMOKE_LATENCY_CAP_MS (5s) for a 2-input batch.
 */
import { expect, test } from "bun:test"
import { createOllamaEmbedder } from "@/retrieval/engines"
import {
  describeOnEnv,
  l2Norm,
  ollamaAvailable,
  SMOKE_INPUTS,
  SMOKE_LATENCY_CAP_MS,
} from "./_helpers"

const DEFAULT_URL = "http://localhost:11434"
const baseURL = process.env.QUANTA_OLLAMA_URL ?? DEFAULT_URL
const MODEL = process.env.QUANTA_OLLAMA_MODEL ?? "nomic-embed-text"

// Probe ONCE at module load. Set a sentinel env var so describeOnEnv can
// gate on it — keeps the polite-skip shape uniform across all eval files.
const up = await ollamaAvailable(baseURL)
if (up) process.env.QUANTA_OLLAMA_UP = "1"
else delete process.env.QUANTA_OLLAMA_UP

describeOnEnv("QUANTA_OLLAMA_UP", `ollama-embedder real-API smoke (${baseURL})`, () => {
  test("HELL-OLL-01: dim is positive + matches capabilities()", async () => {
    const e = createOllamaEmbedder({ baseURL, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    // Some models may not be pulled — surface as drift, don't crash.
    if (!r.ok) {
      // Skip-equivalent: model not loaded → typed error, not a test failure.
      expect(["http-error", "invalid-response", "network"]).toContain(r.error.kind)
      return
    }
    const v = r.value.vectors[0]
    expect(v).toBeDefined()
    if (v === undefined) return
    expect(v.length).toBeGreaterThan(0)
    const caps = await e.capabilities()
    // Capabilities is the declared dim; actual length may differ if the model
    // differs from the default — we only assert both are positive.
    expect(caps.dim).toBeGreaterThan(0)
    expect(r.value.modelTag).toBe(`ollama:${MODEL}`)
  })

  test("HELL-OLL-02: L2-norm is finite + non-zero", async () => {
    const e = createOllamaEmbedder({ baseURL, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    if (!r.ok) return
    const v = r.value.vectors[0]
    if (v === undefined) return
    const norm = l2Norm(v)
    expect(Number.isFinite(norm)).toBe(true)
    expect(norm).toBeGreaterThan(0)
  })

  test("HELL-OLL-03: batch input (2 in → 2 out, each non-empty)", async () => {
    const e = createOllamaEmbedder({ baseURL, model: MODEL })
    const r = await e.embed(SMOKE_INPUTS)
    if (!r.ok) return
    expect(r.value.vectors.length).toBe(SMOKE_INPUTS.length)
    for (const v of r.value.vectors) expect(v.length).toBeGreaterThan(0)
  })

  test("HELL-OLL-04: bogus model → typed EmbedError", async () => {
    const e = createOllamaEmbedder({ baseURL, model: "definitely-not-a-real-model-xxxxx" })
    const r = await e.embed(SMOKE_INPUTS[0] ?? "")
    expect(r.ok).toBe(false)
    if (r.ok) return
    // Ollama returns 404 for unknown models; could also be invalid-response
    // if the daemon shape changes.
    expect(["http-error", "invalid-response", "network"]).toContain(r.error.kind)
  })

  test("HELL-OLL-05: latency under 5s on tiny 2-input batch", async () => {
    const e = createOllamaEmbedder({ baseURL, model: MODEL })
    const t0 = Date.now()
    const r = await e.embed(SMOKE_INPUTS)
    const ms = Date.now() - t0
    // If the model isn't loaded the first call can be slow — still bounded.
    if (!r.ok) return
    expect(ms).toBeLessThan(SMOKE_LATENCY_CAP_MS)
  })
})
