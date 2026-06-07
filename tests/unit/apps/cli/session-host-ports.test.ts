import { describe, expect, test } from "bun:test"
import type { StreamPort } from "@/stream"
import {
  createCliPlanExitPort,
  createCliUserInputPort,
} from "../../../../src/apps/cli/repl/session-host-ports"

const scriptedAsk = (...answers: string[]) => {
  const prompts: string[] = []
  return {
    prompts,
    ask: async (prompt: string): Promise<string> => {
      prompts.push(prompt)
      const next = answers.shift()
      if (next === undefined) throw new Error("unexpected prompt")
      return next
    },
  }
}

const recordingStream = () => {
  const events: Parameters<StreamPort["emit"]>[0][] = []
  const stream: StreamPort = { emit: (event) => void events.push(event) }
  return { stream, events }
}

describe("CLI session host ports", () => {
  test("plan-exit port maps approve directly to the typed outcome", async () => {
    const io = scriptedAsk("a")
    const outcome = await createCliPlanExitPort({ ask: io.ask }).request("ship it")
    expect(outcome).toEqual({ decision: "approved" })
    expect(io.prompts[0]).toContain("Approve [a], reject [r], or request changes [c].")
  })

  test("plan-exit port requires non-empty feedback for changes_requested", async () => {
    const io = scriptedAsk("c", "   ", "tighten the scope")
    const outcome = await createCliPlanExitPort({ ask: io.ask }).request("touch everything")
    expect(outcome).toEqual({ decision: "changes_requested", feedback: "tighten the scope" })
    expect(io.prompts).toHaveLength(3)
  })

  test("user-input port accepts numbered choices and emits requested/resolved events", async () => {
    const io = scriptedAsk("2")
    const rec = recordingStream()
    const outcome = await createCliUserInputPort({ ask: io.ask, stream: rec.stream })({
      promptId: "p1",
      prompt: "Pick a framework",
      choices: ["Next.js", "Remix"],
    })
    expect(outcome).toEqual({ decision: "answer", text: "Remix" })
    expect(rec.events).toEqual([
      {
        type: "plan_user_input_requested",
        promptId: "p1",
        prompt: "Pick a framework",
        choices: ["Next.js", "Remix"],
      },
      {
        type: "plan_user_input_resolved",
        promptId: "p1",
        decision: "answer",
        text: "Remix",
      },
    ])
  })

  test("user-input port supports multiline answers with an explicit terminator", async () => {
    const io = scriptedAsk("line one", "line two", ".")
    const rec = recordingStream()
    const outcome = await createCliUserInputPort({ ask: io.ask, stream: rec.stream })({
      promptId: "p2",
      prompt: "Explain the rollback plan",
      multiline: true,
    })
    expect(outcome).toEqual({ decision: "answer", text: "line one\nline two" })
    expect(rec.events[1]).toEqual({
      type: "plan_user_input_resolved",
      promptId: "p2",
      decision: "answer",
      text: "line one\nline two",
    })
  })

  test("user-input port supports explicit cancellation", async () => {
    const io = scriptedAsk("/cancel")
    const rec = recordingStream()
    const outcome = await createCliUserInputPort({ ask: io.ask, stream: rec.stream })({
      promptId: "p3",
      prompt: "Need more input?",
    })
    expect(outcome).toEqual({ decision: "cancelled" })
    expect(rec.events).toEqual([
      {
        type: "plan_user_input_requested",
        promptId: "p3",
        prompt: "Need more input?",
      },
      {
        type: "plan_user_input_resolved",
        promptId: "p3",
        decision: "cancelled",
      },
    ])
  })
})
