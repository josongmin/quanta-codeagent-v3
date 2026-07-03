import { describe, expect, it } from "vitest"
import type { SessionEvent } from "../types/protocol"
import type { WebSocketCtor } from "../ws/client"
import {
  hydrateThreadResume,
  resolveResumeBoundary,
  threadEventsUrl,
  type FetchLike,
} from "./thread-resume"

/**
 * B2 hellgate — cross-surface thread handoff RESUME (web core).
 *
 * The load-bearing invariant: a `?thread=<REQUESTED>` deeplink drives the
 * daemon's thread-addressed `GET /threads/<REQUESTED>/events` hydration against
 * THAT id — NOT the server-minted live session id — and the requested thread's
 * persisted events flow into the transcript. Adversarial teeth cover unknown /
 * malformed ids (clean empty, no crash), auth header propagation, the honest
 * live-attach vs read-only-history boundary, and per-event decode discipline.
 */

const evt = (eventId: string, seq: number, type: SessionEvent["type"] = "turn.output.delta") =>
  ({
    eventId,
    seq,
    type,
    emittedAt: "2026-07-04T00:00:00.000Z",
    // turn.output.delta carries a `delta`; other decoders only need type+seq+id.
    delta: `chunk-${eventId}`,
  }) as unknown as SessionEvent

/** A deterministic fetch stub that records the URL + headers it was called with
 *  and returns the configured body. */
const makeFetch = (opts: {
  ok?: boolean
  status?: number
  body?: unknown
  throwName?: string
  jsonThrows?: boolean
}): {
  fetchImpl: FetchLike
  calls: Array<{ url: string; headers: Record<string, string> | undefined }>
} => {
  const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers })
    if (opts.throwName !== undefined) {
      const e = new Error("boom")
      e.name = opts.throwName
      throw e
    }
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => {
        if (opts.jsonThrows === true) throw new Error("bad json")
        return opts.body
      },
    }
  }
  return { fetchImpl, calls }
}

describe("hydrateThreadResume — B2 web thread resume", () => {
  it("RED→GREEN: drives /threads/<REQUESTED>/events (NOT the live id) and replays that thread's events", async () => {
    const events = [evt("e1", 1), evt("e2", 2), evt("e3", 3)]
    const { fetchImpl, calls } = makeFetch({ body: { threadId: "requested-thread", events } })

    const outcome = await hydrateThreadResume({
      requestedThreadId: "requested-thread",
      liveSessionId: "live-server-minted-id", // DIFFERENT from the requested id
      httpBase: "http://127.0.0.1:4000",
      fetchImpl,
    })

    // Teeth: the URL targets the REQUESTED thread, not the live session id. If a
    // regression drove hydration against `liveSessionId`, this URL assertion is RED.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/threads/requested-thread/events")
    expect(calls[0]?.url).not.toContain("live-server-minted-id")

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error("unreachable")
    expect(outcome.result.threadId).toBe("requested-thread")
    expect(outcome.result.events.map((e) => e.eventId)).toEqual(["e1", "e2", "e3"])
  })

  it("boundary: requested != live ⇒ read-only-history; requested == live ⇒ live-attach", async () => {
    const { fetchImpl } = makeFetch({ body: { events: [evt("e1", 1)] } })

    const readonly = await hydrateThreadResume({
      requestedThreadId: "other-thread",
      liveSessionId: "live-1",
      httpBase: "http://h",
      fetchImpl,
    })
    expect(readonly.ok && readonly.result.boundary).toBe("read-only-history")

    const attached = await hydrateThreadResume({
      requestedThreadId: "live-1",
      liveSessionId: "live-1",
      httpBase: "http://h",
      fetchImpl,
    })
    expect(attached.ok && attached.result.boundary).toBe("live-attach")

    // Pure boundary resolver (unit): null live id ⇒ read-only.
    expect(resolveResumeBoundary("t", null)).toBe("read-only-history")
    expect(resolveResumeBoundary("t", "t")).toBe("live-attach")
    expect(resolveResumeBoundary("t", "u")).toBe("read-only-history")
  })

  it("prefers the daemon's AUTHORITATIVE boundary report over the id-derived one", async () => {
    // Daemon says read-only even though ids happen to match ⇒ trust the daemon.
    const { fetchImpl } = makeFetch({
      body: { events: [evt("e1", 1)], boundary: "read-only-history" },
    })
    const out = await hydrateThreadResume({
      requestedThreadId: "same",
      liveSessionId: "same", // id-derived would say live-attach
      httpBase: "http://h",
      fetchImpl,
    })
    expect(out.ok && out.result.boundary).toBe("read-only-history")

    // A bogus/absent boundary field falls back to the id-derived tag.
    const { fetchImpl: f2 } = makeFetch({ body: { events: [], boundary: "garbage" } })
    const out2 = await hydrateThreadResume({
      requestedThreadId: "same",
      liveSessionId: "same",
      httpBase: "http://h",
      fetchImpl: f2,
    })
    expect(out2.ok && out2.result.boundary).toBe("live-attach")
  })

  it("adversarial: unknown thread id ⇒ 200 empty log ⇒ clean empty resume (no crash)", async () => {
    // The daemon returns 200 + {events:[]} for an unknown id.
    const { fetchImpl } = makeFetch({ body: { threadId: "ghost", events: [] } })
    const outcome = await hydrateThreadResume({
      requestedThreadId: "ghost",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error("unreachable")
    expect(outcome.result.events).toEqual([])
    expect(outcome.result.boundary).toBe("read-only-history")
  })

  it("adversarial: malformed / hostile id is URL-escaped into the path (cannot break out)", () => {
    // A `../`-laden id must be percent-encoded so it stays a path SEGMENT.
    const url = threadEventsUrl("http://h", "../../admin?x=1")
    expect(url).toBe("http://h/threads/..%2F..%2Fadmin%3Fx%3D1/events")
    expect(url).not.toContain("/admin")
  })

  it("adversarial: 404 (persistence disabled) ⇒ not_found; 500 ⇒ http_error; no throw", async () => {
    const notFound = await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl: makeFetch({ ok: false, status: 404 }).fetchImpl,
    })
    expect(notFound).toEqual({ ok: false, reason: "not_found" })

    const serverErr = await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl: makeFetch({ ok: false, status: 500 }).fetchImpl,
    })
    expect(serverErr).toEqual({ ok: false, reason: "http_error" })
  })

  it("adversarial: abort ⇒ aborted; network throw ⇒ network_error; bad json ⇒ malformed_body", async () => {
    const aborted = await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl: makeFetch({ throwName: "AbortError" }).fetchImpl,
    })
    expect(aborted).toEqual({ ok: false, reason: "aborted" })

    const netErr = await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl: makeFetch({ throwName: "TypeError" }).fetchImpl,
    })
    expect(netErr).toEqual({ ok: false, reason: "network_error" })

    const badJson = await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl: makeFetch({ jsonThrows: true }).fetchImpl,
    })
    expect(badJson).toEqual({ ok: false, reason: "malformed_body" })

    const notArray = await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl: makeFetch({ body: { events: "not-an-array" } }).fetchImpl,
    })
    expect(notArray).toEqual({ ok: false, reason: "malformed_body" })
  })

  it("auth: bearer token is forwarded on the resume fetch", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { events: [] } })
    await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      token: "s3cr3t",
      fetchImpl,
    })
    expect(calls[0]?.headers?.Authorization).toBe("Bearer s3cr3t")

    // No token ⇒ no Authorization header (byte-identical to the legacy no-auth path).
    const { fetchImpl: f2, calls: c2 } = makeFetch({ body: { events: [] } })
    await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl: f2,
    })
    expect(c2[0]?.headers?.Authorization).toBeUndefined()
  })

  it("decode discipline: individually drops malformed persisted rows, keeps valid ones", async () => {
    const body = {
      events: [
        evt("good-1", 1),
        { eventId: "", seq: 2, type: "turn.output.delta" }, // empty eventId ⇒ dropped
        { seq: 3, type: "turn.output.delta" }, // missing eventId ⇒ dropped
        evt("good-2", 4),
        null, // non-object ⇒ dropped
        { eventId: "x", seq: "nope", type: "turn.output.delta" }, // bad seq ⇒ dropped
      ],
    }
    const outcome = await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl: makeFetch({ body }).fetchImpl,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error("unreachable")
    expect(outcome.result.events.map((e) => e.eventId)).toEqual(["good-1", "good-2"])
  })

  it("passes the AbortSignal through so an in-flight resume can be cancelled", async () => {
    const ctrl = new AbortController()
    let sawSignal: AbortSignal | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      sawSignal = init?.signal
      return { ok: true, status: 200, json: async () => ({ events: [] }) }
    }
    await hydrateThreadResume({
      requestedThreadId: "t",
      liveSessionId: null,
      httpBase: "http://h",
      fetchImpl,
      signal: ctrl.signal,
    })
    expect(sawSignal).toBe(ctrl.signal)
  })
})

class InertSocket {
  readyState = 0
  send(): void {}
  close(): void {}
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
}

describe("SessionClient.resumeThreadId — connect intent getter", () => {
  it("reflects ConnectOptions.resumeThreadId and is null when absent", async () => {
    const { SessionClient } = await import("../ws/client")
    const client = new SessionClient({
      webSocketCtor: InertSocket as unknown as WebSocketCtor,
    })

    expect(client.resumeThreadId).toBeNull()
    client.connect({ url: "ws://h", resumeThreadId: "handoff-42" })
    expect(client.resumeThreadId).toBe("handoff-42")
    // A plain reconnect without the field clears the intent (byte-identical path).
    client.connect({ url: "ws://h" })
    expect(client.resumeThreadId).toBeNull()
  })
})
