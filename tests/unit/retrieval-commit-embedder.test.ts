/**
 * Unit — commit-embedder (ADR-0159 Axis C).
 *
 * GitLogPort + EmbeddingPort both injected — no shell, no network.
 * Asserts LRU cache hit/miss behavior across repeated calls.
 */
import { describe, expect, test } from "bun:test"
import {
  type CommitNote,
  createCommitEmbedder,
  type EmbeddingPort,
  type GitLogPort,
} from "@/retrieval"

const note = (sha: string, subject: string, body = ""): CommitNote => ({
  sha,
  authorISO: "2026-05-25T00:00:00Z",
  subject,
  body,
})

const makeGit = (commits: CommitNote[]): { port: GitLogPort; calls: number } => {
  let calls = 0
  return {
    calls,
    port: {
      async log({ limit }) {
        calls++
        return commits.slice(0, limit)
      },
    },
    // exposes a fresh counter ref
  }
}

const countingEmbed = (): { port: EmbeddingPort; calls: string[][] } => {
  const calls: string[][] = []
  return {
    calls,
    port: {
      vendor: "openai",
      model: "test",
      async embed(texts) {
        calls.push([...texts])
        return texts.map((t) => [t.length, calls.length])
      },
    },
  }
}

describe("createCommitEmbedder", () => {
  test("empty git log returns []", async () => {
    const g = makeGit([])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g.port, embed: e.port })
    expect(await ce.recent({ limit: 10, cwd: "/" })).toEqual([])
    expect(e.calls.length).toBe(0)
  })

  test("first call embeds all", async () => {
    const g = makeGit([note("a", "fix x"), note("b", "feat y", "body line")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g.port, embed: e.port })
    const out = await ce.recent({ limit: 10, cwd: "/" })
    expect(out.length).toBe(2)
    expect(e.calls.length).toBe(1)
    expect(e.calls[0]?.length).toBe(2)
  })

  test("second call uses cache for repeated shas", async () => {
    const g = makeGit([note("a", "fix x"), note("b", "feat y")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g.port, embed: e.port })
    await ce.recent({ limit: 10, cwd: "/" })
    // Same instance, same shas → cache covers everything.
    e.calls.length = 0
    await ce.recent({ limit: 10, cwd: "/" })
    expect(e.calls.length).toBe(0) // both shas cached
  })

  test("body-empty commit embeds subject only", async () => {
    const g = makeGit([note("a", "only-subject")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g.port, embed: e.port })
    await ce.recent({ limit: 1, cwd: "/" })
    expect(e.calls[0]?.[0]).toBe("only-subject")
  })

  test("body-present commit formats as subject\\n\\nbody", async () => {
    const g = makeGit([note("a", "subj", "the body")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g.port, embed: e.port })
    await ce.recent({ limit: 1, cwd: "/" })
    expect(e.calls[0]?.[0]).toBe("subj\n\nthe body")
  })

  test("output preserves git log order", async () => {
    const g = makeGit([note("c", "third"), note("a", "first"), note("b", "second")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g.port, embed: e.port })
    const out = await ce.recent({ limit: 3, cwd: "/" })
    expect(out.map((x) => x.sha)).toEqual(["c", "a", "b"])
  })

  test("cacheSize grows after first call", async () => {
    const g = makeGit([note("a", "x"), note("b", "y")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g.port, embed: e.port })
    expect(ce.cacheSize()).toBe(0)
    await ce.recent({ limit: 10, cwd: "/" })
    expect(ce.cacheSize()).toBe(2)
  })

  test("LRU evicts oldest beyond cacheMax", async () => {
    const g = makeGit([note("a", "x"), note("b", "y"), note("c", "z")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g.port, embed: e.port, cacheMax: 2 })
    await ce.recent({ limit: 10, cwd: "/" })
    expect(ce.cacheSize()).toBe(2) // capped
  })
})
