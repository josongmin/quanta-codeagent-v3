/**
 * ADR-0311 hellgate R2 — pr-context-loader against network / permission /
 * truncation / abort / corruption attacks. The loader's safety invariant is
 * strict: ANY failure ⇒ undefined; never throws; never returns a partial
 * PrContext.
 *
 * R1 covered the happy path + basic JSON shape. R2 targets:
 *   - throw-on-call (signal abort path),
 *   - mid-stdout truncation (partial JSON),
 *   - 403 permission denied / rate limit (exit codes 4 / 1),
 *   - diff exactly at 1MB cap and 1MB+1 byte,
 *   - massive changedFiles array (no DoS),
 *   - null comment body / missing user.login (surface gracefully),
 *   - empty / non-hex SHA strings (surface verbatim, caller validates),
 *   - server returning a DIFFERENT PR number (we don't validate).
 */

import { describe, expect, test } from "bun:test"

import { loadPrContext } from "@/integrations/github"
import type { GhCliPort, GhCliResult } from "@/reactor"

import { fail, ok, okText } from "./_helpers"

interface CannedShape {
  readonly view?: GhCliResult | Error
  readonly diff?: GhCliResult | Error
  readonly files?: GhCliResult | Error
  readonly comments?: GhCliResult | Error
}

const resolve = (entry: GhCliResult | Error | undefined, fallback: string): GhCliResult => {
  if (entry instanceof Error) throw entry
  return entry ?? fail(fallback)
}

const routeArgs = (args: readonly string[]): keyof CannedShape | undefined => {
  if (args[0] === "pr" && args[1] === "view") return "view"
  if (args[0] === "pr" && args[1] === "diff") return "diff"
  if (args[0] === "api" && args.some((a) => a.includes("/files"))) return "files"
  if (args[0] === "api" && args.some((a) => a.includes("/comments"))) return "comments"
  return undefined
}

const makePort = (canned: CannedShape): GhCliPort => ({
  run: async (args) => {
    const route = routeArgs(args)
    if (route === undefined) return fail("unmatched")
    return resolve(canned[route], `no-${route}`)
  },
})

const baseOpts = (port: GhCliPort) => ({
  ghCliPort: port,
  repoCwd: "/r",
  repoSlug: "o/r",
  prNumber: 42,
})

describe("ADR-0311 hellgate R2 — pr-context-loader network", () => {
  test("aborted signal pre-call ⇒ undefined, no gh invocation", async () => {
    let invoked = false
    const port: GhCliPort = {
      run: async () => {
        invoked = true
        return ok({})
      },
    }
    const ac = new AbortController()
    ac.abort()
    const ctx = await loadPrContext({ ...baseOpts(port), signal: ac.signal })
    expect(ctx).toBeUndefined()
    expect(invoked).toBe(false)
  })

  test("gh pr view throws (process crash) ⇒ undefined", async () => {
    const port = makePort({ view: new Error("gh spawn crashed") })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx).toBeUndefined()
  })

  test("gh pr diff returns truncated JSON in non-JSON channel ⇒ accepts as raw text", async () => {
    // pr diff is TEXT, not JSON — partial output is still a valid diff string.
    const truncated = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1\n-old"
    const port = makePort({
      view: ok({ title: "t", baseRefOid: "a", headRefOid: "b" }),
      diff: okText(truncated),
      files: ok([{ filename: "x" }]),
      comments: ok([]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx?.diff).toBe(truncated)
  })

  test("gh api files returns malformed JSON ⇒ undefined", async () => {
    const port = makePort({
      view: ok({ title: "t" }),
      diff: okText(""),
      files: { stdout: "not json {", stderr: "", exitCode: 0 },
      comments: ok([]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx).toBeUndefined()
  })

  test("gh pr view exits 4 (permission denied / not authorized) ⇒ undefined", async () => {
    const port = makePort({ view: fail("HTTP 403", 4) })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx).toBeUndefined()
  })

  test("gh api files exits 1 (rate limit) ⇒ undefined (loader fails closed)", async () => {
    const port = makePort({
      view: ok({ title: "t" }),
      diff: okText(""),
      files: fail("API rate limit exceeded"),
      comments: ok([]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx).toBeUndefined()
  })

  test("diff exactly at 1MB cap ⇒ NOT truncated (no sentinel)", async () => {
    const oneMB = "d".repeat(1024 * 1024)
    const port = makePort({
      view: ok({ title: "t" }),
      diff: okText(oneMB),
      files: ok([]),
      comments: ok([]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx?.diff).toBe(oneMB)
    expect(ctx?.diff).not.toContain("[truncated at")
  })

  test("diff exactly 1MB+1 byte ⇒ truncated with sentinel", async () => {
    const over = "d".repeat(1024 * 1024 + 1)
    const port = makePort({
      view: ok({ title: "t" }),
      diff: okText(over),
      files: ok([]),
      comments: ok([]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx?.diff.endsWith(`\n[truncated at ${1024 * 1024} bytes]`)).toBe(true)
  })

  test("10000 changed files ⇒ all surfaced (loader does not silently cap)", async () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ filename: `f${i}.ts` }))
    const port = makePort({
      view: ok({ title: "t" }),
      diff: okText(""),
      files: ok(many),
      comments: ok([]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx?.changedFiles.length).toBe(10_000)
    expect(ctx?.changedFiles[0]).toBe("f0.ts")
    expect(ctx?.changedFiles[9999]).toBe("f9999.ts")
  })

  test("comment with null body ⇒ surfaces as '' (not null)", async () => {
    const port = makePort({
      view: ok({ title: "t" }),
      diff: okText(""),
      files: ok([]),
      comments: ok([{ user: { login: "u1" }, body: null, updated_at: "now" }]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx?.recentComments.length).toBe(1)
    expect(ctx?.recentComments[0]?.body).toBe("")
  })

  test("comment with missing user.login ⇒ row is SILENTLY DROPPED", async () => {
    const port = makePort({
      view: ok({ title: "t" }),
      diff: okText(""),
      files: ok([]),
      comments: ok([
        { user: {}, body: "no author", updated_at: "now" },
        { user: { login: "u1" }, body: "real", updated_at: "now" },
      ]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx?.recentComments.length).toBe(1)
    expect(ctx?.recentComments[0]?.author).toBe("u1")
  })

  test("baseSha / headSha are empty strings ⇒ surfaced verbatim", async () => {
    const port = makePort({
      view: ok({ title: "t", baseRefOid: "", headRefOid: "" }),
      diff: okText(""),
      files: ok([]),
      comments: ok([]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx?.baseSha).toBe("")
    expect(ctx?.headSha).toBe("")
  })

  test("baseSha is non-hex garbage ⇒ surfaced verbatim (caller validates)", async () => {
    const port = makePort({
      view: ok({ title: "t", baseRefOid: "not-a-hash!!", headRefOid: "deadbeef" }),
      diff: okText(""),
      files: ok([]),
      comments: ok([]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    expect(ctx?.baseSha).toBe("not-a-hash!!")
  })

  test("server returns a PrViewRow with WRONG number field ⇒ loader does NOT trust it (uses opts.prNumber)", async () => {
    const port = makePort({
      view: ok({ title: "t", number: 999, baseRefOid: "a", headRefOid: "b" }),
      diff: okText(""),
      files: ok([]),
      comments: ok([]),
    })
    const ctx = await loadPrContext(baseOpts(port))
    // PR number on the returned context is the one the caller passed (42),
    // NOT the server-claimed 999.
    expect(ctx?.prNumber).toBe(42)
  })

  test("aborted signal between view and diff calls ⇒ undefined (no diff fetch)", async () => {
    const ac = new AbortController()
    let stage = 0
    const port: GhCliPort = {
      run: async (args) => {
        stage += 1
        if (args[1] === "view") {
          // Abort AFTER returning the view payload.
          queueMicrotask(() => ac.abort())
          return ok({ title: "t" })
        }
        return fail("should-not-reach")
      },
    }
    const ctx = await loadPrContext({ ...baseOpts(port), signal: ac.signal })
    expect(ctx).toBeUndefined()
    expect(stage).toBe(1) // only the view call happened
  })
})
