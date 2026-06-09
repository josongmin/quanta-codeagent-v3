/**
 * W5 DAP — request/response correlation client over a transport. A debug
 * adapter answers requests OUT OF ORDER and interleaves asynchronous events
 * (`stopped`, `output`, `terminated`) between them, so the client must route by
 * `request_seq` and never let a `success:false` response throw (the tool layer
 * decides what a failed DAP request means). Driven by a scripted fake transport.
 */
import { describe, expect, test } from "bun:test"
import { DapClient, type DapTransport } from "@/tool/debug/dap-client"
import { DapFrameDecoder, encodeDapMessage } from "@/tool/debug/dap-codec"

/** A controllable in-memory transport: captures what the client sends (decoded)
 *  and lets the test inject adapter→client frames. */
const makeFakeTransport = () => {
  let onData: ((chunk: string | Buffer) => void) | undefined
  const sentDecoder = new DapFrameDecoder()
  const sent: Record<string, unknown>[] = []
  const transport: DapTransport = {
    send: (data) => {
      for (const m of sentDecoder.push(data)) sent.push(m as Record<string, unknown>)
    },
    onData: (cb) => {
      onData = cb
    },
    close: () => {},
  }
  return {
    transport,
    sent,
    /** Push an adapter→client message (gets framed for the client to decode). */
    emit: (msg: unknown) => onData?.(encodeDapMessage(msg)),
  }
}

describe("DapClient", () => {
  test("request resolves with the matching response body (correlated by request_seq)", async () => {
    const fake = makeFakeTransport()
    const client = new DapClient(fake.transport)
    const p = client.request("initialize", { adapterID: "python" })
    expect(fake.sent).toHaveLength(1)
    const seq = fake.sent[0]!.seq as number
    expect(fake.sent[0]!.command).toBe("initialize")
    fake.emit({ type: "response", request_seq: seq, success: true, command: "initialize", body: { supportsStepBack: false } })
    const res = await p
    expect(res.success).toBe(true)
    expect(res.body).toEqual({ supportsStepBack: false })
  })

  test("OUT-OF-ORDER responses correlate to the right request", async () => {
    const fake = makeFakeTransport()
    const client = new DapClient(fake.transport)
    const p1 = client.request("threads")
    const p2 = client.request("stackTrace", { threadId: 1 })
    const seq1 = fake.sent[0]!.seq as number
    const seq2 = fake.sent[1]!.seq as number
    // Reply to the SECOND request first.
    fake.emit({ type: "response", request_seq: seq2, success: true, command: "stackTrace", body: { n: 2 } })
    fake.emit({ type: "response", request_seq: seq1, success: true, command: "threads", body: { n: 1 } })
    expect((await p1).body).toEqual({ n: 1 })
    expect((await p2).body).toEqual({ n: 2 })
  })

  test("success:false response RESOLVES (never throws) so the tool can report it", async () => {
    const fake = makeFakeTransport()
    const client = new DapClient(fake.transport)
    const p = client.request("evaluate", { expression: "bogus" })
    const seq = fake.sent[0]!.seq as number
    fake.emit({ type: "response", request_seq: seq, success: false, command: "evaluate", message: "not available" })
    const res = await p
    expect(res.success).toBe(false)
    expect(res.message).toBe("not available")
  })

  test("events are routed to onEvent handlers (stopped delivered while a request is pending)", async () => {
    const fake = makeFakeTransport()
    const client = new DapClient(fake.transport)
    const stops: unknown[] = []
    client.onEvent("stopped", (body) => stops.push(body))
    const p = client.request("configurationDone")
    fake.emit({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } })
    const seq = fake.sent[0]!.seq as number
    fake.emit({ type: "response", request_seq: seq, success: true, command: "configurationDone" })
    await p
    expect(stops).toEqual([{ reason: "breakpoint", threadId: 1 }])
  })

  test("waitForEvent resolves on the next matching event", async () => {
    const fake = makeFakeTransport()
    const client = new DapClient(fake.transport)
    const waited = client.waitForEvent("terminated")
    fake.emit({ type: "event", event: "output", body: { output: "noise" } })
    fake.emit({ type: "event", event: "terminated", body: {} })
    expect(await waited).toEqual({})
  })

  test("request after close rejects (transport gone) — no silent hang", async () => {
    const fake = makeFakeTransport()
    const client = new DapClient(fake.transport)
    client.dispose()
    await expect(client.request("threads")).rejects.toThrow()
  })
})
