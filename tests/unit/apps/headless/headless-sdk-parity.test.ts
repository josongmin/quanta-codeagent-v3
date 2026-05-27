import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runHeadlessOnce } from "@/apps/headless"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

describe("T5 headless SDK parity", () => {
  test("public headless entry is an sdk consumer with local compat ownership", () => {
    const source = read("src/apps/headless/index.ts")

    expect(source).toContain('from "./session-bridge"')
    expect(source).not.toContain('from "@/host/bootstrap"')
    expect(source).not.toContain("bootstrapSession(")
    expect(source).not.toContain("createRuntimeFromBootstrap(")
  })

  test("runHeadlessOnce returns the lean sdk-facing result contract", async () => {
    const result = await runHeadlessOnce({
      prompt: "ping",
      fakeCompletion: { text: "pong" },
    })
    const record = result as unknown as Record<string, unknown>

    expect(result.outcome.reason).toBe("completed")
    expect(result.sessionId).toBeTruthy()
    expect(result.cwd).toBe("/tmp/headless")
    expect(result.snapshot?.sessionId).toBe(result.sessionId)
    expect(result.wires.executionPlane).toBeDefined()
    expect(result.wires.executionPlane.responsesContinuation).toBe(true)
    expect(result.wires.memoryAuto).toBeDefined()
    expect(Array.isArray(result.events)).toBe(true)
    expect(Array.isArray(result.messages)).toBe(true)

    expect("boot" in record).toBe(false)
    expect("deps" in record).toBe(false)
    expect("mcpClients" in record).toBe(false)
    expect("shutdown" in record).toBe(false)
    expect("transportHandle" in record).toBe(false)
  })
})
