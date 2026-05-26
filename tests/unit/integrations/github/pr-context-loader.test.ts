/**
 * ADR-0311 — loadPrContext: bundle 4 gh calls into a PrContext or undefined.
 */

import { describe, expect, test } from "bun:test"

import { loadPrContext } from "@/integrations/github"

import { fail, fakeGhPort, ok, okText } from "./_helpers"

const viewJson = ok({
  title: "Fix the thing",
  body: "## Summary\n\nFixes a thing.",
  baseRefName: "main",
  headRefName: "feat/fix",
  baseRefOid: "deadbeef",
  headRefOid: "cafef00d",
  number: 9,
})

const filesJson = ok([{ filename: "src/a.ts" }, { filename: "src/b.ts" }, {}])

const commentsJson = ok([
  { user: { login: "u1" }, body: "first", updated_at: "2026-05-26T12:00:00Z" },
  { user: { login: "u2" }, body: "second", created_at: "2026-05-26T13:00:00Z" },
])

describe("ADR-0311 — loadPrContext", () => {
  test("happy path returns full bundle", async () => {
    const gh = fakeGhPort([
      { match: (a) => a[0] === "pr" && a[1] === "view", result: viewJson },
      {
        match: (a) => a[0] === "pr" && a[1] === "diff",
        result: okText("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n"),
      },
      { match: (a) => a[0] === "api" && a[1]?.includes("/files") === true, result: filesJson },
      {
        match: (a) => a[0] === "api" && a[1]?.includes("/comments") === true,
        result: commentsJson,
      },
    ])
    const ctx = await loadPrContext({
      ghCliPort: gh.port,
      repoCwd: "/tmp/repo",
      repoSlug: "octo/demo",
      prNumber: 9,
    })
    expect(ctx).toBeDefined()
    if (ctx === undefined) throw new Error("unreachable")
    expect(ctx.title).toBe("Fix the thing")
    expect(ctx.headSha).toBe("cafef00d")
    expect(ctx.changedFiles).toEqual(["src/a.ts", "src/b.ts"])
    expect(ctx.diff).toContain("@@ -1 +1 @@")
    expect(ctx.recentComments.length).toBe(2)
    expect(ctx.recentComments[0]?.author).toBe("u1")
  })

  test("any gh call failing collapses to undefined", async () => {
    const gh = fakeGhPort([
      { match: (a) => a[0] === "pr" && a[1] === "view", result: viewJson },
      { match: (a) => a[0] === "pr" && a[1] === "diff", result: fail("denied") },
    ])
    const ctx = await loadPrContext({
      ghCliPort: gh.port,
      repoCwd: "/tmp/repo",
      repoSlug: "octo/demo",
      prNumber: 9,
    })
    expect(ctx).toBeUndefined()
  })

  test("diff over cap is truncated with sentinel", async () => {
    const bigDiff = "X".repeat(2 * 1024 * 1024)
    const gh = fakeGhPort([
      { match: (a) => a[0] === "pr" && a[1] === "view", result: viewJson },
      { match: (a) => a[0] === "pr" && a[1] === "diff", result: okText(bigDiff) },
      { match: (a) => a[0] === "api" && a[1]?.includes("/files") === true, result: filesJson },
      {
        match: (a) => a[0] === "api" && a[1]?.includes("/comments") === true,
        result: commentsJson,
      },
    ])
    const ctx = await loadPrContext({
      ghCliPort: gh.port,
      repoCwd: "/tmp/repo",
      repoSlug: "octo/demo",
      prNumber: 9,
      diffMaxBytes: 1024,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.diff.endsWith("[truncated at 1024 bytes]")).toBe(true)
  })

  test("aborted signal returns undefined", async () => {
    const gh = fakeGhPort([])
    const ctrl = new AbortController()
    ctrl.abort()
    expect(
      await loadPrContext({
        ghCliPort: gh.port,
        repoCwd: "/tmp/repo",
        repoSlug: "octo/demo",
        prNumber: 9,
        signal: ctrl.signal,
      }),
    ).toBeUndefined()
  })

  test("gh throws ⇒ undefined (no propagation)", async () => {
    const gh = fakeGhPort([
      { match: (a) => a[0] === "pr" && a[1] === "view", result: new Error("ENOENT") },
    ])
    expect(
      await loadPrContext({
        ghCliPort: gh.port,
        repoCwd: "/tmp/repo",
        repoSlug: "octo/demo",
        prNumber: 9,
      }),
    ).toBeUndefined()
  })
})
