/**
 * ADR-0413 Part 1 — AgentConfig slot promotion hellgate.
 *
 * Wave-3 parked `runLedger` + `approvalStateMachine` on the observability-wire
 * handle because AgentConfig had no slot. This pins that the two slots now
 * exist as first-class optional AgentConfig fields (reachable by surface
 * consumers), are optional (default-OFF byte-identical), and are typed to the
 * Wave-1/2 ports.
 */
import { describe, expect, test } from "bun:test"
import { createApprovalStateMachine } from "@/agent/approval-state-machine"
import { createObjectiveStore } from "@/agent/objective"
import { createRunLedger } from "@/agent/run-ledger"
import type { AgentConfig } from "@/agent/types"

describe("ADR-0413 AgentConfig observability slots", () => {
  test("[1] runLedger slot accepts a RunLedgerPort + is readable", () => {
    const ledger = createRunLedger()
    const cfg: Pick<AgentConfig, "runLedger"> = { runLedger: ledger }
    expect(cfg.runLedger).toBe(ledger)
    cfg.runLedger?.start({ id: "r1", kind: "shell", owner: "t1", title: "echo hi" })
    expect(cfg.runLedger?.get("r1")?.status).toBe("running")
  })

  test("[2] approvalStateMachine slot accepts an ApprovalStateMachinePort", () => {
    const asm = createApprovalStateMachine()
    const cfg: Pick<AgentConfig, "approvalStateMachine"> = { approvalStateMachine: asm }
    expect(cfg.approvalStateMachine).toBe(asm)
    const req = cfg.approvalStateMachine?.request({
      threadId: "t1",
      kind: "permission",
      reason: "writes outside cwd",
      proposedAction: "rm build/",
      resumeStep: "step-3",
    })
    expect(req?.status).toBe("pending")
  })

  test("[3] both slots optional ⇒ empty config is valid (default-OFF byte-identical)", () => {
    const cfg: Pick<AgentConfig, "runLedger" | "approvalStateMachine" | "objective"> = {}
    expect(cfg.runLedger).toBeUndefined()
    expect(cfg.approvalStateMachine).toBeUndefined()
    expect(cfg.objective).toBeUndefined()
  })

  test("[4] approvalStateMachine can attribute to objective + runLedger via shared slots", () => {
    const objective = createObjectiveStore()
    const ledger = createRunLedger()
    const asm = createApprovalStateMachine({ objective, ledger })
    objective.set("t1", { goal: "ship feature" })
    const cfg: Pick<AgentConfig, "objective" | "runLedger" | "approvalStateMachine"> = {
      objective,
      runLedger: ledger,
      approvalStateMachine: asm,
    }
    cfg.approvalStateMachine?.request({
      threadId: "t1",
      kind: "permission",
      reason: "needs approval",
      proposedAction: "deploy",
      resumeStep: "deploy-step",
    })
    // attribution recorded a blocker on the shared objective slot
    expect(cfg.objective?.get("t1")?.blockers.length).toBeGreaterThanOrEqual(1)
    expect(cfg.objective?.get("t1")?.status).toBe("blocked")
  })
})
