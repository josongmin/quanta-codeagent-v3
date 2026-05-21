/**
 * TrustScopeRegistry — 5-tier (always_allow / project / workspace / session /
 * deny) + once_only single-use grant. See `src/permission/trust-scope.ts`.
 *
 * Pure in-memory; no IO; no clock. Tests pass a fixed `grantedAt`.
 */
import { describe, expect, test } from "bun:test"
import {
  actionKeyOf,
  TRUST_SCOPES,
  type TrustGrant,
  type TrustScopeQuery,
  TrustScopeRegistry,
} from "@/permission/trust-scope"

const T0 = 1_700_000_000_000

function baseQuery(overrides: Partial<TrustScopeQuery> = {}): TrustScopeQuery {
  return {
    actionKey: "tool::{}",
    cwd: "/repo",
    projectRoot: "/repo",
    workspaceRoot: "/ws",
    sessionId: "s1",
    ...overrides,
  }
}

function baseGrant(overrides: Partial<TrustGrant> = {}): TrustGrant {
  return {
    actionKey: "tool::{}",
    scope: "always_allow",
    grantedAt: T0,
    cwd: "/repo",
    projectRoot: "/repo",
    workspaceRoot: "/ws",
    sessionId: "s1",
    ...overrides,
  }
}

describe("actionKeyOf — canonical, order-independent", () => {
  test("is deterministic for equivalent inputs with reordered keys", () => {
    const a = actionKeyOf({ tool: "edit", input: { path: "a.ts", text: "x" } })
    const b = actionKeyOf({ tool: "edit", input: { text: "x", path: "a.ts" } })
    expect(a).toBe(b)
  })

  test("differs when tool name differs", () => {
    const a = actionKeyOf({ tool: "edit", input: { path: "a.ts" } })
    const b = actionKeyOf({ tool: "write", input: { path: "a.ts" } })
    expect(a).not.toBe(b)
  })

  test("differs when nested values differ", () => {
    const a = actionKeyOf({ tool: "edit", input: { path: "a.ts", nested: { k: 1 } } })
    const b = actionKeyOf({ tool: "edit", input: { path: "a.ts", nested: { k: 2 } } })
    expect(a).not.toBe(b)
  })
})

describe("TRUST_SCOPES enum completeness", () => {
  test("exactly 6 distinct scopes", () => {
    expect(TRUST_SCOPES.length).toBe(6)
    expect(new Set(TRUST_SCOPES).size).toBe(6)
  })
})

describe("TrustScopeRegistry — empty + basic grant matching", () => {
  test("empty registry returns null for any query", () => {
    const r = new TrustScopeRegistry()
    expect(r.check(baseQuery())).toBeNull()
  })

  test("always_allow matches any cwd/project/workspace/session", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "always_allow" }))
    const m = r.check(
      baseQuery({
        cwd: "/elsewhere",
        projectRoot: "/other",
        workspaceRoot: "/other-ws",
        sessionId: "s9",
      }),
    )
    expect(m).not.toBeNull()
    expect(m?.scope).toBe("always_allow")
  })
})

describe("TrustScopeRegistry — project scope", () => {
  test("matches same projectRoot", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "project", projectRoot: "/repo" }))
    expect(r.check(baseQuery({ projectRoot: "/repo" }))?.scope).toBe("project")
  })

  test("misses different projectRoot", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "project", projectRoot: "/repo" }))
    expect(r.check(baseQuery({ projectRoot: "/other" }))).toBeNull()
  })
})

describe("TrustScopeRegistry — workspace scope", () => {
  test("matches same workspaceRoot", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "workspace", workspaceRoot: "/ws" }))
    expect(r.check(baseQuery({ workspaceRoot: "/ws" }))?.scope).toBe("workspace")
  })

  test("misses different workspaceRoot", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "workspace", workspaceRoot: "/ws" }))
    expect(r.check(baseQuery({ workspaceRoot: "/other" }))).toBeNull()
  })
})

describe("TrustScopeRegistry — session scope", () => {
  test("matches same sessionId", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "session", sessionId: "s1" }))
    expect(r.check(baseQuery({ sessionId: "s1" }))?.scope).toBe("session")
  })

  test("misses different sessionId", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "session", sessionId: "s1" }))
    expect(r.check(baseQuery({ sessionId: "s2" }))).toBeNull()
  })
})

describe("TrustScopeRegistry — once_only consumption", () => {
  test("matches first time, returns null on second check", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "once_only" }))
    expect(r.check(baseQuery())?.scope).toBe("once_only")
    expect(r.check(baseQuery())).toBeNull()
  })

  test("consumption only removes the matched grant — siblings persist", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "session", sessionId: "s1" }))
    r.grant(baseGrant({ scope: "once_only" }))
    // newest first ⇒ once_only matches first and is consumed
    expect(r.check(baseQuery())?.scope).toBe("once_only")
    // session grant survives
    expect(r.check(baseQuery())?.scope).toBe("session")
    expect(r.snapshot().length).toBe(1)
  })
})

describe("TrustScopeRegistry — deny", () => {
  test("deny grant is returned with scope:'deny'", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "deny" }))
    const m = r.check(baseQuery())
    expect(m?.scope).toBe("deny")
  })
})

describe("TrustScopeRegistry — precedence (newest wins)", () => {
  test("most recent grant for an actionKey takes precedence", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "session", grantedAt: T0 }))
    r.grant(baseGrant({ scope: "always_allow", grantedAt: T0 + 1 }))
    const m = r.check(baseQuery())
    expect(m?.scope).toBe("always_allow")
    expect(m?.grant.grantedAt).toBe(T0 + 1)
  })
})

describe("TrustScopeRegistry — revoke + clear + snapshot", () => {
  test("revoke(actionKey) removes all grants for that key", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "session" }))
    r.grant(baseGrant({ scope: "project" }))
    r.grant(baseGrant({ actionKey: "other::{}", scope: "always_allow" }))
    const removed = r.revoke("tool::{}")
    expect(removed).toBe(2)
    expect(r.snapshot().length).toBe(1)
    expect(r.check(baseQuery())).toBeNull()
    expect(r.check(baseQuery({ actionKey: "other::{}" }))?.scope).toBe("always_allow")
  })

  test("revoke(actionKey, 'session') removes only session-tier grants", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "session" }))
    r.grant(baseGrant({ scope: "project" }))
    const removed = r.revoke("tool::{}", "session")
    expect(removed).toBe(1)
    expect(r.snapshot().length).toBe(1)
    expect(r.check(baseQuery())?.scope).toBe("project")
  })

  test("clear() wipes everything", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "always_allow" }))
    r.grant(baseGrant({ scope: "project" }))
    r.clear()
    expect(r.snapshot().length).toBe(0)
    expect(r.check(baseQuery())).toBeNull()
  })

  test("snapshot() returns a frozen copy — mutation does not leak", () => {
    const r = new TrustScopeRegistry()
    r.grant(baseGrant({ scope: "always_allow" }))
    const snap = r.snapshot()
    expect(Object.isFrozen(snap)).toBe(true)
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: testing frozen contract
      ;(snap as any).push(baseGrant({ scope: "deny" }))
    }).toThrow()
    expect(r.snapshot().length).toBe(1)
  })
})
