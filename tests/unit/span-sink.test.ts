/**
 * jun-27 span-sink PORT + adapters (otel trace persistence is pluggable: file /
 * S3 / noop). Pins the ACTUAL persistence behavior (real file content, real
 * RemoteBackend.put calls via an injected offline backend), the best-effort
 * never-throw contract, and the env resolver precedence — so a destination swap
 * (the whole point of the abstraction) can't silently regress.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RemoteBackend } from "@/shared/remote-store"
import {
  fileSpanSink,
  noopSpanSink,
  resolveSpanSink,
  s3SpanSink,
} from "../../src/apps/bench/span-sink"

const tmp = (name: string): string => join(mkdtempSync(join(tmpdir(), "spansink-")), name)

describe("span-sink: file adapter", () => {
  test("appends one JSONL line per span; creates parent dirs", async () => {
    const path = tmp("nested/dir/spans.jsonl") // nested ⇒ must be auto-created
    const s = fileSpanSink(path)
    s.write('{"a":1}')
    s.write('{"b":2}')
    await s.flush()
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n')
  })
})

describe("span-sink: s3 adapter (offline, injected RemoteBackend)", () => {
  const fakeBackend = (sink: { path: string; body: string }[]): RemoteBackend => ({
    put: async (path, body) => {
      sink.push({ path, body })
    },
    get: async () => undefined,
    list: async () => [],
  })

  test("buffers until flushEveryN, then auto-flushes one NDJSON object", async () => {
    const puts: { path: string; body: string }[] = []
    const s = s3SpanSink(fakeBackend(puts), "run/abc", { flushEveryN: 2 })
    s.write("l1")
    expect(puts.length).toBe(0) // buffered, not yet flushed
    s.write("l2") // hits flushEveryN ⇒ auto-flush
    await new Promise((r) => setTimeout(r, 0)) // let the fire-and-forget flush settle
    expect(puts.length).toBe(1)
    expect(puts[0]?.path).toBe("run/abc/spans-000000.jsonl")
    expect(puts[0]?.body).toBe("l1\nl2\n")
  })

  test("explicit flush uploads the partial buffer; seq increments", async () => {
    const puts: { path: string; body: string }[] = []
    const s = s3SpanSink(fakeBackend(puts), "p", { flushEveryN: 100 })
    s.write("x")
    await s.flush()
    s.write("y")
    await s.flush()
    expect(puts.map((p) => p.path)).toEqual(["p/spans-000000.jsonl", "p/spans-000001.jsonl"])
    expect(puts.map((p) => p.body)).toEqual(["x\n", "y\n"])
  })

  test("durable seq: resumes after highest existing object (restart appends, race-guarded init)", async () => {
    const puts: string[] = []
    let listCalls = 0
    const backend: RemoteBackend = {
      put: async (p) => void puts.push(p),
      get: async () => undefined,
      list: async () => {
        listCalls++
        return ["p/spans-000000.jsonl", "p/spans-000003.jsonl", "p/junk.txt"]
      },
    }
    const s = s3SpanSink(backend, "p", { flushEveryN: 100 })
    s.write("a")
    s.write("b")
    await Promise.all([s.flush(), s.flush()]) // concurrent; only the first has buffered content
    expect(listCalls).toBe(1) // single init promise guards the seq seed (no double-list)
    expect(puts).toEqual(["p/spans-000004.jsonl"]) // max(0,3)=3 ⇒ resume at 4, NOT overwrite 0
  })

  test("empty flush is a no-op (no spurious object)", async () => {
    const puts: { path: string; body: string }[] = []
    const s = s3SpanSink(fakeBackend(puts), "p")
    await s.flush()
    expect(puts.length).toBe(0)
  })

  test("put failure is swallowed — best-effort, never throws", async () => {
    const s = s3SpanSink(
      {
        put: async () => Promise.reject(new Error("s3 down")),
        get: async () => undefined,
        list: async () => [],
      },
      "p",
      { flushEveryN: 1 },
    )
    s.write("x")
    await expect(s.flush()).resolves.toBeUndefined() // no throw
  })
})

describe("span-sink: resolveSpanSink (env precedence)", () => {
  test("QUANTA_OTEL_SINK s3:// ⇒ s3 adapter with parsed bucket/prefix", async () => {
    const made: string[] = []
    const puts: string[] = []
    const s = resolveSpanSink(
      { QUANTA_OTEL_SINK: "s3://mybucket/traces/run1" } as NodeJS.ProcessEnv,
      {
        makeS3: (bucket) => {
          made.push(bucket)
          return {
            put: async (p) => void puts.push(p),
            get: async () => undefined,
            list: async () => [],
          }
        },
      },
    )
    s.write("x")
    await s.flush()
    expect(made).toEqual(["mybucket"])
    expect(puts[0]).toBe("traces/run1/spans-000000.jsonl")
  })

  test("legacy QUANTA_OTEL_SAVE ⇒ file adapter (back-compat)", () => {
    const path = tmp("legacy.jsonl")
    resolveSpanSink({ QUANTA_OTEL_SAVE: path } as NodeJS.ProcessEnv).write('{"x":1}')
    expect(readFileSync(path, "utf8")).toBe('{"x":1}\n')
  })

  test("QUANTA_OTEL_SINK wins over legacy QUANTA_OTEL_SAVE", () => {
    const win = tmp("win.jsonl")
    const lose = tmp("lose.jsonl")
    resolveSpanSink({
      QUANTA_OTEL_SINK: `file:${win}`,
      QUANTA_OTEL_SAVE: lose,
    } as NodeJS.ProcessEnv).write("a")
    expect(readFileSync(win, "utf8")).toBe("a\n")
    expect(existsSync(lose)).toBe(false)
  })

  test("file: prefix and bare path both ⇒ file adapter", () => {
    const a = tmp("a.jsonl")
    const b = tmp("b.jsonl")
    resolveSpanSink({ QUANTA_OTEL_SINK: `file:${a}` } as NodeJS.ProcessEnv).write("1")
    resolveSpanSink({ QUANTA_OTEL_SINK: b } as NodeJS.ProcessEnv).write("2")
    expect(readFileSync(a, "utf8")).toBe("1\n")
    expect(readFileSync(b, "utf8")).toBe("2\n")
  })

  test("unset ⇒ noop (nothing persisted, no throw)", async () => {
    const s = resolveSpanSink({} as NodeJS.ProcessEnv)
    s.write("x")
    await expect(s.flush()).resolves.toBeUndefined()
  })
})
