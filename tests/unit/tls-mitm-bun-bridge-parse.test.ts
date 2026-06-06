/**
 * jun-7 TLS-MITM Bun bridge — UNIT tests for the manual HTTP/1.1 request parser
 * (`parseHttpRequestBuffer`). This is the load-bearing Bun-specific logic: Bun's
 * `http.Server.emit("connection", …)` does NOT drive the node:http parser (proven
 * by the jun-07 spike), so the Bun terminator bridge parses decrypted plaintext
 * itself. The parser is PURE — these tests pin its framing + the fail-closed
 * decisions (over-cap / chunked / malformed ⇒ `bodyOverCap`) the proxy relies on.
 */

import { describe, expect, test } from "bun:test"
import { parseHttpRequestBuffer } from "@/../src/runtime/network-proxy"

const req = (s: string): Buffer => Buffer.from(s, "utf8")

describe("parseHttpRequestBuffer — framing", () => {
  test("incomplete header block ⇒ not done (waits)", () => {
    const state = parseHttpRequestBuffer(req("POST /x HTTP/1.1\r\nHost: a"), 1_000_000)
    expect(state.done).toBe(false)
    expect(state.request).toBeUndefined()
  })

  test("complete request with Content-Length body ⇒ parsed", () => {
    const state = parseHttpRequestBuffer(
      req("POST /hook?q=1 HTTP/1.1\r\nHost: a\r\nContent-Length: 11\r\n\r\nhello=world"),
      1_000_000,
    )
    expect(state.done).toBe(true)
    expect(state.request?.method).toBe("POST")
    expect(state.request?.path).toBe("/hook?q=1")
    expect(state.request?.body.toString("utf8")).toBe("hello=world")
    expect(state.request?.bodyOverCap).toBe(false)
    expect(state.request?.headers["content-length"]).toBe("11")
  })

  test("body not yet fully arrived ⇒ not done", () => {
    const state = parseHttpRequestBuffer(
      req("POST /x HTTP/1.1\r\nContent-Length: 11\r\n\r\nhel"),
      1_000_000,
    )
    expect(state.done).toBe(false)
  })

  test("zero-length body (GET) ⇒ parsed immediately on header end", () => {
    const state = parseHttpRequestBuffer(req("GET /x HTTP/1.1\r\nHost: a\r\n\r\n"), 1_000_000)
    expect(state.done).toBe(true)
    expect(state.request?.method).toBe("GET")
    expect(state.request?.body.length).toBe(0)
    expect(state.request?.bodyOverCap).toBe(false)
  })

  test("header values join into headerText for the scan", () => {
    const state = parseHttpRequestBuffer(
      req(
        "POST /x HTTP/1.1\r\nAuthorization: Bearer abc\r\nX-Trace: t1\r\nContent-Length: 0\r\n\r\n",
      ),
      1_000_000,
    )
    expect(state.request?.headerText.includes("Bearer abc")).toBe(true)
    expect(state.request?.headerText.includes("t1")).toBe(true)
  })

  test("duplicate header names ⇒ array (node:http convention)", () => {
    const state = parseHttpRequestBuffer(
      req("GET /x HTTP/1.1\r\nX-A: 1\r\nX-A: 2\r\n\r\n"),
      1_000_000,
    )
    expect(state.request?.headers["x-a"]).toEqual(["1", "2"])
  })
})

describe("parseHttpRequestBuffer — FAIL-CLOSED decisions (bodyOverCap)", () => {
  test("Content-Length over the cap ⇒ bodyOverCap (never buffer the whole body)", () => {
    const state = parseHttpRequestBuffer(
      req("POST /x HTTP/1.1\r\nContent-Length: 5000\r\n\r\n"),
      64,
    )
    expect(state.done).toBe(true)
    expect(state.request?.bodyOverCap).toBe(true)
    expect(state.request?.body.length).toBe(0) // nothing retained
  })

  test("chunked transfer-encoding ⇒ bodyOverCap (cannot frame ⇒ fail closed)", () => {
    const state = parseHttpRequestBuffer(
      req("POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"),
      1_000_000,
    )
    expect(state.done).toBe(true)
    expect(state.request?.bodyOverCap).toBe(true)
  })

  test("malformed Content-Length ⇒ bodyOverCap (fail closed)", () => {
    const state = parseHttpRequestBuffer(
      req("POST /x HTTP/1.1\r\nContent-Length: notanumber\r\n\r\n"),
      1_000_000,
    )
    expect(state.done).toBe(true)
    expect(state.request?.bodyOverCap).toBe(true)
  })

  test("negative Content-Length ⇒ bodyOverCap (fail closed)", () => {
    const state = parseHttpRequestBuffer(
      req("POST /x HTTP/1.1\r\nContent-Length: -1\r\n\r\n"),
      1_000_000,
    )
    expect(state.done).toBe(true)
    expect(state.request?.bodyOverCap).toBe(true)
  })

  test("unbounded header block past the cap with NO terminator ⇒ bodyOverCap (header DoS guard)", () => {
    // A hostile peer streams headers forever without the \r\n\r\n terminator. The
    // parser must not buffer past the cap — it fails closed instead of OOMing.
    const huge = `GET /x HTTP/1.1\r\nX-Pad: ${"A".repeat(200)}`
    const state = parseHttpRequestBuffer(req(huge), 64)
    expect(state.done).toBe(true)
    expect(state.request?.bodyOverCap).toBe(true)
  })

  test("a body AT the cap is NOT over-cap (no over-correction)", () => {
    const body = "x".repeat(11)
    const state = parseHttpRequestBuffer(
      req(`POST /x HTTP/1.1\r\nContent-Length: 11\r\n\r\n${body}`),
      11,
    )
    expect(state.done).toBe(true)
    expect(state.request?.bodyOverCap).toBe(false)
    expect(state.request?.body.toString("utf8")).toBe(body)
  })
})
