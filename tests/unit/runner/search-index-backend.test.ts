/**
 * ADR-0391 — Semantic index real-embedder wiring + sqlite delta persist.
 *
 * Hellgate-style adversarial battery proving:
 *   A. Embedder selection (byte-identical default-OFF + real embedder opt-in)
 *   B. sqlite persist backend (default in-memory + opt-in roundtrip)
 *
 * The default path (no `QUANTA_EMBED_PROVIDER`, no `QUANTA_INDEX_PERSIST`)
 * MUST stay byte-identical to the legacy `hashEmbed` + in-memory wire.
 */
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { IndexerFileChunk } from "@/retrieval"
import {
  buildSemanticBackend,
  hashEmbed,
  isPersistOn,
  resolveIndexEmbedder,
  SemanticBackendUnavailableError,
  selectIndexEmbedder,
} from "@/runner/assemble/search-index-backend"

const chunk = (path: string, text: string, start = 1, end = 5): IndexerFileChunk => ({
  path,
  startLine: start,
  endLine: end,
  text,
  mtime: 0,
  sha: "0",
})

const batchFor = (chunks: readonly IndexerFileChunk[], deletedPaths: readonly string[] = []) => {
  const changedPaths = new Map<string, string[]>()
  for (const c of chunks) {
    const ids = changedPaths.get(c.path) ?? []
    ids.push(`${c.path}:${c.startLine}-${c.endLine}`)
    changedPaths.set(c.path, ids)
  }
  return {
    changedPaths,
    deletedPaths: [...deletedPaths],
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

type Recorder = {
  calls: Array<{ url: string; method: string; body: unknown }>
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
}

const recorder = (
  reply: (req: { url: string; method: string; body: unknown }) => Response,
): Recorder => {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      const method = (init?.method as string | undefined) ?? "GET"
      const bodyRaw = init?.body as string | undefined
      const body = bodyRaw === undefined ? undefined : JSON.parse(bodyRaw)
      const req = { url, method, body }
      calls.push(req)
      return reply(req)
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// A. Embedder selection
// ──────────────────────────────────────────────────────────────────────────

describe("selectIndexEmbedder — embedder selection", () => {
  test("A1. no QUANTA_EMBED_PROVIDER ⇒ hashEmbed (byte-identical)", async () => {
    const embed = selectIndexEmbedder({})
    const got = await embed("hello world")
    const want = hashEmbed("hello world")
    expect(got).toEqual([...want])
  })

  test("A2. unknown provider ⇒ hashEmbed fallback (byte-identical)", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "not-a-real-provider" })
    const got = await embed("alpha beta")
    expect(got).toEqual([...hashEmbed("alpha beta")])
  })

  test("A3. headless provider ⇒ real embedder (NOT hashEmbed)", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" })
    const got = await embed("alpha beta")
    // Headless stub is dim-1536; hashEmbed is dim-64. Distinct shapes prove the
    // real embedder path was taken.
    expect(got.length).toBe(1536)
    expect(got.length).not.toBe(hashEmbed("alpha beta").length)
  })

  test("A4. real embedder is deterministic per input", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" })
    const a = await embed("same text")
    const b = await embed("same text")
    expect(a).toEqual([...b])
  })

  test("A5. real embedder failure (missing api key) ⇒ typed error, not hash", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "openai" })
    await expect(embed("needs key")).rejects.toThrow()
  })

  test("A6. empty real-embedder output ⇒ typed error", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" }, () => ({
      async embed() {
        return { ok: true as const, value: { vectors: [], modelTag: "stub" } }
      },
      async capabilities() {
        return { dim: 8, maxInputBytes: 1_000_000, batchSize: 0, modelTag: "stub" }
      },
    }))
    await expect(embed("xyz")).rejects.toThrow()
  })

  test("A7. throwing real embedder ⇒ typed error (no hash mix)", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" }, () => ({
      async embed(): Promise<never> {
        throw new Error("vendor blew up")
      },
      async capabilities() {
        return { dim: 5, maxInputBytes: 1_000_000, batchSize: 0, modelTag: "x" }
      },
    }))
    await expect(embed("boom")).rejects.toThrow()
  })

  test("A8. metrics sink observes primary embed latency", async () => {
    const seen: Array<{ name: string; labels?: Record<string, string> }> = []
    const metrics = {
      observe(name: string, _value: number, labels?: Record<string, string>) {
        seen.push(labels === undefined ? { name } : { name, labels })
      },
    }
    const primary = resolveIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" }, undefined, {
      metrics,
    })
    await primary.embed("primary")
    expect(
      seen.some((s) => s.name === "search.index.embed.latency_ms" && s.labels?.mode === "primary"),
    ).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// A'. Key-detection promotion (gated, reversible) — jun26 frontier fix
// ──────────────────────────────────────────────────────────────────────────

describe("resolveIndexEmbedder — key-detection default promotion", () => {
  test("AP1. no provider AND no key ⇒ hashEmbed (byte-identical default preserved)", async () => {
    const embed = selectIndexEmbedder({})
    const got = await embed("alpha beta gamma")
    expect(got).toEqual([...hashEmbed("alpha beta gamma")])
  })

  test("AP2. VOYAGE_API_KEY present (no explicit provider) ⇒ promotes to voyage, failure is typed", async () => {
    const resolved = resolveIndexEmbedder({ VOYAGE_API_KEY: "vk-test" })
    expect(resolved.providerLabel).toBe("voyage")
    await expect(resolved.embed("needs promotion")).rejects.toThrow()
  })

  test("AP3. OPENAI_API_KEY present (no explicit provider) ⇒ promotes to openai, failure is typed", async () => {
    const resolved = resolveIndexEmbedder({ OPENAI_API_KEY: "sk-test" })
    expect(resolved.providerLabel).toBe("openai")
    await expect(resolved.embed("needs promotion")).rejects.toThrow()
  })

  test("AP4. explicit QUANTA_EMBED_PROVIDER wins over key detection (no silent override)", async () => {
    // Provider explicitly headless (dim-1536) even though a voyage key is present.
    const embed = selectIndexEmbedder({
      QUANTA_EMBED_PROVIDER: "headless",
      VOYAGE_API_KEY: "vk-test",
    })
    const got = await embed("explicit wins")
    expect(got.length).toBe(1536)
  })

  test("AP5. kill-switch QUANTA_INDEX_AUTO_EMBED=off ⇒ key ignored, hashEmbed restored (reversible)", async () => {
    const embed = selectIndexEmbedder({
      VOYAGE_API_KEY: "vk-test",
      QUANTA_INDEX_AUTO_EMBED: "off",
    })
    const got = await embed("kill switch")
    expect(got).toEqual([...hashEmbed("kill switch")])
  })

  test("AP6. providerLabel reflects the promoted provider (observability)", () => {
    const resolved = resolveIndexEmbedder({ VOYAGE_API_KEY: "vk-test" })
    expect(resolved.providerLabel).toBe("voyage")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// A''. In-memory ranking is COSINE, not raw dot — jun26 frontier fix
// ──────────────────────────────────────────────────────────────────────────

describe("buildSemanticBackend — in-memory cosine ranking", () => {
  test("AC1. hash path (unit vectors) ⇒ cosine == dot (byte-identical ordering)", async () => {
    const backend = buildSemanticBackend({}, async (t) => hashEmbed(t))
    await backend.upsert.upsert(chunk("a.ts", "alpha function token"))
    await backend.upsert.upsert(chunk("b.ts", "beta gamma delta"))
    const hits = await backend.port.query(hashEmbed("alpha function token"), 1)
    expect(hits[0]?.metadata?.path).toBe("a.ts")
    // hashEmbed is unit-length, so cosine score equals the dot product (1.0 for
    // identical text). Byte-identical to the legacy dot ranking on this path.
    expect(hits[0]?.score).toBeCloseTo(1, 10)
  })

  test("AC2. non-normalized vectors ⇒ ranking follows cosine, NOT magnitude-inflated dot", async () => {
    // RED-on-injection: with raw dot, the long high-magnitude vector wins by
    // sheer length even when its DIRECTION is orthogonal-ish to the query.
    // With cosine, the directionally-aligned (but small-magnitude) vector wins.
    //   query     = [1, 0]
    //   aligned   = [0.1, 0]      (dot=0.1,  cos=1.0)   ← should rank FIRST
    //   bigButOff = [3, 4]        (dot=3.0,  cos=0.6)   ← raw-dot would win
    const vecs: Record<string, readonly number[]> = {
      "aligned aligned": [0.1, 0],
      "bigoff bigoff": [3, 4],
    }
    const embed = async (t: string): Promise<readonly number[]> => vecs[t] ?? [0, 0]
    const backend = buildSemanticBackend({}, embed)
    await backend.upsert.upsert(chunk("aligned.ts", "aligned aligned"))
    await backend.upsert.upsert(chunk("bigoff.ts", "bigoff bigoff"))
    const hits = await backend.port.query([1, 0], 2)
    expect(hits[0]?.metadata?.path).toBe("aligned.ts")
    expect(hits[0]?.score).toBeCloseTo(1, 10)
    expect(hits[1]?.metadata?.path).toBe("bigoff.ts")
    expect(hits[1]?.score).toBeCloseTo(0.6, 10)
  })

  test("AC3. zero-magnitude vector ⇒ score 0, no NaN (division-by-zero guard)", async () => {
    const embed = async (t: string): Promise<readonly number[]> =>
      t === "zero" ? [0, 0, 0] : [1, 0, 0]
    const backend = buildSemanticBackend({}, embed)
    await backend.upsert.upsert(chunk("zero.ts", "zero"))
    const hits = await backend.port.query([1, 0, 0], 1)
    expect(hits[0]?.score).toBe(0)
    expect(Number.isNaN(hits[0]?.score ?? Number.NaN)).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// B. Backend selection / sqlite persist
// ──────────────────────────────────────────────────────────────────────────

describe("isPersistOn — knob gate", () => {
  test("B0. default off; any truthy token (1/on/…) enables (canonical gate vocab)", () => {
    expect(isPersistOn({})).toBe(false)
    expect(isPersistOn({ QUANTA_INDEX_PERSIST: "off" })).toBe(false)
    expect(isPersistOn({ QUANTA_INDEX_PERSIST: "0" })).toBe(false)
    // Post-unification: `=1` enables just like `=on` (no more strict-"on" footgun).
    expect(isPersistOn({ QUANTA_INDEX_PERSIST: "1" })).toBe(true)
    expect(isPersistOn({ QUANTA_INDEX_PERSIST: "on" })).toBe(true)
  })
})

describe("buildSemanticBackend — in-memory default", () => {
  test("B1. no persist knob ⇒ in-memory backend, upsert+query roundtrip", async () => {
    const embed = hashEmbed
    const backend = buildSemanticBackend({}, async (t) => embed(t))
    await backend.upsert.upsert(chunk("a.ts", "alpha function token"))
    await backend.upsert.upsert(chunk("b.ts", "beta gamma delta"))
    const hits = await backend.port.query(embed("alpha function token"), 1)
    expect(hits.length).toBe(1)
    expect(hits[0]?.metadata?.path).toBe("a.ts")
  })

  test("B2. in-memory delete removes a path's chunks", async () => {
    const backend = buildSemanticBackend({}, async (t) => hashEmbed(t))
    await backend.upsert.upsert(chunk("a.ts", "alpha token here"))
    await backend.upsert.delete("a.ts")
    const hits = await backend.port.query(hashEmbed("alpha token here"), 5)
    expect(hits.length).toBe(0)
  })
})

describe("buildSemanticBackend — sqlite persist", () => {
  test("B3. persist on ⇒ vectors survive across a fresh backend on the same db", async () => {
    const db = new Database(":memory:")
    const env = { QUANTA_INDEX_PERSIST: "on" } as const
    const make = () => buildSemanticBackend(env, async (t) => hashEmbed(t), { db })

    const a = make()
    await a.upsert.upsert(chunk("svc.ts", "semantic index persistence roundtrip"))

    // Fresh backend over the SAME db handle ⇒ must read the persisted vector.
    const b = make()
    const hits = await b.port.query(hashEmbed("semantic index persistence roundtrip"), 1)
    expect(hits.length).toBe(1)
    expect(hits[0]?.metadata?.path).toBe("svc.ts")
  })

  test("B4. persist delete removes the row", async () => {
    const db = new Database(":memory:")
    const backend = buildSemanticBackend(
      { QUANTA_INDEX_PERSIST: "on" },
      async (t) => hashEmbed(t),
      { db },
    )
    await backend.upsert.upsert(chunk("d.ts", "delete me please"))
    await backend.upsert.delete("d.ts")
    const hits = await backend.port.query(hashEmbed("delete me please"), 5)
    expect(hits.length).toBe(0)
  })

  test("B5. persist query returns chunk metadata (path/lines) and is top-k bounded", async () => {
    const db = new Database(":memory:")
    const backend = buildSemanticBackend(
      { QUANTA_INDEX_PERSIST: "on" },
      async (t) => hashEmbed(t),
      { db },
    )
    await backend.upsert.upsert(chunk("one.ts", "first chunk text", 10, 20))
    await backend.upsert.upsert(chunk("two.ts", "second chunk text", 30, 40))
    await backend.upsert.upsert(chunk("three.ts", "third chunk text", 50, 60))
    const hits = await backend.port.query(hashEmbed("first chunk text"), 2)
    expect(hits.length).toBe(2)
    const top = hits[0]
    expect(top?.metadata?.path).toBe("one.ts")
    expect(top?.metadata?.startLine).toBe(10)
    expect(top?.metadata?.endLine).toBe(20)
    expect(top?.source).toBe("semantic")
  })

  test("B6. explicit Lance store ⇒ registry-backed backend hits REST adapter + reconcile deletes stale ids", async () => {
    const rec = recorder((req) => {
      if (req.url.endsWith("/upsert")) return jsonResponse(200, { ok: true })
      if (req.url.endsWith("/query")) {
        return jsonResponse(200, {
          hits: [
            {
              id: "a.ts:1-5",
              score: 0.99,
              metadata: { path: "a.ts", startLine: 1, endLine: 5, text: "alpha" },
            },
          ],
        })
      }
      if (req.url.endsWith("/delete")) return jsonResponse(200, { ok: true })
      return jsonResponse(404, {})
    })
    const env = {
      QUANTA_VECTOR_STORE: "lance",
      QUANTA_LANCE_BASE_URL: "http://lance.test",
      QUANTA_LANCE_TABLE: "docs",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolved = resolveIndexEmbedder(env)
    const backend = buildSemanticBackend(env, resolved.embed, {
      resolvedEmbedder: resolved,
      storeDeps: { lance: { fetchImpl: rec.fetchImpl } },
    })
    const first = chunk("a.ts", "alpha", 1, 5)
    const stale = chunk("a.ts", "stale", 6, 10)
    await backend.upsert.upsert(first)
    await backend.upsert.upsert(stale)
    await backend.reconcileChanges?.(batchFor([first, stale]))
    await backend.reconcileChanges?.(batchFor([first]))
    const hits = await backend.port.query(await resolved.embed("alpha"), 1)
    expect(hits[0]?.metadata?.path).toBe("a.ts")
    expect(rec.calls.some((c) => c.url === "http://lance.test/v1/table/docs/upsert")).toBe(true)
    expect(rec.calls.some((c) => c.url === "http://lance.test/v1/table/docs/query")).toBe(true)
    expect(
      rec.calls.some(
        (c) =>
          c.url === "http://lance.test/v1/table/docs/delete" &&
          JSON.stringify(c.body) === JSON.stringify({ ids: ["a.ts:6-10"] }),
      ),
    ).toBe(true)
  })

  test("B7. explicit Lance max-dim mismatch ⇒ backend hard-disables instead of silently falling back", async () => {
    const rec = recorder(() => jsonResponse(200, { ok: true }))
    const env = {
      QUANTA_VECTOR_STORE: "lance",
      QUANTA_LANCE_BASE_URL: "http://lance.test",
      QUANTA_LANCE_TABLE: "docs",
      QUANTA_LANCE_MAX_DIM: "32",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolved = resolveIndexEmbedder(env)
    const backend = buildSemanticBackend(env, resolved.embed, {
      resolvedEmbedder: resolved,
      storeDeps: { lance: { fetchImpl: rec.fetchImpl } },
    })
    await expect(backend.upsert.upsert(chunk("fallback.ts", "alpha"))).rejects.toBeInstanceOf(
      SemanticBackendUnavailableError,
    )
    expect(rec.calls).toHaveLength(0)
  })

  test("B8. unknown explicit store ⇒ backend hard-disables instead of aliasing to legacy sqlite/in-memory", async () => {
    const backend = buildSemanticBackend(
      { QUANTA_VECTOR_STORE: "lancee", QUANTA_INDEX_PERSIST: "on" },
      async (t) => hashEmbed(t),
    )
    await expect(backend.upsert.upsert(chunk("disabled.ts", "alpha"))).rejects.toBeInstanceOf(
      SemanticBackendUnavailableError,
    )
    await expect(backend.port.query(hashEmbed("alpha"), 1)).rejects.toBeInstanceOf(
      SemanticBackendUnavailableError,
    )
  })

  test("B9. delete(path) failure keeps manifest so the same path can be retried", async () => {
    let deleteOk = false
    const rec = recorder((req) => {
      if (req.url.endsWith("/upsert")) return jsonResponse(200, { ok: true })
      if (req.url.endsWith("/delete")) {
        return deleteOk ? jsonResponse(200, { ok: true }) : jsonResponse(503, { error: "retry" })
      }
      if (req.url.endsWith("/query")) return jsonResponse(200, { hits: [] })
      return jsonResponse(404, {})
    })
    const env = {
      QUANTA_VECTOR_STORE: "lance",
      QUANTA_LANCE_BASE_URL: "http://lance.test",
      QUANTA_LANCE_TABLE: "docs",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolved = resolveIndexEmbedder(env)
    const backend = buildSemanticBackend(env, resolved.embed, {
      resolvedEmbedder: resolved,
      storeDeps: { lance: { fetchImpl: rec.fetchImpl } },
    })
    await backend.upsert.upsert(chunk("retry.ts", "alpha"))
    await expect(backend.upsert.delete("retry.ts")).rejects.toBeInstanceOf(
      SemanticBackendUnavailableError,
    )
    deleteOk = true
    await backend.upsert.delete("retry.ts")
    const deleteBodies = rec.calls
      .filter((c) => c.url === "http://lance.test/v1/table/docs/delete")
      .map((c) => JSON.stringify(c.body))
    expect(deleteBodies).toEqual([
      JSON.stringify({ ids: ["retry.ts:1-5"] }),
      JSON.stringify({ ids: ["retry.ts:1-5"] }),
    ])
  })

  test("B10. stale-id delete failure on rechunk keeps manifest so reconcile can retry", async () => {
    let deleteOk = true
    const rec = recorder((req) => {
      if (req.url.endsWith("/upsert")) return jsonResponse(200, { ok: true })
      if (req.url.endsWith("/delete")) {
        return deleteOk ? jsonResponse(200, { ok: true }) : jsonResponse(503, { error: "retry" })
      }
      if (req.url.endsWith("/query")) return jsonResponse(200, { hits: [] })
      return jsonResponse(404, {})
    })
    const env = {
      QUANTA_VECTOR_STORE: "lance",
      QUANTA_LANCE_BASE_URL: "http://lance.test",
      QUANTA_LANCE_TABLE: "docs",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolved = resolveIndexEmbedder(env)
    const backend = buildSemanticBackend(env, resolved.embed, {
      resolvedEmbedder: resolved,
      storeDeps: { lance: { fetchImpl: rec.fetchImpl } },
    })
    const first = chunk("retry.ts", "alpha", 1, 5)
    const stale = chunk("retry.ts", "stale", 6, 10)
    await backend.upsert.upsert(first)
    await backend.upsert.upsert(stale)
    await backend.reconcileChanges?.(batchFor([first, stale]))
    deleteOk = false
    await backend.reconcileChanges?.(batchFor([first]))
    deleteOk = true
    await backend.reconcileChanges?.(batchFor([first]))
    const deleteBodies = rec.calls
      .filter((c) => c.url === "http://lance.test/v1/table/docs/delete")
      .map((c) => JSON.stringify(c.body))
      .filter((body) => body === JSON.stringify({ ids: ["retry.ts:6-10"] }))
    expect(deleteBodies).toHaveLength(2)
  })

  test("B11. deleted-path reconcile failure keeps manifest so full-path cleanup can retry", async () => {
    let deleteOk = true
    const rec = recorder((req) => {
      if (req.url.endsWith("/upsert")) return jsonResponse(200, { ok: true })
      if (req.url.endsWith("/delete")) {
        return deleteOk ? jsonResponse(200, { ok: true }) : jsonResponse(503, { error: "retry" })
      }
      if (req.url.endsWith("/query")) return jsonResponse(200, { hits: [] })
      return jsonResponse(404, {})
    })
    const env = {
      QUANTA_VECTOR_STORE: "lance",
      QUANTA_LANCE_BASE_URL: "http://lance.test",
      QUANTA_LANCE_TABLE: "docs",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolved = resolveIndexEmbedder(env)
    const backend = buildSemanticBackend(env, resolved.embed, {
      resolvedEmbedder: resolved,
      storeDeps: { lance: { fetchImpl: rec.fetchImpl } },
    })
    await backend.upsert.upsert(chunk("gone.ts", "alpha"))
    deleteOk = false
    await backend.reconcileChanges?.(batchFor([], ["gone.ts"]))
    deleteOk = true
    await backend.reconcileChanges?.(batchFor([], ["gone.ts"]))
    const deleteBodies = rec.calls
      .filter((c) => c.url === "http://lance.test/v1/table/docs/delete")
      .map((c) => JSON.stringify(c.body))
      .filter((body) => body === JSON.stringify({ ids: ["gone.ts:1-5"] }))
    expect(deleteBodies).toHaveLength(2)
  })

  test("B12. query metrics land on the supplied sink", async () => {
    const seen: Array<{ name: string; labels?: Record<string, string> }> = []
    const metrics = {
      observe(name: string, _value: number, labels?: Record<string, string>) {
        seen.push(labels === undefined ? { name } : { name, labels })
      },
    }
    const backend = buildSemanticBackend({}, async (t) => hashEmbed(t), { metrics })
    await backend.upsert.upsert(chunk("metric.ts", "alpha"))
    await backend.port.query(hashEmbed("alpha"), 1)
    expect(
      seen.some(
        (s) => s.name === "search.index.query.latency_ms" && s.labels?.store === "legacy-in-memory",
      ),
    ).toBe(true)
  })

  test("B13. remote store restart without a persistent manifest cannot discover stale ids to delete", async () => {
    const rec = recorder((req) => {
      if (req.url.endsWith("/upsert")) return jsonResponse(200, { ok: true })
      if (req.url.endsWith("/delete")) return jsonResponse(200, { ok: true })
      if (req.url.endsWith("/query")) return jsonResponse(200, { hits: [] })
      return jsonResponse(404, {})
    })
    const env = {
      QUANTA_VECTOR_STORE: "lance",
      QUANTA_LANCE_BASE_URL: "http://lance.test",
      QUANTA_LANCE_TABLE: "docs",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolved = resolveIndexEmbedder(env)
    const firstBackend = buildSemanticBackend(env, resolved.embed, {
      resolvedEmbedder: resolved,
      storeDeps: { lance: { fetchImpl: rec.fetchImpl } },
    })
    const first = chunk("restart.ts", "alpha", 1, 5)
    const stale = chunk("restart.ts", "beta", 6, 10)
    await firstBackend.upsert.upsert(first)
    await firstBackend.upsert.upsert(stale)
    await firstBackend.reconcileChanges?.(batchFor([first, stale]))

    const beforeRestart = rec.calls.length
    const secondBackend = buildSemanticBackend(env, resolved.embed, {
      resolvedEmbedder: resolved,
      storeDeps: { lance: { fetchImpl: rec.fetchImpl } },
    })
    const rewritten = chunk("restart.ts", "gamma", 1, 1)
    await secondBackend.upsert.upsert(rewritten)
    await secondBackend.reconcileChanges?.(batchFor([rewritten]))

    const deleteBodies = rec.calls
      .slice(beforeRestart)
      .filter((c) => c.url === "http://lance.test/v1/table/docs/delete")
      .map((c) => JSON.stringify(c.body))
    expect(deleteBodies).toEqual([])
  })
})
