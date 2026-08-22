/**
 * agent_role × tool-policy HELL e2e (Cluster E / F16, ADR-0042 part 1).
 *
 * Exhaustive matrix: 3 roles × 7 tool kinds = 21 cells.
 *
 *   - Every (role, kind) is asserted EXPLICITLY (no defaulting allowed).
 *   - `none` is the documented inherit signal: empty/empty lists, and
 *     `roleAllowsKind('none', any)` ⇒ true.
 *   - Unknown role: `getToolPolicyForRole` and `roleAllowsKind` BOTH throw
 *     `UnknownAgentRoleError` (no silent default).
 *   - Compile-time × runtime: `as any` bypasses TS; runtime still guards.
 *
 * The private `POLICY_TABLE` is not exported. Per the source's intended
 * surface (see `src/subagent/role.ts:54-77`), the invariants on the table are
 * observable through `getToolPolicyForRole` — this file probes that surface
 * exhaustively rather than reaching into the module.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig } from "@/shared"
import {
  AGENT_ROLES,
  type AgentRole,
  getToolPolicyForRole,
  roleAllowsKind,
  TOOL_KINDS,
  type ToolKind,
  UnknownAgentRoleError,
} from "@/subagent/role"

beforeEach(() => {
  __resetRuntimeConfig()
})

/* ── 1. POLICY surface exhaustiveness × invariants ──────────────────────── */

describe("policy surface — exhaustiveness × invariants", () => {
  test("AGENT_ROLES is exactly ['explorer','worker','none']", () => {
    expect([...AGENT_ROLES]).toEqual(["explorer", "worker", "none"])
  })

  test("TOOL_KINDS is exactly the 7 documented kinds", () => {
    expect([...TOOL_KINDS]).toEqual([
      "read",
      "edit",
      "shell",
      "network",
      "subagent",
      "memory",
      "lsp",
    ])
    expect(TOOL_KINDS.length).toBe(7)
  })

  for (const role of AGENT_ROLES) {
    test(`role '${role}' policy is explicit + disjoint`, () => {
      assertRolePolicyShape(role)
    })
  }
})

/** Assert (allow, deny) lists are present, disjoint, and either empty (for
 *  'none') or covering every TOOL_KIND (for explorer/worker). */
const assertRolePolicyShape = (role: AgentRole): void => {
  const p = getToolPolicyForRole(role)
  expect(Array.isArray(p.allowedToolKinds)).toBe(true)
  expect(Array.isArray(p.deniedToolKinds)).toBe(true)

  const allow = new Set<ToolKind>(p.allowedToolKinds)
  const deny = new Set<ToolKind>(p.deniedToolKinds)
  assertDisjoint(role, allow, deny)

  if (role === "none") {
    expect(allow.size).toBe(0)
    expect(deny.size).toBe(0)
    return
  }
  assertCoversAllKinds(role, allow, deny)
}

const assertDisjoint = (role: AgentRole, allow: Set<ToolKind>, deny: Set<ToolKind>): void => {
  for (const k of allow) {
    if (deny.has(k)) {
      throw new Error(`role '${role}' contradiction: '${k}' is both allowed and denied`)
    }
  }
}

const assertCoversAllKinds = (role: AgentRole, allow: Set<ToolKind>, deny: Set<ToolKind>): void => {
  for (const k of TOOL_KINDS) {
    const present = allow.has(k) || deny.has(k)
    if (!present) {
      throw new Error(`role '${role}' missing explicit policy for kind '${k}'`)
    }
  }
}

/* ── 2. role-to-tool-policy matrix: 3 × 7 = 21 cells ────────────────────── */

/**
 * Expected matrix — derived directly from the source's POLICY_TABLE.
 *   explorer  allow: read, lsp, memory       deny: edit, shell, network, subagent
 *   worker    allow: read, edit, shell, memory  deny: network, subagent, lsp
 *   none      inherit (all true)
 */
const EXPECTED_ALLOW: Readonly<Record<AgentRole, ReadonlyArray<ToolKind>>> = {
  explorer: ["read", "lsp", "memory"],
  worker: ["read", "edit", "shell", "memory"],
  none: [...TOOL_KINDS], // inherit ⇒ all true
}

describe("roleAllowsKind matrix — every (role, kind) cell", () => {
  for (const role of AGENT_ROLES) {
    for (const kind of TOOL_KINDS) {
      const expected = EXPECTED_ALLOW[role].includes(kind)
      test(`(${role}, ${kind}) ⇒ ${expected}`, () => {
        expect(roleAllowsKind(role, kind)).toBe(expected)
      })
    }
  }
})

describe("'none' inherit-signal semantics", () => {
  test("getToolPolicyForRole('none') returns empty/empty", () => {
    const p = getToolPolicyForRole("none")
    expect(p.allowedToolKinds.length).toBe(0)
    expect(p.deniedToolKinds.length).toBe(0)
  })

  test("roleAllowsKind('none', k) is true for every kind (inherit signal)", () => {
    for (const k of TOOL_KINDS) {
      expect(roleAllowsKind("none", k)).toBe(true)
    }
  })
})

/* ── 3. UnknownAgentRoleError specificity ──────────────────────────────── */

describe("UnknownAgentRoleError — runtime defence is total (no silent defaults)", () => {
  test("getToolPolicyForRole('invalid-role') throws UnknownAgentRoleError", () => {
    let threw: unknown = null
    try {
      // biome-ignore lint/suspicious/noExplicitAny: bypassing TS to test runtime guard
      getToolPolicyForRole("invalid-role" as any)
    } catch (e) {
      threw = e
    }
    if (!(threw instanceof UnknownAgentRoleError)) {
      throw new Error(`expected UnknownAgentRoleError, got ${String(threw)}`)
    }
    expect(threw.name).toBe("UnknownAgentRoleError")
    // The exact role name must appear in the message — no swallowing.
    expect(threw.message.includes("invalid-role")).toBe(true)
  })

  test("roleAllowsKind('invalid-role', 'read') ALSO throws UnknownAgentRoleError (no silent default)", () => {
    let threw: unknown = null
    try {
      // biome-ignore lint/suspicious/noExplicitAny: bypassing TS to test runtime guard
      roleAllowsKind("invalid-role" as any, "read")
    } catch (e) {
      threw = e
    }
    if (!(threw instanceof UnknownAgentRoleError)) {
      throw new Error(`expected UnknownAgentRoleError, got ${String(threw)}`)
    }
    expect(threw.message.includes("invalid-role")).toBe(true)
  })

  test("error message contains role name even for empty string ''", () => {
    let threw: unknown = null
    try {
      // biome-ignore lint/suspicious/noExplicitAny: bypassing TS to test runtime guard
      getToolPolicyForRole("" as any)
    } catch (e) {
      threw = e
    }
    if (!(threw instanceof UnknownAgentRoleError)) {
      throw new Error(`expected UnknownAgentRoleError, got ${String(threw)}`)
    }
    // Even for empty role, the wrapper text appears.
    expect(/unknown agent_role/.test(threw.message)).toBe(true)
  })
})

/* ── 4. compile-time vs. runtime ─────────────────────────────────────────── */

describe("compile-time vs. runtime guard", () => {
  test("the type system would reject 'invalid' for AgentRole, but `as any` bypasses it; the runtime catches it", () => {
    // @ts-expect-error — 'invalid' is not a member of AgentRole literal union
    const callBypass = () => getToolPolicyForRole("invalid")
    expect(() => callBypass()).toThrow(UnknownAgentRoleError)
  })

  test("the type system would reject an unknown kind, but runtime is intentionally permissive on the kind", () => {
    // `roleAllowsKind` does NOT validate the kind — it just looks it up in
    // the allow set. Passing an unknown kind on a NON-'none' role returns
    // false (not in allow). On 'none' it returns true (inherit).
    // biome-ignore lint/suspicious/noExplicitAny: probing runtime behaviour
    expect(roleAllowsKind("explorer", "bogus" as any)).toBe(false)
    // biome-ignore lint/suspicious/noExplicitAny: probing runtime behaviour
    expect(roleAllowsKind("worker", "bogus" as any)).toBe(false)
    // biome-ignore lint/suspicious/noExplicitAny: probing runtime behaviour
    expect(roleAllowsKind("none", "bogus" as any)).toBe(true)
  })
})

/* ── 5. policy table frozen / immutable ─────────────────────────────────── */

describe("policy table immutability", () => {
  test("the returned policy lists are frozen (Object.freeze applied at source)", () => {
    const p = getToolPolicyForRole("explorer")
    expect(Object.isFrozen(p.allowedToolKinds)).toBe(true)
    expect(Object.isFrozen(p.deniedToolKinds)).toBe(true)
  })

  test("mutating the returned object via cast is rejected at runtime by Object.freeze", () => {
    const p = getToolPolicyForRole("worker")
    let threwOrIgnored = true
    try {
      // biome-ignore lint/suspicious/noExplicitAny: probing freeze
      ;(p.allowedToolKinds as any).push("subagent")
      // In non-strict module mode, push on a frozen array is a silent no-op.
      // Verify by length comparison: it must NOT have grown.
      threwOrIgnored = p.allowedToolKinds.length === 4
    } catch {
      threwOrIgnored = true
    }
    expect(threwOrIgnored).toBe(true)
  })
})
