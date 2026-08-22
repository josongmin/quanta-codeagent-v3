/**
 * HELLGATE — 4-pillar permission projection (ADR-0135 `infer*Policy` helpers).
 *
 * The pillar projectors (`inferApprovalPolicy` / `inferNetworkPolicy` /
 * `inferSandboxPolicy` / `inferControlPolicy`) are the security FLOOR: an
 * absent pillar MUST collapse to the strictest frozen default
 * (`once`+promptUser / `deny-all` / readOnly+isolated / audit-off). Anything
 * that lets an absent pillar resolve to a PERMISSIVE value silently widens
 * the gate.
 *
 * `permission-pillars.test.ts` proves the happy path (default + explicit
 * passthrough). This battery is the adversarial complement:
 *
 *   1. PROTOTYPE-POLLUTION BYPASS — a poisoned `Object.prototype.<pillar>`
 *      upstream must NOT leak a permissive pillar into an absent-pillar
 *      profile. (`profile?.approval` reads the prototype chain; the fix reads
 *      own-properties only via `Object.hasOwn`.)
 *   2. FROZEN-DEFAULT TAMPER — the shared default returned for an absent
 *      profile cannot be mutated to poison the NEXT caller.
 *   3. own-`undefined` pillar still collapses to the strict default.
 *   4. genuine own pillars are still honored (no over-correction).
 *
 * RED-ON-INJECTION (teeth, verified in-session): reverting `ownPillar` back to
 * `profile?.[key]` makes case (1) FAIL — the polluted permissive pillar leaks
 * through the prototype chain and the strict-default assertions break.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { PermissionProfile } from "@/permission/permission-profile"
import {
  inferApprovalPolicy,
  inferControlPolicy,
  inferNetworkPolicy,
  inferSandboxPolicy,
} from "@/permission/policy"

const POISON_KEYS = ["approval", "network", "sandbox", "control"] as const

// Always scrub Object.prototype even if an assertion throws mid-test — a
// leaked poison key would silently corrupt every later test in the run.
const scrubPrototype = (): void => {
  for (const k of POISON_KEYS) delete (Object.prototype as Record<string, unknown>)[k]
}
afterEach(scrubPrototype)

describe("HELLGATE: 4-pillar projection — prototype-pollution bypass", () => {
  test("a poisoned Object.prototype CANNOT widen an absent-pillar profile", () => {
    // An attacker (or a buggy recursive-merge sink elsewhere in the process)
    // poisons the prototype with maximally-permissive pillar values.
    ;(Object.prototype as Record<string, unknown>).approval = { mode: "always", promptUser: false }
    ;(Object.prototype as Record<string, unknown>).network = { mode: "allow-all" }
    ;(Object.prototype as Record<string, unknown>).sandbox = {
      osSandbox: "none",
      readOnly: false,
      workspaceWrite: true,
      networkIsolated: false,
    }
    ;(Object.prototype as Record<string, unknown>).control = {
      auditRequired: false,
      managedBy: "admin",
    }

    // A profile with NO own pillar keys — every pillar must fall to the strict
    // default, NOT the poisoned prototype value.
    const emptyProfile = {} as PermissionProfile

    const approval = inferApprovalPolicy(emptyProfile)
    expect(approval.mode).toBe("once") // NOT "always"
    expect(approval.promptUser).toBe(true) // NOT false — the prompt is never suppressed

    expect(inferNetworkPolicy(emptyProfile).mode).toBe("deny-all") // NOT allow-all

    const sandbox = inferSandboxPolicy(emptyProfile)
    expect(sandbox.readOnly).toBe(true) // NOT false
    expect(sandbox.workspaceWrite).toBe(false) // NOT true
    expect(sandbox.networkIsolated).toBe(true) // NOT false

    expect(inferControlPolicy(emptyProfile).auditRequired).toBe(false)
    // control must be the strict frozen default object, never the poisoned one
    expect(
      (inferControlPolicy(emptyProfile) as unknown as Record<string, unknown>).managedBy,
    ).toBeUndefined()
  })

  test("an UNDEFINED profile is equally immune to prototype pollution", () => {
    ;(Object.prototype as Record<string, unknown>).approval = { mode: "always", promptUser: false }
    ;(Object.prototype as Record<string, unknown>).network = { mode: "allow-all" }

    expect(inferApprovalPolicy(undefined).mode).toBe("once")
    expect(inferApprovalPolicy(undefined).promptUser).toBe(true)
    expect(inferNetworkPolicy(undefined).mode).toBe("deny-all")
  })

  test("the sandbox `fallback` still wins over the strict default — but a poisoned proto does NOT", () => {
    ;(Object.prototype as Record<string, unknown>).sandbox = {
      osSandbox: "none",
      readOnly: false,
      workspaceWrite: true,
      networkIsolated: false,
    }
    const fallback = {
      osSandbox: "seatbelt" as const,
      readOnly: false,
      workspaceWrite: true,
      networkIsolated: true,
    }
    // Absent own-sandbox ⇒ caller fallback wins (migration seam preserved),
    // and the poisoned prototype is ignored entirely.
    const got = inferSandboxPolicy({} as PermissionProfile, fallback)
    expect(got.osSandbox).toBe("seatbelt") // the legit fallback, not the poison
    expect(got).toBe(fallback) // exact reference — no prototype value mixed in
  })
})

describe("HELLGATE: 4-pillar projection — frozen-default tamper resistance", () => {
  test("mutating the returned absent-profile default cannot poison the next caller", () => {
    const first = inferApprovalPolicy(undefined)
    // A buggy/malicious caller tries to flip the prompt off on the shared default.
    expect(() => {
      ;(first as { promptUser: boolean }).promptUser = false
    }).toThrow() // frozen — the write is rejected, not silently applied

    // The NEXT caller still gets the strict default, unpoisoned.
    const second = inferApprovalPolicy(undefined)
    expect(second.promptUser).toBe(true)
    expect(second.mode).toBe("once")
    expect(Object.isFrozen(second)).toBe(true)
  })

  test("every absent-profile pillar default is frozen", () => {
    expect(Object.isFrozen(inferApprovalPolicy(undefined))).toBe(true)
    expect(Object.isFrozen(inferNetworkPolicy(undefined))).toBe(true)
    expect(Object.isFrozen(inferSandboxPolicy(undefined))).toBe(true)
    expect(Object.isFrozen(inferControlPolicy(undefined))).toBe(true)
  })
})

describe("HELLGATE: 4-pillar projection — own pillars still honored (no over-correction)", () => {
  test("an own pillar value passes through verbatim", () => {
    const profile = {
      approval: { mode: "session" as const, promptUser: false },
      network: { mode: "allow-list" as const, allowedHosts: ["example.com"] },
      sandbox: {
        osSandbox: "landlock" as const,
        readOnly: false,
        workspaceWrite: true,
        networkIsolated: false,
      },
      control: { auditRequired: true, managedBy: "admin" as const },
    } as unknown as PermissionProfile

    expect(inferApprovalPolicy(profile).mode).toBe("session")
    expect(inferNetworkPolicy(profile).mode).toBe("allow-list")
    expect(inferSandboxPolicy(profile).osSandbox).toBe("landlock")
    expect(inferControlPolicy(profile).auditRequired).toBe(true)
  })

  test("an own pillar that is explicitly `undefined` still collapses to the strict default", () => {
    // `Object.hasOwn` is true but the value is undefined ⇒ `?? DEFAULT` floors it.
    const profile = { approval: undefined } as unknown as PermissionProfile
    expect(inferApprovalPolicy(profile).mode).toBe("once")
    expect(inferApprovalPolicy(profile).promptUser).toBe(true)
  })
})
