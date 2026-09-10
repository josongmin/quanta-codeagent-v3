import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type EventMsgRecord, SESSION_ENVELOPE_VERSION } from "@/session/envelope"
import { encodeSessionLine, iterateSessionFile } from "@/session/envelope-encoder"
import { appendEnvelope, sessionEnvelopePath } from "@/session/store"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

const root = mkdtempSync(join(tmpdir(), "session-envelope-stress-"))
const savedSessionsDir = process.env.QUANTA_SESSIONS_DIR
const isoAt = (index: number): string => new Date(1_716_000_000_000 + index * 1000).toISOString()

afterAll(() => {
  if (savedSessionsDir === undefined) delete process.env.QUANTA_SESSIONS_DIR
  else process.env.QUANTA_SESSIONS_DIR = savedSessionsDir
  __resetRuntimeConfig()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

const event = (turnId: string, index: number): EventMsgRecord => ({
  type: "event_msg",
  schema_version: SESSION_ENVELOPE_VERSION,
  ts: isoAt(index),
  turn_id: turnId,
  kind: "token_count",
  input_tokens: index,
  output_tokens: index,
})

const writeStreamingFixture = async (path: string, count: number): Promise<void> => {
  const file = await open(path, "a")
  try {
    for (let start = 0; start < count; start += 1_000) {
      const end = Math.min(start + 1_000, count)
      let chunk = ""
      for (let index = start; index < end; index += 1) {
        chunk += encodeSessionLine(event(`t-${index % 32}`, index))
      }
      await file.write(chunk)
    }
  } finally {
    await file.close()
  }
}

describe("session envelope exhaustive scale", () => {
  test("streams exactly 10,000 records with a running counter", async () => {
    const path = sessionEnvelopePath("stream-10k-nightly")
    await writeStreamingFixture(path, 10_000)
    let count = 0
    let sum = 0
    for await (const result of iterateSessionFile(path)) {
      if (!result.ok) throw result.error
      count += 1
      if (result.value.type === "event_msg" && result.value.kind === "token_count") {
        sum += result.value.input_tokens
      }
    }
    expect(count).toBe(10_000)
    expect(sum).toBe((10_000 * 9_999) / 2)
  })

  test("two concurrent 500-record writers produce 1,000 untorn lines", async () => {
    const sessionId = "concurrent-1000-nightly"
    const write = async (label: string, offset: number): Promise<void> => {
      for (let index = 0; index < 500; index += 1) {
        await appendEnvelope(sessionId, event(label, offset + index))
      }
    }
    await Promise.all([write("writer-A", 0), write("writer-B", 500)])

    let total = 0
    let a = 0
    let b = 0
    for await (const result of iterateSessionFile(sessionEnvelopePath(sessionId))) {
      if (!result.ok) throw result.error
      total += 1
      if (result.value.type !== "event_msg") continue
      if (result.value.turn_id === "writer-A") a += 1
      if (result.value.turn_id === "writer-B") b += 1
    }
    expect({ total, a, b }).toEqual({ total: 1_000, a: 500, b: 500 })
  })
})
