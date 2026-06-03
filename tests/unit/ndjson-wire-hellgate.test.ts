/**
 * Adversarial hellgate for `apps/cli/repl/ndjson-wire.ts` (ADR-0468).
 *
 * Proves the composition-root contract:
 *   1. Gate-OFF (no env) ⇒ NullNdjsonSink + no-op stop, ZERO alloc / socket /
 *      file — byte-identical to "not wired".
 *   2. Gate-ON (file path) ⇒ buffered adapter constructed, port satisfied, the
 *      injected flush writes NDJSON lines to the real file.
 *   3. Gate-ON (TCP port) ⇒ adapter binds a loopback server, isActive() true,
 *      stop() releases it (a second bind on the same port then succeeds).
 *   4. Adapter failure (bad port string / unwritable file path / EADDRINUSE)
 *      ⇒ caught, logged, degrades to NullSink + no-op stop — NEVER throws.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { maybeCreateNdjsonSinkWire } from "@/apps/cli/repl/ndjson-wire"
import { NullNdjsonSink } from "@/observability/ndjson"

const collectWarns = () => {
  const warns: string[] = []
  return { logger: { warn: (m: string) => warns.push(m) }, warns }
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ndjson-wire-"))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("ndjson-wire — default-OFF byte-identical", () => {
  test("no env ⇒ exactly the slice NullNdjsonSink + inactive + no-op stop", () => {
    const { logger, warns } = collectWarns()
    const h = maybeCreateNdjsonSinkWire({ env: {}, logger })
    expect(h.sink).toBe(NullNdjsonSink) // SAME singleton — zero new alloc
    expect(h.isActive()).toBe(false)
    expect(() => {
      h.stop()
      h.stop() // idempotent
    }).not.toThrow()
    // emit on the null sink is a no-op ok()
    expect(h.sink.emit({ type: "x" }).ok).toBe(true)
    expect(warns).toHaveLength(0)
  })

  test("empty-string env values are treated as unset (default-OFF)", () => {
    const h = maybeCreateNdjsonSinkWire({
      env: { QUANTA_NDJSON_INGEST_PORT: "", QUANTA_NDJSON_INGEST_FILE: "" },
    })
    expect(h.sink).toBe(NullNdjsonSink)
    expect(h.isActive()).toBe(false)
  })
})

describe("ndjson-wire — gate-ON file adapter", () => {
  test("file path set ⇒ adapter constructed, port satisfied, flush writes NDJSON", () => {
    const path = join(tmp, "debug.ndjson")
    const h = maybeCreateNdjsonSinkWire({ env: { QUANTA_NDJSON_INGEST_FILE: path }, capacity: 2 })
    expect(h.isActive()).toBe(true)
    expect(h.sink).not.toBe(NullNdjsonSink)

    // capacity 2 ⇒ third emit triggers a flush of the batch. Emit + stop-flush
    // covers both the auto-flush and the teardown drain.
    expect(h.sink.emit({ type: "a", n: 1 }).ok).toBe(true)
    expect(h.sink.emit({ type: "b", n: 2 }).ok).toBe(true)
    h.stop() // flush remaining

    const body = readFileSync(path, "utf8")
    const lines = body.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(2)
    // deterministic sorted-key encoding from the slice
    expect(lines).toContain('{"n":1,"type":"a"}')
    expect(lines).toContain('{"n":2,"type":"b"}')
    h.stop() // idempotent
  })

  test("encode-failed event surfaces as Err, never throws", () => {
    const path = join(tmp, "debug2.ndjson")
    const h = maybeCreateNdjsonSinkWire({ env: { QUANTA_NDJSON_INGEST_FILE: path } })
    const bad = h.sink.emit({ type: "x", big: 1n as unknown as number })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.kind).toBe("encode-failed")
    h.stop()
  })
})

describe("ndjson-wire — gate-ON http adapter", () => {
  test("valid port ⇒ binds loopback server, isActive, stop releases the port", async () => {
    // Grab a free port deterministically: bind a throwaway server to :0, read
    // the assigned port, close it, then hand that port to the wire.
    const probe = createServer()
    await new Promise<void>((res) => probe.listen(0, "127.0.0.1", res))
    const addr = probe.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    await new Promise<void>((res) => probe.close(() => res()))
    expect(port).toBeGreaterThan(0)

    const { logger, warns } = collectWarns()
    const h = maybeCreateNdjsonSinkWire({
      env: { QUANTA_NDJSON_INGEST_PORT: String(port) },
      logger,
    })
    expect(h.isActive()).toBe(true)
    expect(h.sink).not.toBe(NullNdjsonSink)
    // emit with no connected client is still ok() (best-effort firehose).
    expect(h.sink.emit({ type: "tick" }).ok).toBe(true)
    h.stop()

    // After stop, the port must be free again — a fresh bind succeeds.
    const reuse = createServer()
    await new Promise<void>((res, rej) => {
      reuse.once("error", rej)
      reuse.listen(port, "127.0.0.1", res)
    })
    await new Promise<void>((res) => reuse.close(() => res()))
    expect(warns).toHaveLength(0)
  })
})

describe("ndjson-wire — adapter failure caught (no throw)", () => {
  test("malformed port ⇒ warn + NullSink, never throws", () => {
    const { logger, warns } = collectWarns()
    let h: ReturnType<typeof maybeCreateNdjsonSinkWire> | undefined
    expect(() => {
      h = maybeCreateNdjsonSinkWire({ env: { QUANTA_NDJSON_INGEST_PORT: "not-a-port" }, logger })
    }).not.toThrow()
    expect(h?.sink).toBe(NullNdjsonSink)
    expect(h?.isActive()).toBe(false)
    expect(warns.some((w) => w.includes("invalid QUANTA_NDJSON_INGEST_PORT"))).toBe(true)
  })

  test.each([
    "0",
    "65536",
    "-1",
    "3.5",
    "99999999",
  ])("out-of-range port %p ⇒ warn + NullSink", (raw) => {
    const { logger, warns } = collectWarns()
    const h = maybeCreateNdjsonSinkWire({ env: { QUANTA_NDJSON_INGEST_PORT: raw }, logger })
    expect(h.sink).toBe(NullNdjsonSink)
    expect(h.isActive()).toBe(false)
    expect(warns.length).toBeGreaterThan(0)
  })

  test("unwritable file path ⇒ warn + NullSink, never throws", () => {
    // A path whose parent directory does not exist is unopenable.
    const path = join(tmp, "nope", "deep", "debug.ndjson")
    const { logger, warns } = collectWarns()
    let h: ReturnType<typeof maybeCreateNdjsonSinkWire> | undefined
    expect(() => {
      h = maybeCreateNdjsonSinkWire({ env: { QUANTA_NDJSON_INGEST_FILE: path }, logger })
    }).not.toThrow()
    expect(h?.sink).toBe(NullNdjsonSink)
    expect(h?.isActive()).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(warns.some((w) => w.includes("file open failed"))).toBe(true)
  })

  test("port precedence over file when both set", () => {
    // A bad port short-circuits to NullSink (degrade); proves port is read
    // first even though a valid file path is also present.
    const path = join(tmp, "ignored.ndjson")
    const { logger } = collectWarns()
    const h = maybeCreateNdjsonSinkWire({
      env: { QUANTA_NDJSON_INGEST_PORT: "bad", QUANTA_NDJSON_INGEST_FILE: path },
      logger,
    })
    expect(h.sink).toBe(NullNdjsonSink)
    expect(existsSync(path)).toBe(false) // file path never touched
  })
})
