import { describe, expect, test } from "bun:test"
import { type AdmissibilityWaveAOptions, runAdmissibilityGate } from "@/agent/admissibility-gate"
import {
  type ApprovalDecision,
  OutcomeInvariantError,
  type ReviewerPort,
  ReviewerUnavailableError,
} from "@/permission"
import { ToolRegistry } from "@/tool"
import {
  actionOf,
  bashSchema,
  call,
  cfg,
  decision,
  loadedStore,
  makePort,
  makeTool,
} from "./_fixtures"

describe("Wave A: ReviewerPort dispatch on HITL always-confirm", () => {
  const dangerous = makeTool("dangerous", {
    readOnly: false,
    hitlTier: () => "always-confirm",
  })

  // 3.A — admissible outcomes for each reviewer (admit path)

  test("reviewer=user, outcome=user_approved → admit", async () => {
    let callCount = 0
    const port = makePort({
      userReview: async () => {
        callCount += 1
        return decision("user", "user_approved")
      },
    })
    const wave: AdmissibilityWaveAOptions = {
      reviewerPort: port,
      defaultReviewer: "user",
      decidedAt: () => 12345,
    }
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      wave,
    )
    expect(res).toBeNull()
    expect(callCount).toBe(1)
  })

  test("reviewer=user, outcome=user_approved_for_session → admit", async () => {
    const port = makePort({
      userReview: async () => decision("user", "user_approved_for_session"),
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 },
    )
    expect(res).toBeNull()
  })

  test("reviewer=user, outcome=not_needed → admit", async () => {
    const port = makePort({ userReview: async () => decision("user", "not_needed") })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 },
    )
    expect(res).toBeNull()
  })

  test("reviewer=user, outcome=user_denied → terminal deny (reviewer_user tag)", async () => {
    const port = makePort({ userReview: async () => decision("user", "user_denied") })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 },
    )
    expect(res?.preview).toBe("reviewer_user")
    expect(res?.block.content).toContain("User declined")
    expect(res?.block.content).toContain("rendered user_denied")
  })

  test("reviewer=user, outcome=user_aborted → terminal deny with handoff suffix", async () => {
    const port = makePort({ userReview: async () => decision("user", "user_aborted") })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 },
    )
    expect(res?.preview).toBe("reviewer_user")
    expect(res?.block.content).toContain("User aborted")
    expect(res?.block.content).toContain("cannot proceed without explicit human takeover")
  })

  test("reviewer=auto_review, outcome=config_allowed → admit (reviewer_auto)", async () => {
    let called = false
    const port = makePort({
      autoReview: async () => {
        called = true
        return decision("auto_review", "config_allowed")
      },
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "auto_review", decidedAt: () => 1 },
    )
    expect(called).toBe(true)
    expect(res).toBeNull()
  })

  test("reviewer=auto_review, outcome=not_needed → admit", async () => {
    const port = makePort({
      autoReview: async () => decision("auto_review", "not_needed"),
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "auto_review", decidedAt: () => 1 },
    )
    expect(res).toBeNull()
  })

  test("reviewer=guardian_subagent, outcome=guardian_approved → admit", async () => {
    const port = makePort({
      guardianReview: async () => decision("guardian_subagent", "guardian_approved"),
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "guardian_subagent", decidedAt: () => 1 },
    )
    expect(res).toBeNull()
  })

  test("reviewer=guardian_subagent, outcome=guardian_denied → deny (reviewer_guardian)", async () => {
    const port = makePort({
      guardianReview: async () => decision("guardian_subagent", "guardian_denied"),
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "guardian_subagent", decidedAt: () => 1 },
    )
    expect(res?.preview).toBe("reviewer_guardian")
    expect(res?.block.content).toContain("Guardian denied")
  })

  test("defaultReviewer omitted → falls back to 'user'", async () => {
    let userCalled = false
    let autoCalled = false
    const port = makePort({
      userReview: async () => {
        userCalled = true
        return decision("user", "user_approved")
      },
      autoReview: async () => {
        autoCalled = true
        return decision("auto_review", "config_allowed")
      },
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port },
    )
    expect(userCalled).toBe(true)
    expect(autoCalled).toBe(false)
    expect(res).toBeNull()
  })

  test("ReviewerPort method missing → ReviewerUnavailableError propagates", async () => {
    // port has only guardianReview wired but defaultReviewer asks for "auto_review"
    const partialPort = {
      guardianReview: async () => decision("guardian_subagent", "guardian_approved"),
    } as unknown as ReviewerPort
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    await expect(
      runAdmissibilityGate(
        call("dangerous"),
        c,
        { mode: "bypass" },
        actionOf(dangerous),
        undefined,
        { reviewerPort: partialPort, defaultReviewer: "auto_review", decidedAt: () => 1 },
      ),
    ).rejects.toBeInstanceOf(ReviewerUnavailableError)
  })

  test("port throw propagates (no silent catch)", async () => {
    class CustomError extends Error {}
    const port = makePort({
      userReview: async () => {
        throw new CustomError("kaboom")
      },
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    await expect(
      runAdmissibilityGate(
        call("dangerous"),
        c,
        { mode: "bypass" },
        actionOf(dangerous),
        undefined,
        { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 },
      ),
    ).rejects.toBeInstanceOf(CustomError)
  })

  test("invariant violation (auto_review denying) surfaces OutcomeInvariantError", async () => {
    // auto_review CANNOT deny per the invariant matrix; the port returning
    // a guardian_denied for an auto_review tier triggers OutcomeInvariantError
    // inside reviewAction.
    const port = makePort({
      autoReview: async () =>
        ({
          reviewer: "auto_review",
          outcome: "guardian_denied",
          riskLevel: "high",
          rationale: "violates matrix",
          decidedAt: 1,
        }) as ApprovalDecision,
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    await expect(
      runAdmissibilityGate(
        call("dangerous"),
        c,
        { mode: "bypass" },
        actionOf(dangerous),
        undefined,
        { reviewerPort: port, defaultReviewer: "auto_review", decidedAt: () => 1 },
      ),
    ).rejects.toBeInstanceOf(OutcomeInvariantError)
  })

  test("HITL pre-approval-ok tier does NOT trigger reviewer (only always-confirm does)", async () => {
    const pre = makeTool("pre", {
      readOnly: false,
      hitlTier: () => "pre-approval-ok",
    })
    let called = false
    const port = makePort({
      userReview: async () => {
        called = true
        return decision("user", "user_approved")
      },
    })
    const c = cfg({
      registry: new ToolRegistry([pre]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("pre"),
      c,
      { mode: "bypass" },
      actionOf(pre),
      undefined,
      { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 },
    )
    // pre-approval-ok falls through to mode policy → bypass admits.
    expect(called).toBe(false)
    expect(res).toBeNull()
  })
})

// ─── 4. RulesStore + ReviewerPort (rule ask → reviewer escalate) ──────────

describe("Wave A: rule 'ask' escalates to ReviewerPort", () => {
  const bash = makeTool("bash", {
    readOnly: false,
    schema: bashSchema,
    extractShellCommand: (input) => (input as { command: string }).command,
  })

  test("rule ask + reviewer approves → admit (reviewer route observable via decided_by)", async () => {
    let invoked = false
    const port = makePort({
      userReview: async () => {
        invoked = true
        return decision("user", "user_approved")
      },
    })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("ask git push\n"),
      reviewerPort: port,
      defaultReviewer: "user",
      decidedAt: () => 1,
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "default" },
    })
    const input = { command: "git push origin main" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "default" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(invoked).toBe(true)
    expect(res).toBeNull()
  })

  test("rule ask + reviewer denies → deny tagged reviewer_user", async () => {
    const port = makePort({
      userReview: async () => decision("user", "user_denied"),
    })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("ask git push\n"),
      reviewerPort: port,
      defaultReviewer: "user",
      decidedAt: () => 1,
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "bypass" },
    })
    const input = { command: "git push" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res?.preview).toBe("reviewer_user")
    expect(res?.block.content).toContain("User declined")
    expect(res?.block.content).toContain("origin=rule")
  })

  test("rule ask + guardian denies → reviewer_guardian tag", async () => {
    const port = makePort({
      guardianReview: async () => decision("guardian_subagent", "guardian_denied"),
    })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("ask git push\n"),
      reviewerPort: port,
      defaultReviewer: "guardian_subagent",
      decidedAt: () => 1,
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "bypass" },
    })
    const input = { command: "git push" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res?.preview).toBe("reviewer_guardian")
    expect(res?.block.content).toContain("origin=rule")
  })

  test("rule allow short-circuits BEFORE reviewer (reviewer never called)", async () => {
    let invoked = false
    const port = makePort({
      userReview: async () => {
        invoked = true
        return decision("user", "user_denied")
      },
    })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow git status\n"),
      reviewerPort: port,
      defaultReviewer: "user",
      decidedAt: () => 1,
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "default" },
    })
    const input = { command: "git status" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "default" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(invoked).toBe(false)
    expect(res).toBeNull()
  })

  test("rule deny short-circuits BEFORE reviewer", async () => {
    let invoked = false
    const port = makePort({
      userReview: async () => {
        invoked = true
        return decision("user", "user_approved")
      },
    })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("deny git push\n"),
      reviewerPort: port,
      defaultReviewer: "user",
      decidedAt: () => 1,
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "bypass" },
    })
    const input = { command: "git push" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(invoked).toBe(false)
    expect(res?.preview).toBe("rule_deny")
  })
})

// ─── 5. Sticky priorDenials precedence ────────────────────────────────────
