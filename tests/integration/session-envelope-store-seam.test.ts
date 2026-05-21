import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import {
  appendEnvelope,
  type EventMsgRecord,
  iterateSessionFile,
  SESSION_ENVELOPE_VERSION,
  type SessionEnvelopeRecord,
  sessionEnvelopePath,
} from "@/session"

const root = mkdtempSync(join(tmpdir(), "session-envelope-seam-"))

beforeAll(() => {
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

// Other session test suites in this process pool also flip
// QUANTA_SESSIONS_DIR and call __resetRuntimeConfig() in their own
// beforeEach. Re-assert OUR root + reset cache before every test so a
// concurrent suite's afterEach cleanup can't leak its cached path into our
// reads. Reset is the contract — env mutation alone is insufficient because
// the runtime-config layer memoizes sessionsRoot() per process.
beforeEach(() => {
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

afterAll(() => {
  delete process.env.QUANTA_SESSIONS_DIR
  __resetRuntimeConfig()
  rmSync(root, { recursive: true, force: true })
})

const isoAt = (sec: number): string => new Date(1_716_000_000_000 + sec * 1000).toISOString()

const buildEvent = (i: number): EventMsgRecord => ({
  type: "event_msg",
  schema_version: SESSION_ENVELOPE_VERSION,
  ts: isoAt(i),
  turn_id: `t-${i}`,
  kind: "token_count",
  input_tokens: i,
  output_tokens: i * 2,
})

const readAll = async (path: string): Promise<SessionEnvelopeRecord[]> => {
  const out: SessionEnvelopeRecord[] = []
  for await (const r of iterateSessionFile(path)) {
    if (!r.ok) throw new Error(`unexpected decode failure: ${r.error.message}`)
    out.push(r.value)
  }
  return out
}

const assertTokenCount = (rec: SessionEnvelopeRecord, i: number): void => {
  if (rec.type !== "event_msg") throw new Error(`unexpected type at ${i}: ${rec.type}`)
  if (rec.kind !== "token_count") throw new Error(`unexpected kind at ${i}: ${rec.kind}`)
  expect(rec.turn_id).toBe(`t-${i}`)
  expect(rec.input_tokens).toBe(i)
  expect(rec.output_tokens).toBe(i * 2)
}

describe("appendEnvelope ↔ iterateSessionFile end-to-end", () => {
  test("write 100 records in order, read them back in the same order", async () => {
    const sessionId = "session-100"
    for (let i = 0; i < 100; i += 1) {
      await appendEnvelope(sessionId, buildEvent(i))
    }
    const path = sessionEnvelopePath(sessionId)
    const out = await readAll(path)
    expect(out.length).toBe(100)
    for (let i = 0; i < 100; i += 1) {
      const rec = out[i]
      if (rec === undefined) throw new Error(`missing record at ${i}`)
      assertTokenCount(rec, i)
    }
  })

  test("appending one more record after read-back preserves prior records", async () => {
    const sessionId = "session-append"
    await appendEnvelope(sessionId, buildEvent(1))
    await appendEnvelope(sessionId, buildEvent(2))
    const path = sessionEnvelopePath(sessionId)
    let count = 0
    for await (const _ of iterateSessionFile(path)) count += 1
    expect(count).toBe(2)
    await appendEnvelope(sessionId, buildEvent(3))
    count = 0
    for await (const _ of iterateSessionFile(path)) count += 1
    expect(count).toBe(3)
  })

  test("does not mutate the snapshot store (saveSessionById remains independent)", async () => {
    // The new seam is additive — it must not touch the .json snapshot file.
    const sessionId = "session-additive"
    await appendEnvelope(sessionId, buildEvent(0))
    // The JSONL exists; the snapshot does NOT.
    const jsonl = sessionEnvelopePath(sessionId)
    const snapshot = join(root, `${sessionId}.json`)
    expect(await Bun.file(jsonl).exists()).toBe(true)
    expect(await Bun.file(snapshot).exists()).toBe(false)
  })
})
