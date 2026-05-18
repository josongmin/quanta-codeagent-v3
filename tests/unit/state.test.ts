import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSession, saveSession } from "@/agent"
import type { Message } from "@/llm"

describe("session state persistence", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-state-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("save → load round trip preserves sessionId and messages", async () => {
    const path = join(dir, "session.json")
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ]
    await saveSession(path, { sessionId: "s-42", messages, reason: "completed", turns: 2 })
    const loaded = await loadSession(path)
    expect(loaded).not.toBeNull()
    expect(loaded?.sessionId).toBe("s-42")
    expect(loaded?.messages).toEqual(messages)
  })

  test("missing file → null", async () => {
    const loaded = await loadSession(join(dir, "nope.json"))
    expect(loaded).toBeNull()
  })

  test("corrupt file → null (never throws)", async () => {
    const path = join(dir, "bad.json")
    writeFileSync(path, "{ this is not json")
    const loaded = await loadSession(path)
    expect(loaded).toBeNull()
  })

  test("valid JSON but wrong shape → null", async () => {
    const path = join(dir, "wrong.json")
    writeFileSync(path, JSON.stringify({ foo: "bar" }))
    const loaded = await loadSession(path)
    expect(loaded).toBeNull()
  })
})
