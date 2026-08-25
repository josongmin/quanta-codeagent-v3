/**
 * GOAL-06 rail 11 — the external prompt queue's push hook receives the input,
 * so the host can treat ONLY independent ingress as activity: the wake
 * controller's own continuation push must never bump the epoch (it would
 * self-cancel at dequeue).
 */

import { describe, expect, test } from "bun:test"
import { ExternalPromptQueue } from "@/apps/cli/repl/external-prompt-queue"
import type { CliPromptInput } from "@/apps/cli/repl/prompt-types"

describe("GOAL-06 — external queue push hook carries the input", () => {
  test("onPush receives the pushed input (string and structured)", () => {
    const seen: CliPromptInput[] = []
    const queue = new ExternalPromptQueue({ onPush: (input) => seen.push(input) })
    queue.push("plain")
    queue.push({
      text: "continue",
      goalContinuation: { threadId: "t", objectiveRevision: 1, attemptKey: "k", activityEpoch: 3 },
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe("plain")
    expect(typeof seen[1] === "string" ? undefined : seen[1]?.goalContinuation?.attemptKey).toBe(
      "k",
    )
  })
})
