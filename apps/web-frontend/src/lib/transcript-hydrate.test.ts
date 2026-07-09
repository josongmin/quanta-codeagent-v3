/**
 * WS-F (UUX-5-07) — transcript hydration must FAIL LOUD, not render nothing.
 *
 * The pre-fix App.tsx effect did `if (!resp.ok) return` — a daemon hiccup on
 * `GET /threads/:id/events` yielded a silently empty transcript with zero UI.
 * `hydrateTranscript` is the extracted, typed-outcome seam: every failure path
 * returns `{ ok: false, reason }` so the App can raise the degraded banner.
 */

import { describe, expect, it } from "vitest"
import type { SessionEvent } from "../types/protocol"
import { hydrateTranscript } from "./transcript-hydrate"

const fakeEvent = (id: string): SessionEvent =>
  ({
    type: "session.closed",
    eventId: id,
    sessionId: "s-1",
    emittedAt: "2026-07-10T00:00:00.000Z",
  }) as unknown as SessionEvent

const fetchReturning = (resp: Partial<Response>): typeof fetch =>
  (async () => resp as Response) as unknown as typeof fetch

describe("hydrateTranscript", () => {
  it("replays fetched events and reports the count", async () => {
    const replayed: SessionEvent[][] = []
    const outcome = await hydrateTranscript({
      httpBase: "http://127.0.0.1:4096",
      sessionId: "s-1",
      token: "tok",
      fetchImpl: fetchReturning({
        ok: true,
        status: 200,
        json: async () => ({ events: [fakeEvent("e1"), fakeEvent("e2")] }),
      } as unknown as Response),
      replay: (events) => replayed.push([...events]),
    })
    expect(outcome).toEqual({ ok: true, count: 2 })
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toHaveLength(2)
  })

  it("non-2xx is a TYPED failure carrying the status (never a silent return)", async () => {
    let replayCalls = 0
    const outcome = await hydrateTranscript({
      httpBase: "http://127.0.0.1:4096",
      sessionId: "s-1",
      fetchImpl: fetchReturning({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as unknown as Response),
      replay: () => {
        replayCalls += 1
      },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain("500")
      expect(outcome.aborted).not.toBe(true)
    }
    expect(replayCalls).toBe(0)
  })

  it("network error is a typed failure with the error message", async () => {
    const outcome = await hydrateTranscript({
      httpBase: "http://127.0.0.1:4096",
      sessionId: "s-1",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
      replay: () => undefined,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("ECONNREFUSED")
  })

  it("abort is distinguished from real failure (no banner on unmount)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" })
    const outcome = await hydrateTranscript({
      httpBase: "http://127.0.0.1:4096",
      sessionId: "s-1",
      fetchImpl: (async () => {
        throw abortErr
      }) as unknown as typeof fetch,
      replay: () => undefined,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.aborted).toBe(true)
  })

  it("a malformed body (no events array) is ok with count 0 — nothing to replay", async () => {
    let replayCalls = 0
    const outcome = await hydrateTranscript({
      httpBase: "http://127.0.0.1:4096",
      sessionId: "s-1",
      fetchImpl: fetchReturning({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as unknown as Response),
      replay: () => {
        replayCalls += 1
      },
    })
    expect(outcome).toEqual({ ok: true, count: 0 })
    expect(replayCalls).toBe(0)
  })

  it("URL-encodes the session id and hits /threads/:id/events with bearer auth", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    await hydrateTranscript({
      httpBase: "http://127.0.0.1:4096/",
      sessionId: "s/1 x",
      token: "tok",
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        seen.push({
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
        })
        return { ok: true, status: 200, json: async () => ({ events: [] }) } as unknown as Response
      }) as unknown as typeof fetch,
      replay: () => undefined,
    })
    expect(seen[0]?.url).toBe("http://127.0.0.1:4096/threads/s%2F1%20x/events")
    expect(seen[0]?.headers.Authorization).toBe("Bearer tok")
  })
})
