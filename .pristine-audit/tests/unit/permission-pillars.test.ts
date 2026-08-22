/**
 * ADR-0135 — 4-pillar inference + AutoApprovalReview threshold logic.
 *
 * Each pillar inferer must return its strictest default when no profile is
 * supplied (so legacy callers land closed-by-default), and faithfully echo
 * the profile's value when one is. The reviewer must fire EXACTLY at the
 * threshold and reset on user/deny boundaries.
 */
import { describe, expect, test } from "bun:test"
import {
  createApprovalReviewer,
  DEFAULT_PERMISSION_PROFILE,
  inferApprovalPolicy,
  inferControlPolicy,
  inferNetworkPolicy,
  inferSandboxPolicy,
  type PermissionProfile,
  type PermissionSandboxPolicy,
} from "@/permission"

/* ---------------- 4 pillars: defaults ---------------- */

describe("ADR-0135 — pillar defaults (no profile)", () => {
  test("approval default is `once` + promptUser=true (strictest)", () => {
    const a = inferApprovalPolicy(undefined)
    expect(a.mode).toBe("once")
    expect(a.promptUser).toBe(true)
  })

  test("network default is `deny-all`", () => {
    expect(inferNetworkPolicy(undefined).mode).toBe("deny-all")
  })

  test("sandbox default is osSandbox=none + readOnly + isolated", () => {
    const s = inferSandboxPolicy(undefined)
    expect(s.osSandbox).toBe("none")
    expect(s.readOnly).toBe(true)
    expect(s.workspaceWrite).toBe(false)
    expect(s.networkIsolated).toBe(true)
  })

  test("control default is user-managed + audit OFF", () => {
    const c = inferControlPolicy(undefined)
    expect(c.managedBy).toBeUndefined()
    expect(c.auditRequired).toBe(false)
  })
})

/* ---------------- 4 pillars: profile passthrough ---------------- */

describe("ADR-0135 — pillar passthrough with profile", () => {
  test("approval honors profile.approval", () => {
    const p: PermissionProfile = {
      ...DEFAULT_PERMISSION_PROFILE,
      approval: { mode: "always", promptUser: false },
    }
    const a = inferApprovalPolicy(p)
    expect(a.mode).toBe("always")
    expect(a.promptUser).toBe(false)
  })

  test("network honors allow-list with hosts", () => {
    const p: PermissionProfile = {
      ...DEFAULT_PERMISSION_PROFILE,
      network: {
        mode: "allow-list",
        allowHosts: ["api.openai.com", "registry.npmjs.org"],
        perRequestApproval: true,
      },
    }
    const n = inferNetworkPolicy(p)
    expect(n.mode).toBe("allow-list")
    expect(n.allowHosts).toEqual(["api.openai.com", "registry.npmjs.org"])
    expect(n.perRequestApproval).toBe(true)
  })

  test("sandbox honors osSandbox enum (seatbelt / landlock / windows-sandbox)", () => {
    const make = (k: "seatbelt" | "landlock" | "windows-sandbox"): PermissionProfile => ({
      ...DEFAULT_PERMISSION_PROFILE,
      sandbox: { osSandbox: k, readOnly: false, workspaceWrite: true, networkIsolated: false },
    })
    expect(inferSandboxPolicy(make("seatbelt")).osSandbox).toBe("seatbelt")
    expect(inferSandboxPolicy(make("landlock")).osSandbox).toBe("landlock")
    expect(inferSandboxPolicy(make("windows-sandbox")).osSandbox).toBe("windows-sandbox")
  })

  test("sandbox fallback wins over default when profile is absent", () => {
    const fallback: PermissionSandboxPolicy = {
      osSandbox: "landlock",
      readOnly: false,
      workspaceWrite: true,
      networkIsolated: false,
    }
    const s = inferSandboxPolicy(undefined, fallback)
    expect(s.osSandbox).toBe("landlock")
    expect(s.workspaceWrite).toBe(true)
  })

  test("control.managed_by=admin + audit_required=true is propagated", () => {
    const p: PermissionProfile = {
      ...DEFAULT_PERMISSION_PROFILE,
      control: { managedBy: "admin", auditRequired: true },
    }
    const c = inferControlPolicy(p)
    expect(c.managedBy).toBe("admin")
    expect(c.auditRequired).toBe(true)
  })
})

/* ---------------- AutoApprovalReviewer ---------------- */

describe("ADR-0135 — AutoApprovalReviewer threshold", () => {
  let clock = 0
  const now = () => ++clock

  test("default threshold fires on the 10th consecutive auto-approval", () => {
    clock = 0
    const r = createApprovalReviewer({ now })
    for (let i = 0; i < 9; i++) {
      expect(r.record({ tool: "bash", granted: true, method: "auto" })).toBe(false)
    }
    expect(r.record({ tool: "bash", granted: true, method: "auto" })).toBe(true)
  })

  test("user decision resets the streak (no prompt at N+1)", () => {
    clock = 0
    const r = createApprovalReviewer({ threshold: 3, now })
    r.record({ tool: "bash", granted: true, method: "auto" })
    r.record({ tool: "bash", granted: true, method: "auto" })
    r.record({ tool: "edit", granted: true, method: "user" }) // reset
    expect(r.consecutiveAutoApprovals()).toBe(0)
    expect(r.record({ tool: "bash", granted: true, method: "auto" })).toBe(false) // streak=1
  })

  test("denial resets the streak", () => {
    clock = 0
    const r = createApprovalReviewer({ threshold: 3, now })
    r.record({ tool: "bash", granted: true, method: "auto" })
    r.record({ tool: "rm-rf", granted: false, method: "system" }) // HARD_DENY
    expect(r.consecutiveAutoApprovals()).toBe(0)
  })

  test("threshold of 1 fires on every auto-approval (edge case)", () => {
    clock = 0
    const r = createApprovalReviewer({ threshold: 1, now })
    expect(r.record({ tool: "x", granted: true, method: "auto" })).toBe(true)
    expect(r.record({ tool: "x", granted: true, method: "auto" })).toBe(true)
  })

  test("summary surfaces the recent auto-approvals + a hint", () => {
    clock = 0
    const r = createApprovalReviewer({ threshold: 3, now })
    r.record({ tool: "bash", granted: true, method: "auto" })
    r.record({ tool: "edit", granted: true, method: "auto" })
    r.record({ tool: "write", granted: true, method: "auto" })
    const summary = r.generateReviewSummary()
    expect(summary).toContain("Auto-approval review")
    expect(summary).toContain("bash")
    expect(summary).toContain("edit")
    expect(summary).toContain("write")
    expect(summary).toContain("Hint")
  })

  test("empty ledger summary is the empty string", () => {
    expect(createApprovalReviewer().generateReviewSummary()).toBe("")
  })

  test("history snapshot is frozen and ordered oldest → newest", () => {
    clock = 0
    const r = createApprovalReviewer({ now })
    r.record({ tool: "a", granted: true, method: "auto" })
    r.record({ tool: "b", granted: true, method: "auto" })
    const h = r.history()
    expect(h.length).toBe(2)
    expect(h[0]?.tool).toBe("a")
    expect(h[1]?.tool).toBe("b")
    expect(Object.isFrozen(h)).toBe(true)
  })

  test("clear empties the ledger and resets streak", () => {
    clock = 0
    const r = createApprovalReviewer({ threshold: 3, now })
    r.record({ tool: "x", granted: true, method: "auto" })
    r.record({ tool: "x", granted: true, method: "auto" })
    r.clear()
    expect(r.history().length).toBe(0)
    expect(r.consecutiveAutoApprovals()).toBe(0)
  })

  test("capacity bounds history (FIFO eviction)", () => {
    clock = 0
    const r = createApprovalReviewer({ capacity: 3, now })
    for (let i = 0; i < 5; i++) r.record({ tool: `t${i}`, granted: true, method: "auto" })
    const h = r.history()
    expect(h.length).toBe(3)
    expect(h[0]?.tool).toBe("t2") // earliest 2 evicted
  })

  test("threshold rearms — fires every N consecutive auto-approvals", () => {
    clock = 0
    const r = createApprovalReviewer({ threshold: 2, now })
    expect(r.record({ tool: "x", granted: true, method: "auto" })).toBe(false)
    expect(r.record({ tool: "x", granted: true, method: "auto" })).toBe(true) // 1st prompt
    expect(r.record({ tool: "x", granted: true, method: "auto" })).toBe(false)
    expect(r.record({ tool: "x", granted: true, method: "auto" })).toBe(true) // 2nd prompt
  })
})
