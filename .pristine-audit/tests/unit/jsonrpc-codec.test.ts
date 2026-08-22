import { describe, expect, test } from "bun:test"
import {
  decodeFrame,
  decodeNotification,
  decodeRequest,
  decodeResponse,
  decodeTimeout,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  encodeTimeout,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JsonRpcCodecError,
} from "@/shared/jsonrpc"

describe("encode / decode round-trips", () => {
  test("request — id + method + params", () => {
    const wire = encodeRequest({ id: 7, method: "agent.run", params: { foo: "bar" } })
    const r = decodeRequest(wire)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.id).toBe(7)
    expect(r.value.method).toBe("agent.run")
    expect(r.value.params).toEqual({ foo: "bar" })
    expect(r.value.jsonrpc).toBe(JSONRPC_VERSION)
  })

  test("request — params omitted when not provided", () => {
    const wire = encodeRequest({ id: "x", method: "ping" })
    expect(JSON.parse(wire)).toEqual({ jsonrpc: JSONRPC_VERSION, id: "x", method: "ping" })
  })

  test("notification — no id", () => {
    const wire = encodeNotification({ method: "tick", params: [1, 2] })
    const parsed = JSON.parse(wire) as Record<string, unknown>
    expect("id" in parsed).toBe(false)
    const r = decodeNotification(wire)
    expect(r.ok).toBe(true)
  })

  test("success response", () => {
    const wire = encodeResponse({ id: 1, result: { hello: "world" } })
    const r = decodeResponse(wire)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    if (!("result" in r.value)) throw new Error("expected success branch")
    expect(r.value.result).toEqual({ hello: "world" })
  })

  test("error response", () => {
    const wire = encodeError({ id: 1, code: -32603, message: "boom" })
    const r = decodeResponse(wire)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    if (!("error" in r.value)) throw new Error("expected error branch")
    expect(r.value.error.code).toBe(-32603)
  })

  test("timeout encoder uses -32000 + data.kind=timeout", () => {
    const wire = encodeTimeout({ id: 9, elapsedMs: 12345 })
    const r = decodeTimeout(wire)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.error.code).toBe(JSONRPC_ERROR_CODES.TIMEOUT)
    expect((r.value.error.data as { kind: string }).kind).toBe("timeout")
    expect((r.value.error.data as { elapsedMs: number }).elapsedMs).toBe(12345)
  })

  test("frame demux accepts every legal shape", () => {
    const req = encodeRequest({ id: 1, method: "m" })
    const note = encodeNotification({ method: "n" })
    const ok = encodeResponse({ id: 1, result: 1 })
    const errr = encodeError({ id: 1, code: -1, message: "x" })
    for (const wire of [req, note, ok, errr]) {
      const r = decodeFrame(wire)
      expect(r.ok).toBe(true)
    }
  })
})

describe("decoder never throws on bad input", () => {
  test("garbage JSON", () => {
    const r = decodeRequest("not json {{{")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error).toBeInstanceOf(JsonRpcCodecError)
    expect(r.error.kind).toBe("parse_json")
  })

  test("valid JSON but wrong shape", () => {
    const r = decodeRequest('{"hello":"world"}')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("schema_request")
  })

  test("frame decoder surfaces version mismatch distinctly", () => {
    const r = decodeFrame('{"jsonrpc":"1.0","id":1,"method":"m"}')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("version_mismatch")
  })

  test("response with both result+error", () => {
    const r = decodeResponse(
      JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        result: 1,
        error: { code: -1, message: "x" },
      }),
    )
    expect(r.ok).toBe(false)
  })

  test("timeout decoder rejects non-timeout error", () => {
    const wire = encodeError({ id: 1, code: -32603, message: "internal" })
    const r = decodeTimeout(wire)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("schema_timeout")
  })

  test("empty string", () => {
    const r = decodeRequest("")
    expect(r.ok).toBe(false)
  })

  test("null literal", () => {
    const r = decodeRequest("null")
    expect(r.ok).toBe(false)
  })

  test("notification decoder rejects request shape", () => {
    const wire = encodeRequest({ id: 1, method: "m" })
    const r = decodeNotification(wire)
    expect(r.ok).toBe(false)
  })
})

describe("encoders throw only on programmer error", () => {
  test("encodeRequest with empty method", () => {
    expect(() => encodeRequest({ id: 1, method: "" })).toThrow(JsonRpcCodecError)
  })
  test("encodeNotification with empty method", () => {
    expect(() => encodeNotification({ method: "" })).toThrow(JsonRpcCodecError)
  })
})
