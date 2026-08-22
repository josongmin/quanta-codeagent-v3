/**
 * Hellgate — guardian per-action TYPED assessment collapse (ADR-0497,
 * jun-7-misc 03).
 *
 * The collapse (`collapseAssessment`) is the SINGLE BOUNDARY between the richer
 * typed `ActionAssessment` and the legacy 8-state `ApprovalDecision`. Its
 * correctness is the load-bearing safety invariant: the collapse must be TOTAL
 * and CONSERVATIVE — only `allow` / `allow_for_session` may collapse to an allow
 * outcome; every other variant (and any unknown/future kind) collapses to AT
 * LEAST a deny, NEVER a silent allow.
 *
 * RED-ON-INJECTION: if the collapse is loosened so a deny/ask/edit/escalate
 * variant collapses to an allow outcome, or an unknown kind collapses to allow,
 * these assertions fail. Likewise the OFF-path byte-identity ratchet fails if
 * the knob-gated branch fires absent the knob.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type ActionAssessment,
  ALL_ASSESSMENT_KINDS,
  buildDecision,
  collapseAssessment,
  isAllowed,
  OutcomeInvariantError,
  type ReviewContext,
  type ReviewerPort,
  ReviewerUnavailableError,
  reviewAction,
  structuredDenyReason,
  type ToolActionKeyed,
} from "@/permission"
import { __resetRuntimeConfig } from "@/shared"

const DECIDED_AT = 1_700_000_000_000

const ctx = (overrides: Partial<ReviewContext> = {}): ReviewContext => ({
  sessionId: "s1",
  turnId: "t1",
  priorDenials: [],
  configReviewer: "guardian_subagent",
  decidedAt: DECIDED_AT,
  reviewKind: "terminal",
  ...overrides,
})

const action: ToolActionKeyed = {
  tool: "bash",
  input: { command: "rm -rf /" },
  isReadOnly: false,
  actionKey: "bash:rm",
}

const denyR = structuredDenyReason({ layer: "reviewer", pillar: "approval", safeReason: "unsafe" })

const sampleFor = (kind: ActionAssessment["kind"]): ActionAssessment => {
  switch (kind) {
    case "allow":
      return { kind: "allow", rationale: "fine", riskLevel: "low" }
    case "allow_for_session":
      return { kind: "allow_for_session", rationale: "fine all session" }
    case "allow_with_edit":
      return {
        kind: "allow_with_edit",
        rationale: "use --force-with-lease",
        updatedInput: { command: "git push --force-with-lease" },
        steer: "use --force-with-lease instead of --force",
      }
    case "ask":
      return { kind: "ask", rationale: "uncertain" }
    case "deny":
      return { kind: "deny", rationale: "no", denyReason: denyR }
    case "deny_and_steer":
      return { kind: "deny_and_steer", rationale: "no", denyReason: denyR, steer: "try X" }
    case "escalate":
      return { kind: "escalate", rationale: "needs grant", escalation: { axis: "sandbox" } }
  }
}

describe("collapseAssessment — per-variant routing", () => {
  test("allow ⇒ guardian_approved (allowed)", () => {
    const d = collapseAssessment(sampleFor("allow"), DECIDED_AT)
    expect(d.outcome).toBe("guardian_approved")
    expect(d.reviewer).toBe("guardian_subagent")
    expect(isAllowed(d.outcome)).toBe(true)
    expect(d.riskLevel).toBe("low")
  })

  test("allow_for_session ⇒ one-shot guardian_approved (NOT session-wide)", () => {
    const d = collapseAssessment(sampleFor("allow_for_session"), DECIDED_AT)
    // CONSERVATIVE: a machine assessor never silently widens authority to the
    // session scope. It collapses to a one-shot guardian_approved, never
    // user_approved_for_session.
    expect(d.outcome).toBe("guardian_approved")
    expect(d.outcome).not.toBe("user_approved_for_session")
  })

  test("allow_with_edit ⇒ guardian_denied + steer (original NEVER runs)", () => {
    const d = collapseAssessment(sampleFor("allow_with_edit"), DECIDED_AT)
    // The corrected input is a counter-proposal; until a reviewer→executor
    // input-mutation hop exists, the only safe collapse is a steered deny.
    expect(d.outcome).toBe("guardian_denied")
    expect(isAllowed(d.outcome)).toBe(false)
    expect(d.verb).toEqual({
      verb: "reject_and_tell",
      message: "use --force-with-lease instead of --force",
    })
  })

  test("ask ⇒ deny floor (never a silent allow)", () => {
    const d = collapseAssessment(sampleFor("ask"), DECIDED_AT)
    expect(isAllowed(d.outcome)).toBe(false)
    expect(d.verb?.verb).toBe("reject_and_tell")
  })

  test("deny ⇒ guardian_denied", () => {
    const d = collapseAssessment(sampleFor("deny"), DECIDED_AT)
    expect(d.outcome).toBe("guardian_denied")
    expect(d.verb).toBeUndefined()
  })

  test("deny_and_steer ⇒ guardian_denied + reject_and_tell", () => {
    const d = collapseAssessment(sampleFor("deny_and_steer"), DECIDED_AT)
    expect(d.outcome).toBe("guardian_denied")
    expect(d.verb).toEqual({ verb: "reject_and_tell", message: "try X" })
  })

  test("escalate ⇒ deny floor (never auto-grant)", () => {
    const d = collapseAssessment(sampleFor("escalate"), DECIDED_AT)
    expect(isAllowed(d.outcome)).toBe(false)
    expect(d.verb?.verb).toBe("reject_and_tell")
  })
})

describe("collapseAssessment — conservative property (the security claim)", () => {
  test("ONLY allow/allow_for_session collapse to an allow outcome", () => {
    for (const kind of ALL_ASSESSMENT_KINDS) {
      const d = collapseAssessment(sampleFor(kind), DECIDED_AT)
      const expectedAllow = kind === "allow" || kind === "allow_for_session"
      expect(isAllowed(d.outcome)).toBe(expectedAllow)
    }
  })

  test("decidedAt is threaded verbatim (pure — no wall clock)", () => {
    for (const kind of ALL_ASSESSMENT_KINDS) {
      const d = collapseAssessment(sampleFor(kind), 42)
      expect(d.decidedAt).toBe(42)
    }
  })
})

describe("collapseAssessment — tuple exhaustiveness (drift guard)", () => {
  test("ALL_ASSESSMENT_KINDS covers EVERY constructible kind (no silently-untested variant)", () => {
    // The conservative-property test iterates ALL_ASSESSMENT_KINDS. If a new
    // union member were added without listing it here, that member would never
    // be exercised by the security property — a silent drift. `sampleFor` is a
    // total switch over the union (no default), so it only compiles when every
    // kind has a builder; this asserts the runtime tuple is in lockstep by
    // round-tripping every listed kind through sampleFor + collapse.
    const seen = new Set<string>()
    for (const kind of ALL_ASSESSMENT_KINDS) {
      const a = sampleFor(kind)
      expect(a.kind).toBe(kind)
      seen.add(kind)
      // every kind must collapse without throwing and yield a guardian-tier
      // decision (never a foreign reviewer that would dodge the matrix).
      const d = collapseAssessment(a, DECIDED_AT)
      expect(d.reviewer).toBe("guardian_subagent")
    }
    // Pin the count so adding a union member without a tuple entry (the compile
    // guard `_assessmentKindsExhaustive`) is ALSO caught here as a fast-fail.
    expect(seen.size).toBe(7)
    const kindCount: number = ALL_ASSESSMENT_KINDS.length
    expect(kindCount).toBe(seen.size)
  })
})

describe("collapseAssessment — allow_with_edit never executes original (hardening)", () => {
  test("even with an aggressive/empty updatedInput, the collapse is a NON-allow deny", () => {
    for (const updatedInput of [
      { command: "rm -rf /" },
      {},
      null,
      undefined,
      "rm -rf --no-preserve-root /",
    ]) {
      const a: ActionAssessment = {
        kind: "allow_with_edit",
        rationale: "edit",
        updatedInput,
        steer: "use a safer form",
      }
      const d = collapseAssessment(a, DECIDED_AT)
      expect(d.outcome).toBe("guardian_denied")
      expect(isAllowed(d.outcome)).toBe(false)
      // The verb carries ONLY the steer string — never the updatedInput payload,
      // so the original/edited command can never be threaded as an allow.
      expect(d.verb).toEqual({ verb: "reject_and_tell", message: "use a safer form" })
    }
  })
})

describe("collapseAssessment — allow_with_edit with MISSING/undefined updatedInput is STILL a non-allow (R4: L3→L4 future-hop guard)", () => {
  // §5 trap: "allow_with_edit never degrades to allow-original". The decoder's
  // `updatedInput: z.unknown()` does NOT require the key to be present, so a
  // model reply that names `allow_with_edit` but omits `updatedInput` decodes to
  // an assessment whose `updatedInput` is `undefined`. TODAY the conservative
  // collapse saves it (steered deny). But the spec describes a future
  // reviewer→executor input-mutation hop that WOULD thread `updatedInput` to the
  // executor; if that hop is added and someone threads an `undefined` edit, the
  // ORIGINAL (un-edited) action would run under an "allow" — exactly the §5
  // worst case. This pins the invariant at the collapse boundary so the future
  // hop CANNOT make a missing-edit allow_with_edit collapse to an allow without
  // first turning this test RED. (Red-on-injection: change the collapse to
  // approve allow_with_edit and this fails.)
  test("undefined updatedInput ⇒ guardian_denied (never allow-original)", () => {
    const a = {
      kind: "allow_with_edit",
      rationale: "fix it",
      updatedInput: undefined,
      steer: "use the safer form",
    } as ActionAssessment
    const d = collapseAssessment(a, DECIDED_AT)
    expect(d.outcome).toBe("guardian_denied")
    expect(isAllowed(d.outcome)).toBe(false)
    // The verb carries ONLY the steer — never any input payload.
    expect(d.verb).toEqual({ verb: "reject_and_tell", message: "use the safer form" })
  })

  test("entirely-absent updatedInput key ⇒ guardian_denied (no allow-original)", () => {
    const a = {
      kind: "allow_with_edit",
      rationale: "fix",
      steer: "safer",
    } as unknown as ActionAssessment
    const d = collapseAssessment(a, DECIDED_AT)
    expect(isAllowed(d.outcome)).toBe(false)
    expect(d.outcome).toBe("guardian_denied")
  })
})

describe("reviewAction — knob-ON collapse threads ctx.decidedAt provenance (R4 hardening)", () => {
  const originalGate = process.env.QUANTA_GUARDIAN_ASSESSOR
  beforeEach(() => {
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (originalGate === undefined) delete process.env.QUANTA_GUARDIAN_ASSESSOR
    else process.env.QUANTA_GUARDIAN_ASSESSOR = originalGate
    __resetRuntimeConfig()
  })

  test("the collapsed decision carries the SAME decidedAt the context supplied (deterministic clock, no drift)", async () => {
    process.env.QUANTA_GUARDIAN_ASSESSOR = "1"
    __resetRuntimeConfig()
    const customClock = 1_700_123_456_789
    const port: ReviewerPort = {
      userReview: async () => {
        throw new Error("unused")
      },
      autoReview: async () => {
        throw new Error("unused")
      },
      guardianReview: async () => {
        throw new Error("binary path must NOT run when assessor services the tier")
      },
      // assessor uses a DIFFERENT decidedAt internally to prove the collapse uses
      // ctx.decidedAt (caller-threaded), not whatever the assessment carried.
      guardianAssess: async () => ({ kind: "deny", rationale: "no", denyReason: denyR }),
    }
    const dec = await reviewAction(action, ctx({ decidedAt: customClock }), port)
    expect(dec.decidedAt).toBe(customClock)
    expect(dec.outcome).toBe("guardian_denied")
  })
})

describe("collapseAssessment — buildDecision second line rejects malformed assessment", () => {
  test("an empty-rationale allow THROWS (never a silent allow with no audit trail)", () => {
    // A hand-built / malformed-but-typed assessment with an empty rationale must
    // NOT collapse to a quiet allow — buildDecision's rationale invariant fires.
    const a = { kind: "allow", rationale: "", riskLevel: "low" } as ActionAssessment
    expect(() => collapseAssessment(a, DECIDED_AT)).toThrow(OutcomeInvariantError)
  })

  test("a non-integer decidedAt THROWS (deterministic-clock invariant holds post-collapse)", () => {
    expect(() => collapseAssessment(sampleFor("allow"), 1.5)).toThrow(OutcomeInvariantError)
  })
})

describe("collapseAssessment — unknown/future variant ⇒ fail-closed (red-on-injection)", () => {
  test("a kind outside the union collapses to guardian_denied, NEVER allow", () => {
    // Simulate a version-skew / malformed-but-typed reply that slipped past the
    // compile-time `never` guard at runtime.
    const rogue = {
      kind: "auto_grant_everything",
      rationale: "trust me",
    } as unknown as ActionAssessment
    const d = collapseAssessment(rogue, DECIDED_AT)
    expect(d.outcome).toBe("guardian_denied")
    expect(isAllowed(d.outcome)).toBe(false)
  })
})

describe("collapseAssessment — KNOWN kind with malformed body ⇒ fail-closed, NEVER throws (R3 red-on-injection)", () => {
  // The unknown-KIND default arm handles a wrong discriminant. But a KNOWN kind
  // whose required body field is missing at runtime (version skew, a loosely
  // decoded reply, a hand-built malformed-but-typed value) is the §5
  // "malformed-but-typed" case: it must ALSO fall to the most-restrictive
  // outcome (`guardian_denied`), NEVER raise an uncaught TypeError. A raw throw
  // is neither a clean deny nor a silent allow — it crashes the turn (a DoS /
  // availability hole) and escapes the documented fail-closed contract. These
  // assertions go RED if the collapse dereferences a missing field blindly.

  test("escalate MISSING escalation ⇒ guardian_denied (no TypeError on .escalation.axis)", () => {
    const rogue = { kind: "escalate", rationale: "x" } as unknown as ActionAssessment
    let threw = false
    let d: ReturnType<typeof collapseAssessment> | undefined
    try {
      d = collapseAssessment(rogue, DECIDED_AT)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(d?.outcome).toBe("guardian_denied")
    expect(isAllowed(d?.outcome ?? "guardian_denied")).toBe(false)
  })

  test("escalate with escalation but MISSING axis ⇒ guardian_denied (no undefined in steer)", () => {
    const rogue = {
      kind: "escalate",
      rationale: "x",
      escalation: {},
    } as unknown as ActionAssessment
    const d = collapseAssessment(rogue, DECIDED_AT)
    expect(d.outcome).toBe("guardian_denied")
    expect(isAllowed(d.outcome)).toBe(false)
    // The steer, if present, must be a well-formed string — never carry the
    // literal "undefined" produced by interpolating a missing axis.
    if (d.verb?.verb === "reject_and_tell") {
      expect(d.verb.message).not.toContain("undefined")
      expect(typeof d.verb.message).toBe("string")
    }
  })

  test("deny_and_steer MISSING steer ⇒ guardian_denied with a STRING verb message (never undefined)", () => {
    const rogue = {
      kind: "deny_and_steer",
      rationale: "x",
      denyReason: denyR,
    } as unknown as ActionAssessment
    const d = collapseAssessment(rogue, DECIDED_AT)
    expect(d.outcome).toBe("guardian_denied")
    expect(isAllowed(d.outcome)).toBe(false)
    // reject_and_tell's contract is `message: string`. A missing steer must NOT
    // produce `{verb:"reject_and_tell"}` with an undefined message (a malformed
    // verb the steering seam would render as the literal "undefined").
    if (d.verb !== undefined) {
      expect(d.verb.verb).toBe("reject_and_tell")
      if (d.verb.verb === "reject_and_tell") {
        expect(typeof d.verb.message).toBe("string")
        expect(d.verb.message.length).toBeGreaterThan(0)
      }
    }
  })

  test("allow_with_edit MISSING steer ⇒ guardian_denied (original NEVER runs) with a STRING verb message", () => {
    const rogue = {
      kind: "allow_with_edit",
      rationale: "x",
      updatedInput: { command: "rm -rf /" },
    } as unknown as ActionAssessment
    const d = collapseAssessment(rogue, DECIDED_AT)
    expect(d.outcome).toBe("guardian_denied")
    expect(isAllowed(d.outcome)).toBe(false)
    if (d.verb !== undefined && d.verb.verb === "reject_and_tell") {
      expect(typeof d.verb.message).toBe("string")
      expect(d.verb.message.length).toBeGreaterThan(0)
    }
  })

  test("allow MISSING/invalid riskLevel ⇒ NOT a malformed allow (riskLevel is a valid literal)", () => {
    // An allow whose riskLevel is absent or not one of the three literals must
    // not flow through as an allow carrying an invalid riskLevel. The collapse
    // clamps to a valid literal (the conservative "high"), so the emitted
    // ApprovalDecision is always well-formed.
    for (const bad of [undefined, "critical", "", null, 7]) {
      const rogue = { kind: "allow", rationale: "x", riskLevel: bad } as unknown as ActionAssessment
      const d = collapseAssessment(rogue, DECIDED_AT)
      expect(d.outcome).toBe("guardian_approved")
      expect(["low", "medium", "high"]).toContain(d.riskLevel)
    }
  })
})

describe("collapseAssessment — matrix is the second line of defense", () => {
  test("buildDecision throws OutcomeInvariantError on a (guardian, user_*) pair", () => {
    // Every collapse uses reviewer=guardian_subagent, which the ADMISSIBLE
    // matrix permits only for guardian_*/not_needed. If a future edit made the
    // collapse emit a user_* outcome under guardian_subagent, buildDecision —
    // which the collapse routes through — throws. We assert the invariant
    // directly to pin the second-line guarantee.
    expect(() =>
      buildDecision({
        reviewer: "guardian_subagent",
        outcome: "user_approved_for_session",
        riskLevel: "high",
        rationale: "illegal pair",
        decidedAt: DECIDED_AT,
      }),
    ).toThrow(OutcomeInvariantError)
  })
})

describe("reviewAction dispatch — knob gating (OFF byte-identity ratchet)", () => {
  const originalGate = process.env.QUANTA_GUARDIAN_ASSESSOR

  beforeEach(() => {
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (originalGate === undefined) delete process.env.QUANTA_GUARDIAN_ASSESSOR
    else process.env.QUANTA_GUARDIAN_ASSESSOR = originalGate
    __resetRuntimeConfig()
  })

  const binaryDecision = {
    reviewer: "guardian_subagent" as const,
    outcome: "guardian_denied" as const,
    riskLevel: "high" as const,
    rationale: "binary guardian path",
    decidedAt: DECIDED_AT,
  }

  const makePort = (calls: string[]): ReviewerPort => ({
    userReview: async () => binaryDecision,
    autoReview: async () => binaryDecision,
    guardianReview: async () => {
      calls.push("guardianReview")
      return binaryDecision
    },
    guardianAssess: async () => {
      calls.push("guardianAssess")
      return { kind: "allow", rationale: "assessor allowed", riskLevel: "low" }
    },
  })

  test("knob OFF ⇒ guardianAssess NEVER called; binary guardianReview path runs", async () => {
    delete process.env.QUANTA_GUARDIAN_ASSESSOR
    __resetRuntimeConfig()
    const calls: string[] = []
    const dec = await reviewAction(action, ctx(), makePort(calls))
    expect(calls).toEqual(["guardianReview"])
    expect(dec.outcome).toBe("guardian_denied")
  })

  test("knob loose-truthy (not '1') ⇒ still OFF (strict gate)", async () => {
    process.env.QUANTA_GUARDIAN_ASSESSOR = "true"
    __resetRuntimeConfig()
    const calls: string[] = []
    await reviewAction(action, ctx(), makePort(calls))
    expect(calls).toEqual(["guardianReview"])
  })

  test("knob ON ('1') ⇒ guardianAssess called + collapsed", async () => {
    process.env.QUANTA_GUARDIAN_ASSESSOR = "1"
    __resetRuntimeConfig()
    const calls: string[] = []
    const dec = await reviewAction(action, ctx(), makePort(calls))
    expect(calls).toEqual(["guardianAssess"])
    expect(dec.outcome).toBe("guardian_approved")
  })

  test("knob ON but port lacks guardianAssess ⇒ binary path (byte-identical)", async () => {
    process.env.QUANTA_GUARDIAN_ASSESSOR = "1"
    __resetRuntimeConfig()
    const calls: string[] = []
    const port = makePort(calls)
    // Remove the optional method — every CURRENT port impl omits it.
    delete (port as { guardianAssess?: unknown }).guardianAssess
    const dec = await reviewAction(action, ctx(), port)
    expect(calls).toEqual(["guardianReview"])
    expect(dec.outcome).toBe("guardian_denied")
  })

  test("OutcomeInvariantError is thrown if a collapse produces an illegal pair", () => {
    // Pin the named error import so a refactor that drops it red-flags here.
    expect(OutcomeInvariantError).toBeDefined()
  })

  test("R2 HOLE: knob ON + assessor-ONLY port (no guardianReview) ⇒ assessor SERVICES the tier (not ReviewerUnavailableError)", async () => {
    // A composition that wires the richer guardianAssess as the guardian tier's
    // servicing method MAY legitimately omit the binary guardianReview (the
    // assessor REPLACES it when the knob is on — ticket §4.b option 1). The
    // availability pre-check must recognize guardianAssess as a valid servicer
    // for the guardian tier under the knob; otherwise the seam is structurally
    // un-wireable end-to-end. Fail direction stays closed (the assessor itself is
    // the fail-closed boundary), but it must REACH the assessor, not throw before.
    process.env.QUANTA_GUARDIAN_ASSESSOR = "1"
    __resetRuntimeConfig()
    const calls: string[] = []
    const port: ReviewerPort = {
      userReview: async () => binaryDecision,
      autoReview: async () => binaryDecision,
      // Assessor-only intent: guardianReview is present but MUST NOT be reached
      // (the knob-on assessor path services the guardian tier). It throws so a
      // regression that bypassed the assessor would fail loudly.
      guardianReview: async () => {
        throw new Error("guardianReview must not be called on the assessor path")
      },
      guardianAssess: async () => {
        calls.push("guardianAssess")
        return { kind: "deny", rationale: "no", denyReason: denyR }
      },
    }
    const dec = await reviewAction(action, ctx(), port)
    expect(calls).toEqual(["guardianAssess"])
    expect(dec.outcome).toBe("guardian_denied")
    expect(isAllowed(dec.outcome)).toBe(false)
  })

  test("R2 RATCHET: knob OFF + assessor-only port (no guardianReview) ⇒ STILL ReviewerUnavailableError (no silent allow, OFF byte-identity)", async () => {
    // The inverse safety pin: with the knob OFF, an assessor-only port has NO
    // legacy servicer — the OFF path must NOT silently fall through to the
    // assessor (that would breach OFF byte-identity). It fails closed with
    // ReviewerUnavailableError, exactly as today.
    delete process.env.QUANTA_GUARDIAN_ASSESSOR
    __resetRuntimeConfig()
    // This test REQUIRES guardianReview to be ABSENT at runtime: the OFF-path
    // safety is the `typeof port.guardianReview !== "function"` guard throwing
    // ReviewerUnavailableError. The only way to model a runtime-absent required
    // method is the codebase's established test pattern (see reviewer.test.ts) —
    // `undefined as unknown as` — NOT a bug paper-over but deliberate guard-test infra.
    const port: ReviewerPort = {
      userReview: async () => binaryDecision,
      autoReview: async () => binaryDecision,
      guardianReview: undefined as unknown as ReviewerPort["guardianReview"],
      guardianAssess: async () => ({ kind: "allow", rationale: "x", riskLevel: "low" }),
    }
    await expect(reviewAction(action, ctx(), port)).rejects.toThrow(ReviewerUnavailableError)
  })
})
