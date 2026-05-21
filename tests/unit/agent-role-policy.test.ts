/**
 * agent_role policy tests (Cluster E / F16, ADR-0042).
 *
 * For each role, every tool kind in the registry must have an explicit
 * allow/deny mapping. If a new ToolKind lands without a mapping ⇒ FAIL.
 */
import { describe, expect, test } from "bun:test"
import {
  AGENT_ROLES,
  getToolPolicyForRole,
  roleAllowsKind,
  TOOL_KINDS,
  UnknownAgentRoleError,
} from "../../src/subagent/role"

describe("AGENT_ROLES", () => {
  test("contains exactly 3 roles", () => {
    expect(AGENT_ROLES).toEqual(["explorer", "worker", "none"])
  })
})

describe("policy table exhaustiveness — every (role, kind) is explicit", () => {
  for (const role of AGENT_ROLES) {
    test(`role '${role}' covers every ToolKind explicitly`, () => {
      const p = getToolPolicyForRole(role)
      // none = inherit signal (both lists empty by design).
      if (role === "none") {
        expect(p.allowedToolKinds).toEqual([])
        expect(p.deniedToolKinds).toEqual([])
        return
      }
      const allowSet = new Set(p.allowedToolKinds)
      const denySet = new Set(p.deniedToolKinds)
      // No overlap.
      for (const k of allowSet) {
        expect(denySet.has(k)).toBe(false)
      }
      // Union covers every TOOL_KIND — adding a new ToolKind here without
      // updating the policy table is the intentional failure path.
      for (const k of TOOL_KINDS) {
        const inOne = allowSet.has(k) || denySet.has(k)
        expect(inOne).toBe(true)
      }
    })
  }
})

describe("getToolPolicyForRole", () => {
  test("returns the explorer policy", () => {
    const p = getToolPolicyForRole("explorer")
    expect(p.allowedToolKinds).toContain("read")
    expect(p.deniedToolKinds).toContain("edit")
  })

  test("returns the worker policy", () => {
    const p = getToolPolicyForRole("worker")
    expect(p.allowedToolKinds).toContain("edit")
    expect(p.deniedToolKinds).toContain("network")
  })

  test("returns the empty/empty (inherit) signal for 'none'", () => {
    const p = getToolPolicyForRole("none")
    expect(p.allowedToolKinds.length).toBe(0)
    expect(p.deniedToolKinds.length).toBe(0)
  })

  test("throws on unknown role (runtime defensive)", () => {
    expect(() => getToolPolicyForRole("alien" as unknown as "explorer")).toThrow(
      UnknownAgentRoleError,
    )
  })
})

describe("roleAllowsKind", () => {
  test("explorer allows read but not edit", () => {
    expect(roleAllowsKind("explorer", "read")).toBe(true)
    expect(roleAllowsKind("explorer", "edit")).toBe(false)
  })

  test("worker allows edit but not subagent", () => {
    expect(roleAllowsKind("worker", "edit")).toBe(true)
    expect(roleAllowsKind("worker", "subagent")).toBe(false)
  })

  test("none allows every kind (inherits parent)", () => {
    for (const k of TOOL_KINDS) {
      expect(roleAllowsKind("none", k)).toBe(true)
    }
  })
})
