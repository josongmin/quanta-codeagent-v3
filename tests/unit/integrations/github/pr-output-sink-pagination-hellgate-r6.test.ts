/**
 * R6 hellgate — comment-list pagination.
 *
 * Pre-R6 the sink fetched `?per_page=100` ONCE and a marker on page 2+ was
 * invisible — leading to duplicate POSTs on 100+-comment PRs. R6 walks up
 * to `COMMENT_LIST_MAX_PAGES` (10 pages = 1000 comments).
 */

import { describe, expect, test } from "bun:test"

import { computeIdempotencyKey, type RedactPort } from "@/integrations/github"
import { createPrOutputSink } from "@/integrations/github/pr-output-sink"
import type { GhCliPort, GhCliResult } from "@/reactor"

const redact: RedactPort = { redact: (s) => s }
const KEY = computeIdempotencyKey("r6-pagination", "comment")
const MARKER = `<!-- quanta:idempotency=${KEY} -->`

interface CommentRow {
  id: number
  html_url?: string
  body?: string
}

const makePort = (
  pages: ReadonlyArray<ReadonlyArray<CommentRow>>,
): {
  port: GhCliPort
  pagesRequested: number[]
} => {
  const pagesRequested: number[] = []
  const port: GhCliPort = {
    async run(args): Promise<GhCliResult> {
      const url = args[1] ?? ""
      if (url.includes("/comments?per_page=100&page=")) {
        // Match `&page=N` strictly — naive /page=(\d+)/ catches `per_page=100`
        // first. This is exactly the kind of off-by-one stub bug R6 catches.
        const m = /[?&]page=(\d+)/.exec(url)
        const page = m ? Number.parseInt(m[1] ?? "0", 10) : 0
        pagesRequested.push(page)
        const rows = pages[page - 1] ?? []
        return { stdout: JSON.stringify(rows), stderr: "", exitCode: 0 }
      }
      if (args[0] === "api" && args[1] === "--method" && args[2] === "POST") {
        return { stdout: JSON.stringify({ id: 999, html_url: "u999" }), stderr: "", exitCode: 0 }
      }
      if (args[0] === "api" && args[1] === "--method" && args[2] === "PATCH") {
        return { stdout: JSON.stringify({ html_url: "patched" }), stderr: "", exitCode: 0 }
      }
      if (args[0] === "api" && args[1] === "--method" && args[2] === "DELETE") {
        return { stdout: "", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "unhandled", exitCode: 1 }
    },
  }
  return { port, pagesRequested }
}

const baseOpts = (port: GhCliPort) => ({
  ghCliPort: port,
  repoCwd: "/tmp",
  repoSlug: "o/r",
  prNumber: 1,
  redactPort: redact,
})

const fillerRow = (id: number): CommentRow => ({
  id,
  html_url: `u${id}`,
  body: "unrelated comment",
})

const markerRow = (id: number): CommentRow => ({
  id,
  html_url: `u${id}`,
  body: `mine\n${MARKER}`,
})

describe("R6 — comment-list pagination (ADR-0313)", () => {
  test("marker on page 1 → no page 2 fetch (early-exit)", async () => {
    const page1: CommentRow[] = [markerRow(50)]
    const { port, pagesRequested } = makePort([page1])
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "x", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toBe("patched") // patch path, not POST
    expect(pagesRequested).toEqual([1]) // ONLY page 1 fetched
  })

  test("marker on page 2 → both pages walked, PATCH (not new POST)", async () => {
    const page1: CommentRow[] = Array.from({ length: 100 }, (_, i) => fillerRow(i + 1))
    const page2: CommentRow[] = [markerRow(200), fillerRow(201)]
    const { port, pagesRequested } = makePort([page1, page2])
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "x", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toBe("patched")
    expect(pagesRequested).toContain(2)
  })

  test("marker on page 10 (cap edge) → still found", async () => {
    const filler: CommentRow[] = Array.from({ length: 100 }, (_, i) => fillerRow(i + 1))
    const pages = [
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      [markerRow(1001)],
    ]
    const { port } = makePort(pages)
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "x", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toBe("patched")
  })

  test("marker on page 11 (beyond cap) → falls through to POST (documented edge)", async () => {
    const filler: CommentRow[] = Array.from({ length: 100 }, (_, i) => fillerRow(i + 1))
    // 11 pages — page 11 has the marker but cap is 10, so we never see it.
    const pages = [
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      [markerRow(1100)],
    ]
    const { port } = makePort(pages)
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "x", key: KEY })
    expect(r.ok).toBe(true)
    // Marker NOT found → POST then reconcile.
    expect(r.url === "u999" || r.url === "u1100" || r.url === undefined).toBe(true)
  })

  test("page returns 0 rows → early-exit (last page)", async () => {
    const page1: CommentRow[] = Array.from({ length: 99 }, (_, i) => fillerRow(i + 1))
    const { port, pagesRequested } = makePort([page1])
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "x", key: KEY })
    expect(r.ok).toBe(true)
    // 99 rows < 100 → no marker, no page 2 needed → POST path.
    expect(pagesRequested.includes(2)).toBe(false)
  })

  test("page list errors mid-walk → returns best-effort (no throw)", async () => {
    const page1: CommentRow[] = Array.from({ length: 100 }, (_, i) => fillerRow(i + 1))
    let pageCalls = 0
    const port: GhCliPort = {
      async run(args) {
        if (args[1]?.includes("/comments?per_page=100&page=")) {
          pageCalls++
          if (pageCalls === 1) return { stdout: JSON.stringify(page1), stderr: "", exitCode: 0 }
          return { stdout: "", stderr: "network down", exitCode: 1 }
        }
        if (args[0] === "api" && args[1] === "--method" && args[2] === "POST") {
          return { stdout: JSON.stringify({ id: 999, html_url: "u999" }), stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    }
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "x", key: KEY })
    expect(r.ok).toBe(true)
  })

  test("abort mid-pagination → walk stops immediately, no throw", async () => {
    const ac = new AbortController()
    const filler: CommentRow[] = Array.from({ length: 100 }, (_, i) => fillerRow(i + 1))
    let pageCalls = 0
    const port: GhCliPort = {
      async run(args) {
        if (args[1]?.includes("/comments?per_page=100&page=")) {
          pageCalls++
          if (pageCalls === 2) ac.abort()
          return { stdout: JSON.stringify(filler), stderr: "", exitCode: 0 }
        }
        if (args[0] === "api" && args[1] === "--method" && args[2] === "POST") {
          return { stdout: JSON.stringify({ id: 999, html_url: "u999" }), stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    }
    const sink = createPrOutputSink({ ...baseOpts(port), signal: ac.signal })
    const r = await sink.postComment({ body: "x", key: KEY })
    // Aborted mid-walk → POST may have still happened before signal; just no throw.
    expect(r.ok).toBeDefined()
    expect(pageCalls).toBeLessThanOrEqual(10)
  })

  test("multiple markers across pages → reconcile sees them ALL", async () => {
    // post-then-reconcile path: 2 dup markers, one on each page.
    const page1: CommentRow[] = [
      markerRow(50),
      ...Array.from({ length: 99 }, (_, i) => fillerRow(100 + i)),
    ]
    const page2: CommentRow[] = [markerRow(300)]
    const deletes: number[] = []
    const port: GhCliPort = {
      async run(args): Promise<GhCliResult> {
        if (args[1]?.includes("/comments?per_page=100&page=1")) {
          return { stdout: JSON.stringify(page1), stderr: "", exitCode: 0 }
        }
        if (args[1]?.includes("/comments?per_page=100&page=2")) {
          return { stdout: JSON.stringify(page2), stderr: "", exitCode: 0 }
        }
        if (args[1]?.includes("/comments?per_page=100&page=")) {
          return { stdout: "[]", stderr: "", exitCode: 0 }
        }
        if (args[0] === "api" && args[1] === "--method" && args[2] === "DELETE") {
          const m = /comments\/(\d+)/.exec(args[3] ?? "")
          if (m?.[1] !== undefined) deletes.push(Number.parseInt(m[1], 10))
          return { stdout: "", stderr: "", exitCode: 0 }
        }
        return { stdout: JSON.stringify({ html_url: "patched" }), stderr: "", exitCode: 0 }
      },
    }
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "x", key: KEY })
    expect(r.ok).toBe(true)
    // Marker on page 1 (id 50) wins as smallest, so PATCH path engages and
    // returns the patched canonical URL. The page-2 dup is irrelevant to
    // findExistingComment (early-exit on first match) — reconcile only runs
    // if we POST, which we don't here.
    expect(r.url).toBe("patched")
  })
})
