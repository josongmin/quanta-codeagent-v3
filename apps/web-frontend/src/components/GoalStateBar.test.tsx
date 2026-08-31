import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { GoalReadoutData } from "../types/protocol.readout.generated"
import { GoalStateBar } from "./GoalStateBar"

const state: GoalReadoutData = {
  kind: "goal",
  revision: 4,
  freshness: "source-unavailable",
  validationContract: "checked",
  wake: { kind: "armed", delayMs: 15_000, wakeAt: 20_000 },
  latestSettlement: {
    turnOutcome: "completed",
    objectiveRevisionBefore: 3,
    objectiveRevisionAfter: 4,
    recordedAt: 1,
    criterionTransitions: 1,
    remainingCriteria: 1,
  },
  objective: {
    objectiveId: "objective-1",
    goal: "ship safely",
    status: "completion_unconfirmed",
    budget: { turnsUsed: 1, tokensUsed: 20 },
    blockers: [],
    criteria: [],
  },
}

describe("GoalStateBar", () => {
  it("renders freshness, absolute wake countdown and latest settlement without observability", () => {
    const html = renderToStaticMarkup(<GoalStateBar state={state} now={5_000} />)
    expect(html).toContain("ship safely")
    expect(html).toContain("completion_unconfirmed")
    expect(html).toContain("freshness source-unavailable")
    expect(html).toContain("wake 15s")
    expect(html).toContain("last completed")
  })
})
