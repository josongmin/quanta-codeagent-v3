/**
 * §9.6 — Anthropic Message Batches API client core hellgate.
 *
 * The Batches API (`POST /v1/messages/batches`) processes Messages requests
 * asynchronously at 50% price. V1 = a pure client core (create / retrieve /
 * results / cancel) with an INJECTED `fetch` (test seam), no-throw boundaries,
 * and Default-OFF posture (importing it does nothing; only an explicit call
 * fires a request).
 *
 * Wire contract (from the claude-api skill `batches.md`):
 *   - create:   POST {base}/v1/messages/batches  body {requests:[{custom_id,params}]}
 *               → { id, processing_status, request_counts }
 *   - retrieve: GET  {base}/v1/messages/batches/{id}
 *   - results:  GET  {base}/v1/messages/batches/{id}/results  (JSONL stream)
 *   - cancel:   POST {base}/v1/messages/batches/{id}/cancel
 *   headers: x-api-key, anthropic-version: 2023-06-01, content-type: application/json
 *
 * Cases:
 *   MB-01: create POSTs to the right URL w/ auth + version headers + body
 *   MB-02: create returns the parsed batch (id + processing_status + counts)
 *   MB-03: retrieve GETs the batch by id
 *   MB-04: results parses a JSONL body into per-custom_id results
 *   MB-05: cancel POSTs to /cancel
 *   MB-06: a non-2xx response ⇒ typed {ok:false} (NO-THROW), error carries status
 *   MB-07: a fetch rejection ⇒ typed {ok:false} (NO-THROW)
 *   MB-08: results tolerates blank lines / trailing newline in the JSONL
 *   MB-09: malformed JSONL line is skipped, others still parsed (no-throw)
 *   MB-10: e2e — create → poll-until-ended → results round-trips through fetch
 */

import { describe, expect, test } from "bun:test"
import { createMessageBatchesClient, type MessageBatchesClient } from "@/llm/message-batches"
import { nth, present } from "../../_helpers/expect-present"

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

const headersOf = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (raw === undefined) return out
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  Object.assign(out, raw as Record<string, string>)
  return out
}

type FetchFn = typeof fetch

const fakeFetch = (
  handler: (url: string, init: RequestInit) => { status: number; body: string },
): { fetch: FetchFn; calls: Call[] } => {
  const calls: Call[] = []
  const f = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const i = init ?? {}
    const url = typeof input === "string" ? input : String(input)
    calls.push({
      url,
      method: i.method ?? "GET",
      headers: headersOf(i.headers),
      body: typeof i.body === "string" ? i.body : undefined,
    })
    const { status, body } = handler(url, i)
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return body
      },
      async json() {
        return JSON.parse(body)
      },
    } as Response
  }
  return { fetch: f as unknown as FetchFn, calls }
}

const BASE = "https://api.anthropic.com"
const mkClient = (fetch: FetchFn): MessageBatchesClient =>
  createMessageBatchesClient({ apiKey: "sk-test", baseUrl: BASE, fetch })

const BATCH_CREATED = JSON.stringify({
  id: "msgbatch_01",
  type: "message_batch",
  processing_status: "in_progress",
  request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
})
const BATCH_ENDED = JSON.stringify({
  id: "msgbatch_01",
  type: "message_batch",
  processing_status: "ended",
  request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
})

describe("§9.6 Message Batches client", () => {
  test("MB-01/MB-02: create POSTs body + headers and parses the batch", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: BATCH_CREATED }))
    const client = mkClient(fetch)
    const res = await client.create({
      requests: [
        {
          custom_id: "r1",
          params: {
            model: "claude-opus-4-8",
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
          },
        },
      ],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.id).toBe("msgbatch_01")
    expect(res.value.processing_status).toBe("in_progress")
    expect(res.value.request_counts.processing).toBe(2)

    const c = nth(calls, 0, "c")
    expect(c.url).toBe(`${BASE}/v1/messages/batches`)
    expect(c.method).toBe("POST")
    expect(c.headers["x-api-key"]).toBe("sk-test")
    expect(c.headers["anthropic-version"]).toBe("2023-06-01")
    expect(c.headers["content-type"] ?? c.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(present(c.body, "c.body")).requests[0].custom_id).toBe("r1")
  })

  test("MB-03: retrieve GETs by id", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: BATCH_ENDED }))
    const client = mkClient(fetch)
    const res = await client.retrieve("msgbatch_01")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.processing_status).toBe("ended")
    expect(nth(calls, 0, "calls").url).toBe(`${BASE}/v1/messages/batches/msgbatch_01`)
    expect(nth(calls, 0, "calls").method).toBe("GET")
  })

  test("MB-04/MB-08: results parses JSONL with blank + trailing lines", async () => {
    const jsonl = [
      JSON.stringify({
        custom_id: "r1",
        result: { type: "succeeded", message: { content: [{ type: "text", text: "A" }] } },
      }),
      "", // blank line tolerated
      JSON.stringify({
        custom_id: "r2",
        result: { type: "errored", error: { type: "invalid_request" } },
      }),
      "", // trailing newline → trailing blank
    ].join("\n")
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: jsonl }))
    const client = mkClient(fetch)
    const res = await client.results("msgbatch_01")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.length).toBe(2)
    expect(nth(res.value, 0, "res.value").custom_id).toBe("r1")
    expect(nth(res.value, 0, "res.value").result.type).toBe("succeeded")
    expect(nth(res.value, 1, "res.value").result.type).toBe("errored")
    expect(nth(calls, 0, "calls").url).toBe(`${BASE}/v1/messages/batches/msgbatch_01/results`)
  })

  test("MB-09: malformed JSONL line skipped, others parsed (no-throw)", async () => {
    const jsonl = [
      "{not valid json",
      JSON.stringify({ custom_id: "r2", result: { type: "succeeded" } }),
    ].join("\n")
    const { fetch } = fakeFetch(() => ({ status: 200, body: jsonl }))
    const client = mkClient(fetch)
    const res = await client.results("msgbatch_01")
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.length).toBe(1)
      expect(nth(res.value, 0, "res.value").custom_id).toBe("r2")
    }
  })

  test("MB-05: cancel POSTs to /cancel", async () => {
    const cancelling = JSON.stringify({
      id: "msgbatch_01",
      type: "message_batch",
      processing_status: "canceling",
      request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    })
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: cancelling }))
    const client = mkClient(fetch)
    const res = await client.cancel("msgbatch_01")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.processing_status).toBe("canceling")
    expect(nth(calls, 0, "calls").url).toBe(`${BASE}/v1/messages/batches/msgbatch_01/cancel`)
    expect(nth(calls, 0, "calls").method).toBe("POST")
  })

  test("MB-06: non-2xx ⇒ typed {ok:false} carrying status (NO-THROW)", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 429,
      body: JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "slow down" },
      }),
    }))
    const client = mkClient(fetch)
    const res = await client.retrieve("msgbatch_01")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.status).toBe(429)
      expect(res.error.message).toContain("rate_limit")
    }
  })

  test("MB-07: fetch rejection ⇒ typed {ok:false} (NO-THROW)", async () => {
    const f = (async () => {
      throw new Error("network down")
    }) as unknown as FetchFn
    const client = mkClient(f)
    const res = await client.retrieve("msgbatch_01")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.status).toBeUndefined()
      expect(res.error.message).toContain("network down")
    }
  })
})

describe("§9.6 Message Batches e2e", () => {
  test("MB-10: create → poll-until-ended → results round-trips through fetch", async () => {
    let retrieveCount = 0
    const resultsBody = [
      JSON.stringify({
        custom_id: "r1",
        result: { type: "succeeded", message: { content: [{ type: "text", text: "done" }] } },
      }),
    ].join("\n")
    const { fetch, calls } = fakeFetch((url, init) => {
      if (url.endsWith("/results")) return { status: 200, body: resultsBody }
      if ((init.method ?? "GET") === "POST") return { status: 200, body: BATCH_CREATED }
      // GET retrieve: first in_progress, then ended
      retrieveCount += 1
      return { status: 200, body: retrieveCount === 1 ? BATCH_CREATED : BATCH_ENDED }
    })
    const client = mkClient(fetch)

    const created = await client.create({
      requests: [
        {
          custom_id: "r1",
          params: {
            model: "claude-opus-4-8",
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
          },
        },
      ],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.id

    // poll
    let status = created.value.processing_status
    let guard = 0
    while (status !== "ended" && guard < 5) {
      guard += 1
      const r = await client.retrieve(id)
      expect(r.ok).toBe(true)
      if (r.ok) status = r.value.processing_status
    }
    expect(status).toBe("ended")

    const results = await client.results(id)
    expect(results.ok).toBe(true)
    if (results.ok) {
      expect(nth(results.value, 0, "results.value").custom_id).toBe("r1")
      expect(nth(results.value, 0, "results.value").result.type).toBe("succeeded")
    }
    // create + 2 retrieves + results
    expect(calls.length).toBe(4)
  })
})
