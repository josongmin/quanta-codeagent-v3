import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { setColorPolicy } from "@/ui/ui-helpers"
import { dispatchReplSlash } from "../../../../src/apps/cli/repl"

let originalStdoutWrite: typeof process.stdout.write

beforeEach(() => {
  setColorPolicy("off")
  originalStdoutWrite = process.stdout.write.bind(process.stdout)
})

afterEach(() => {
  setColorPolicy(null)
  process.stdout.write = originalStdoutWrite
})

describe("REPL /mcp slash wiring", () => {
  test("/mcp in REPL uses wired mcp surface and is consumed by the slash dispatcher", async () => {
    let captured = ""
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s)
      return true
    }) as typeof process.stdout.write

    const handled = await dispatchReplSlash("/mcp", {
      mcp: {
        servers: [
          {
            name: "fs",
            status: "connected",
            toolCount: 1,
            tools: [{ name: "read_file", description: "read file", required: [] }],
          },
        ],
        now: () => 0,
      },
    })

    expect(handled).toBe(true)
    expect(captured).toContain("MCP servers")
    expect(captured).toContain("fs")
  })

  test("/mcp in REPL without wired mcp surface stays fail-closed", async () => {
    let captured = ""
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s)
      return true
    }) as typeof process.stdout.write

    const handled = await dispatchReplSlash("/mcp")

    expect(handled).toBe(true)
    expect(captured).toContain("not wired in this surface")
  })
})
