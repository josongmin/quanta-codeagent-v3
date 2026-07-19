import { describe, expect, test } from "bun:test"
import { type AdmissibilityWaveAOptions, runAdmissibilityGate } from "@/agent/admissibility-gate"
import {
  type DenialMemory,
  OutcomeInvariantError,
  type PermissionContext,
  ReviewerUnavailableError,
  type ToolActionKeyed,
} from "@/permission"
import { RulesStore } from "@/rules"
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

describe("Wave A: priorDenials sticky precedence", () => {
  const dangerous = makeTool("dangerous", {
    readOnly: false,
    hitlTier: () => "always-confirm",
  })

  test("guardian_denied in priorDenials → blocks same actionKey without re-asking", async () => {
    let portCalled = false
    const port = makePort({
      userReview: async () => {
        portCalled = true
        return decision("user", "user_approved")
      },
    })
    const priorDenials: ReadonlyArray<DenialMemory> = [
      {
        sessionId: "s1",
        // ALBB-11 (872b78a56, jul-9): non-shell actionKeys are now
        // `${tool}|#${canonicalInputKey(input)}` — the bare tool name would
        // over-approve every future call, so a discriminator is required. For
        // the `dangerous` call with input `{}` the canonical key is
        // `dangerous|#{}`; a stale bare `"dangerous"` no longer matches and the
        // sticky short-circuit would be silently skipped.
        actionKey: "dangerous|#{}",
        reviewer: "guardian_subagent",
        outcome: "guardian_denied",
        deniedAt: 9000,
      },
    ]
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
      {
        reviewerPort: port,
        defaultReviewer: "user",
        priorDenials,
        decidedAt: () => 1,
      },
    )
    expect(portCalled).toBe(false)
    expect(res?.preview).toBe("reviewer_guardian")
    expect(res?.block.content).toContain("Guardian denied")
  })

  test("user_aborted in priorDenials → terminator wins over guardian_denied", async () => {
    const priorDenials: ReadonlyArray<DenialMemory> = [
      {
        sessionId: "s1",
        // ALBB-11 (872b78a56): canonical non-shell key for `dangerous {}`.
        actionKey: "dangerous|#{}",
        reviewer: "guardian_subagent",
        outcome: "guardian_denied",
        deniedAt: 9000,
      },
      {
        sessionId: "s1",
        actionKey: "dangerous|#{}",
        reviewer: "user",
        outcome: "user_aborted",
        deniedAt: 9500,
      },
    ]
    const port = makePort({
      userReview: async () => decision("user", "user_approved"),
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
      {
        reviewerPort: port,
        defaultReviewer: "user",
        priorDenials,
        decidedAt: () => 1,
      },
    )
    expect(res?.preview).toBe("reviewer_user")
    expect(res?.block.content).toContain("User aborted")
  })

  test("priorDenials with DIFFERENT actionKey does NOT block (reviewer called)", async () => {
    let invoked = false
    const port = makePort({
      userReview: async () => {
        invoked = true
        return decision("user", "user_approved")
      },
    })
    const priorDenials: ReadonlyArray<DenialMemory> = [
      {
        sessionId: "s1",
        actionKey: "OTHER_TOOL", // different key
        reviewer: "guardian_subagent",
        outcome: "guardian_denied",
        deniedAt: 9000,
      },
    ]
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
      {
        reviewerPort: port,
        defaultReviewer: "user",
        priorDenials,
        decidedAt: () => 1,
      },
    )
    expect(invoked).toBe(true)
    expect(res).toBeNull()
  })

  test("sticky precedence applies on RULE ASK path too (actionKey carries shellCommand)", async () => {
    const bash = makeTool("bash", {
      readOnly: false,
      schema: bashSchema,
      extractShellCommand: (input) => (input as { command: string }).command,
    })
    let invoked = false
    const port = makePort({
      userReview: async () => {
        invoked = true
        return decision("user", "user_approved")
      },
    })
    const priorDenials: ReadonlyArray<DenialMemory> = [
      {
        sessionId: "s1",
        actionKey: "bash|git push",
        reviewer: "guardian_subagent",
        outcome: "guardian_denied",
        deniedAt: 9000,
      },
    ]
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("ask git push\n"),
      reviewerPort: port,
      defaultReviewer: "user",
      priorDenials,
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
    expect(res?.preview).toBe("reviewer_guardian")
    expect(res?.block.content).toContain("origin=rule")
  })
})

// ─── 6. HARD_DENY beats every Wave A option ───────────────────────────────

describe("Wave A: HARD_DENY beats every option", () => {
  const bash = makeTool("bash", {
    readOnly: false,
    schema: bashSchema,
    extractShellCommand: (input) => (input as { command: string }).command,
  })

  test("HARD_DENY beats rule allow (rule_allow CANNOT bypass denylist)", async () => {
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow rm\n"),
    }
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res?.preview).toBe("handoff")
    expect(res?.block.content).toContain("human handoff")
    expect(res?.block.content).toContain("Blocked dangerous command")
  })

  test("HARD_DENY beats reviewer approval (port never called)", async () => {
    let invoked = false
    const port = makePort({
      userReview: async () => {
        invoked = true
        return decision("user", "user_approved")
      },
    })
    const wave: AdmissibilityWaveAOptions = {
      reviewerPort: port,
      defaultReviewer: "user",
      decidedAt: () => 1,
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(invoked).toBe(false)
    expect(res?.preview).toBe("handoff")
  })

  test("HARD_DENY beats rule deny (priority — denylist is the security boundary, not the rule)", async () => {
    // Both produce a deny, but HARD_DENY's "handoff" preview must win because
    // it carries the security-boundary semantics (no mode authorizes).
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("deny rm\n"),
    }
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res?.preview).toBe("handoff")
  })

  test("HARD_DENY beats rule no_match strict deny too", async () => {
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow git status\n"),
      noMatchPolicy: "deny",
    }
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res?.preview).toBe("handoff")
  })

  test("mode-block beats HARD_DENY (review mode short-circuits even bash rm)", async () => {
    // Mode-block runs FIRST in the gate; this asserts the canonical ordering
    // is unchanged by Wave A.
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("deny rm\n"),
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      mode: "review",
      permission: { mode: "bypass" },
    })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res?.preview).toBe("review-blocked")
  })
})

// ─── 7. Injected clock determinism ────────────────────────────────────────
