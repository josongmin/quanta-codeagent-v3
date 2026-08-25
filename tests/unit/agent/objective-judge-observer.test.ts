/**
 * GOAL-02 — the objective judge is a SHADOW OBSERVER: bounded, sanitized,
 * telemetry-only. It never touches objective state and its failures (timeout,
 * throw, circuit, hostile output) are `unavailable` telemetry, not admissions.
 */

import { describe, expect, test } from "bun:test"
import {
  createObjectiveJudgeObserver,
  type ObjectiveJudgeTelemetry,
} from "@/agent/tier1/objective-judge-observer"
import type { LLMPort } from "@/llm"
import { asObjectiveReadPort, createObjectiveAuthority } from "@/objective"

const authorityWith = (criteria: readonly string[] = ["manual proof"]) => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  authority.create("t", { goal: "ship", successCriteria: criteria })
  return authority
}

const textLlm = (text: string, calls?: { n: number }): LLMPort => ({
  async *stream() {
    if (calls) calls.n += 1
    yield { type: "text_delta", delta: text } as never
  },
})

const blockVerdict = (criterionId: string): string =>
  JSON.stringify({
    decision: "block",
    unmetCriterionIds: [criterionId],
    evidenceRefs: [],
    reasonCodes: ["criterion-unmet"],
  })

describe("GOAL-02 — judge observer", () => {
  test("a schema-valid block verdict is telemetry only; objective state is untouched", async () => {
    const authority = authorityWith()
    const cid = authority.get("t")?.successCriteria[0]?.id ?? ""
    const seen: ObjectiveJudgeTelemetry[] = []
    const observer = createObjectiveJudgeObserver({
      llm: textLlm(blockVerdict(cid)),
      onDecision: (t) => seen.push(t),
    })
    const before = authority.readDomain("t")
    const result = await observer.evaluate({ read: asObjectiveReadPort(authority), threadId: "t" })
    expect(result.outcome).toBe("block")
    expect(seen).toEqual([result])
    expect(authority.readDomain("t")).toEqual(before)
    expect(authority.get("t")?.status).toBe("active")
    expect(authority.get("t")?.blockers).toEqual([])
  })

  test("invented criterion references cannot even produce a block (abstain-or-unavailable)", async () => {
    const authority = authorityWith()
    const observer = createObjectiveJudgeObserver({ llm: textLlm(blockVerdict("not-a-criterion")) })
    const result = await observer.evaluate({ read: asObjectiveReadPort(authority), threadId: "t" })
    expect(result.outcome).toBe("unavailable")
  })

  test("criterion text and caller digests never reach the judge input", async () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "SECRET-GOAL", successCriteria: ["SECRET-CRITERION-TEXT"] })
    let seenInput = ""
    const llm: LLMPort = {
      async *stream(input) {
        seenInput = JSON.stringify(input.messages)
        yield {
          type: "text_delta",
          delta: JSON.stringify({
            decision: "abstain",
            unmetCriterionIds: [],
            evidenceRefs: [],
            reasonCodes: [],
          }),
        } as never
      },
    }
    const observer = createObjectiveJudgeObserver({ llm })
    const result = await observer.evaluate({ read: asObjectiveReadPort(authority), threadId: "t" })
    expect(result.outcome).toBe("abstain")
    expect(seenInput).not.toContain("SECRET-GOAL")
    expect(seenInput).not.toContain("SECRET-CRITERION-TEXT")
  })

  test("timeout / provider throw / hostile output are unavailable telemetry; a three-failure circuit opens and recovers", async () => {
    const authority = authorityWith()
    const cid = authority.get("t")?.successCriteria[0]?.id ?? ""
    let calls = 0
    let time = 0
    const llm: LLMPort = {
      stream() {
        calls += 1
        if (calls > 3) return textLlm(blockVerdict(cid)).stream({} as never)
        return {
          [Symbol.asyncIterator]() {
            return { next: async () => Promise.reject(new Error("provider unavailable")) }
          },
        } as never
      },
    }
    const observer = createObjectiveJudgeObserver({ llm, now: () => time })
    const read = asObjectiveReadPort(authority)
    for (let i = 0; i < 4; i += 1) {
      expect((await observer.evaluate({ read, threadId: "t" })).outcome).toBe("unavailable")
    }
    expect(calls).toBe(3) // circuit open: the 4th evaluation made no request
    time = 60_001
    expect((await observer.evaluate({ read, threadId: "t" })).outcome).toBe("block")
    expect(authority.get("t")?.status).toBe("active")

    const slow: LLMPort = {
      async *stream(input) {
        await new Promise<void>((resolve) =>
          input.signal?.addEventListener("abort", () => resolve(), { once: true }),
        )
      },
    }
    const timed = createObjectiveJudgeObserver({ llm: slow, timeoutMs: 5 })
    expect((await timed.evaluate({ read, threadId: "t" })).outcome).toBe("unavailable")
  })

  test("no objective / oversized evidence is unavailable without a request", async () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    const calls = { n: 0 }
    const observer = createObjectiveJudgeObserver({ llm: textLlm("{}", calls) })
    expect(
      (await observer.evaluate({ read: asObjectiveReadPort(authority), threadId: "none" })).outcome,
    ).toBe("unavailable")
    expect(calls.n).toBe(0)
  })

  test("observer callback failures cannot change the result", async () => {
    const authority = authorityWith()
    const observer = createObjectiveJudgeObserver({
      llm: textLlm(
        JSON.stringify({
          decision: "abstain",
          unmetCriterionIds: [],
          evidenceRefs: [],
          reasonCodes: [],
        }),
      ),
      onDecision: () => {
        throw new Error("boom")
      },
    })
    expect(
      (await observer.evaluate({ read: asObjectiveReadPort(authority), threadId: "t" })).outcome,
    ).toBe("abstain")
  })
})
