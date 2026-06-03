/**
 * Hellgate — ADR-0132 Phase A PR-comment trigger source: the watermark must
 * never advance PAST a comment that was received cleanly but DROPPED on the
 * normal path (no `html_url` evidence anchor).
 *
 * Regression guard for the idempotency defect where the watermark was
 * pre-advanced to the max stamp of ALL fresh rows BEFORE the build loop decided
 * to skip a row with no `html_url`. A non-maximal dropped row would then sit
 * forever behind the cursor (every future poll filters `stamp <= watermark`),
 * silently lost — which is NOT the documented at-most-once-on-crash tradeoff
 * (that one only excuses loss when the CONSUMER crashes; here the consumer never
 * even saw the comment).
 *
 * The fix: advance the watermark only to the newest EMITTED stamp that is still
 * strictly before the earliest hole. The dropped row (and anything after it)
 * stays unacked so the next poll reconsiders it.
 */

import { describe, expect, test } from "bun:test"
import {
  type ClockPort,
  createPrCommentTriggerSource,
  type GhCliPort,
  type GhCliResult,
  type WatermarkStore,
} from "@/reactor"

const fixedClock = (at: number): ClockPort => ({ now: () => at })

const ok = (json: unknown): GhCliResult => ({
  stdout: JSON.stringify(json),
  stderr: "",
  exitCode: 0,
})

/** A `GhCliPort` that returns a different canned `gh api` payload per call so
 *  we can model TWO consecutive polls and observe what the second poll sees. */
const sequencedGhPort = (payloads: ReadonlyArray<GhCliResult>): GhCliPort => {
  let i = 0
  return {
    run: async () => {
      const r = payloads[Math.min(i, payloads.length - 1)]
      i += 1
      return r
    },
  }
}

/** A real (persistent across polls) in-memory watermark store that records the
 *  exact value last written. */
const recordingStore = (
  initial: string,
): { store: WatermarkStore; current: () => string; writes: () => readonly string[] } => {
  let value = initial
  const writes: string[] = []
  return {
    store: {
      load: async () => value,
      save: async (_k, v) => {
        value = v
        writes.push(v)
      },
    },
    current: () => value,
    writes: () => writes,
  }
}

describe("HELLGATE — PR-comment watermark must not skip a dropped (no html_url) comment forever", () => {
  test("non-maximal hole followed by a valid later comment: watermark capped below the hole; hole re-considered next poll", async () => {
    const WM0 = "2026-06-03T10:00:00Z"
    // Batch (poll #1):
    //   #1  10:30  has html_url        → EMITTED (before the hole)
    //   #2  11:00  NO html_url         → DROPPED (the hole)
    //   #3  11:30  has html_url        → would be emitted, but it is AFTER the hole
    const poll1 = ok([
      {
        id: 1,
        body: "early valid",
        html_url: "https://example/c/1",
        updated_at: "2026-06-03T10:30:00Z",
        user: { login: "alice" },
      },
      {
        id: 2,
        body: "received cleanly but no anchor",
        updated_at: "2026-06-03T11:00:00Z",
        user: { login: "bob" },
      },
      {
        id: 3,
        body: "later valid",
        html_url: "https://example/c/3",
        updated_at: "2026-06-03T11:30:00Z",
        user: { login: "carol" },
      },
    ])
    // Poll #2 — the dropped comment NOW carries an html_url (e.g. GitHub backfilled
    // it). If the watermark had jumped past 11:00 on poll #1, this poll would
    // never see it. We assert it IS seen → the hole was reconsidered.
    const poll2 = ok([
      {
        id: 2,
        body: "now with anchor",
        html_url: "https://example/c/2",
        updated_at: "2026-06-03T11:00:00Z",
        user: { login: "bob" },
      },
      {
        id: 3,
        body: "later valid",
        html_url: "https://example/c/3",
        updated_at: "2026-06-03T11:30:00Z",
        user: { login: "carol" },
      },
    ])

    const rec = recordingStore(WM0)
    const src = createPrCommentTriggerSource({
      ghCliPort: sequencedGhPort([poll1, poll2]),
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: rec.store,
    })

    // ---- Poll #1 ----
    const t1 = await src.poll()
    // Only the EMITTED comment(s) surface — the hole row produces no trigger.
    expect(t1.map((t) => t.evidence.value)).toContain("https://example/c/1")
    // The valid earlier comment advanced the watermark (it is acked)...
    expect(rec.current()).toBe("2026-06-03T10:30:00Z")
    // ...but it MUST NOT have advanced to/past the hole at 11:00 — otherwise the
    // dropped comment is lost forever. (The unfixed code wrote 11:30 here.)
    expect(rec.current() < "2026-06-03T11:00:00Z").toBe(true)

    // ---- Poll #2 ----
    const t2 = await src.poll()
    const urls2 = t2.map((t) => t.evidence.value)
    // The previously-dropped comment is RE-CONSIDERED (watermark never passed it)
    // and now emits because it gained an anchor.
    expect(urls2).toContain("https://example/c/2")
    // Now the cursor advances to the newest emitted stamp (no remaining hole).
    expect(rec.current()).toBe("2026-06-03T11:30:00Z")
  })

  test("ALL fresh rows are holes: watermark does not move at all (nothing acked, all reconsidered)", async () => {
    const WM0 = "2026-06-03T10:00:00Z"
    const onlyHoles = ok([
      { id: 1, body: "no anchor a", updated_at: "2026-06-03T10:30:00Z", user: { login: "x" } },
      { id: 2, body: "no anchor b", updated_at: "2026-06-03T11:00:00Z", user: { login: "y" } },
    ])
    const rec = recordingStore(WM0)
    const src = createPrCommentTriggerSource({
      ghCliPort: sequencedGhPort([onlyHoles]),
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: rec.store,
    })
    const t = await src.poll()
    expect(t).toEqual([])
    // No emitted row ⇒ NO watermark advance whatsoever (not even a no-op write).
    expect(rec.current()).toBe(WM0)
    expect(rec.writes()).toEqual([])
  })

  test("no holes: watermark still advances to the max emitted stamp (idempotency preserved for the common case)", async () => {
    const WM0 = "2026-06-03T10:00:00Z"
    const allValid = ok([
      {
        id: 1,
        body: "a",
        html_url: "https://example/c/1",
        updated_at: "2026-06-03T10:30:00Z",
        user: { login: "x" },
      },
      {
        id: 2,
        body: "b",
        html_url: "https://example/c/2",
        updated_at: "2026-06-03T11:00:00Z",
        user: { login: "y" },
      },
    ])
    const rec = recordingStore(WM0)
    const src = createPrCommentTriggerSource({
      ghCliPort: sequencedGhPort([allValid]),
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: rec.store,
    })
    const t = await src.poll()
    expect(t).toHaveLength(2)
    expect(rec.current()).toBe("2026-06-03T11:00:00Z")
  })
})
