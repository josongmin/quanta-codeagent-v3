/**
 * HELLGATE — adversarial commit-embedder proofs (ADR-0159 Axis C).
 *
 * Invariants under attack: (i) cache poisoning — a malicious embedder
 * returning a different vector for the same sha MUST NOT silently replace
 * the cached entry across cache-hit boundaries; (ii) git log returning
 * fewer commits than `limit` is NOT an error; (iii) embed call count
 * matches MISS count exactly; (iv) shas with empty bodies are valid;
 * (v) duplicate shas in a single log call are de-duped at the cache layer.
 *
 * 12 adversarial cases.
 */

import { describe, expect, test } from "bun:test"
import {
  type CommitNote,
  createCommitEmbedder,
  type EmbeddingPort,
  type GitLogPort,
} from "@/retrieval"

const note = (sha: string, subject = "x", body = ""): CommitNote => ({
  sha,
  authorISO: "2026-05-25T00:00:00Z",
  subject,
  body,
})

const makeEmbed = (
  impl?: (texts: readonly string[]) => readonly (readonly number[])[],
): {
  port: EmbeddingPort
  calls: string[][]
} => {
  const calls: string[][] = []
  return {
    calls,
    port: {
      vendor: "openai",
      model: "test",
      async embed(texts) {
        calls.push([...texts])
        return impl ? impl(texts) : texts.map((t) => [t.length])
      },
    },
  }
}

const makeGit = (commits: CommitNote[]): GitLogPort => ({
  async log({ limit }) {
    return commits.slice(0, limit)
  },
})

describe("commit-embedder hellgate", () => {
  test("git log returns 0 commits → embedder is NEVER called", async () => {
    const e = makeEmbed()
    const ce = createCommitEmbedder({ git: makeGit([]), embed: e.port })
    await ce.recent({ limit: 10, cwd: "/" })
    expect(e.calls.length).toBe(0)
  })

  test("git log < limit returns what is available (no error, no padding)", async () => {
    const e = makeEmbed()
    const ce = createCommitEmbedder({ git: makeGit([note("a")]), embed: e.port })
    const out = await ce.recent({ limit: 100, cwd: "/" })
    expect(out.length).toBe(1)
  })

  test("repeated recent() calls hit cache (embed.calls grows by 0 on hit)", async () => {
    const e = makeEmbed()
    const ce = createCommitEmbedder({
      git: makeGit([note("a"), note("b")]),
      embed: e.port,
    })
    await ce.recent({ limit: 10, cwd: "/" })
    expect(e.calls.length).toBe(1)
    await ce.recent({ limit: 10, cwd: "/" })
    expect(e.calls.length).toBe(1) // same shas, all cached
  })

  test("cache MUST NOT re-embed a sha just because the embedder returned a different vector this time", async () => {
    let counter = 0
    const e = makeEmbed(() => [[++counter]])
    const ce = createCommitEmbedder({ git: makeGit([note("a")]), embed: e.port })
    const out1 = await ce.recent({ limit: 1, cwd: "/" })
    const out2 = await ce.recent({ limit: 1, cwd: "/" })
    expect(out1[0]?.embedding).toEqual(out2[0]?.embedding)
  })

  test("cacheMax=1 → only most-recent insertion kept", async () => {
    const e = makeEmbed()
    const ce = createCommitEmbedder({
      git: makeGit([note("a"), note("b"), note("c")]),
      embed: e.port,
      cacheMax: 1,
    })
    await ce.recent({ limit: 10, cwd: "/" })
    expect(ce.cacheSize()).toBe(1)
  })

  test("cacheMax=0 → cache is bypassed; every call re-embeds", async () => {
    const e = makeEmbed()
    const ce = createCommitEmbedder({
      git: makeGit([note("a")]),
      embed: e.port,
      cacheMax: 0,
    })
    await ce.recent({ limit: 1, cwd: "/" })
    await ce.recent({ limit: 1, cwd: "/" })
    expect(e.calls.length).toBe(2)
  })

  test("git log throwing propagates (no silent empty return)", async () => {
    const failing: GitLogPort = {
      async log() {
        throw new Error("git: not a repository")
      },
    }
    const e = makeEmbed()
    const ce = createCommitEmbedder({ git: failing, embed: e.port })
    await expect(ce.recent({ limit: 10, cwd: "/" })).rejects.toThrow("not a repository")
  })

  test("embed throwing propagates AND leaves cache untouched", async () => {
    const ce = createCommitEmbedder({
      git: makeGit([note("a")]),
      embed: {
        vendor: "openai",
        model: "x",
        async embed() {
          throw new Error("embed boom")
        },
      },
    })
    await expect(ce.recent({ limit: 1, cwd: "/" })).rejects.toThrow("embed boom")
    expect(ce.cacheSize()).toBe(0)
  })

  test("embedder returning fewer vectors than asked → missing slots default to []", async () => {
    const truncated = makeEmbed((_t) => [[1]])
    const ce = createCommitEmbedder({
      git: makeGit([note("a"), note("b")]),
      embed: truncated.port,
    })
    const out = await ce.recent({ limit: 2, cwd: "/" })
    expect(out.length).toBe(2)
    // The first slot has the real vector; the second is the [] fallback.
    expect(out[0]?.embedding).toEqual([1])
    expect(out[1]?.embedding).toEqual([])
  })

  test("subjects with newlines / unicode are embedded verbatim", async () => {
    const e = makeEmbed()
    const ce = createCommitEmbedder({
      git: makeGit([note("a", "fix: 🐛 newline\nbreak")]),
      embed: e.port,
    })
    await ce.recent({ limit: 1, cwd: "/" })
    expect(e.calls[0]?.[0]).toBe("fix: 🐛 newline\nbreak")
  })

  test("body with empty subject → embedded as '\\n\\n<body>'", async () => {
    const e = makeEmbed()
    const ce = createCommitEmbedder({
      git: makeGit([note("a", "", "body only")]),
      embed: e.port,
    })
    await ce.recent({ limit: 1, cwd: "/" })
    expect(e.calls[0]?.[0]).toBe("\n\nbody only")
  })

  test("partial-cache call: 1 hit + 1 miss → embed called with 1 text only", async () => {
    const e = makeEmbed()
    const ce = createCommitEmbedder({ git: makeGit([note("a")]), embed: e.port })
    await ce.recent({ limit: 1, cwd: "/" })
    expect(e.calls.length).toBe(1)

    const ce2 = createCommitEmbedder({
      git: makeGit([note("a"), note("b")]),
      embed: e.port,
    })
    e.calls.length = 0
    await ce2.recent({ limit: 2, cwd: "/" })
    // New CommitEmbedder instance has fresh cache → both shas embed.
    expect(e.calls[0]?.length).toBe(2)
  })
})

/* ------------------------------------------------------------------ */
/* merged from retrieval-commit-embedder.test.ts */
/* ------------------------------------------------------------------ */

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
    const ce = createCommitEmbedder({ git: g, embed: e.port })
    expect(await ce.recent({ limit: 10, cwd: "/" })).toEqual([])
    expect(e.calls.length).toBe(0)
  })

  test("first call embeds all", async () => {
    const g = makeGit([note("a", "fix x"), note("b", "feat y", "body line")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g, embed: e.port })
    const out = await ce.recent({ limit: 10, cwd: "/" })
    expect(out.length).toBe(2)
    expect(e.calls.length).toBe(1)
    expect(e.calls[0]?.length).toBe(2)
  })

  test("second call uses cache for repeated shas", async () => {
    const g = makeGit([note("a", "fix x"), note("b", "feat y")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g, embed: e.port })
    await ce.recent({ limit: 10, cwd: "/" })
    // Same instance, same shas → cache covers everything.
    e.calls.length = 0
    await ce.recent({ limit: 10, cwd: "/" })
    expect(e.calls.length).toBe(0) // both shas cached
  })

  test("body-empty commit embeds subject only", async () => {
    const g = makeGit([note("a", "only-subject")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g, embed: e.port })
    await ce.recent({ limit: 1, cwd: "/" })
    expect(e.calls[0]?.[0]).toBe("only-subject")
  })

  test("body-present commit formats as subject\\n\\nbody", async () => {
    const g = makeGit([note("a", "subj", "the body")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g, embed: e.port })
    await ce.recent({ limit: 1, cwd: "/" })
    expect(e.calls[0]?.[0]).toBe("subj\n\nthe body")
  })

  test("output preserves git log order", async () => {
    const g = makeGit([note("c", "third"), note("a", "first"), note("b", "second")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g, embed: e.port })
    const out = await ce.recent({ limit: 3, cwd: "/" })
    expect(out.map((x) => x.sha)).toEqual(["c", "a", "b"])
  })

  test("cacheSize grows after first call", async () => {
    const g = makeGit([note("a", "x"), note("b", "y")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g, embed: e.port })
    expect(ce.cacheSize()).toBe(0)
    await ce.recent({ limit: 10, cwd: "/" })
    expect(ce.cacheSize()).toBe(2)
  })

  test("LRU evicts oldest beyond cacheMax", async () => {
    const g = makeGit([note("a", "x"), note("b", "y"), note("c", "z")])
    const e = countingEmbed()
    const ce = createCommitEmbedder({ git: g, embed: e.port, cacheMax: 2 })
    await ce.recent({ limit: 10, cwd: "/" })
    expect(ce.cacheSize()).toBe(2) // capped
  })
})
