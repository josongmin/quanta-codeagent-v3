/**
 * Cross-feature hell-difficulty E2E: JSON-RPC envelope × session JSONL envelope.
 *
 * Scenario:
 *   - Spin up a tiny in-process JSON-RPC dispatcher (5 methods).
 *   - Issue 200 requests.
 *   - For EVERY request → record one `response_item` envelope record into a
 *     session JSONL file (item_kind=assistant_tool_use, content=encoded request).
 *   - For EVERY response → record another `response_item` (assistant_text,
 *     content=encoded response).
 *   - Read back the JSONL: assert exactly 400 records in the exact dispatch
 *     order, with each pair (request, response) matched on the embedded id.
 *   - Inject 1 malformed request mid-stream: the dispatcher rejects it via
 *     `JsonRpcCodecError`, the rejection is recorded as a `custom` event
 *     envelope, AND the very next valid request still dispatches normally
 *     (the server is not stuck).
 *
 * Test-isolation contract:
 *   - mkdtemp roots only; re-assert env + __resetRuntimeConfig in beforeEach.
 *
 * Hard rules respected:
 *   - Exact assertions throughout (400 records, 200 method calls each).
 *   - Errors are tested via Result branches; encodeRequest with empty method
 *     is asserted to throw `JsonRpcCodecError` with `instanceof` check.
 *   - No setTimeout race tricks; no swallowing try/catch.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendEnvelope,
  type EventMsgRecord,
  iterateSessionFile,
  type ResponseItemRecord,
  SESSION_ENVELOPE_VERSION,
  type SessionEnvelopeRecord,
  sessionEnvelopePath,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import {
  decodeRequest,
  encodeError,
  encodeRequest,
  encodeResponse,
  JSONRPC_ERROR_CODES,
  JsonRpcCodecError,
  type JsonRpcResponse,
} from "@/shared/jsonrpc"

const root = mkdtempSync(join(tmpdir(), "e2e-jsonrpc-x-session-"))

afterAll(() => {
  delete process.env.QUANTA_SESSIONS_DIR
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

const isoAt = (sec: number): string => new Date(1_716_000_000_000 + sec * 1000).toISOString()

/* ------------------------------------------------------------------ */
/* In-process JSON-RPC dispatcher                                      */
/* ------------------------------------------------------------------ */

type MethodHandler = (params: Record<string, unknown> | unknown[] | undefined) => unknown

const buildDispatcher = (
  methods: Readonly<Record<string, MethodHandler>>,
): ((wire: string) => string) => {
  return (wire: string): string => {
    const dec = decodeRequest(wire)
    if (!dec.ok) {
      // The wire was not a valid request — synthesise an error response with
      // id: null (per JSON-RPC §5 when the request id couldn't be parsed).
      return encodeError({
        id: null,
        code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
        message: dec.error.message,
        data: { kind: dec.error.kind, issues: dec.error.issues },
      })
    }
    const handler = methods[dec.value.method]
    if (handler === undefined) {
      return encodeError({
        id: dec.value.id,
        code: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
        message: `unknown method: ${dec.value.method}`,
      })
    }
    let result: unknown
    try {
      result = handler(dec.value.params)
    } catch (e) {
      return encodeError({
        id: dec.value.id,
        code: JSONRPC_ERROR_CODES.INTERNAL_ERROR,
        message: e instanceof Error ? e.message : String(e),
      })
    }
    return encodeResponse({ id: dec.value.id, result })
  }
}

/* ------------------------------------------------------------------ */
/* Envelope-recording helpers                                          */
/* ------------------------------------------------------------------ */

const recordRequest = async (
  sessionId: string,
  turnId: string,
  index: number,
  wire: string,
): Promise<ResponseItemRecord> => {
  const rec: ResponseItemRecord = {
    type: "response_item",
    schema_version: SESSION_ENVELOPE_VERSION,
    turn_id: turnId,
    item_kind: "assistant_tool_use",
    index,
    content: wire,
  }
  await appendEnvelope(sessionId, rec)
  return rec
}

const recordResponse = async (
  sessionId: string,
  turnId: string,
  index: number,
  wire: string,
): Promise<ResponseItemRecord> => {
  const rec: ResponseItemRecord = {
    type: "response_item",
    schema_version: SESSION_ENVELOPE_VERSION,
    turn_id: turnId,
    item_kind: "assistant_text",
    index,
    content: wire,
  }
  await appendEnvelope(sessionId, rec)
  return rec
}

const recordRejection = async (
  sessionId: string,
  turnId: string,
  ts: string,
  rawWire: string,
  reason: string,
): Promise<EventMsgRecord> => {
  const rec: EventMsgRecord = {
    type: "event_msg",
    schema_version: SESSION_ENVELOPE_VERSION,
    ts,
    turn_id: turnId,
    kind: "custom",
    custom_kind: "jsonrpc.codec_error",
    data: { rawWire, reason },
  }
  await appendEnvelope(sessionId, rec)
  return rec
}

/* ------------------------------------------------------------------ */
/* Scenario A — 200 well-formed calls round-trip into envelope log     */
/* ------------------------------------------------------------------ */

describe("JSON-RPC × session envelope — 200 calls produce 400 ordered envelope records", () => {
  test("dispatch 200 requests across 5 methods → read back exactly 400 records in order", async () => {
    const sessionId = "rpc-x-env-200"
    const methods: Record<string, MethodHandler> = {
      "math.add": (p) => {
        const a = (p as { a: number }).a
        const b = (p as { b: number }).b
        return { sum: a + b }
      },
      "math.mul": (p) => {
        const a = (p as { a: number }).a
        const b = (p as { b: number }).b
        return { product: a * b }
      },
      "str.upper": (p) => {
        const s = (p as { s: string }).s
        return { upper: s.toUpperCase() }
      },
      "str.length": (p) => {
        const s = (p as { s: string }).s
        return { length: s.length }
      },
      "agent.ping": () => ({ pong: true }),
    }
    const dispatch = buildDispatcher(methods)
    const methodKeys = Object.keys(methods)
    expect(methodKeys.length).toBe(5)

    const N = 200
    const requestWires: string[] = []
    const responseWires: string[] = []
    const requestRecs: ResponseItemRecord[] = []
    const responseRecs: ResponseItemRecord[] = []

    for (let i = 0; i < N; i += 1) {
      const id = i + 1
      const method = methodKeys[i % methodKeys.length] as string
      let params: Record<string, unknown>
      switch (method) {
        case "math.add":
          params = { a: i, b: i + 1 }
          break
        case "math.mul":
          params = { a: i, b: 2 }
          break
        case "str.upper":
          params = { s: `hello-${i}` }
          break
        case "str.length":
          params = { s: `len-${i}` }
          break
        default:
          params = {}
      }
      const reqWire = encodeRequest({ id, method, params })
      requestWires.push(reqWire)
      // 1) Record the request as a response_item.
      const reqRec = await recordRequest(sessionId, `t-${i}`, i * 2, reqWire)
      requestRecs.push(reqRec)
      // 2) Dispatch — synchronous (server is in-process).
      const respWire = dispatch(reqWire)
      responseWires.push(respWire)
      // 3) Record the response.
      const respRec = await recordResponse(sessionId, `t-${i}`, i * 2 + 1, respWire)
      responseRecs.push(respRec)
    }
    expect(requestRecs.length).toBe(N)
    expect(responseRecs.length).toBe(N)

    // Read back the JSONL and assert exact 400-record ordering.
    const path = sessionEnvelopePath(sessionId)
    const readBack: SessionEnvelopeRecord[] = []
    for await (const r of iterateSessionFile(path)) {
      if (!r.ok) throw new Error(`decode failed: ${r.error.message}`)
      readBack.push(r.value)
    }
    expect(readBack.length).toBe(2 * N)
    expect(readBack.length).toBe(400)

    for (let i = 0; i < N; i += 1) {
      const reqIdx = i * 2
      const respIdx = i * 2 + 1
      const reqRead = readBack[reqIdx]
      const respRead = readBack[respIdx]
      if (reqRead === undefined || respRead === undefined) {
        throw new Error(`missing record at i=${i}`)
      }
      if (reqRead.type !== "response_item" || reqRead.item_kind !== "assistant_tool_use") {
        throw new Error(`request slot wrong type at i=${i}: ${JSON.stringify(reqRead)}`)
      }
      if (respRead.type !== "response_item" || respRead.item_kind !== "assistant_text") {
        throw new Error(`response slot wrong type at i=${i}: ${JSON.stringify(respRead)}`)
      }
      // Indexes preserved exactly.
      expect(reqRead.index).toBe(i * 2)
      expect(respRead.index).toBe(i * 2 + 1)
      expect(reqRead.turn_id).toBe(`t-${i}`)
      expect(respRead.turn_id).toBe(`t-${i}`)
      // Wire content preserved byte-stably.
      expect(reqRead.content).toBe(requestWires[i] as string)
      expect(respRead.content).toBe(responseWires[i] as string)
      // The response's id MUST match the request's id.
      const reqParsed = JSON.parse(reqRead.content) as { id: number }
      const respParsed = JSON.parse(respRead.content) as JsonRpcResponse
      expect(respParsed.id).toBe(reqParsed.id)
    }
  })
})

/* ------------------------------------------------------------------ */
/* Assertion helpers (kept module-scope to flatten test complexity)    */
/* ------------------------------------------------------------------ */

type SlotKind = "req" | "resp" | "rejection"

const slotKindOf = (rec: SessionEnvelopeRecord): SlotKind => {
  if (rec.type === "response_item") {
    return rec.item_kind === "assistant_tool_use" ? "req" : "resp"
  }
  if (rec.type === "event_msg" && rec.kind === "custom") {
    return "rejection"
  }
  throw new Error(`unexpected record type in this scenario: ${rec.type}`)
}

const assertSlotKinds = (out: SessionEnvelopeRecord[], expected: SlotKind[]): void => {
  expect(out.map(slotKindOf)).toEqual(expected)
}

const assertResponseSuccess = (
  out: SessionEnvelopeRecord[],
  slotIndex: number,
  expectedId: number,
  expectedResult: unknown,
): void => {
  const slot = out[slotIndex]
  if (slot?.type !== "response_item" || slot.item_kind !== "assistant_text") {
    throw new Error(`expected response_item/assistant_text at ${slotIndex}`)
  }
  const parsed = JSON.parse(slot.content) as JsonRpcResponse
  if (!("result" in parsed)) {
    throw new Error(`expected success branch at ${slotIndex}`)
  }
  expect(parsed.id).toBe(expectedId)
  expect(parsed.result).toEqual(expectedResult)
}

const assertResponseInvalidRequest = (out: SessionEnvelopeRecord[], slotIndex: number): void => {
  const slot = out[slotIndex]
  if (slot?.type !== "response_item" || slot.item_kind !== "assistant_text") {
    throw new Error(`expected response_item/assistant_text at ${slotIndex}`)
  }
  const parsed = JSON.parse(slot.content) as JsonRpcResponse
  if (!("error" in parsed)) {
    throw new Error(`expected error branch at ${slotIndex}`)
  }
  expect(parsed.id).toBeNull()
  expect(parsed.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_REQUEST)
}

const assertRejectionEnvelope = (
  out: SessionEnvelopeRecord[],
  slotIndex: number,
  expectedWire: string,
): void => {
  const slot = out[slotIndex]
  if (slot?.type !== "event_msg" || slot.kind !== "custom") {
    throw new Error(`expected event_msg/custom at ${slotIndex}`)
  }
  expect(slot.custom_kind).toBe("jsonrpc.codec_error")
  expect((slot.data as { rawWire: string }).rawWire).toBe(expectedWire)
  expect((slot.data as { reason: string }).reason).toContain("parse_json")
}

/* ------------------------------------------------------------------ */
/* Scenario B — malformed request mid-stream, server keeps serving     */
/* ------------------------------------------------------------------ */

describe("JSON-RPC × session envelope — malformed mid-stream is recorded, next call still works", () => {
  test("dispatcher returns INVALID_REQUEST error, custom envelope captures it, next request succeeds", async () => {
    const sessionId = "rpc-x-env-bad"
    const methods: Record<string, MethodHandler> = {
      "echo.ping": () => ({ pong: 42 }),
    }
    const dispatch = buildDispatcher(methods)

    // Sequence: valid → MALFORMED → valid. Three logical calls; the
    // malformed one produces an error response (recorded as response) AND
    // a custom envelope capturing the codec error.
    const expectedRecords: Array<"req" | "resp" | "rejection"> = []

    // -- Call 1: valid
    const w1 = encodeRequest({ id: 1, method: "echo.ping" })
    await recordRequest(sessionId, "t-1", 0, w1)
    expectedRecords.push("req")
    const r1 = dispatch(w1)
    await recordResponse(sessionId, "t-1", 1, r1)
    expectedRecords.push("resp")

    // -- Call 2: malformed — the codec rejects with a typed error. We
    //    capture both the dispatcher's INVALID_REQUEST response AND a
    //    `custom` envelope describing the codec failure.
    const malformedWire = "{not valid json — chaos"
    await recordRequest(sessionId, "t-2", 2, malformedWire)
    expectedRecords.push("req")
    const r2 = dispatch(malformedWire)
    await recordResponse(sessionId, "t-2", 3, r2)
    expectedRecords.push("resp")
    // The codec error is also directly available — re-decode to capture it
    // for the custom envelope (the dispatcher swallowed the details into an
    // error response; we want the structured form too).
    const directDecode = decodeRequest(malformedWire)
    expect(directDecode.ok).toBe(false)
    if (directDecode.ok) throw new Error("unreachable")
    expect(directDecode.error).toBeInstanceOf(JsonRpcCodecError)
    expect(directDecode.error.kind).toBe("parse_json")
    await recordRejection(
      sessionId,
      "t-2",
      isoAt(2),
      malformedWire,
      `codec rejected: ${directDecode.error.kind}: ${directDecode.error.message}`,
    )
    expectedRecords.push("rejection")

    // -- Call 3: valid — the server is NOT stuck.
    const w3 = encodeRequest({ id: 3, method: "echo.ping" })
    await recordRequest(sessionId, "t-3", 4, w3)
    expectedRecords.push("req")
    const r3 = dispatch(w3)
    await recordResponse(sessionId, "t-3", 5, r3)
    expectedRecords.push("resp")

    // Read back.
    const path = sessionEnvelopePath(sessionId)
    const out: SessionEnvelopeRecord[] = []
    for await (const r of iterateSessionFile(path)) {
      if (!r.ok) throw new Error(`decode failed: ${r.error.message}`)
      out.push(r.value)
    }
    // 3 reqs + 3 resps + 1 rejection = 7
    expect(out.length).toBe(7)
    expect(expectedRecords.length).toBe(7)

    assertSlotKinds(out, expectedRecords)
    assertResponseSuccess(out, 1, 1, { pong: 42 })
    assertResponseInvalidRequest(out, 3)
    assertRejectionEnvelope(out, 4, malformedWire)
    assertResponseSuccess(out, 6, 3, { pong: 42 })
  })

  test("encoder programmer-error still throws JsonRpcCodecError (instanceof)", () => {
    // Adjacent contract test — the encoder side fails LOUD on empty method.
    expect(() => encodeRequest({ id: 1, method: "" })).toThrow(JsonRpcCodecError)
  })
})
