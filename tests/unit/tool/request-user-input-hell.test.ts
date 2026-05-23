/**
 * ADR-0095 (draft) — `request_user_input` tool hell-suite.
 *
 * Mirrors the `request_plan_exit` contract (ADR-0086 sister tool) and pins:
 *   - graceful absent-port degradation (no throw past the loop),
 *   - the CLOSED 2-arm outcome union (`answer` | `cancelled`),
 *   - structured `ToolFailure` discriminants (`error` / `rejected`),
 *   - zod input validation (min/max prompt, ≤12 non-empty choices),
 *   - promptId uniqueness across calls,
 *   - parameter passthrough (multiline + choices reach the requester unchanged),
 *   - read-only + concurrency-UNSAFE metadata.
 *
 * Uses REAL captured-call mocks (no flimsy stubs) so a regression in the tool
 * is visible at the assertion site, not behind a mocking framework.
 */
import { describe, expect, test } from "bun:test"
import { requestUserInputTool } from "@/tool/request-user-input"
import type {
  ToolContext,
  ToolEvent,
  ToolResult,
  UserInputOutcome,
  UserInputRequester,
} from "@/tool/types"

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/repo",
  signal: new AbortController().signal,
  ...over,
})

const terminal = (events: ToolEvent[]): ToolResult => {
  const last = events.at(-1)
  if (last?.type !== "result") throw new Error("no terminal result event")
  return last.result
}

type CapturedRequest = Parameters<UserInputRequester>[0]

const capturingRequester = (
  outcome: UserInputOutcome | (() => UserInputOutcome | Promise<UserInputOutcome>),
): { requester: UserInputRequester; calls: CapturedRequest[] } => {
  const calls: CapturedRequest[] = []
  const requester: UserInputRequester = async (req) => {
    calls.push(req)
    return typeof outcome === "function" ? await outcome() : outcome
  }
  return { requester, calls }
}

const tool = requestUserInputTool()

describe("request_user_input — metadata & contract", () => {
  test("name + description match the ADR-0095 draft surface", () => {
    expect(tool.name).toBe("request_user_input")
    expect(tool.description).toContain("Ask the operator")
    expect(tool.description).toContain("answer")
    expect(tool.description).toContain("cancelled")
  })

  test("isReadOnly() === true (does not touch FS or shell)", () => {
    expect(tool.isReadOnly()).toBe(true)
  })

  test("isConcurrencySafe(input) === false — blocks on operator", () => {
    expect(tool.isConcurrencySafe({ prompt: "anything" })).toBe(false)
    expect(tool.isConcurrencySafe({ prompt: "x", choices: ["a", "b"] })).toBe(false)
    expect(tool.isConcurrencySafe({ prompt: "x", multiline: true })).toBe(false)
  })
})

describe("request_user_input — port wiring", () => {
  test("port absent ⇒ graceful ok:false + failure.mode === 'error' (never throws)", async () => {
    const events = await drain(tool.execute({ prompt: "anything?" }, ctx()))
    const r = terminal(events)
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
    if (r.failure?.mode === "error") {
      expect(r.failure.modelVisibleError).toContain("no user-input port")
    }
    expect(r.output).toContain("unavailable")
  })

  test("port absent ⇒ NO progress event emitted (terminal-only)", async () => {
    const events = await drain(tool.execute({ prompt: "anything?" }, ctx()))
    expect(events.length).toBe(1)
    expect(events[0]?.type).toBe("result")
  })

  test("port present ⇒ emits a progress event BEFORE the terminal result", async () => {
    const { requester } = capturingRequester({ decision: "answer", text: "ok" })
    const events = await drain(
      tool.execute({ prompt: "anything?" }, ctx({ requestUserInput: requester })),
    )
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]?.type).toBe("progress")
    if (events[0]?.type === "progress") {
      expect(events[0].message).toContain("awaiting user input")
    }
    expect(events.at(-1)?.type).toBe("result")
  })
})

describe("request_user_input — happy & cancelled outcomes (CLOSED 2-arm union)", () => {
  test("answer ⇒ ok:true + output === the operator text (verbatim)", async () => {
    const { requester } = capturingRequester({ decision: "answer", text: "yes" })
    const r = terminal(
      await drain(tool.execute({ prompt: "go?" }, ctx({ requestUserInput: requester }))),
    )
    expect(r.ok).toBe(true)
    expect(r.output).toBe("yes")
    expect(r.failure).toBeUndefined()
  })

  test("answer with multiline text ⇒ preserved verbatim (no trimming, no escaping)", async () => {
    const text = "line1\nline2\n  indented\n\nfinal"
    const { requester } = capturingRequester({ decision: "answer", text })
    const r = terminal(
      await drain(
        tool.execute({ prompt: "describe", multiline: true }, ctx({ requestUserInput: requester })),
      ),
    )
    expect(r.ok).toBe(true)
    expect(r.output).toBe(text)
  })

  test("answer with EMPTY string ⇒ still ok:true + output === '' (relayed verbatim)", async () => {
    const { requester } = capturingRequester({ decision: "answer", text: "" })
    const r = terminal(
      await drain(tool.execute({ prompt: "go?" }, ctx({ requestUserInput: requester }))),
    )
    expect(r.ok).toBe(true)
    expect(r.output).toBe("")
  })

  test("cancelled ⇒ ok:false + failure.mode === 'rejected' + failure.reason === 'user_cancelled'", async () => {
    const { requester } = capturingRequester({ decision: "cancelled" })
    const r = terminal(
      await drain(tool.execute({ prompt: "go?" }, ctx({ requestUserInput: requester }))),
    )
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
    if (r.failure?.mode === "rejected") {
      expect(r.failure.reason).toBe("user_cancelled")
    }
  })
})

describe("request_user_input — error paths (never throws past the loop)", () => {
  test("requester throws synchronously inside async body ⇒ caught + ok:false (error)", async () => {
    const requester: UserInputRequester = async () => {
      throw new Error("sync-style boom")
    }
    const r = terminal(
      await drain(tool.execute({ prompt: "go?" }, ctx({ requestUserInput: requester }))),
    )
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
    if (r.failure?.mode === "error") {
      expect(r.failure.modelVisibleError).toContain("sync-style boom")
    }
    expect(r.output).toContain("sync-style boom")
  })

  test("requester returns a rejected promise ⇒ caught + ok:false (error)", async () => {
    const requester: UserInputRequester = () => Promise.reject(new Error("async-reject"))
    const r = terminal(
      await drain(tool.execute({ prompt: "go?" }, ctx({ requestUserInput: requester }))),
    )
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
    if (r.failure?.mode === "error") {
      expect(r.failure.modelVisibleError).toContain("async-reject")
    }
  })

  test("requester throws a non-Error value ⇒ still caught + ok:false (error)", async () => {
    const requester: UserInputRequester = async () => {
      throw "string-throw"
    }
    const r = terminal(
      await drain(tool.execute({ prompt: "go?" }, ctx({ requestUserInput: requester }))),
    )
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
  })

  test("closed-union discipline: an out-of-band decision tag (forced via cast) is handled, not crash-thrown", async () => {
    // Deliberately bypass the type system to simulate a contract violation by
    // a future producer that ships before TS catches up. The tool's `never`
    // default must give a STRUCTURED ok:false, not crash the loop.
    const requester: UserInputRequester = async () =>
      ({ decision: "unknown" }) as unknown as UserInputOutcome
    const r = terminal(
      await drain(tool.execute({ prompt: "go?" }, ctx({ requestUserInput: requester }))),
    )
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
    expect(r.output).toContain("unknown")
  })
})

describe("request_user_input — promptId generation", () => {
  test("promptId is a string and reaches the requester unmodified", async () => {
    const { requester, calls } = capturingRequester({ decision: "answer", text: "k" })
    await drain(tool.execute({ prompt: "q" }, ctx({ requestUserInput: requester })))
    expect(calls.length).toBe(1)
    expect(typeof calls[0]?.promptId).toBe("string")
    expect((calls[0]?.promptId ?? "").length).toBeGreaterThan(0)
  })

  test("promptId is unique across 100 calls (UUID-strength)", async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const { requester, calls } = capturingRequester({ decision: "answer", text: "k" })
      await drain(tool.execute({ prompt: "q" }, ctx({ requestUserInput: requester })))
      const id = calls[0]?.promptId ?? ""
      seen.add(id)
    }
    expect(seen.size).toBe(100)
  })
})

describe("request_user_input — parameter passthrough", () => {
  test("prompt reaches the requester verbatim", async () => {
    const prompt = "Which migration should I apply: A, B, or C?"
    const { requester, calls } = capturingRequester({ decision: "answer", text: "B" })
    await drain(tool.execute({ prompt }, ctx({ requestUserInput: requester })))
    expect(calls[0]?.prompt).toBe(prompt)
  })

  test("multiline=true reaches the requester as true", async () => {
    const { requester, calls } = capturingRequester({ decision: "answer", text: "ok" })
    await drain(
      tool.execute({ prompt: "describe", multiline: true }, ctx({ requestUserInput: requester })),
    )
    expect(calls[0]?.multiline).toBe(true)
  })

  test("multiline=false reaches the requester as false (not stripped)", async () => {
    const { requester, calls } = capturingRequester({ decision: "answer", text: "ok" })
    await drain(
      tool.execute({ prompt: "q", multiline: false }, ctx({ requestUserInput: requester })),
    )
    expect(calls[0]?.multiline).toBe(false)
  })

  test("multiline omitted ⇒ field absent on the requester payload (not undefined-key)", async () => {
    const { requester, calls } = capturingRequester({ decision: "answer", text: "ok" })
    await drain(tool.execute({ prompt: "q" }, ctx({ requestUserInput: requester })))
    expect(Object.hasOwn(calls[0] ?? {}, "multiline")).toBe(false)
  })

  test("choices reaches the requester verbatim (order preserved)", async () => {
    const choices = ["alpha", "beta", "gamma"]
    const { requester, calls } = capturingRequester({ decision: "answer", text: "alpha" })
    await drain(tool.execute({ prompt: "pick", choices }, ctx({ requestUserInput: requester })))
    expect(calls[0]?.choices).toEqual(choices)
  })

  test("choices omitted ⇒ field absent on the requester payload", async () => {
    const { requester, calls } = capturingRequester({ decision: "answer", text: "ok" })
    await drain(tool.execute({ prompt: "q" }, ctx({ requestUserInput: requester })))
    expect(Object.hasOwn(calls[0] ?? {}, "choices")).toBe(false)
  })
})

describe("request_user_input — zod validation (dispatch-layer owns the parse; we pin the schema)", () => {
  test("empty prompt rejected by schema (min(1))", () => {
    expect(tool.inputSchema.safeParse({ prompt: "" }).success).toBe(false)
  })

  test("prompt at exactly 2000 chars is accepted", () => {
    const s = "x".repeat(2000)
    expect(tool.inputSchema.safeParse({ prompt: s }).success).toBe(true)
  })

  test("prompt over 2000 chars is rejected (max(2000))", () => {
    const s = "x".repeat(2001)
    expect(tool.inputSchema.safeParse({ prompt: s }).success).toBe(false)
  })

  test("choices: array of non-empty strings is accepted", () => {
    expect(tool.inputSchema.safeParse({ prompt: "q", choices: ["a", "b", "c"] }).success).toBe(true)
  })

  test("choices: an EMPTY string item is rejected (min(1) on the item)", () => {
    expect(tool.inputSchema.safeParse({ prompt: "q", choices: ["a", "", "c"] }).success).toBe(false)
  })

  test("choices: exactly 12 items is accepted", () => {
    const c12 = Array.from({ length: 12 }, (_, i) => `c${i}`)
    expect(tool.inputSchema.safeParse({ prompt: "q", choices: c12 }).success).toBe(true)
  })

  test("choices: 13 items is rejected (max(12))", () => {
    const c13 = Array.from({ length: 13 }, (_, i) => `c${i}`)
    expect(tool.inputSchema.safeParse({ prompt: "q", choices: c13 }).success).toBe(false)
  })

  test("multiline: boolean accepted, non-boolean rejected", () => {
    expect(tool.inputSchema.safeParse({ prompt: "q", multiline: true }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ prompt: "q", multiline: false }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ prompt: "q", multiline: "yes" }).success).toBe(false)
  })

  test("schema accepts the minimal shape { prompt }", () => {
    expect(tool.inputSchema.safeParse({ prompt: "q" }).success).toBe(true)
  })
})
