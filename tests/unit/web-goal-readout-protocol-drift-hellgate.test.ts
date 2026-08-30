import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { decodeGoalReadoutData } from "@/protocol/readout"
import {
  GENERATED_READOUT_OUTPUT_PATH,
  generateReadoutProtocolBundle,
} from "../../tools/gen-web-frontend-readout-protocol"

const REPO_ROOT = join(import.meta.dir, "..", "..")

const valid = {
  kind: "goal",
  revision: 7,
  validationContract: "checked",
  objective: {
    objectiveId: "objective:t:1",
    goal: "ship it",
    status: "active",
    budget: { turnsUsed: 1, tokensUsed: 20, maxTurns: 4 },
    startedAttemptId: "attempt:t:1",
    blockers: [{ id: "blocker:t:1", reason: "review", waitingOn: "user" }],
    criteria: [
      {
        id: "criterion:t:1",
        kind: "checked",
        text: "tests pass",
        met: false,
        check: {
          id: "check:t:1",
          kind: "command",
          argv: ["bun", "test", ""],
          timeoutMs: 120_000,
          successExitCodes: [0],
          cwdPolicy: "thread",
        },
      },
    ],
  },
} as const

describe("web goal readout protocol drift hellgate", () => {
  test("committed browser bundle byte-equals a fresh canonical generation", () => {
    expect(readFileSync(join(REPO_ROOT, GENERATED_READOUT_OUTPUT_PATH), "utf8")).toBe(
      generateReadoutProtocolBundle(),
    )
  })

  test("paired control accepts every control identity and check field", () => {
    expect(decodeGoalReadoutData(valid)).toEqual(valid)
  })

  test("red-on-injection: a missing revision is rejected rather than read as absent", () => {
    const { revision: _removed, ...withoutRevision } = valid
    expect(decodeGoalReadoutData(withoutRevision)).toBeNull()
  })

  test("red-on-injection: a partial checked criterion is rejected", () => {
    const partial = structuredClone(valid) as Record<string, unknown>
    const objective = partial.objective as { criteria: Record<string, unknown>[] }
    delete (objective.criteria[0]?.check as Record<string, unknown>).successExitCodes
    expect(decodeGoalReadoutData(partial)).toBeNull()
  })
})
