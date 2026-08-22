import { describe, expect, test } from "bun:test"
import type { IndexerFileChunk } from "@/retrieval"
import { buildSemanticBackend, type SemanticBackend } from "@/runner/assemble/search-index-backend"

/**
 * T06 — Search backend fail-closed hellgate (L5 H-4 / M-12 / M-13).
 *
 * Proof rail: an EXPLICIT but mis-spelled `QUANTA_VECTOR_STORE` must FAIL
 * CLOSED at the backend owner — typed `state: "failed"` exposed to the
 * consumer, NOT a silently-empty index that drops chunks. A valid implicit /
 * explicit selection stays `state: "ready"`. Default-OFF (no env) stays ready.
 *
 * Before this seam the disabled backend was shape-identical to a normal empty
 * index, so a single-character typo silently disabled semantic search with no
 * signal a consumer could branch on.
 */

const passEmbed = async (_text: string): Promise<readonly number[]> => [1, 0, 0]

const chunk = (path: string): IndexerFileChunk => ({
  path,
  startLine: 1,
  endLine: 2,
  text: "hello world",
  mtime: 1_700_000_000_000,
  sha: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
})

const upsertThenQuery = async (backend: SemanticBackend): Promise<number> => {
  await backend.upsert.upsert(chunk("a.ts"))
  const hits = await backend.port.query([1, 0, 0], 5)
  return hits.length
}

describe("T06 / search backend fail-closed", () => {
  test("FAIL-CLOSED-1: invalid explicit QUANTA_VECTOR_STORE → state==='failed' + reason", () => {
    const backend = buildSemanticBackend(
      { QUANTA_VECTOR_STORE: "lannce", QUANTA_INDEX: "on" } as NodeJS.ProcessEnv,
      passEmbed,
    )
    expect(backend.state).toBe("failed")
    expect(backend.stateReason).toBeDefined()
    expect(backend.stateReason ?? "").toContain("lannce")
  })

  test("FAIL-CLOSED-2: failed backend is INERT — upsert no-ops, query returns []", async () => {
    const backend = buildSemanticBackend(
      { QUANTA_VECTOR_STORE: "qdrnt" } as NodeJS.ProcessEnv,
      passEmbed,
    )
    // No throw, but absolutely nothing is indexed (no silent fallback store).
    const n = await upsertThenQuery(backend)
    expect(n).toBe(0)
    expect(backend.state).toBe("failed")
  })

  test("READY-1: no env (default-OFF) → state==='ready', in-memory still works", async () => {
    const backend = buildSemanticBackend({} as NodeJS.ProcessEnv, passEmbed)
    expect(backend.state).toBe("ready")
    const n = await upsertThenQuery(backend)
    expect(n).toBeGreaterThan(0)
  })

  test("READY-2: valid explicit in-memory store → state==='ready'", async () => {
    const backend = buildSemanticBackend(
      { QUANTA_VECTOR_STORE: "in-memory" } as NodeJS.ProcessEnv,
      passEmbed,
    )
    expect(backend.state).toBe("ready")
    const n = await upsertThenQuery(backend)
    expect(n).toBeGreaterThan(0)
  })

  test("FAIL-CLOSED-3: a failed backend is distinguishable from an empty ready one", async () => {
    const failed = buildSemanticBackend(
      { QUANTA_VECTOR_STORE: "nope" } as NodeJS.ProcessEnv,
      passEmbed,
    )
    const readyEmpty = buildSemanticBackend({} as NodeJS.ProcessEnv, passEmbed)
    // Both currently return [] on query, but the consumer can tell them apart
    // via `state` — the whole point of M-13.
    expect(await failed.port.query([1, 0, 0], 5)).toEqual([])
    expect(await readyEmpty.port.query([1, 0, 0], 5)).toEqual([])
    expect(failed.state).not.toBe(readyEmpty.state)
  })
})
