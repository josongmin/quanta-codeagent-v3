import { describe, expect, test } from "bun:test"
import type { AdvisorConsultRequest, AdvisorPort } from "@/tool/advisor"
import { advisorInputSchema, advisorTool } from "@/tool/advisor"
import type { ToolContext, ToolEvent } from "@/tool/types"

/**
 * RFC jun-6 §6.2 — advisor schema enhancements hellgate.
 *
 *  - `question` is now OPTIONAL; `forwardHistory:boolean` added.
 *  - at-least-one-of {question, forwardHistory:true} validation (else ok:false).
 *  - explicit-question mode still works; the request shape forwards forwardHistory.
 */

const ctx = (): ToolContext =>
  ({ cwd: "/repo", signal: new AbortController().signal }) as unknown as ToolContext

/** Capture the request the port receives. */
const capturingPort = (): { port: AdvisorPort; seen: () => AdvisorConsultRequest | undefined } => {
  let req: AdvisorConsultRequest | undefined
  const port: AdvisorPort = {
    async consult(r) {
      req = r
      return { ok: true, analysis: "ok", modelUsed: "gpt-5" }
    },
    listModels: () => ["gpt-5"],
  }
  return { port, seen: () => req }
}

const runTool = async (input: unknown, port: AdvisorPort): Promise<ToolEvent> => {
  const tool = advisorTool(port)
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx())) last = ev
  return last as ToolEvent
}

describe("advisor schema — optional question + forwardHistory", () => {
  test("question optional: omitting it is a valid schema parse", () => {
    expect(advisorInputSchema.safeParse({ forwardHistory: true }).success).toBe(true)
  })

  test("forwardHistory accepts boolean only", () => {
    expect(advisorInputSchema.safeParse({ forwardHistory: "yes" }).success).toBe(false)
    expect(advisorInputSchema.safeParse({ forwardHistory: true }).success).toBe(true)
  })
})

describe("advisor tool — at-least-one-of validation", () => {
  test("neither question nor forwardHistory ⇒ ok:false, port never consulted", async () => {
    const { port, seen } = capturingPort()
    const ev = await runTool({}, port)
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(false)
      expect(ev.result.output).toContain("supply question or forwardHistory")
    }
    expect(seen()).toBeUndefined()
  })

  test("forwardHistory:false alone ⇒ ok:false (still no consult)", async () => {
    const { port, seen } = capturingPort()
    const ev = await runTool({ forwardHistory: false }, port)
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect(seen()).toBeUndefined()
  })
})

describe("advisor tool — request forwarding", () => {
  test("forwardHistory:true (no question) ⇒ request carries forwardHistory", async () => {
    const { port, seen } = capturingPort()
    await runTool({ forwardHistory: true }, port)
    expect(seen()?.forwardHistory).toBe(true)
    // Empty-string question is forwarded so the port's composer stays total.
    expect(seen()?.question).toBe("")
  })

  test("explicit-question mode still works + forwardHistory absent from request", async () => {
    const { port, seen } = capturingPort()
    const ev = await runTool({ question: "X or Y?" }, port)
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(seen()?.question).toBe("X or Y?")
    expect(seen()?.forwardHistory).toBeUndefined()
  })

  test("explicit model still allowlist-gated (unlisted ⇒ ok:false, no consult)", async () => {
    const { port, seen } = capturingPort()
    const ev = await runTool({ question: "x", model: "not-allowed" }, port)
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(false)
      expect(ev.result.output).toContain("not-allowlisted")
    }
    expect(seen()).toBeUndefined()
  })
})
