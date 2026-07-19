/**
 * Browser tool surface contract: every currently registered browser tool must
 * turn a rejected BrowserPort spawn into one terminal tool result.  Iterating
 * the assembled surface (rather than a hand-maintained name list) makes a new
 * browser tool inherit this no-hang requirement automatically.
 */
import { describe, expect, test } from "bun:test"
import { createHeadlessBrowser, type BrowserPort } from "@/browser"
import type { Tool, ToolResult } from "@/tool"
import { createBrowserToolset } from "@/tool/browser"

const terminalResult = async (tool: Tool, input: unknown): Promise<ToolResult> => {
  const ctx = { cwd: "/tmp", signal: new AbortController().signal }
  let result: ToolResult | undefined
  for await (const event of tool.execute(input, ctx)) {
    if (event.type === "result") result = event.result
  }
  if (result === undefined) throw new Error(`${tool.name}: iterator ended without a result`)
  return result
}

const within = async <T>(label: string, work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: iterator hung`)), 250)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe("HELLGATE browser tools — rejected port is total", () => {
  test("every discovered tool returns spawn_error without throw or hanging when BrowserPort.spawn rejects", async () => {
    const headless = createHeadlessBrowser()
    const rejectingPort: BrowserPort = {
      ...headless,
      spawn: async () => {
        throw new Error("browser port rejected")
      },
    }
    const toolset = createBrowserToolset(rejectingPort, {
      bounds: true,
      highlight: true,
      network: true,
      tabs: true,
    })

    // 15 base + bounds + highlight + network + four tab verbs.  The execution
    // loop below intentionally discovers tools from the assembled surface.
    expect(toolset.tools).toHaveLength(22)
    for (const tool of toolset.tools) {
      const input = tool.name === "browser_navigate" ? { url: "https://example.com" } : {}
      const result = await within(tool.name, terminalResult(tool, input))
      expect(result.ok, tool.name).toBe(false)
      expect(result.failure?.mode, tool.name).toBe("spawn_error")
    }
    await toolset.dispose()
  })
})
