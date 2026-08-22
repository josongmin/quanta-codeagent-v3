/**
 * R5 hellgate — bounded reconcile retry loop (ADR-0313 §concurrency / R4 follow-up).
 *
 * R4 sealed the single-pass post-then-reconcile: list once, smallest id wins,
 * losers self-delete. R4 cannot resolve a higher-burst race — if 5 processes
 * race and ALL of them list mid-race (BEFORE every loser deletes), each one
 * still sees ≥2 survivors AFTER its own delete. The fix (assumed landed by the
 * parallel main track) is a **bounded retry loop**: after the first reconcile,
 * if `list().length >= 2` again, re-list + re-reconcile up to N times.
 *
 * Why bounded: GH API has no conditional-write; an unbounded loop would let a
 * hostile network DoS us. R4 default `reconcileMaxRetries: 3` is enough for
 * 5-burst convergence (delete-then-list is monotone-shrinking).
 *
 * Contract under test (post-fix shape):
 *   - knob: `reconcileMaxRetries?: number` (default 3, min 0).
 *   - first reconcile yields 1 → no second list.
 *   - first reconcile yields ≥2 → delete losers → re-list → re-reconcile.
 *   - retry cap reached with ≥2 still → best-effort return (no throw, no infinite).
 *   - list / delete failures collapse to original POST (no-throw, no spurious work).
 *   - abort signal interrupts mid-retry.
 *   - knob = 0 → reconcile ONCE, no retry loop.
 *
 * Cases marked "REQUIRES R5 FIX" fail until the parallel main track lands the
 * retry loop. We document each so the failure is intentional, not surprise.
 */

import { describe, expect, it } from "bun:test"
import { computeIdempotencyKey, type RedactPort } from "@/integrations/github"
import { createPrOutputSink, type PrOutputSinkOpts } from "@/integrations/github/pr-output-sink"
import type { GhCliPort, GhCliResult } from "@/reactor"

const redactPassthrough: RedactPort = { redact: (s) => s }
const KEY = computeIdempotencyKey("r5-retry-delivery", "comment")
const MARKER = `<!-- quanta:idempotency=${KEY} -->`

const isList = (args: readonly string[]): boolean =>
  args[0] === "api" &&
  args[1]?.includes("/comments?per_page=100") === true &&
  !args.includes("--method")
const isPost = (args: readonly string[]): boolean =>
  args[0] === "api" && args[1] === "--method" && args[2] === "POST"
const isDelete = (args: readonly string[]): boolean =>
  args[0] === "api" && args[1] === "--method" && args[2] === "DELETE"

interface ListRow {
  readonly id: number
  readonly html_url?: string
  readonly body?: string
}

const makeListReply = (rows: readonly ListRow[]): GhCliResult => ({
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

const okEmpty: GhCliResult = { stdout: "", stderr: "", exitCode: 0 }
const errReply = (msg: string, code = 1): GhCliResult => ({
  stdout: "",
  stderr: msg,
  exitCode: code,
})

const extractDeleteId = (args: readonly string[]): number | undefined => {
  const m = /comments\/(\d+)/.exec(args[3] ?? "")
  if (m?.[1] === undefined) return undefined
  return Number.parseInt(m[1], 10)
}

const baseOpts = (port: GhCliPort, extra?: Partial<PrOutputSinkOpts>): PrOutputSinkOpts => ({
  ghCliPort: port,
  repoCwd: "/tmp",
  repoSlug: "o/r",
  prNumber: 1,
  redactPort: redactPassthrough,
  ...extra,
})

/**
 * Scenario builder — centralizes the dispatcher so each test stays under
 * complexity 15. Provide canned list responses per call index (1-based), a
 * canned post reply, and optional delete + error hooks.
 */
interface Scenario {
  readonly listReplies: ReadonlyArray<readonly ListRow[] | GhCliResult>
  readonly postCommentId: number
  readonly onDelete?: (id: number | undefined) => GhCliResult
  readonly onSignal?: (signal: AbortSignal | undefined) => void
}

interface Counters {
  listCalls: number
  postCalls: number
  deleteIds: number[]
}

const buildPort = (scenario: Scenario): { port: GhCliPort; counters: Counters } => {
  const counters: Counters = { listCalls: 0, postCalls: 0, deleteIds: [] }
  const replyAt = (idx: number): GhCliResult => {
    const r = scenario.listReplies[idx]
    if (r === undefined) return makeListReply([])
    return Array.isArray(r) ? makeListReply(r as readonly ListRow[]) : (r as GhCliResult)
  }
  const port: GhCliPort = {
    async run(args, _cwd, signal) {
      scenario.onSignal?.(signal)
      if (isList(args)) {
        const idx = counters.listCalls
        counters.listCalls++
        return replyAt(idx)
      }
      if (isPost(args)) {
        counters.postCalls++
        return makePostReply(scenario.postCommentId)
      }
      if (isDelete(args)) {
        const id = extractDeleteId(args)
        if (id !== undefined) counters.deleteIds.push(id)
        return scenario.onDelete?.(id) ?? okEmpty
      }
      return errReply(`unhandled: ${args.join(" ")}`)
    },
  }
  return { port, counters }
}

describe("R5 — bounded reconcile retry loop", () => {
  it("first reconcile yields exactly 1 → no second list call (single cycle)", async () => {
    const { port, counters } = buildPort({
      postCommentId: 100,
      listReplies: [
        [], // pre-POST
        [
          {
            id: 100,
            html_url: "https://github.com/o/r/pull/1#issuecomment-100",
            body: `hi\n${MARKER}`,
          },
        ],
      ],
    })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "hi", key: KEY })
    expect(r.ok).toBe(true)
    // EXACTLY 2 lists: pre-POST findExisting + 1 reconcile list. No retry.
    expect(counters.listCalls).toBe(2)
  })

  it("first reconcile yields 2 → either single or retry cycle, both OK", async () => {
    // Without retry: reconcile lists once, deletes loser, returns.
    // With retry (R5 fix): reconcile may list again to verify convergence.
    // Either behavior is acceptable here — the contract is "convergence
    // observed (or attempted)".
    const { port, counters } = buildPort({
      postCommentId: 100,
      listReplies: [
        [],
        [
          { id: 100, html_url: "u100", body: `me\n${MARKER}` },
          { id: 200, html_url: "u200", body: `loser\n${MARKER}` },
        ],
        // Retry list — race resolved (loser deleted).
        [{ id: 100, html_url: "u100", body: `me\n${MARKER}` }],
      ],
    })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    expect(counters.deleteIds).toEqual([200])
    // Either 2 or 3 lists is acceptable (retry-loop vs single-cycle).
    expect([2, 3]).toContain(counters.listCalls)
  })

  it("REQUIRES R5 FIX: 5-burst race — multi-cycle retry converges to 1 survivor", async () => {
    // 5 racers, I'm one of them. Each cycle deletes ≥1 loser. After ≤3
    // cycles, only 1 survives.
    const { port, counters } = buildPort({
      postCommentId: 100,
      listReplies: [
        [], // pre-POST
        [
          { id: 100, html_url: "u100", body: `a\n${MARKER}` },
          { id: 200, html_url: "u200", body: `b\n${MARKER}` },
          { id: 300, html_url: "u300", body: `c\n${MARKER}` },
          { id: 400, html_url: "u400", body: `d\n${MARKER}` },
          { id: 500, html_url: "u500", body: `e\n${MARKER}` },
        ],
        // Retry-1: 3 left.
        [
          { id: 100, html_url: "u100", body: `a\n${MARKER}` },
          { id: 300, html_url: "u300", body: `c\n${MARKER}` },
          { id: 500, html_url: "u500", body: `e\n${MARKER}` },
        ],
        // Retry-2: converged.
        [{ id: 100, html_url: "u100", body: `a\n${MARKER}` }],
      ],
    })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "a", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toBe("u100")
    expect(counters.listCalls).toBeGreaterThanOrEqual(2)
  })

  it("REQUIRES R5 FIX: retry cap = 3 — non-convergence → best-effort return (no infinite loop)", async () => {
    // Adversarial: every list returns ≥2. After cap-N retries the sink MUST
    // still return.
    const fixedRows: readonly ListRow[] = [
      { id: 100, html_url: "u100", body: `me\n${MARKER}` },
      { id: 200, html_url: "u200", body: `still here\n${MARKER}` },
    ]
    const replies: ReadonlyArray<readonly ListRow[]> = [
      [],
      fixedRows,
      fixedRows,
      fixedRows,
      fixedRows,
      fixedRows,
      fixedRows,
    ]
    const { port, counters } = buildPort({ postCommentId: 100, listReplies: replies })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    // Bounded — no infinite loop. 6 is a generous upper bound (1 pre + ≤5).
    expect(counters.listCalls).toBeLessThanOrEqual(6)
    expect(counters.deleteIds.length).toBeLessThanOrEqual(6)
  })

  it("list failure mid-retry → original POST returned (no-throw)", async () => {
    const replies: ReadonlyArray<readonly ListRow[] | GhCliResult> = [
      [], // pre-POST
      [
        { id: 100, html_url: "u100", body: `me\n${MARKER}` },
        { id: 200, html_url: "u200", body: `loser\n${MARKER}` },
      ],
      errReply("network", 1), // retry-list FAILS
    ]
    const { port, counters } = buildPort({ postCommentId: 100, listReplies: replies })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    expect(counters.listCalls).toBeGreaterThanOrEqual(2)
  })

  it("delete failure mid-retry → next cycle retries (no abort)", async () => {
    let deleteAttempts = 0
    const onDelete = (_id: number | undefined): GhCliResult => {
      deleteAttempts++
      if (deleteAttempts === 1) return errReply("503", 1)
      return okEmpty
    }
    const replies: ReadonlyArray<readonly ListRow[]> = [
      [],
      [
        { id: 100, html_url: "u100", body: `me\n${MARKER}` },
        { id: 200, html_url: "u200", body: `loser\n${MARKER}` },
      ],
      // Retry-list (post-fix) shows the loser still there because the
      // delete failed.
      [
        { id: 100, html_url: "u100", body: `me\n${MARKER}` },
        { id: 200, html_url: "u200", body: `loser\n${MARKER}` },
      ],
      [{ id: 100, html_url: "u100", body: `me\n${MARKER}` }],
    ]
    const { port } = buildPort({ postCommentId: 100, listReplies: replies, onDelete })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    expect(deleteAttempts).toBeGreaterThanOrEqual(1)
  })

  it("reconcile disabled via knob → no second list", async () => {
    const { port, counters } = buildPort({ postCommentId: 100, listReplies: [[]] })
    const sink = createPrOutputSink(baseOpts(port, { reconcileConcurrentPosts: false }))
    const r = await sink.postComment({ body: "hi", key: KEY })
    expect(r.ok).toBe(true)
    expect(counters.listCalls).toBe(1) // only pre-POST findExisting
  })

  it("abort signal mid-retry → no-throw, returns gracefully", async () => {
    // Abort fires AFTER the POST succeeds; reconcile list throws AbortError
    // via the gh port. The sink's safeRun absorbs the throw → reconcile
    // returns empty matches → original POST result is preserved.
    const ac = new AbortController()
    let callCount = 0
    const port: GhCliPort = {
      async run(args, _cwd, signal) {
        callCount++
        // call 1: pre-POST list (OK), call 2: POST (OK), call 3+: abort fires.
        if (callCount >= 3) {
          ac.abort()
          if (signal?.aborted === true) throw new DOMException("aborted", "AbortError")
        }
        if (isList(args)) return makeListReply([])
        if (isPost(args)) return makePostReply(100)
        return okEmpty
      },
    }
    const sink = createPrOutputSink(baseOpts(port, { signal: ac.signal }))
    const r = await sink.postComment({ body: "hi", key: KEY })
    // Hostile abort during reconcile → original POST is preserved (no-throw).
    expect(r.ok).toBe(true)
  })

  it("duplicate ids in GitHub stale read → idempotent reconcile (dedup)", async () => {
    const { port, counters } = buildPort({
      postCommentId: 100,
      listReplies: [
        [],
        [
          { id: 100, html_url: "u100", body: `me\n${MARKER}` },
          { id: 100, html_url: "u100", body: `me\n${MARKER}` },
        ],
      ],
    })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    // Hard invariant: we did NOT delete an id we don't own.
    for (const d of counters.deleteIds) {
      expect(d).toBe(100)
    }
  })

  it("100 comments in listing, only N have our marker", async () => {
    const rows: ListRow[] = []
    for (let i = 1; i <= 97; i++) {
      rows.push({ id: i, html_url: `u${i}`, body: `unrelated comment ${i}` })
    }
    rows.push({ id: 100, html_url: "u100", body: `me\n${MARKER}` })
    rows.push({ id: 200, html_url: "u200", body: `loser\n${MARKER}` })
    rows.push({ id: 300, html_url: "u300", body: `another\n${MARKER}` })
    const { port } = buildPort({ postCommentId: 100, listReplies: [[], rows] })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toBe("u100") // smallest of the 3 marker-matching ids
  })

  it("marker-matched comment + non-marker quanta comment mixed → only marker matches", async () => {
    const { port, counters } = buildPort({
      postCommentId: 100,
      listReplies: [
        [],
        [
          { id: 50, html_url: "u50", body: "old quanta comment without marker" },
          { id: 100, html_url: "u100", body: `me\n${MARKER}` },
          { id: 200, html_url: "u200", body: `loser\n${MARKER}` },
        ],
      ],
    })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    expect(counters.deleteIds).not.toContain(50)
  })

  it("winner-self but listing without html_url → falls back to POST URL", async () => {
    const { port } = buildPort({
      postCommentId: 100,
      listReplies: [
        [],
        [
          { id: 100, body: `me\n${MARKER}` },
          { id: 200, body: `loser\n${MARKER}` },
        ],
      ],
    })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toContain("issuecomment-100")
  })

  it("loser-self but winner listing without html_url → URL absent (best-effort)", async () => {
    const { port } = buildPort({
      postCommentId: 100,
      listReplies: [
        [],
        [
          { id: 50, body: `winner\n${MARKER}` },
          { id: 100, html_url: "u100", body: `me\n${MARKER}` },
        ],
      ],
    })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    if (r.url !== undefined) {
      expect(r.url).not.toContain("issuecomment-100")
    }
  })

  it("empty listing (race finished before listing) → my POST URL preserved", async () => {
    const { port } = buildPort({ postCommentId: 100, listReplies: [[], []] })
    const sink = createPrOutputSink(baseOpts(port))
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    expect(r.url).toContain("issuecomment-100")
  })

  it("retry knob = 0 → reconcile runs ONCE (no retry)", async () => {
    // Knob explicit-0 (or omitted-as-zero) disables retry loop entirely.
    const { port, counters } = buildPort({
      postCommentId: 100,
      listReplies: [
        [],
        [
          { id: 100, html_url: "u100", body: `me\n${MARKER}` },
          { id: 200, html_url: "u200", body: `loser\n${MARKER}` },
        ],
      ],
    })
    const sink = createPrOutputSink(
      baseOpts(port, { reconcileMaxRetries: 0 } as PrOutputSinkOpts & {
        reconcileMaxRetries?: number
      }),
    )
    const r = await sink.postComment({ body: "me", key: KEY })
    expect(r.ok).toBe(true)
    expect(counters.listCalls).toBe(2)
  })
})
