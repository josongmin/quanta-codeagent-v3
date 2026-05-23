/**
 * `inspectPermission` — Codex 5-axis stack inspector for the `/permission`
 * CLI surface. Pins:
 *   - read-only short-circuit (axis 1 wins)
 *   - HARD_DENY matching surfaces `name` + `description` ONLY (NEVER regex)
 *   - HITL tier overlay on the per-mode matrix (hand-off-required wins;
 *     always-confirm forces ask; pre-approval-ok defers; none allows)
 *   - unmapped tool degrades to a "default policy" explanation
 *   - mode matrix covers all 4 modes (default | acceptEdits | bypass | auto)
 *   - pipeline trace lists all 5 axes in precedence order
 *   - HARD_DENY descriptors must never include `pattern`/regex source
 */

import { describe, expect, test } from "bun:test"
import {
  finalDecisionFor,
  inspectPermission,
  listHardDenyRuleDescriptors,
  PERMISSION_AXES,
} from "../../../src/permission/inspect"

describe("inspectPermission — read-only axis (axis 1)", () => {
  test("read-only tool ⇒ allow across every mode (HITL tier 'none')", () => {
    const r = inspectPermission("read", { mode: "default" }, { isReadOnly: true, hitlTier: "none" })
    expect(r.isReadOnly).toBe(true)
    expect(r.hitlTier).toBe("none")
    expect(r.modePolicy.default).toBe("allow")
    expect(r.modePolicy.acceptEdits).toBe("allow")
    expect(r.modePolicy.bypass).toBe("allow")
    expect(r.modePolicy.auto).toBe("allow")
    const pipe1 = r.pipeline[0]
    expect(pipe1?.axis).toBe("read-only-bypass")
    expect(pipe1?.outcome).toBe("allow")
  })
})

describe("inspectPermission — HITL tier overlay (axis 3)", () => {
  test("bash 'always-confirm' ⇒ ask in every mode (overrides bypass)", () => {
    const r = inspectPermission(
      "bash",
      { mode: "bypass" },
      { isReadOnly: false, hitlTier: "always-confirm" },
    )
    expect(r.modePolicy.default).toBe("ask")
    expect(r.modePolicy.acceptEdits).toBe("ask")
    expect(r.modePolicy.bypass).toBe("ask")
    expect(r.modePolicy.auto).toBe("ask")
  })

  test("'pre-approval-ok' ⇒ defers to mode policy (bypass ⇒ allow)", () => {
    const r = inspectPermission(
      "edit",
      { mode: "default" },
      { isReadOnly: false, hitlTier: "pre-approval-ok" },
    )
    expect(r.modePolicy.default).toBe("ask")
    expect(r.modePolicy.bypass).toBe("allow")
    expect(r.modePolicy.acceptEdits).toBe("allow")
  })

  test("'hand-off-required' ⇒ deny in every mode (security boundary)", () => {
    const r = inspectPermission(
      "scary-tool",
      { mode: "bypass" },
      { isReadOnly: false, hitlTier: "hand-off-required" },
    )
    expect(r.modePolicy.default).toBe("deny")
    expect(r.modePolicy.acceptEdits).toBe("deny")
    expect(r.modePolicy.bypass).toBe("deny")
    expect(r.modePolicy.auto).toBe("deny")
  })
})

describe("inspectPermission — HARD_DENY axis (axis 2, security boundary)", () => {
  test("`rm -rf /` matches HARD_DENY and surfaces a descriptor", () => {
    const r = inspectPermission(
      "bash",
      { mode: "default" },
      {
        isReadOnly: false,
        hitlTier: "always-confirm",
        shellCommand: "rm -rf /",
      },
    )
    expect(r.hardDenyMatched).toBe(true)
    expect(r.hardDenyRules.length).toBeGreaterThan(0)
    const first = r.hardDenyRules[0]
    expect(first?.name).toBeDefined()
    expect(first?.description).toBeDefined()
    expect(first?.name.length).toBeGreaterThan(0)
    expect(first?.description.length).toBeGreaterThan(0)
  })

  test("benign shell command ⇒ no HARD_DENY match", () => {
    const r = inspectPermission(
      "bash",
      { mode: "default" },
      {
        isReadOnly: false,
        hitlTier: "always-confirm",
        shellCommand: "ls -la ./src",
      },
    )
    expect(r.hardDenyMatched).toBe(false)
    expect(r.hardDenyRules.length).toBe(0)
  })

  test("HARD_DENY descriptor NEVER exposes a raw regex (security contract)", () => {
    const r = inspectPermission(
      "bash",
      { mode: "default" },
      {
        isReadOnly: false,
        hitlTier: "always-confirm",
        shellCommand: "rm -rf /",
      },
    )
    for (const rule of r.hardDenyRules) {
      // The shape ought to have ONLY `name` + `description`. Any extra key
      // — or a key whose value is a RegExp — fails the contract.
      const keys = Object.keys(rule).sort()
      expect(keys).toEqual(["description", "name"])
      const recordRule = rule as unknown as Record<string, unknown>
      expect(recordRule.pattern).toBeUndefined()
      expect(rule.description).not.toMatch(/\\b|\\s|\(\?:/)
    }
  })

  test("`finalDecisionFor` returns deny when HARD_DENY matched", () => {
    const r = inspectPermission(
      "bash",
      { mode: "default" },
      {
        isReadOnly: false,
        hitlTier: "always-confirm",
        shellCommand: "rm -rf /",
      },
    )
    const verdict = finalDecisionFor(r, "default")
    expect(verdict.kind).toBe("deny")
  })
})

describe("inspectPermission — unmapped tool ⇒ default-policy explanation", () => {
  test("unmapped ⇒ mapped:false + hitlTier undefined + base mode policy", () => {
    const r = inspectPermission("unknown-tool", { mode: "default" }, {})
    expect(r.mapped).toBe(false)
    expect(r.hitlTier).toBeUndefined()
    // Without isReadOnly meta, treated as mutating ⇒ default mode → ask.
    expect(r.modePolicy.default).toBe("ask")
    expect(r.modePolicy.bypass).toBe("allow")
    const hitlStep = r.pipeline.find((s) => s.axis === "hitl-tier")
    expect(hitlStep?.outcome).toBe("n/a")
    expect(hitlStep?.reason).toContain("unmapped")
  })
})

describe("inspectPermission — pipeline trace structure (5 axes in order)", () => {
  test("pipeline lists every PERMISSION_AXES entry exactly once, in order", () => {
    const r = inspectPermission(
      "bash",
      { mode: "default" },
      { isReadOnly: false, hitlTier: "always-confirm" },
    )
    const axisOrder = r.pipeline.map((s) => s.axis)
    expect(axisOrder).toEqual([...PERMISSION_AXES])
  })

  test("pipeline includes the current mode in mode-policy reason", () => {
    const r = inspectPermission(
      "bash",
      { mode: "acceptEdits" },
      { isReadOnly: false, hitlTier: "pre-approval-ok" },
    )
    const step = r.pipeline.find((s) => s.axis === "mode-policy")
    expect(step?.reason).toContain("acceptEdits")
  })
})

describe("listHardDenyRuleDescriptors — public read-only catalog", () => {
  test("returns non-empty list; each entry has name+description ONLY (no regex)", () => {
    const rules = listHardDenyRuleDescriptors()
    expect(rules.length).toBeGreaterThan(0)
    for (const r of rules) {
      const keys = Object.keys(r).sort()
      expect(keys).toEqual(["description", "name"])
      expect(typeof r.name).toBe("string")
      expect(typeof r.description).toBe("string")
    }
  })

  test("catalog count is reasonable (9-rules-or-more invariant per RFC)", () => {
    const rules = listHardDenyRuleDescriptors()
    // The RFC documents "9 HARD_DENY rules" minimum. The current catalog
    // has ~25 — we pin the lower bound only so adding rules can't regress.
    expect(rules.length).toBeGreaterThanOrEqual(9)
  })
})
