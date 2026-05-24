import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { setColorPolicy } from "@/ui/ui-helpers"
import { runReplLoop } from "../../../../src/apps/cli/repl"

const makeRl = (
  lines: string[],
): { rl: { question: (q: string) => Promise<string> }; trace: string[] } => {
  const trace: string[] = []
  let i = 0
  const rl = {
    question: async (_q: string): Promise<string> => {
      const line = lines[i++]
      if (line === undefined) throw new Error("rl: out of inputs")
      trace.push(line)
      return line
    },
  }
  return { rl, trace }
}

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
  test("/mcp in REPL uses wired mcp surface and never reaches the model", async () => {
    const turnCalls: string[] = []
    const { rl } = makeRl(["/mcp", "/exit"])
    const abort = new AbortController()
    let captured = ""
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s)
      return true
    }) as typeof process.stdout.write

    await runReplLoop(
      rl as never,
      abort.signal,
      async (text) => {
        turnCalls.push(text)
      },
      {
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
      },
    )

    expect(captured).toContain("MCP servers")
    expect(captured).toContain("fs")
    expect(turnCalls).toHaveLength(0)
  })

  test("/mcp in REPL without wired mcp surface stays fail-closed", async () => {
    const turnCalls: string[] = []
    const { rl } = makeRl(["/mcp", "/exit"])
    const abort = new AbortController()
    let captured = ""
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s)
      return true
    }) as typeof process.stdout.write

    await runReplLoop(rl as never, abort.signal, async (text) => {
      turnCalls.push(text)
    })

    expect(captured).toContain("not wired in this surface")
    expect(turnCalls).toHaveLength(0)
  })
})
