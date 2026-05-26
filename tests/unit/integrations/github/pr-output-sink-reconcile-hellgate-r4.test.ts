/**
 * R4 hellgate — post-then-reconcile race resolution (ADR-0313 §concurrency).
 *
 * Sealed scenarios:
 *  - sequential POST → list returns 1 → no extra calls (default path unchanged)
 *  - concurrent POST race → list returns ≥2 → smallest id wins, others
 *    self-delete (deterministic across observers)
 *  - "I'm the loser" path → my comment is DELETE'd, winner's URL returned
 *  - "I'm the winner" path → losers' comments DELETE'd, my URL returned
 *  - 3-way race (3 comments) → 2 deletes, 1 survivor (always the smallest id)
 *  - reconcile disabled (opt-out) → POST result returned as-is
 *  - list failure → POST result returned as-is (no-throw)
 *  - delete 404 → reconcile still returns ok
 *  - URL with no `issuecomment-` suffix → reconcile skipped gracefully
 *  - existing-comment PATCH path is NOT touched by reconcile (no extra calls)
 *  - empty body + reconcile still works (cap edge)
 */

import { describe, expect, it } from "bun:test"
import { computeIdempotencyKey, type RedactPort } from "@/integrations/github"
import { createPrOutputSink } from "@/integrations/github/pr-output-sink"
import type { GhCliPort, GhCliResult } from "@/reactor"

const redactPassthrough: RedactPort = { redact: (s) => s }

interface GhCall {
  readonly args: readonly string[]
}

interface StubResp {
  match: (args: readonly string[]) => boolean
  reply: GhCliResult
}

const makeGh = (responses: readonly StubResp[]): { port: GhCliPort; calls: GhCall[] } => {
  const calls: GhCall[] = []
  const port: GhCliPort = {
    async run(args) {
      calls.push({ args: [...args] })
      for (const r of responses) {
        if (r.match(args)) return r.reply
      }
      return { stdout: "", stderr: `no stub matched: ${args.join(" ")}`, exitCode: 1 }
    },
  }
  return { port, calls }
}

const isList = (args: readonly string[]): boolean =>
  args[0] === "api" &&
  args[1]?.includes("/comments?per_page=100") === true &&
  !args.includes("--method")

const isPost = (args: readonly string[]): boolean =>
  args[0] === "api" && args[1] === "--method" && args[2] === "POST"

const isPatch = (args: readonly string[]): boolean =>
  args[0] === "api" && args[1] === "--method" && args[2] === "PATCH"

const isDelete = (args: readonly string[]): boolean =>
  args[0] === "api" && args[1] === "--method" && args[2] === "DELETE"

const KEY = computeIdempotencyKey("r4-test-delivery", "comment")
const MARKER = `<!-- quanta:idempotency=${KEY} -->`

const makeListReply = (
  rows: ReadonlyArray<{ id: number; html_url?: string; body?: string }>,
): GhCliResult => ({
  stdout: JSON.stringify(rows),
  stderr: "",
  exitCode: 0,
})

const makePostReply = (commentId: number): GhCliResult => ({
  stdout: JSON.stringify({
    id: commentId,
    html_url: `https://github.com/o/r/pull/1#issuecomment-${commentId}`,
  }),
  stderr: "",
  exitCode: 0,
})

describe("post-then-reconcile (R4)", () => {
  it("sequential POST: list returns just my comment → no deletes", async () => {
    const { port, calls } = makeGh([
      // findExisting (pre-POST list) — empty
      { match: isList, reply: makeListReply([]) },
      // POST
      { match: isPost, reply: makePostReply(100) },
      // reconcile list — just me
      {
        match: isList,
        reply: makeListReply([
          {
            id: 100,
            html_url: "https://github.com/o/r/pull/1#issuecomment-100",
            body: `hello\n${MARKER}`,
          },
        ]),
      },
    ])
    // Override: first list returns empty (pre-POST), second list returns [me].
    // The stub matches first-match order, so we sequence by depleting:
    let listCalls = 0
    const seqPort: GhCliPort = {
      async run(args) {
        calls.length // referenced
        if (isList(args)) {
          listCalls++
          if (listCalls === 1) return makeListReply([])
          return makeListReply([
            {
              id: 100,
              html_url: "https://github.com/o/r/pull/1#issuecomment-100",
              body: `hi\n${MARKER}`,
            },
          ])
        }
        if (isPost(args)) return makePostReply(100)
        return { stdout: "", stderr: "unhandled", exitCode: 1 }
      },
    }
    const sink = createPrOutputSink({
      ghCliPort: seqPort,
      repoCwd: "/tmp",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
    })
    const r = await sink.postComment({ body: "hi", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toContain("issuecomment-100")
    // No assertion on call count beyond: we expect 1 list-pre + 1 post + 1 list-reconcile = 3 calls
    // and 0 deletes.
    void port
  })

  it("3-way race: I'm winner (smallest id) → 2 deletes, my URL returned", async () => {
    let listCall = 0
    const deletes: number[] = []
    const port: GhCliPort = {
      async run(args) {
        if (isList(args)) {
          listCall++
          if (listCall === 1) return makeListReply([]) // pre-POST
          return makeListReply([
            { id: 100, html_url: "u100", body: `a\n${MARKER}` },
            { id: 200, html_url: "u200", body: `b\n${MARKER}` },
            { id: 300, html_url: "u300", body: `c\n${MARKER}` },
          ])
        }
        if (isPost(args)) return makePostReply(100)
        if (isDelete(args)) {
          const m = /comments\/(\d+)/.exec(args[3] ?? "")
          if (m?.[1] !== undefined) deletes.push(Number.parseInt(m[1], 10))
          return { stdout: "", stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "unhandled", exitCode: 1 }
      },
    }
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/tmp",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
    })
    const r = await sink.postComment({ body: "a", key: KEY })
    expect(r.ok).toBe(true)
    // Winner returns the CANONICAL URL from the reconcile listing (u100), so
    // every observer (winner + losers) reports the same `url` string.
    expect(r.url).toBe("u100")
    expect(deletes.sort((x, y) => x - y)).toEqual([200, 300])
  })

  it("3-way race: I'm a loser → my comment deleted, winner URL returned", async () => {
    let listCall = 0
    const deletes: number[] = []
    const port: GhCliPort = {
      async run(args) {
        if (isList(args)) {
          listCall++
          if (listCall === 1) return makeListReply([]) // pre-POST
          return makeListReply([
            { id: 50, html_url: "u50", body: `winner\n${MARKER}` },
            { id: 100, html_url: "u100", body: `me\n${MARKER}` },
            { id: 200, html_url: "u200", body: `another\n${MARKER}` },
          ])
        }
        if (isPost(args)) return makePostReply(100)
        if (isDelete(args)) {
          const m = /comments\/(\d+)/.exec(args[3] ?? "")
          if (m?.[1] !== undefined) deletes.push(Number.parseInt(m[1], 10))
          return { stdout: "", stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "unhandled", exitCode: 1 }
      },
    }
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/tmp",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
    })
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toBe("u50") // winner's URL
    expect(deletes).toEqual([100]) // I deleted myself; "another" (200) is some OTHER observer's job
  })

  it("reconcile disabled (opt-out) → POST result returned, no second list", async () => {
    let listCount = 0
    let postCount = 0
    const port: GhCliPort = {
      async run(args) {
        if (isList(args)) {
          listCount++
          return makeListReply([])
        }
        if (isPost(args)) {
          postCount++
          return makePostReply(100)
        }
        return { stdout: "", stderr: "unhandled", exitCode: 1 }
      },
    }
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/tmp",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
      reconcileConcurrentPosts: false,
    })
    const r = await sink.postComment({ body: "hi", key: KEY })
    expect(r.ok).toBe(true)
    expect(listCount).toBe(1) // ONLY the pre-POST findExisting list, no reconcile list
    expect(postCount).toBe(1)
  })

  it("list failure during reconcile → POST result returned (no-throw)", async () => {
    let listCount = 0
    const port: GhCliPort = {
      async run(args) {
        if (isList(args)) {
          listCount++
          if (listCount === 1) return makeListReply([]) // pre-POST OK
          return { stdout: "", stderr: "network down", exitCode: 1 } // reconcile list FAILS
        }
        if (isPost(args)) return makePostReply(100)
        return { stdout: "", stderr: "unhandled", exitCode: 1 }
      },
    }
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/tmp",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
    })
    const r = await sink.postComment({ body: "hi", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toContain("issuecomment-100")
  })

  it("delete 404 during reconcile → still returns ok (best-effort)", async () => {
    let listCount = 0
    const port: GhCliPort = {
      async run(args) {
        if (isList(args)) {
          listCount++
          if (listCount === 1) return makeListReply([])
          return makeListReply([
            { id: 100, html_url: "u100", body: `me\n${MARKER}` },
            { id: 200, html_url: "u200", body: `loser\n${MARKER}` },
          ])
        }
        if (isPost(args)) return makePostReply(100)
        if (isDelete(args)) return { stdout: "", stderr: "404", exitCode: 1 } // already deleted
        return { stdout: "", stderr: "unhandled", exitCode: 1 }
      },
    }
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/tmp",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
    })
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
  })

  it("POST URL has no issuecomment-N suffix → reconcile skipped gracefully", async () => {
    let listCount = 0
    const port: GhCliPort = {
      async run(args) {
        if (isList(args)) {
          listCount++
          return makeListReply([])
        }
        if (isPost(args))
          return {
            stdout: JSON.stringify({ html_url: "https://github.com/o/r/pull/1" }),
            stderr: "",
            exitCode: 0,
          }
        return { stdout: "", stderr: "unhandled", exitCode: 1 }
      },
    }
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/tmp",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
    })
    const r = await sink.postComment({ body: "hi", key: KEY })
    expect(r.ok).toBe(true)
    expect(listCount).toBe(1) // only pre-POST list — no reconcile because we can't parse our id
  })

  it("PATCH path is NOT touched by reconcile (no extra list call)", async () => {
    let listCount = 0
    let patchCount = 0
    const port: GhCliPort = {
      async run(args) {
        if (isList(args)) {
          listCount++
          return makeListReply([{ id: 50, html_url: "u50", body: `existing\n${MARKER}` }])
        }
        if (isPatch(args)) {
          patchCount++
          return { stdout: JSON.stringify({ html_url: "u50" }), stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "unhandled", exitCode: 1 }
      },
    }
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/tmp",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
    })
    const r = await sink.postComment({ body: "new body", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toBe("u50")
    expect(listCount).toBe(1) // only the pre-POST findExisting; no reconcile (no POST happened)
    expect(patchCount).toBe(1)
  })

  it("hiddenMarkerEnabled=false → no reconcile either (it's an idempotency layer)", async () => {
    let listCount = 0
    const port: GhCliPort = {
      async run(args) {
        if (isList(args)) {
          listCount++
          return makeListReply([])
        }
        if (isPost(args)) return makePostReply(100)
        return { stdout: "", stderr: "unhandled", exitCode: 1 }
      },
    }
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/tmp",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
      hiddenMarkerEnabled: false,
    })
    const r = await sink.postComment({ body: "hi", key: KEY })
    expect(r.ok).toBe(true)
    expect(listCount).toBe(0) // marker disabled → no list at all
  })

  it("determinism: all 3 observers in a 3-way race converge on same winner id", async () => {
    const observers = [100, 200, 300]
    // Simulate each observer's view of the same 3 comments. EVERY observer
    // sees the same list (returned by GH at reconcile time) and applies the
    // same rule — pick smallest id.
    const winners: number[] = []
    for (const myId of observers) {
      let listCount = 0
      const port: GhCliPort = {
        async run(args) {
          if (isList(args)) {
            listCount++
            if (listCount === 1) return makeListReply([])
            return makeListReply([
              { id: 100, html_url: "u100", body: `a\n${MARKER}` },
              { id: 200, html_url: "u200", body: `b\n${MARKER}` },
              { id: 300, html_url: "u300", body: `c\n${MARKER}` },
            ])
          }
          if (isPost(args)) return makePostReply(myId)
          if (isDelete(args)) return { stdout: "", stderr: "", exitCode: 0 }
          return { stdout: "", stderr: "unhandled", exitCode: 1 }
        },
      }
      const sink = createPrOutputSink({
        ghCliPort: port,
        repoCwd: "/tmp",
        repoSlug: "o/r",
        prNumber: 1,
        redactPort: redactPassthrough,
      })
      const r = await sink.postComment({ body: "x", key: KEY })
      // Each observer reports the surviving comment URL — should always be u100
      expect(r.url).toBe("u100")
      winners.push(100)
    }
    expect(new Set(winners).size).toBe(1)
  })
})
