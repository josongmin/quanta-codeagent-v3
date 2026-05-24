import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { FollowUpQueue, threadId } from "@/agent/follow-up-queue"
import type { FollowUpQueueSnapshot } from "@/agent/follow-up-queue"
import { FakeLLM, cfg, text, withTimeout } from "../_harness"

const baseFollowUp = (content: string, submittedAt: number) => ({
  content,
  submittedAt,
  submittedTurnId: null,
  metadata: {},
})

describe("loop follow-up queue restore", () => {
  test("session-start restore replaces the caller queue state before first dequeue", async () => {
    const sessionId = "sess-restore"
    const tid = threadId(sessionId)
    const queue = new FollowUpQueue({ maxPerThread: 2 })
    queue.enqueue(tid, baseFollowUp("stale-local", 1))

    const snapshot: FollowUpQueueSnapshot = {
      version: 2,
      maxPerThread: 2,
      threads: [
        {
          threadId: sessionId,
          entries: [
            {
              ...baseFollowUp("from-snapshot", 2),
              id: FollowUpQueue.makeId(tid, 0),
            },
          ],
        },
      ],
    }
    const llm = new FakeLLM([text("done")])

    const outcome = await withTimeout(
      runAgent(
        cfg({
          llm,
          sessionId,
          followUpQueue: queue,
          followUpQueueSnapshotStore: {
            load: async () => snapshot,
            save: async () => {},
          },
        }),
      ),
      2000,
      "follow-up queue restore",
    )

    expect(outcome.reason).toBe("completed")
    const userTexts =
      llm.seenMessages[0]
        ?.filter((m) => m.role === "user")
        .map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("")) ?? []
    expect(userTexts.some((textBlock) => textBlock.includes("from-snapshot"))).toBe(true)
    expect(userTexts.some((textBlock) => textBlock.includes("stale-local"))).toBe(false)
    expect(queue.sizeFor(tid)).toBe(0)
  })
})
