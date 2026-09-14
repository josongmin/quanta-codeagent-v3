/**
 * Plan-exit flow tests (ADR-0062 wire-up, absorb #3).
 *
 * Covers the pure async orchestrator that bridges `CollaborationMode`,
 * `buildPlanExit`, and a host-supplied `PlanExitPort`. The flow itself owns
 * NO mutation — it merely asks the port, re-validates the outcome, and
 * returns a typed result the caller acts on via `planExitAllowsMutation` /
 * `planExitStaysInPlan`.
 */

import { describe, expect, test } from "bun:test"
import type { CollaborationMode } from "@/agent/mode"
import {
  type PlanExitOutcome,
  planExitAllowsMutation,
  planExitStaysInPlan,
} from "@/agent/plan-exit"
import {
  PlanExitFlowError,
  type PlanExitFlowResult,
  PlanExitNotInPlanModeError,
  type PlanExitPort,
  PlanExitPortFailedError,
  runPlanExitFlow,
} from "@/agent/plan-exit-flow"

/** Build a port that resolves with a fixed outcome. */
const fixedPort = (outcome: PlanExitOutcome): PlanExitPort => ({
  request: async () => outcome,
})

/** Build a port that rejects with the given error. */
const rejectingPort = (err: unknown): PlanExitPort => ({
  request: async () => {
    throw err
  },
})

describe("runPlanExitFlow — three decisions", () => {
  test("approved ⇒ allows mutation true; stays in plan false; result decision approved", async () => {
    const port = fixedPort({ decision: "approved" })
    const result: PlanExitFlowResult = await runPlanExitFlow("plan", "draft plan", port)
    expect(result.decision).toBe("approved")
    expect("feedback" in result).toBe(false)
    expect(planExitAllowsMutation(result.decision)).toBe(true)
    expect(planExitStaysInPlan(result.decision)).toBe(false)
  })

  // A rejection stays in plan (9f4b864c7): leaving plan means default mode, which admits
  // writes. This arm asserted `false` and went red with that fix; the full unit tier caught
  // it, the targeted runs did not include this file.
  test("rejected ⇒ allows mutation false; stays in plan true", async () => {
    const port = fixedPort({ decision: "rejected" })
    const result = await runPlanExitFlow("plan", "draft plan", port)
    expect(result.decision).toBe("rejected")
    expect("feedback" in result).toBe(false)
    expect(planExitAllowsMutation(result.decision)).toBe(false)
    expect(planExitStaysInPlan(result.decision)).toBe(true)
  })

  test("changes_requested with feedback ⇒ allows mutation false; stays in plan true; feedback propagated", async () => {
    const port = fixedPort({ decision: "changes_requested", feedback: "tighten step 2" })
    const result = await runPlanExitFlow("plan", "draft plan", port)
    expect(result.decision).toBe("changes_requested")
    expect(result.feedback).toBe("tighten step 2")
    expect(planExitAllowsMutation(result.decision)).toBe(false)
    expect(planExitStaysInPlan(result.decision)).toBe(true)
  })
})

describe("runPlanExitFlow — port plumbs the plan text", () => {
  test("the plan string is forwarded verbatim to port.request", async () => {
    const observed: { plan: string | null } = { plan: null }
    const port: PlanExitPort = {
      request: async (plan) => {
        observed.plan = plan
        return { decision: "approved" }
      },
    }
    await runPlanExitFlow("plan", "Step 1: x\nStep 2: y", port)
    expect(observed.plan).toBe("Step 1: x\nStep 2: y")
  })
})

describe("runPlanExitFlow — port-rejection failure mode", () => {
  test("port-throws (Error) ⇒ wrapped as PlanExitPortFailedError; cause preserved", async () => {
    const underlying = new Error("network timeout")
    const port = rejectingPort(underlying)
    try {
      await runPlanExitFlow("plan", "draft", port)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PlanExitPortFailedError)
      const err = e as PlanExitPortFailedError
      expect(err.code).toBe("plan_exit_port_failed")
      expect(err.message).toContain("network timeout")
      expect(err.originalMessage).toBe("network timeout")
      // standard ES2022 `cause` field
      expect((err as { cause?: unknown }).cause).toBe(underlying)
    }
  })

  test("port-rejects (non-Error) ⇒ wrapped as PlanExitPortFailedError; not swallowed", async () => {
    const port = rejectingPort("plain string failure")
    await expect(runPlanExitFlow("plan", "draft", port)).rejects.toBeInstanceOf(
      PlanExitPortFailedError,
    )
  })
})

describe("runPlanExitFlow — port returns an invariant-violating outcome", () => {
  test("approved + feedback ⇒ wrapped as PlanExitPortFailedError (no silent normalization)", async () => {
    // Port forges an `approved` with feedback — the flow must catch this via
    // the buildPlanExit re-validation and surface it as a port failure.
    const badPort: PlanExitPort = {
      // Cast through unknown to bypass the type — simulating a port written in
      // JS or arriving over an untyped boundary.
      request: async () => {
        return { decision: "approved", feedback: "spurious" } as unknown as PlanExitOutcome
      },
    }
    await expect(runPlanExitFlow("plan", "draft", badPort)).rejects.toBeInstanceOf(
      PlanExitPortFailedError,
    )
  })

  test("changes_requested without feedback ⇒ wrapped as PlanExitPortFailedError", async () => {
    const badPort: PlanExitPort = {
      request: async () => {
        return { decision: "changes_requested" } as unknown as PlanExitOutcome
      },
    }
    await expect(runPlanExitFlow("plan", "draft", badPort)).rejects.toBeInstanceOf(
      PlanExitPortFailedError,
    )
  })
})

describe("runPlanExitFlow — preconditions", () => {
  test("absent port (undefined) ⇒ throws PlanExitFlowError; does NOT silently no-op", async () => {
    await expect(runPlanExitFlow("plan", "draft", undefined)).rejects.toBeInstanceOf(
      PlanExitFlowError,
    )
  })

  test("currentMode === 'default' ⇒ throws PlanExitNotInPlanModeError (caller bug)", async () => {
    const port = fixedPort({ decision: "approved" })
    try {
      await runPlanExitFlow("default" as CollaborationMode, "draft", port)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PlanExitNotInPlanModeError)
      const err = e as PlanExitNotInPlanModeError
      expect(err.currentMode).toBe("default")
      expect(err.code).toBe("plan_exit_not_in_plan_mode")
    }
  })

  test("port-failure error code is stable", async () => {
    const port = rejectingPort(new Error("x"))
    try {
      await runPlanExitFlow("plan", "draft", port)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PlanExitPortFailedError)
      expect((e as PlanExitPortFailedError).code).toBe("plan_exit_port_failed")
    }
  })
})

describe("runPlanExitFlow — exactOptionalPropertyTypes shape", () => {
  test("approved result omits the feedback key entirely (never explicit undefined)", async () => {
    const port = fixedPort({ decision: "approved" })
    const result = await runPlanExitFlow("plan", "draft", port)
    expect(Object.hasOwn(result, "feedback")).toBe(false)
  })

  test("rejected result omits the feedback key entirely", async () => {
    const port = fixedPort({ decision: "rejected" })
    const result = await runPlanExitFlow("plan", "draft", port)
    expect(Object.hasOwn(result, "feedback")).toBe(false)
  })

  test("changes_requested result carries the feedback key", async () => {
    const port = fixedPort({ decision: "changes_requested", feedback: "redo step 1" })
    const result = await runPlanExitFlow("plan", "draft", port)
    expect(Object.hasOwn(result, "feedback")).toBe(true)
    expect(result.feedback).toBe("redo step 1")
  })
})
