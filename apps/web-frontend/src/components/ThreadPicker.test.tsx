/**
 * UUX-4-06 (plan D-10) — web thread list consuming `GET /threads`.
 *
 * The daemon has served `GET /threads` (fetch-handler.ts) since the
 * persistence wave, but the frontend never consumed it. This pins the
 * consumer: `fetchThreadList` (lib/thread-list.ts) decodes the daemon's
 * `{ threads: [{id,title,createdAt,lastTouched,eventCount}] }` payload
 * defensively, and `ThreadPicker` renders the rows with an Open action per
 * row that routes into the EXISTING resume path (`onOpen(threadId)` →
 * App's `setResumeThreadId` → `hydrateThreadResume`, the same wire the
 * deeplink banner uses).
 *
 * Rendered with `renderToStaticMarkup` (node env, no DOM) — same pattern as
 * ThreadDeeplinkBanner.test.tsx. The fetch effect cannot run under SSR, so
 * the picker exposes an `initialSnapshot` test seam (mirrors the banner's
 * `initialIntent` seam); the tests below still drive the REAL decode path by
 * feeding `fetchThreadList`'s outcome into the render.
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { fetchThreadList, threadsUrl } from "../lib/thread-list"
import type { FetchLike } from "../lib/thread-resume"
import { ThreadPicker } from "./ThreadPicker"

const daemonPayload = {
  threads: [
    {
      id: "th-live",
      title: "fix the reducer",
      createdAt: 1_000,
      lastTouched: 9_000,
      eventCount: 42,
    },
    { id: "th-old", title: null, createdAt: 500, lastTouched: 800, eventCount: 3 },
  ],
}

const stubFetch =
  (status: number, body: unknown): FetchLike =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

describe("UUX-4-06 thread-list — fetchThreadList decode", () => {
  it("TL-01: decodes the daemon /threads payload into rows (URL contract pinned)", async () => {
    expect(threadsUrl("http://127.0.0.1:4096/")).toBe("http://127.0.0.1:4096/threads")
    const outcome = await fetchThreadList({
      httpBase: "http://127.0.0.1:4096",
      fetchImpl: stubFetch(200, daemonPayload),
    })
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`)
    expect(outcome.threads.map((t) => t.id)).toEqual(["th-live", "th-old"])
    expect(outcome.threads[0]?.title).toBe("fix the reducer")
    expect(outcome.threads[0]?.eventCount).toBe(42)
  })

  it("TL-02: 404 (persistence disabled) ⇒ typed not_found, never a throw", async () => {
    const outcome = await fetchThreadList({
      httpBase: "http://x",
      fetchImpl: stubFetch(404, { error: "persistence_disabled" }),
    })
    expect(outcome).toEqual({ ok: false, reason: "not_found" })
  })

  it("TL-03: malformed body / network error ⇒ typed failures, malformed rows dropped", async () => {
    expect(
      await fetchThreadList({ httpBase: "http://x", fetchImpl: stubFetch(200, { threads: "?" }) }),
    ).toEqual({ ok: false, reason: "malformed_body" })
    const throwing: FetchLike = async () => {
      throw new Error("boom")
    }
    expect(await fetchThreadList({ httpBase: "http://x", fetchImpl: throwing })).toEqual({
      ok: false,
      reason: "network_error",
    })
    // Row-level defence: a junk row is dropped, valid rows survive.
    const mixed = await fetchThreadList({
      httpBase: "http://x",
      fetchImpl: stubFetch(200, {
        threads: [daemonPayload.threads[0], { id: 42 }, null, "junk"],
      }),
    })
    if (!mixed.ok) throw new Error("expected ok")
    expect(mixed.threads.map((t) => t.id)).toEqual(["th-live"])
  })

  it("TL-04: bearer token rides the Authorization header", async () => {
    let seenAuth: string | undefined
    const capture: FetchLike = async (_url, init) => {
      seenAuth = init?.headers?.Authorization
      return { ok: true, status: 200, json: async () => daemonPayload }
    }
    await fetchThreadList({ httpBase: "http://x", token: "sekret", fetchImpl: capture })
    expect(seenAuth).toBe("Bearer sekret")
  })
})

describe("UUX-4-06 ThreadPicker — renders rows from a fetched /threads payload", () => {
  it("TP-01: rows from the REAL fetch outcome render with id/title/count + per-row Open", async () => {
    const outcome = await fetchThreadList({
      httpBase: "http://x",
      fetchImpl: stubFetch(200, daemonPayload),
    })
    if (!outcome.ok) throw new Error("expected ok")
    const markup = renderToStaticMarkup(
      <ThreadPicker
        endpoint={{ httpUrl: "http://x" }}
        onOpen={() => {}}
        initialSnapshot={{ phase: "loaded", threads: outcome.threads }}
        initialOpen
      />,
    )
    expect(markup).toContain("thread-picker")
    expect(markup).toContain("th-live")
    expect(markup).toContain("fix the reducer")
    expect(markup).toContain("th-old")
    // Untitled thread degrades honestly, not to a blank cell.
    expect(markup).toContain("(untitled)")
    // Event counts surface so the user can tell an empty thread apart.
    expect(markup).toContain("42")
    expect(markup).toContain("Open")
  })

  it("TP-02: collapsed by default — only the toggle renders (no phantom pane)", () => {
    const markup = renderToStaticMarkup(
      <ThreadPicker endpoint={{ httpUrl: "http://x" }} onOpen={() => {}} />,
    )
    expect(markup).toContain("Threads")
    expect(markup).not.toContain("thread-picker-row")
  })

  it("TP-03: no endpoint yet ⇒ renders nothing (no dead toggle before bootstrap)", () => {
    const markup = renderToStaticMarkup(<ThreadPicker endpoint={null} onOpen={() => {}} />)
    expect(markup).toBe("")
  })

  it("TP-04: failed fetch ⇒ honest error copy, never an empty pane pretending success", () => {
    const markup = renderToStaticMarkup(
      <ThreadPicker
        endpoint={{ httpUrl: "http://x" }}
        onOpen={() => {}}
        initialSnapshot={{ phase: "failed", reason: "not_found" }}
        initialOpen
      />,
    )
    expect(markup.toLowerCase()).toContain("could not load threads")
    expect(markup).toContain("not_found")
  })

  it("TP-05: empty thread list ⇒ explicit empty copy (not a blank pane)", () => {
    const markup = renderToStaticMarkup(
      <ThreadPicker
        endpoint={{ httpUrl: "http://x" }}
        onOpen={() => {}}
        initialSnapshot={{ phase: "loaded", threads: [] }}
        initialOpen
      />,
    )
    expect(markup.toLowerCase()).toContain("no persisted threads")
  })

  it("TP-06: live session id is badged so live-attach vs read-only history is honest", async () => {
    const outcome = await fetchThreadList({
      httpBase: "http://x",
      fetchImpl: stubFetch(200, daemonPayload),
    })
    if (!outcome.ok) throw new Error("expected ok")
    const markup = renderToStaticMarkup(
      <ThreadPicker
        endpoint={{ httpUrl: "http://x" }}
        onOpen={() => {}}
        liveSessionId="th-live"
        initialSnapshot={{ phase: "loaded", threads: outcome.threads }}
        initialOpen
      />,
    )
    expect(markup).toContain("live")
  })

  it("TP-07: thread ids are escaped as text content (no HTML injection)", () => {
    const markup = renderToStaticMarkup(
      <ThreadPicker
        endpoint={{ httpUrl: "http://x" }}
        onOpen={() => {}}
        initialSnapshot={{
          phase: "loaded",
          threads: [
            {
              id: "<script>x</script>",
              title: null,
              createdAt: 0,
              lastTouched: 0,
              eventCount: 0,
            },
          ],
        }}
        initialOpen
      />,
    )
    expect(markup).not.toContain("<script>x</script>")
    expect(markup).toContain("&lt;script&gt;")
  })
})
