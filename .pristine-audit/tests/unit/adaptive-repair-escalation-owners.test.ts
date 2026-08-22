import { describe, expect, test } from "bun:test"
import {
  adaptiveRepairEscalationOwners,
  maybeRunRepairEscalationFollowup,
  repairEscalationFollowupOwners,
} from "@/runner/batch/eval/driver"

describe("adaptiveRepairEscalationOwners", () => {
  test("returns sibling widen owners when repair-capable posture leaves the primary rail red", () => {
    const owners = adaptiveRepairEscalationOwners({
      prepared: {
        posture: { repairEscalation: true } as never,
        closureSession: {
          bundle: {
            evidence: {
              candidates: [
                { file: "base.py", score: 5, sources: ["stage1", "issue-file"] },
                { file: "pg.py", score: 4, sources: ["owner-resolve"] },
              ],
            },
          },
          primaryRailStep: undefined,
        } as never,
        ownerResolved: [{ file: "pg.py", forSymbol: "runshell" }],
        primaryRailStep: { kind: "owner-test", command: "pytest x" } as never,
      },
      phase: { validated: false, primaryFalseGreen: false },
    })
    expect(owners).toEqual(["base.py", "pg.py"])
  })

  test("returns empty when the red-after-repair condition is absent", () => {
    const owners = adaptiveRepairEscalationOwners({
      prepared: {
        posture: { repairEscalation: true } as never,
        closureSession: {
          bundle: {
            evidence: {
              candidates: [{ file: "base.py", score: 5, sources: ["stage1", "issue-file"] }],
            },
          },
          primaryRailStep: undefined,
        } as never,
        ownerResolved: [{ file: "pg.py", forSymbol: "runshell" }],
        primaryRailStep: { kind: "owner-test", command: "pytest x" } as never,
      },
      phase: { validated: true, primaryFalseGreen: false },
    })
    expect(owners).toEqual([])
  })
})

describe("repairEscalationFollowupOwners", () => {
  test("drops owners already present in the current localized seed set", () => {
    const owners = repairEscalationFollowupOwners({
      prepared: {
        localizeCandidates: ["base.py"],
        posture: { repairEscalation: true } as never,
        closureSession: {
          bundle: {
            evidence: {
              candidates: [
                { file: "base.py", score: 5, sources: ["stage1", "issue-file"] },
                { file: "pg.py", score: 4, sources: ["owner-resolve"] },
              ],
            },
          },
        } as never,
        ownerResolved: [{ file: "pg.py", forSymbol: "runshell" }],
        primaryRailStep: { kind: "owner-test", command: "pytest x" } as never,
      },
      phase: { validated: false, primaryFalseGreen: false },
    })
    expect(owners).toEqual(["pg.py"])
  })
})

describe("maybeRunRepairEscalationFollowup", () => {
  test("reruns one bounded pass when repair escalation exposes a new owner seed", async () => {
    const nextPrepared = {
      localizeCandidates: ["base.py", "pg.py"],
      posture: { repairEscalation: true } as never,
      state: { preset: "x" },
      reproTest: { installed: true },
    } as never
    let seenWidenedOwners: readonly string[] | undefined
    let phaseRuns = 0
    const result = await maybeRunRepairEscalationFollowup<{
      patch: string
      validated: boolean
      primaryFalseGreen: boolean
    }>({
      instance: {} as never,
      deps: {} as never,
      sandbox: "/tmp/sandbox",
      signal: new AbortController().signal,
      prepared: {
        localizeCandidates: ["base.py"],
        posture: { repairEscalation: true } as never,
        state: { preset: "x" } as never,
        closureSession: {
          bundle: {
            evidence: {
              candidates: [
                { file: "base.py", score: 5, sources: ["stage1", "issue-file"] },
                { file: "pg.py", score: 4, sources: ["owner-resolve"] },
              ],
            },
          },
        } as never,
        ownerResolved: [{ file: "pg.py", forSymbol: "runshell" }],
        primaryRailStep: { kind: "owner-test", command: "pytest x" } as never,
      } as never,
      phase: {
        patch: "diff --git a/base.py b/base.py",
        validated: false,
        primaryFalseGreen: false,
      },
      prepare: async (_instance, _sandbox, _deps, _signal, _posture, _state, widenedOwners) => {
        seenWidenedOwners = widenedOwners
        return nextPrepared
      },
      runPhase: async (prepared) => {
        phaseRuns += 1
        expect(prepared).toBe(nextPrepared)
        return {
          patch: "diff --git a/pg.py b/pg.py",
          validated: true,
          primaryFalseGreen: false,
        }
      },
    })
    expect(seenWidenedOwners).toEqual(["pg.py"])
    expect(phaseRuns).toBe(1)
    expect(result.reran).toBe(true)
    expect(result.telemetry).toEqual({
      owners: ["pg.py"],
      sources: ["repair_escalation"],
      path: "single_pass_followup",
    })
    expect(result.prepared).toBe(nextPrepared)
    expect(result.phase.patch).toContain("pg.py")
  })

  test("skips the follow-up pass when escalation contributes no new localized owner", async () => {
    let phaseRuns = 0
    const prepared = {
      localizeCandidates: ["base.py", "pg.py"],
      posture: { repairEscalation: true } as never,
      state: { preset: "x" } as never,
      closureSession: {
        bundle: {
          evidence: {
            candidates: [
              { file: "base.py", score: 5, sources: ["stage1", "issue-file"] },
              { file: "pg.py", score: 4, sources: ["owner-resolve"] },
            ],
          },
        },
      } as never,
      ownerResolved: [{ file: "pg.py", forSymbol: "runshell" }],
      primaryRailStep: { kind: "owner-test", command: "pytest x" } as never,
    } as never
    const phase = {
      patch: "diff --git a/base.py b/base.py",
      validated: false,
      primaryFalseGreen: false,
    }
    const result = await maybeRunRepairEscalationFollowup({
      instance: {} as never,
      deps: {} as never,
      sandbox: "/tmp/sandbox",
      signal: new AbortController().signal,
      prepared,
      phase,
      prepare: async () => {
        throw new Error("prepare should not run")
      },
      runPhase: async () => {
        phaseRuns += 1
        return phase
      },
    })
    expect(phaseRuns).toBe(0)
    expect(result.reran).toBe(false)
    expect(result.telemetry).toBeUndefined()
    expect(result.prepared).toBe(prepared)
    expect(result.phase).toBe(phase)
    expect(result.widenedOwners).toEqual([])
  })
})
