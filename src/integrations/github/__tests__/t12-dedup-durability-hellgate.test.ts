/**
 * T12 hellgate — GitHub boundary hygiene (audit L9 H6 / H9 / H10).
 *
 * Proof rails (red-first against the pre-fix code):
 *  - H9 durable dedup: a delivery-id store backed by `persistPath` survives a
 *    process restart — a redelivered `X-GitHub-Delivery` is recognised after a
 *    fresh store hydrates from the SAME persist port (NOT in-memory best-effort).
 *  - H10 review dedup: `postReview` SKIPs a duplicate when a prior review
 *    carries the marker; `postReviewComment` PATCHes the existing inline
 *    comment instead of POSTing a duplicate.
 *  - H6 path hygiene: a hostile `repoSlug` / `prNumber` is refused before it is
 *    interpolated into the gh-api path (no traversal / query injection).
 */

import { describe, expect, it } from "bun:test"
import {
  computeIdempotencyKey,
  createDurableDeliveryStore,
  type DeliveryPersistPort,
  type RedactPort,
} from "@/integrations/github"
import { createPrOutputSink } from "@/integrations/github/pr-output-sink"
import {
  createInMemoryWatermarkStore,
  createPrCommentTriggerSource,
} from "@/reactor"
import type { ClockPort } from "@/reactor"
import type { GhCliPort, GhCliResult } from "@/reactor"

const redactPassthrough: RedactPort = { redact: (s) => s }

// ── A persist port backed by a single in-memory cell — survives across two
//    store instances exactly the way a file on disk survives a process exit.
const makeFilePersist = (): { port: DeliveryPersistPort; cell: { ids: string[] } } => {
  const cell = { ids: [] as string[] }
  return {
    cell,
    port: {
      async load() {
        return [...cell.ids]
      },
      async save(_path, ids) {
        cell.ids = [...ids]
      },
    },
  }
}

interface StubResp {
  match: (args: readonly string[]) => boolean
  reply: GhCliResult
}
const makeGh = (responses: readonly StubResp[]): { port: GhCliPort; calls: string[][] } => {
  const calls: string[][] = []
  const port: GhCliPort = {
    async run(args) {
      calls.push([...args])
      for (const r of responses) if (r.match(args)) return r.reply
      return { stdout: "", stderr: `no stub: ${args.join(" ")}`, exitCode: 1 }
    },
  }
  return { port, calls }
}

const ok = (body: unknown): GhCliResult => ({
  stdout: JSON.stringify(body),
  stderr: "",
  exitCode: 0,
})

describe("T12 / H9 — durable delivery-id dedup survives restart", () => {
  it("a redelivered id is recognised after a fresh store hydrates from disk", async () => {
    const { port, cell } = makeFilePersist()
    const path = "/tmp/quanta-deliveries.json"

    // Process 1: record a delivery, then flush to disk.
    const s1 = createDurableDeliveryStore({ persistPath: path, persist: port })
    await s1.ready
    expect(s1.has("delivery-A")).toBe(false)
    s1.add("delivery-A")
    await s1.flush()
    expect(cell.ids).toContain("delivery-A")

    // Process 2 (restart): a brand-new store hydrates from the SAME persist port.
    const s2 = createDurableDeliveryStore({ persistPath: path, persist: port })
    await s2.ready
    // The dedup window SURVIVED the restart — this is the bug H9 flagged: the
    // pre-fix store was pure in-memory and would return false here, re-firing
    // the trigger on a GitHub re-delivery.
    expect(s2.has("delivery-A")).toBe(true)
    s2.add("delivery-A") // duplicate — no new write needed
  })

  it("save failure is surfaced via onError, never thrown into the add() path", async () => {
    const errors: string[] = []
    const failingPersist: DeliveryPersistPort = {
      async load() {
        return []
      },
      async save() {
        throw new Error("disk full")
      },
    }
    const s = createDurableDeliveryStore({
      persistPath: "/tmp/x.json",
      persist: failingPersist,
      onError: (m) => errors.push(m),
    })
    await s.ready
    expect(() => s.add("d1")).not.toThrow()
    await s.flush()
    expect(errors.some((e) => e.includes("disk full"))).toBe(true)
  })
})

describe("T12 / H10 — review + review-comment dedup", () => {
  const KEY = computeIdempotencyKey("t12-review", "review")
  const MARKER = `<!-- quanta:idempotency=${KEY} -->`

  it("postReview SKIPs when a prior review already carries the marker", async () => {
    const { port, calls } = makeGh([
      {
        // GET /pulls/<n>/reviews → an existing review with our marker.
        match: (a) =>
          a[0] === "api" &&
          a[1]?.includes("/pulls/1/reviews?per_page=100") === true &&
          !a.includes("--method"),
        reply: ok([
          {
            id: 555,
            body: `LGTM\n${MARKER}`,
            html_url: "https://github.com/o/r/pull/1#pullrequestreview-555",
          },
        ]),
      },
    ])
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/repo",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
    })
    const res = await sink.postReview({ verdict: "approve", body: "LGTM", key: KEY })
    expect(res.ok).toBe(true)
    expect(res.url).toBe("https://github.com/o/r/pull/1#pullrequestreview-555")
    // No POST happened — the only call was the find-existing GET.
    expect(calls.some((c) => c.includes("--method") && c.includes("POST"))).toBe(false)
  })

  it("postReviewComment PATCHes the existing inline comment instead of POSTing", async () => {
    const ICKEY = computeIdempotencyKey("t12-inline", "review_comment")
    const ICMARK = `<!-- quanta:idempotency=${ICKEY} -->`
    const { port, calls } = makeGh([
      {
        // GET /pulls/<n>/comments → existing inline comment with our marker.
        match: (a) =>
          a[0] === "api" &&
          a[1]?.includes("/pulls/1/comments?per_page=100") === true &&
          !a.includes("--method"),
        reply: ok([{ id: 909, body: `old\n${ICMARK}` }]),
      },
      {
        // PATCH /pulls/comments/909
        match: (a) =>
          a.includes("--method") &&
          a.includes("PATCH") &&
          a.some((s) => s.includes("/pulls/comments/909")),
        reply: ok({ id: 909, html_url: "https://github.com/o/r/pull/1#discussion_r909" }),
      },
    ])
    const sink = createPrOutputSink({
      ghCliPort: port,
      repoCwd: "/repo",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactPassthrough,
    })
    const res = await sink.postReviewComment({
      file: "src/x.ts",
      line: 10,
      body: "nit",
      key: ICKEY,
    })
    expect(res.ok).toBe(true)
    // PATCH happened; no POST to /pulls/<n>/comments.
    expect(calls.some((c) => c.includes("PATCH"))).toBe(true)
    expect(
      calls.some(
        (c) => c.includes("POST") && c.some((s) => s.endsWith("/pulls/1/comments")),
      ),
    ).toBe(false)
  })
})

describe("T12 / H6 — pr-comment path-segment hygiene", () => {
  const clock: ClockPort = { now: () => 1_700_000_000_000 }

  const makeSource = (repoSlug: string, prNumber: number, onError: (m: string) => void) => {
    const gh: GhCliPort = {
      async run() {
        // If we ever reach the gh call with a hostile slug, the test FAILS.
        return { stdout: "[]", stderr: "", exitCode: 0 }
      },
    }
    const store = createInMemoryWatermarkStore()
    return createPrCommentTriggerSource({
      ghCliPort: gh,
      clockPort: clock,
      repoCwd: "/repo",
      repoSlug,
      prNumber,
      watermarkKey: "k",
      watermarkStore: store,
      onError,
    })
  }

  it("a slug with extra path/query segments is refused before the gh call", async () => {
    const errors: string[] = []
    const src = makeSource("foo/bar/comments?per_page=1&x=", 1, (m) => errors.push(m))
    const out = await src.poll()
    expect(out).toEqual([])
    expect(errors.some((e) => e.includes("invalid_repo_slug"))).toBe(true)
  })

  it("a traversal slug (../) is refused", async () => {
    const errors: string[] = []
    const src = makeSource("../../etc", 1, (m) => errors.push(m))
    const out = await src.poll()
    expect(out).toEqual([])
    expect(errors.some((e) => e.includes("invalid_repo_slug"))).toBe(true)
  })

  it("a non-integer prNumber is refused", async () => {
    const errors: string[] = []
    const src = makeSource("o/r", 1.5, (m) => errors.push(m))
    const out = await src.poll()
    expect(out).toEqual([])
    expect(errors.some((e) => e.includes("invalid_pr_number"))).toBe(true)
  })

  it("a legitimate owner/repo + integer passes the gate", async () => {
    const errors: string[] = []
    // First poll seeds the watermark; a second poll exercises the real path.
    const src = makeSource("octo-org/my.repo", 42, (m) => errors.push(m))
    await src.poll()
    await src.poll()
    expect(errors.filter((e) => e.includes("invalid_"))).toEqual([])
  })
})
